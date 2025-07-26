  module.exports = function(io) {
  const express = require('express');
  const router = express.Router();
  const { pool } = require("../db");


  const { emitAlert, emitStockUpdate,emitOrderUpdate,emitOrderConfirmed } = require('../utils/realtime');





router.patch("/orders/:id/driver-status", async (req, res) => {
  const { id } = req.params;
  const { driver_status } = req.body;

  try {
    if (driver_status === "picked_up") {
      await pool.query(
        `UPDATE orders SET driver_status = $1, picked_up_at = NOW() WHERE id = $2`,
        [driver_status, id]
      );
    } else if (driver_status === "delivered") {
      await pool.query(
        `UPDATE orders SET driver_status = $1, delivered_at = NOW() WHERE id = $2`,
        [driver_status, id]
      );
    } else {
      await pool.query(
        `UPDATE orders SET driver_status = $1 WHERE id = $2`,
        [driver_status, id]
      );
    }
    io.emit("orders_updated");
    res.json({ success: true });

  } catch (err) {
    console.error("❌ Update driver status failed:", err);
    res.status(500).json({ error: "Update failed" });
  }
});


router.post("/orders/:id/close", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(
      `UPDATE orders SET status = 'closed' WHERE id = $1`,
      [id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Close order failed:", err);
    res.status(500).json({ error: "Close failed" });
  }
});

// Store latest location in-memory (for demo; use Redis for production!)
const driverLocations = {};

// POST /api/drivers/location -- Update location (for tracking)
router.post('/location', (req, res) => {
  const { driver_id, lat, lng } = req.body;
  if (!driver_id || !lat || !lng) return res.status(400).json({ error: 'Missing fields' });
  driverLocations[driver_id] = { lat, lng, timestamp: Date.now() };
  res.json({ status: 'ok' });
});

// GET /api/drivers/location/:driver_id -- Fetch last known location
router.get('/location/:driver_id', (req, res) => {
  const { driver_id } = req.params;
  const loc = driverLocations[driver_id];
  if (!loc) return res.status(404).json({ error: 'No location for driver' });
  res.json(loc);
});


// POST /orders/:id/claim-driver
router.post("/orders/:id/claim-driver", async (req, res) => {
  const { id } = req.params;
  const { driver_id } = req.body;

  if (!driver_id) {
    return res.status(400).json({ error: "Missing driver_id" });
  }

  try {
    // Only claim if not already assigned
    const result = await pool.query(
      `UPDATE orders
       SET driver_id = $1
       WHERE id = $2 AND driver_id IS NULL
       RETURNING *`,
      [driver_id, id]
    );

    if (result.rowCount === 0) {
      console.log(`🚫 Order ${id} already claimed by another driver.`);
      return res.status(409).json({ error: "Already claimed" });
    }

    // Emit to all clients that orders changed!
    emitOrderUpdate(io);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error claiming order:", err);
    res.status(500).json({ error: "Failed to claim order" });
  }
});


router.get("/api/geocode", async (req, res) => {
  const address = req.query.q;
  if (!address) return res.status(400).json({ error: "Missing address" });

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}, Turkey&key=${GOOGLE_API_KEY}`;
    const geoRes = await fetch(url);
    const geoData = await geoRes.json();
    if (!geoData.results || !geoData.results.length) {
      return res.status(404).json({ error: "No results" });
    }
    const loc = geoData.results[0].geometry.location;
    res.json({ lat: loc.lat, lng: loc.lng });
  } catch (err) {
    console.error("Geocode failed:", err);
    res.status(500).json({ error: "Geocode failed" });
  }
});

router.get("/api/google-directions", async (req, res) => {
  const { origin, destination, waypoints } = req.query;
  if (!origin || !destination) return res.status(400).json({ error: "Missing origin/destination" });

  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&mode=driving&key=${GOOGLE_API_KEY}`;
  if (waypoints) url += `&waypoints=${encodeURIComponent(waypoints)}`;

  try {
    const result = await fetch(url);
    const data = await result.json();
    res.json(data);
  } catch (e) {
    console.error("❌ Failed to fetch directions:", e);  // <---- ADD THIS LINE
    res.status(500).json({ error: "Failed to fetch directions" });
  }
});


return router;
};