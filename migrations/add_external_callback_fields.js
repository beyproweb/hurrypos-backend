#!/usr/bin/env node

require("dotenv").config();
const { Pool } = require("pg");

const isProduction = process.env.DATABASE_URL?.includes("render.com");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(isProduction && {
    ssl: {
      require: true,
      rejectUnauthorized: false,
    },
  }),
});

async function addExternalCallbackFields() {
  const client = await pool.connect();
  try {
    console.log("\n🔄 Running migration: Add external callback fields to orders...\n");

    const checkQuery = `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'orders'
        AND column_name IN ('external_order_token', 'external_callback_urls', 'external_source', 'cancel_sync_error')
      ORDER BY column_name;
    `;

    const checkResult = await client.query(checkQuery);
    const existingCols = checkResult.rows.map((r) => r.column_name);

    if (existingCols.length === 4) {
      console.log("✅ External callback columns already exist");
      console.log("━".repeat(70));
      await pool.end();
      return;
    }

    console.log(`📍 Found ${existingCols.length}/4 columns. Adding missing ones...\n`);

    if (!existingCols.includes("external_order_token")) {
      await client.query(`
        ALTER TABLE orders
        ADD COLUMN external_order_token TEXT;
      `);
      console.log("✅ Added external_order_token column (TEXT)");
    }

    if (!existingCols.includes("external_callback_urls")) {
      await client.query(`
        ALTER TABLE orders
        ADD COLUMN external_callback_urls JSONB;
      `);
      console.log("✅ Added external_callback_urls column (JSONB)");
    }

    if (!existingCols.includes("external_source")) {
      await client.query(`
        ALTER TABLE orders
        ADD COLUMN external_source TEXT;
      `);
      console.log("✅ Added external_source column (TEXT)");
    }

    if (!existingCols.includes("cancel_sync_error")) {
      await client.query(`
        ALTER TABLE orders
        ADD COLUMN cancel_sync_error TEXT;
      `);
      console.log("✅ Added cancel_sync_error column (TEXT)");
    }

    const verifyQuery = `
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'orders'
        AND column_name IN ('external_order_token', 'external_callback_urls', 'external_source', 'cancel_sync_error')
      ORDER BY column_name;
    `;

    const verifyResult = await client.query(verifyQuery);
    console.log("\n✅ Verification - New columns:");
    console.log("━".repeat(70));
    verifyResult.rows.forEach((col) => {
      console.log(
        `  • ${col.column_name.padEnd(25)} | ${col.data_type.padEnd(
          15
        )} | Nullable: ${col.is_nullable} | Default: ${col.column_default || "NULL"}`
      );
    });

    console.log("━".repeat(70));
    console.log("\n✅ Migration completed successfully!\n");
  } catch (error) {
    console.error("\n❌ Migration failed:", error.message);
    console.error("\nFull error:", error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

addExternalCallbackFields();
