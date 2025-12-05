#!/usr/bin/env node

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    require: true,
    rejectUnauthorized: false,
  },
});

async function checkOrdersSchema() {
  try {
    console.log('\n📋 Checking ORDERS table schema...\n');
    
    // Get all columns from orders table
    const query = `
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'orders'
      ORDER BY ordinal_position;
    `;
    
    const result = await pool.query(query);
    
    if (result.rows.length === 0) {
      console.log('❌ No columns found for "orders" table');
      return;
    }
    
    console.log('✅ ORDERS Table Columns:');
    console.log('━'.repeat(70));
    
    result.rows.forEach(col => {
      const nullable = col.is_nullable === 'YES' ? '(nullable)' : '(NOT NULL)';
      console.log(`  • ${col.column_name.padEnd(20)} | ${col.data_type.padEnd(15)} | ${nullable}`);
    });
    
    console.log('━'.repeat(70));
    console.log(`\nTotal columns: ${result.rows.length}\n`);
    
    // Check if specific columns exist
    const hasColumns = {
      tax_value: result.rows.some(c => c.column_name === 'tax_value'),
      discount_value: result.rows.some(c => c.column_name === 'discount_value'),
      tax_amount: result.rows.some(c => c.column_name === 'tax_amount'),
      discount_amount: result.rows.some(c => c.column_name === 'discount_amount'),
      tax: result.rows.some(c => c.column_name === 'tax'),
      discount: result.rows.some(c => c.column_name === 'discount'),
    };
    
    console.log('🔍 Column Existence Check:');
    console.log('━'.repeat(70));
    console.log(`  • tax_value: ${hasColumns.tax_value ? '✅ EXISTS' : '❌ MISSING'}`);
    console.log(`  • discount_value: ${hasColumns.discount_value ? '✅ EXISTS' : '❌ MISSING'}`);
    console.log(`  • tax_amount: ${hasColumns.tax_amount ? '✅ EXISTS' : '❌ MISSING'}`);
    console.log(`  • discount_amount: ${hasColumns.discount_amount ? '✅ EXISTS' : '❌ MISSING'}`);
    console.log(`  • tax: ${hasColumns.tax ? '✅ EXISTS' : '❌ MISSING'}`);
    console.log(`  • discount: ${hasColumns.discount ? '✅ EXISTS' : '❌ MISSING'}`);
    console.log('━'.repeat(70));
    
    // Check sample data
    console.log('\n📊 Sample Order Data:');
    const sampleQuery = `SELECT * FROM orders LIMIT 1;`;
    const sampleResult = await pool.query(sampleQuery);
    if (sampleResult.rows.length > 0) {
      console.log(JSON.stringify(sampleResult.rows[0], null, 2));
    } else {
      console.log('No orders found in database');
    }
    
    await pool.end();
    
  } catch (error) {
    console.error('❌ Database Error:', error.message);
    process.exit(1);
  }
}

checkOrdersSchema();
