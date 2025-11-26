#!/usr/bin/env node
/**
 * Test production database to verify coordinates are correct
 */

process.env.DATABASE_URL = 'postgresql://beypro_user:oIL9KlkjpGYhobN8PBb0ADha1eC6y4nQ@dpg-d22jfm95pdvs7392if0g-a.frankfurt-postgres.render.com/beypro';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function testData() {
  try {
    console.log('🔍 Testing production database...\n');

    // Check restaurant coordinates
    console.log('📍 Restaurant coordinates:');
    const restaurants = await pool.query(`
      SELECT id, name, pos_location, pos_location_lat, pos_location_lng
      FROM restaurants
      WHERE id = 1
      LIMIT 1
    `);
    console.log(restaurants.rows);

    // Check a sample order
    console.log('\n📦 Sample order (most recent):');
    const orders = await pool.query(`
      SELECT id, customer_name, pickup_lat, pickup_lng, delivery_lat, delivery_lng
      FROM orders
      WHERE restaurant_id = 1
      ORDER BY id DESC
      LIMIT 3
    `);
    console.log(orders.rows);

    // Test the actual query the backend uses
    console.log('\n🔍 Testing backend query (simulating /orders/:id):');
    const testOrderId = orders.rows[0]?.id;
    if (testOrderId) {
      const backendQuery = await pool.query(`
        SELECT
          o.*,
          r.name AS restaurant_name,
          r.slug AS restaurant_slug,
          r.logo_url AS restaurant_logo_url,
          r.pos_location AS restaurant_pos_location,
          r.pos_location_lat AS restaurant_pos_location_lat,
          r.pos_location_lng AS restaurant_pos_location_lng
        FROM orders o
        LEFT JOIN restaurants r ON r.id = o.restaurant_id
        WHERE o.id = $1 AND o.restaurant_id = 1
        LIMIT 1
      `, [testOrderId]);

      const record = backendQuery.rows[0];
      console.log(`\nOrder #${testOrderId} backend response would be:`);
      console.log({
        pickup_lat: record.pickup_lat,
        pickup_lng: record.pickup_lng,
        pos_location_lat: record.restaurant_pos_location_lat,
        pos_location_lng: record.restaurant_pos_location_lng,
        delivery_lat: record.delivery_lat,
        delivery_lng: record.delivery_lng,
      });
    }

    console.log('\n✅ Test complete!');
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await pool.end();
  }
}

testData();
