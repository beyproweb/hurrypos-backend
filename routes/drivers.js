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
    const restaurantId = req.user.restaurant_id;

    if (!driver_id)
      return res.status(400).json({ error: "Missing driver_id" });

    try {
      const restaurantId = req.user.restaurant_id;
const isAdmin = req.user.role === "admin" || req.user.is_admin;

const result = await pool.query(
  `UPDATE orders
   SET driver_id = $1
   WHERE id = $2
     AND (driver_id IS NULL)
     ${isAdmin ? "" : "AND restaurant_id = $3"}
   RETURNING *`,
   isAdmin ? [driver_id, id] : [driver_id, id, restaurantId]
);


      if (result.rowCount === 0)
        return res.status(409).json({ error: "Already claimed" });

      emitOrderUpdate(io, restaurantId);
      res.json(result.rows[0]);
    } catch (err) {
      console.error("❌ Error claiming order:", err);
      res.status(500).json({ error: "Failed to claim order" });
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
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(
      origin
    )}&destination=${encodeURIComponent(
      destination
    )}&mode=driving&key=${GOOGLE_API_KEY}`;
    if (waypoints) url += `&waypoints=${encodeURIComponent(waypoints)}`;
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
