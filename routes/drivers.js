module.exports = function (io) {
  const express = require("express");
  const router = express.Router();
  const { pool } = require("../db");
  const authMiddleware = require("../middleware/authMiddleware");
  const { emitOrderUpdate, emitDriverOnRoad } = require("../utils/realtime");

  // ✅ Safe Redis handling — disable when not configured
  let redis = null;
  try {
    if (process.env.REDIS_URL) {
      redis = require("../utils/redis");
      console.log("✅ Redis enabled for driver locations");
    } else {
      console.log("⚠️ Redis not configured — using in-memory driver location store");
    }
  } catch (err) {
    console.warn("⚠️ Redis initialization failed, using memory:", err.message);
    redis = null;
  }

  // 🔒 apply tenant auth to all routes
  router.use(authMiddleware);

  // PATCH /api/drivers/orders/:id/driver-status
  router.patch("/orders/:id/driver-status", async (req, res) => {
    const { id } = req.params;
    const { driver_status } = req.body;
    const restaurantId = req.user.restaurant_id;

    try {
      const fields = [];
      if (driver_status === "picked_up") fields.push("picked_up_at = NOW()");
      if (driver_status === "delivered") fields.push("delivered_at = NOW()");

      // Fetch order details for notification
      const orderResult = await pool.query(
        `SELECT id, customer_name, order_type FROM orders WHERE restaurant_id = $1 AND id = $2`,
        [restaurantId, id]
      );
      const order = orderResult.rows[0];

      const sql = `
        UPDATE orders
        SET driver_status = $1${fields.length ? "," + fields.join(",") : ""}
        WHERE restaurant_id = $2 AND id = $3
      `;
      await pool.query(sql, [driver_status, restaurantId, id]);

      // Emit notification when driver is on road
      if (driver_status === "on_road" && order) {
        emitDriverOnRoad(io, restaurantId, Number(id), {
          customer_name: order.customer_name,
        });
      }

      emitOrderUpdate(io, restaurantId);
      res.json({ success: true });
    } catch (err) {
      console.error("❌ Update driver status failed:", err);
      res.status(500).json({ error: "Update failed" });
    }
  });

  // POST /api/drivers/orders/:id/close
  router.post("/orders/:id/close", async (req, res) => {
    const { id } = req.params;
    const restaurantId = req.user.restaurant_id;
    try {
      await pool.query(
        `UPDATE orders SET status = 'closed'
         WHERE restaurant_id = $1 AND id = $2`,
        [restaurantId, id]
      );
      emitOrderUpdate(io, restaurantId);
      res.json({ success: true });
    } catch (err) {
      console.error("❌ Close order failed:", err);
      res.status(500).json({ error: "Close failed" });
    }
  });

  // In-memory driver locations (could later move to Redis)
  const driverLocations = {};

  // Utility: decode an encoded polyline string (Google format)
  // Returns array of [lat, lng]
  function decodePolyline(encoded) {
    if (!encoded || typeof encoded !== 'string') return [];
    let index = 0;
    const len = encoded.length;
    const path = [];
    let lat = 0;
    let lng = 0;

    while (index < len) {
      let result = 0;
      let shift = 0;
      let b;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlat = (result & 1) ? ~(result >> 1) : result >> 1;
      lat += dlat;

      result = 0;
      shift = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlng = (result & 1) ? ~(result >> 1) : result >> 1;
      lng += dlng;

      path.push([lat / 1e5, lng / 1e5]);
    }
    return path;
  }

  router.post("/location", async (req, res) => {
  const { driver_id, lat, lng } = req.body;
  if (!driver_id || !lat || !lng)
    return res.status(400).json({ error: "Missing fields" });
  const key = `driver:${req.user.restaurant_id}:${driver_id}`;
  const value = JSON.stringify({ lat, lng, timestamp: Date.now() });

  if (redis) await redis.set(key, value, "EX", 600);
  else driverLocations[key] = value;

  res.json({ status: "ok" });
});

router.get("/location/:driver_id", async (req, res) => {
  const { driver_id } = req.params;
  const key = `driver:${req.user.restaurant_id}:${driver_id}`;

  let data;
  if (redis) data = await redis.get(key);
  else data = driverLocations[key];

  if (!data) return res.status(404).json({ error: "No location for driver" });
  res.json(JSON.parse(data));
});




  // POST /api/drivers/orders/:id/claim-driver
  router.post("/orders/:id/claim-driver", async (req, res) => {
    const { id } = req.params;
    const { driver_id } = req.body;

    // Debug authentication
    console.log("📍 Claim driver endpoint called:", {
      orderId: id,
      driverId: driver_id,
      user: req.user ? { id: req.user.id, role: req.user.role, restaurant_id: req.user.restaurant_id } : null,
    });

    if (!driver_id)
      return res.status(400).json({ error: "Missing driver_id" });

    const restaurantId = req.user?.restaurant_id;
    if (!restaurantId) {
      return res.status(401).json({ error: "Missing restaurant context - authentication failed" });
    }

    try {
      const isAdmin = req.user.role === "admin" || req.user.is_admin;

      // First, verify the order exists and belongs to this restaurant
      const orderCheck = await pool.query(
        `SELECT id, driver_id, restaurant_id FROM orders WHERE id = $1`,
        [id]
      );

      if (orderCheck.rowCount === 0) {
        console.log("❌ Order not found:", id);
        return res.status(404).json({ error: "Order not found" });
      }

      const order = orderCheck.rows[0];
      console.log("📋 Order found:", { id: order.id, driver_id: order.driver_id, restaurant_id: order.restaurant_id });

      if (!isAdmin) {
        if (order.restaurant_id !== restaurantId) {
          console.log("❌ Order restaurant mismatch:", { orderRestaurant: order.restaurant_id, userRestaurant: restaurantId });
          return res.status(403).json({ error: "Order does not belong to your restaurant" });
        }
      }

      if (order.driver_id !== null) {
        console.log("❌ Order already has driver:", order.driver_id);
        return res.status(409).json({ error: "Order already claimed by another driver" });
      }

      const result = await pool.query(
        `UPDATE orders
         SET driver_id = $1
         WHERE id = $2
           AND driver_id IS NULL
         RETURNING *`,
        [driver_id, id]
      );

      if (result.rowCount === 0) {
        console.log("❌ Update failed - order already claimed");
        return res.status(409).json({ error: "Order was already claimed" });
      }

      console.log("✅ Order claimed successfully:", { orderId: id, driverId: driver_id });
      emitOrderUpdate(io, restaurantId);
      res.json(result.rows[0]);
    } catch (err) {
      console.error("❌ Error claiming order:", {
        error: err.message,
        stack: err.stack,
        code: err.code,
      });
      res.status(500).json({ error: "Failed to claim order", details: err.message });
    }
  });

  // 🆕 GET /api/drivers/:id/active-orders
  // Fetch all active/pending orders assigned to a driver for multi-stop route display
  // Returns orders with pos_location (pickup) and delivery info
  router.get("/:id/active-orders", async (req, res) => {
    const { id: driverId } = req.params;
    const restaurantId = req.user?.restaurant_id;

    if (!restaurantId) {
      return res.status(401).json({ error: "Missing restaurant context" });
    }

    if (!driverId) {
      return res.status(400).json({ error: "Missing driver_id" });
    }

    try {
      // Query orders assigned to this driver that are not yet delivered or closed
      const query = `
        SELECT 
          o.id,
          o.id as order_number,
          o.customer_name,
          o.customer_address,
          o.customer_address AS delivery_address,
          NULL::numeric AS delivery_lat,
          NULL::numeric AS delivery_lng,
          o.driver_id,
          o.driver_status,
          o.status,
          o.estimated_delivery_time,
          o.created_at,
          p.name as pos_name,
          p.latitude as pos_location_lat,
          p.longitude as pos_location_lng,
          p.address as pos_location
        FROM orders o
        LEFT JOIN point_of_sale p ON o.restaurant_id = p.id
        WHERE o.restaurant_id = $1
          AND o.driver_id = $2
          AND o.status NOT IN ('closed', 'cancelled')
          AND (o.driver_status IS NULL OR o.driver_status NOT IN ('delivered'))
        ORDER BY o.created_at ASC
      `;

      const result = await pool.query(query, [restaurantId, driverId]);

      if (result.rowCount === 0) {
        console.log(`ℹ️ No active orders found for driver ${driverId}`);
        return res.json([]);
      }

      console.log(`✅ Found ${result.rowCount} active orders for driver ${driverId}`);

      // Transform the results to match the frontend expectation
      const orders = result.rows.map(row => ({
        id: row.id,
        order_number: row.order_number,
        customer_name: row.customer_name,
        customer_address: row.customer_address,
        delivery_address: row.delivery_address,
        delivery_lat: row.delivery_lat ? parseFloat(row.delivery_lat) : null,
        delivery_lng: row.delivery_lng ? parseFloat(row.delivery_lng) : null,
        driver_id: row.driver_id,
        driver_status: row.driver_status,
        status: row.status,
        estimated_arrival: row.estimated_delivery_time ? Math.round((new Date(row.estimated_delivery_time) - new Date()) / 60000) : undefined,
        // Pickup location info (for multi-stop routes)
        pos_name: row.pos_name,
        pos_location: row.pos_location,
        pos_location_lat: row.pos_location_lat ? parseFloat(row.pos_location_lat) : null,
        pos_location_lng: row.pos_location_lng ? parseFloat(row.pos_location_lng) : null,
        restaurant_id: restaurantId,
        created_at: row.created_at,
      }));

      res.json(orders);
    } catch (err) {
      console.error("❌ Failed to fetch active orders for driver:", err);
      res.status(500).json({ error: "Failed to fetch orders", details: err.message });
    }
  });

  // Google APIs — use server-side key securely
  router.get("/geocode", async (req, res) => {
    const address = req.query.q;
    if (!address) return res.status(400).json({ error: "Missing address" });
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        address
      )}, Turkey&key=${GOOGLE_API_KEY}`;
      const geoRes = await fetch(url);
      const geoData = await geoRes.json();
      if (!geoData.results?.length)
        return res.status(404).json({ error: "No results" });
      const loc = geoData.results[0].geometry.location;
      res.json({ lat: loc.lat, lng: loc.lng });
    } catch (err) {
      console.error("Geocode failed:", err);
      res.status(500).json({ error: "Geocode failed" });
    }
  });

  router.get("/google-directions", async (req, res) => {
    const { origin, destination, waypoints } = req.query;
    if (!origin || !destination)
      return res.status(400).json({ error: "Missing origin/destination" });

    try {
      // Parse origin and destination (format: "lat,lng")
      const [originLat, originLng] = origin.split(',').map(Number);
      const [destLat, destLng] = destination.split(',').map(Number);

      if (!Number.isFinite(originLat) || !Number.isFinite(originLng) || 
          !Number.isFinite(destLat) || !Number.isFinite(destLng)) {
        return res.status(400).json({ error: "Invalid coordinates" });
      }

      // Build OSRM URL (free, open-source routing)
      // Format: /route/v1/driving/lng1,lat1;lng2,lat2
      let osrmUrl = `https://router.project-osrm.org/route/v1/driving/${originLng},${originLat};${destLng},${destLat}?overview=full&geometries=geojson`;

      // Add waypoints if provided (format: "lat1,lng1|lat2,lng2|...")
      if (waypoints) {
        const wpArray = waypoints.split('|').map(wp => {
          const [lat, lng] = wp.split(',').map(Number);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            return `${lng},${lat}`;
          }
          return null;
        }).filter(Boolean);
        
        if (wpArray.length > 0) {
          osrmUrl = `https://router.project-osrm.org/route/v1/driving/${originLng},${originLat};${wpArray.join(';')};${destLng},${destLat}?overview=full&geometries=geojson`;
        }
      }

      const result = await fetch(osrmUrl);
      const data = await result.json();

      if (data.code !== "Ok" || !data.routes || !data.routes[0]) {
        console.warn("⚠️ OSRM routing failed:", data.code || "Unknown error");
        return res.json({
          decoded_polyline: [],
          distance: 0,
          duration: 0,
          error: "No route found",
        });
      }

      const route = data.routes[0];
      
      // Convert OSRM GeoJSON coordinates to {lat, lng} array
      const decoded_polyline = (route.geometry && route.geometry.coordinates)
        ? route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }))
        : [];

      const distance = route.distance / 1000; // km
      const duration = Math.ceil(route.duration / 60); // minutes

      console.log(`✅ OSRM route: ${distance.toFixed(1)} km, ${duration} min, ${decoded_polyline.length} points`);

      res.json({
        decoded_polyline,
        distance: parseFloat(distance.toFixed(2)),
        duration,
        routes: [{
          overview_polyline: { points: "dummy" },
          legs: [],
          distance: { value: route.distance },
          duration: { value: route.duration },
        }],
      });
    } catch (err) {
      console.error("❌ Routing failed:", err && err.message);
      res.json({
        decoded_polyline: [],
        distance: 0,
        duration: 0,
        error: err && err.message,
      });
    }
  });

  // 🆕 POST /api/drivers/optimize-route
  // Optimize multi-stop route using OSRM Table API (Traveling Salesman Problem)
  // Reorders stops for fastest/shortest total distance
  router.post("/optimize-route", async (req, res) => {
    const { waypoints } = req.body;
    if (!waypoints || waypoints.length < 2) {
      return res.status(400).json({ error: "Need at least 2 waypoints" });
    }

    try {
      // Build OSRM Table API URL to get distance matrix
      const coordinates = waypoints.map(wp => `${wp.lng},${wp.lat}`).join(';');
      const tableUrl = `https://router.project-osrm.org/table/v1/driving/${coordinates}?annotations=distance,duration`;

      const result = await fetch(tableUrl);
      const data = await result.json();

      if (data.code !== "Ok" || !data.distances) {
        console.warn("⚠️ OSRM Table API failed:", data.code);
        return res.json({ optimized_order: waypoints.map((_, i) => i), message: "Could not optimize" });
      }

      // Nearest-neighbor TSP solver: start at first stop, always go to nearest unvisited stop
      const distances = data.distances;
      const n = waypoints.length;
      const visited = new Array(n).fill(false);
      const order = [0]; // Start at first stop (restaurant)
      visited[0] = true;

      let current = 0;
      for (let i = 1; i < n; i++) {
        let nearest = -1;
        let minDist = Infinity;

        for (let j = 0; j < n; j++) {
          if (!visited[j] && distances[current][j] < minDist) {
            minDist = distances[current][j];
            nearest = j;
          }
        }

        if (nearest !== -1) {
          order.push(nearest);
          visited[nearest] = true;
          current = nearest;
        }
      }

      // Reorder waypoints by the optimized order
      const optimized_waypoints = order.map(idx => ({
        ...waypoints[idx],
        original_index: idx,
      }));

      // Calculate total distance and duration for the optimized route
      let totalDist = 0;
      let totalDur = 0;
      for (let i = 0; i < order.length - 1; i++) {
        totalDist += distances[order[i]][order[i + 1]];
        totalDur += data.durations[order[i]][order[i + 1]];
      }

      console.log(`✅ Optimized route: ${(totalDist / 1000).toFixed(1)} km, ${Math.ceil(totalDur / 60)} min`);
      res.json({
        optimized_waypoints,
        optimized_order: order,
        total_distance: (totalDist / 1000).toFixed(2),
        total_duration: Math.ceil(totalDur / 60),
      });
    } catch (err) {
      console.error("❌ Route optimization failed:", err && err.message);
      res.status(500).json({ error: "Optimization failed", details: err && err.message });
    }
  });

  return router;
};
