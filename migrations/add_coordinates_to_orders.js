/**
 * Migration: Add coordinate columns to orders and restaurants tables
 * Run this once to add lat/lng columns for proper map display
 */

require('dotenv').config();
const { pool } = require('../db');

async function migrateCoordinates() {
  try {
    console.log('🔧 Starting coordinate migration...');

    // 1. Add coordinate columns to restaurants table
    console.log('📍 Adding coordinate columns to restaurants table...');
    await pool.query(`
      ALTER TABLE restaurants 
      ADD COLUMN IF NOT EXISTS pos_location VARCHAR(500),
      ADD COLUMN IF NOT EXISTS pos_location_lat NUMERIC(10, 7),
      ADD COLUMN IF NOT EXISTS pos_location_lng NUMERIC(10, 7)
    `);
    console.log('✅ Restaurant coordinate columns added');

    // 2. Add coordinate columns to orders table
    console.log('📍 Adding coordinate columns to orders table...');
    await pool.query(`
      ALTER TABLE orders 
      ADD COLUMN IF NOT EXISTS pickup_lat NUMERIC(10, 7),
      ADD COLUMN IF NOT EXISTS pickup_lng NUMERIC(10, 7),
      ADD COLUMN IF NOT EXISTS delivery_lat NUMERIC(10, 7),
      ADD COLUMN IF NOT EXISTS delivery_lng NUMERIC(10, 7)
    `);
    console.log('✅ Order coordinate columns added');

    // 3. Update HURRY BEY restaurant with correct coordinates
    console.log('🏪 Setting HURRY BEY restaurant coordinates...');
    const hurryBeyResult = await pool.query(`
      UPDATE restaurants 
      SET 
        pos_location = 'HURRY BEY, 4 Eylül, Ortaokul Cd. No:34, 35900 Tire/İzmir',
        pos_location_lat = 38.087224737935394,
        pos_location_lng = 27.728762177138627
      WHERE name LIKE '%HURRY%BEY%' OR name LIKE '%HurryBey%' OR name LIKE '%Hurry Bey%'
      RETURNING id, name
    `);
    
    if (hurryBeyResult.rowCount > 0) {
      console.log(`✅ Updated ${hurryBeyResult.rowCount} restaurant(s):`, hurryBeyResult.rows);
    } else {
      console.log('⚠️  No HURRY BEY restaurant found. Please update manually.');
    }

    console.log('✅ Migration completed successfully!');
    console.log('');
    console.log('📝 Next steps:');
    console.log('   1. Update other restaurants with their coordinates');
    console.log('   2. Restart your backend server');
    console.log('   3. Test the map view in your mobile app');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

// Run migration
migrateCoordinates()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
