module.exports = function (io) {
  const express = require("express");
  const router = express.Router();
  const { pool } = require("../db");
  const authMiddleware = require("../middleware/authMiddleware");
  const { emitOrderUpdate } = require("../utils/realtime");

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

      const sql = `
        UPDATE orders
        SET driver_status = $1${fields.length ? "," + fields.join(",") : ""}
        WHERE restaurant_id = $2 AND id = $3
      `;
      await pool.query(sql, [driver_status, restaurantId, id]);

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
          o.order_number,
          o.customer_name,
          o.customer_address,
          o.delivery_address,
          o.delivery_lat,
          o.delivery_lng,
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

  // 🆕 POST /api/drivers/calculate-route
  // Calculate total distance and duration for multi-stop routes
  router.post("/calculate-route", async (req, res) => {
    const { waypoints } = req.body;
    if (!waypoints || waypoints.length === 0) {
      return res.status(400).json({ error: "Missing waypoints" });
    }

    try {
      const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
      
      // For multi-stop routes, use first point as origin and last as destination
      // with intermediate points as waypoints
      const origin = `${waypoints[0].lat},${waypoints[0].lng}`;
      const destination = `${waypoints[waypoints.length - 1].lat},${waypoints[waypoints.length - 1].lng}`;
      
      let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(
        origin
      )}&destination=${encodeURIComponent(
        destination
      )}&mode=driving&key=${GOOGLE_API_KEY}`;
      
      // Add intermediate waypoints
      if (waypoints.length > 2) {
        const intermediateWaypoints = waypoints
          .slice(1, -1)
          .map((wp) => `${wp.lat},${wp.lng}`)
          .join("|");
        url += `&waypoints=${encodeURIComponent(intermediateWaypoints)}`;
      }

      const result = await fetch(url);
      const data = await result.json();

      if (data.status !== "OK" || !data.routes || data.routes.length === 0) {
        console.warn("⚠️ Google Directions API returned:", data.status);
        // Fallback estimation
        return res.json({
          distance: waypoints.length * 2,
          duration: Math.ceil((waypoints.length * 2) / 30) * 60 + waypoints.length * 3,
        });
      }

      const route = data.routes[0];
      const distance = (route.legs.reduce((sum, leg) => sum + leg.distance.value, 0) / 1000).toFixed(2); // km
      const duration = Math.ceil(route.legs.reduce((sum, leg) => sum + leg.duration.value, 0) / 60); // minutes

      console.log(`✅ Route calculated: ${distance} km, ${duration} min`);
      res.json({
        distance: parseFloat(distance),
        duration,
      });
    } catch (err) {
      console.error("❌ Route calculation failed:", err);
      // Fallback estimation
      const { waypoints } = req.body;
      const estimatedDistance = waypoints.length * 2;
      const estimatedDuration = Math.ceil(estimatedDistance / 30) * 60;
      res.json({
        distance: estimatedDistance,
        duration: estimatedDuration,
      });
    }
  });

  router.get("/google-directions", async (req, res) => {
    const { origin, destination, waypoints, language, traffic } = req.query;
    if (!origin || !destination)
      return res.status(400).json({ error: "Missing origin/destination" });
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(
      origin
    )}&destination=${encodeURIComponent(
      destination
    )}&mode=driving&key=${GOOGLE_API_KEY}`;
    if (waypoints) url += `&waypoints=${encodeURIComponent(waypoints)}`;
    if (language) url += `&language=${encodeURIComponent(language)}`;

    // If traffic param is truthy, request traffic-aware ETA by setting departure_time and traffic_model
    // departure_time expects seconds since epoch
    if (String(traffic).toLowerCase() === "true") {
      const departure = Math.floor(Date.now() / 1000);
      url += `&departure_time=${departure}&traffic_model=best_guess`;
    }

    try {
      const result = await fetch(url);
      const data = await result.json();
      res.json(data);
    } catch (e) {
      console.error("❌ Failed to fetch directions:", e);
      res.status(500).json({ error: "Failed to fetch directions" });
    }
  });

  return router;
};
