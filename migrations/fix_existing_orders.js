/**
 * Update existing orders with correct pickup coordinates from restaurant
 */

require('dotenv').config();
const { pool } = require('../db');

async function fixExistingOrders() {
  try {
    console.log('🔧 Fixing existing orders with correct pickup coordinates...');

    // Update all orders to use restaurant coordinates for pickup
    const result = await pool.query(`
      UPDATE orders o
      SET 
        pickup_lat = r.pos_location_lat,
        pickup_lng = r.pos_location_lng
      FROM restaurants r
      WHERE o.restaurant_id = r.id
        AND (o.order_type = 'packet' OR o.order_type = 'phone')
        AND r.pos_location_lat IS NOT NULL
        AND r.pos_location_lng IS NOT NULL
      RETURNING o.id, o.order_type, o.pickup_lat, o.pickup_lng
    `);

    console.log(`✅ Updated ${result.rowCount} orders with restaurant pickup coordinates`);
    if (result.rows.length > 0) {
      console.log('Sample updated orders:');
      result.rows.slice(0, 5).forEach(order => {
        console.log(`   Order #${order.id} (${order.order_type}): ${order.pickup_lat}, ${order.pickup_lng}`);
      });
    }

    // Also update orders that have customer_address but no delivery coordinates
    console.log('\n🔧 Geocoding delivery addresses for existing orders...');
    
    const ordersNeedingGeocode = await pool.query(`
      SELECT id, customer_address, restaurant_id
      FROM orders
      WHERE customer_address IS NOT NULL
        AND customer_address != ''
        AND (delivery_lat IS NULL OR delivery_lng IS NULL)
        AND (order_type = 'packet' OR order_type = 'phone')
      LIMIT 50
    `);

    console.log(`Found ${ordersNeedingGeocode.rowCount} orders needing geocoding`);

    const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!GOOGLE_API_KEY) {
      console.warn('⚠️  No GOOGLE_MAPS_API_KEY found, skipping delivery geocoding');
    } else {
      let geocoded = 0;
      for (const order of ordersNeedingGeocode.rows) {
        try {
          const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
            order.customer_address + ', Turkey'
          )}&key=${GOOGLE_API_KEY}`;
          
          const response = await fetch(geocodeUrl);
          const data = await response.json();
          
          if (data.status === 'OK' && data.results[0]) {
            const lat = data.results[0].geometry.location.lat;
            const lng = data.results[0].geometry.location.lng;
            
            await pool.query(
              'UPDATE orders SET delivery_lat = $1, delivery_lng = $2 WHERE id = $3',
              [lat, lng, order.id]
            );
            
            geocoded++;
            console.log(`   ✅ Order #${order.id}: ${lat}, ${lng}`);
            
            // Rate limit: wait 100ms between requests
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } catch (err) {
          console.warn(`   ⚠️  Failed to geocode order #${order.id}:`, err.message);
        }
      }
      console.log(`✅ Geocoded ${geocoded} delivery addresses`);
    }

    console.log('\n✅ All done! Orders have been updated.');
    console.log('📝 Next: Deploy/restart your backend on Render');

  } catch (error) {
    console.error('❌ Failed to fix orders:', error);
  } finally {
    await pool.end();
  }
}

fixExistingOrders();
