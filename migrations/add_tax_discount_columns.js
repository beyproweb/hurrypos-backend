#!/usr/bin/env node

require('dotenv').config();
const { Pool } = require('pg');

// Determine connection type based on DATABASE_URL
const isProduction = process.env.DATABASE_URL?.includes('render.com');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(isProduction && {
    ssl: {
      require: true,
      rejectUnauthorized: false,
    },
  }),
});

async function addTaxDiscountColumns() {
  const client = await pool.connect();
  try {
    console.log('\n🔄 Running migration: Add tax and discount columns to orders...\n');

    // Check if columns already exist
    const checkQuery = `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'orders' 
      AND column_name IN ('tax_value', 'discount_value')
      ORDER BY column_name;
    `;
    
    const checkResult = await client.query(checkQuery);
    const existingCols = checkResult.rows.map(r => r.column_name);
    
    if (existingCols.length === 2) {
      console.log('✅ Both tax_value and discount_value columns already exist');
      console.log('━'.repeat(70));
      await pool.end();
      return;
    }

    console.log(`📍 Found ${existingCols.length}/2 columns. Adding missing ones...\n`);

    // Add tax_value column if missing
    if (!existingCols.includes('tax_value')) {
      await client.query(`
        ALTER TABLE orders
        ADD COLUMN tax_value NUMERIC(10, 2) DEFAULT 0;
      `);
      console.log('✅ Added tax_value column (NUMERIC(10,2), DEFAULT 0)');
    }

    // Add discount_value column if missing
    if (!existingCols.includes('discount_value')) {
      await client.query(`
        ALTER TABLE orders
        ADD COLUMN discount_value NUMERIC(10, 2) DEFAULT 0;
      `);
      console.log('✅ Added discount_value column (NUMERIC(10,2), DEFAULT 0)');
    }

    // Verify columns were added
    const verifyQuery = `
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_name = 'orders' 
      AND column_name IN ('tax_value', 'discount_value')
      ORDER BY column_name;
    `;
    
    const verifyResult = await client.query(verifyQuery);
    console.log('\n✅ Verification - New columns:');
    console.log('━'.repeat(70));
    verifyResult.rows.forEach(col => {
      console.log(`  • ${col.column_name.padEnd(20)} | ${col.data_type.padEnd(15)} | Default: ${col.column_default}`);
    });

    console.log('━'.repeat(70));
    console.log('\n✅ Migration completed successfully!\n');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

addTaxDiscountColumns();
