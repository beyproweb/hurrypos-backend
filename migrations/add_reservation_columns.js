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

async function addReservationColumns() {
  const client = await pool.connect();
  try {
    console.log('\n🔄 Running migration: Add reservation columns to orders...\n');

    // Check if columns already exist
    const checkQuery = `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'orders' 
      AND column_name IN ('reservation_date', 'reservation_time', 'reservation_clients', 'reservation_notes')
      ORDER BY column_name;
    `;
    
    const checkResult = await client.query(checkQuery);
    const existingCols = checkResult.rows.map(r => r.column_name);
    
    if (existingCols.length === 4) {
      console.log('✅ All reservation columns already exist');
      console.log('━'.repeat(70));
      await pool.end();
      return;
    }

    console.log(`📍 Found ${existingCols.length}/4 columns. Adding missing ones...\n`);

    // Add reservation_date column if missing
    if (!existingCols.includes('reservation_date')) {
      await client.query(`
        ALTER TABLE orders
        ADD COLUMN reservation_date DATE;
      `);
      console.log('✅ Added reservation_date column (DATE)');
    }

    // Add reservation_time column if missing
    if (!existingCols.includes('reservation_time')) {
      await client.query(`
        ALTER TABLE orders
        ADD COLUMN reservation_time TIME;
      `);
      console.log('✅ Added reservation_time column (TIME)');
    }

    // Add reservation_clients column if missing
    if (!existingCols.includes('reservation_clients')) {
      await client.query(`
        ALTER TABLE orders
        ADD COLUMN reservation_clients INTEGER DEFAULT 0;
      `);
      console.log('✅ Added reservation_clients column (INTEGER, DEFAULT 0)');
    }

    // Add reservation_notes column if missing
    if (!existingCols.includes('reservation_notes')) {
      await client.query(`
        ALTER TABLE orders
        ADD COLUMN reservation_notes TEXT;
      `);
      console.log('✅ Added reservation_notes column (TEXT)');
    }

    // Verify columns were added
    const verifyQuery = `
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'orders' 
      AND column_name IN ('reservation_date', 'reservation_time', 'reservation_clients', 'reservation_notes')
      ORDER BY column_name;
    `;
    
    const verifyResult = await client.query(verifyQuery);
    console.log('\n✅ Verification - New columns:');
    console.log('━'.repeat(70));
    verifyResult.rows.forEach(col => {
      console.log(`  • ${col.column_name.padEnd(25)} | ${col.data_type.padEnd(15)} | Nullable: ${col.is_nullable} | Default: ${col.column_default || 'NULL'}`);
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

addReservationColumns();
