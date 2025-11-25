/**
 * Update restaurant coordinates manually
 */

require('dotenv').config();
const { pool } = require('../db');

async function updateRestaurantCoordinates() {
  try {
    console.log('🔧 Updating restaurant coordinates...');

    // List all restaurants first
    const restaurants = await pool.query('SELECT id, name, pos_location_lat, pos_location_lng FROM restaurants');
    console.log('\n📋 Current restaurants:');
    restaurants.rows.forEach(r => {
      console.log(`   ID: ${r.id}, Name: ${r.name}, Coords: ${r.pos_location_lat}, ${r.pos_location_lng}`);
    });

    // Update Hurrybey restaurant (ID 1)
    const hurryBeyRestaurant = restaurants.rows.find(r => r.name === 'Hurrybey' || r.id === 1);
    if (hurryBeyRestaurant) {
      const restaurantId = hurryBeyRestaurant.id;
      console.log(`\n🏪 Updating restaurant ID ${restaurantId} (${hurryBeyRestaurant.name})...`);
      
      const result = await pool.query(`
        UPDATE restaurants 
        SET 
          pos_location = 'HURRY BEY, 4 Eylül, Ortaokul Cd. No:34, 35900 Tire/İzmir',
          pos_location_lat = 38.087224737935394,
          pos_location_lng = 27.728762177138627
        WHERE id = $1
        RETURNING id, name, pos_location, pos_location_lat, pos_location_lng
      `, [restaurantId]);
      
      console.log('✅ Updated restaurant:', result.rows[0]);
    }

    console.log('\n✅ Done!');
  } catch (error) {
    console.error('❌ Update failed:', error);
  } finally {
    await pool.end();
  }
}

updateRestaurantCoordinates();
