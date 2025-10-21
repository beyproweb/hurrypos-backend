// routes/notifications.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");

router.use(authMiddleware);

/* -------------------------------------------------------------
   🔹 GET tenant-scoped notifications (latest first)
   Example: GET /api/notifications?limit=100
------------------------------------------------------------- */
router.get("/", async (req, res) => {
  const restaurantId = req.user?.restaurant_id;

  if (!restaurantId) {
    return res.status(400).json({ error: "Missing restaurant_id" });
  }

  const limit = parseInt(req.query.limit || "100");

  try {
    const { rows } = await pool.query(
      `
      SELECT id, message, type, stock_id, extra, time
      FROM notifications
      WHERE restaurant_id = $1
      ORDER BY time DESC
      LIMIT $2
      `,
      [restaurantId, limit]
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching notifications:", err);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

/* -------------------------------------------------------------
   🔹 POST new tenant-scoped notification
   Example body:
   { "message": "Stock Low: Fries", "type": "stock", "stock_id": 123 }
------------------------------------------------------------- */
router.post("/", async (req, res) => {
  const restaurantId = req.user?.restaurant_id;
  const { message, type, stock_id, extra } = req.body;

  if (!restaurantId) {
    return res.status(400).json({ error: "Missing restaurant_id" });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO notifications (restaurant_id, message, type, stock_id, extra, time)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
      `,
      [restaurantId, message, type, stock_id, extra ? JSON.stringify(extra) : null]
    );

    console.log(`🔔 New notification for restaurant ${restaurantId}: ${message}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error inserting notification:", err);
    res.status(500).json({ error: "Failed to insert notification" });
  }
});

/* -------------------------------------------------------------
   🔹 Optional: clear old notifications for this tenant
------------------------------------------------------------- */
router.delete("/clear", async (req, res) => {
  const restaurantId = req.user?.restaurant_id;

  if (!restaurantId) {
    return res.status(400).json({ error: "Missing restaurant_id" });
  }

  try {
    await pool.query(`DELETE FROM notifications WHERE restaurant_id = $1`, [restaurantId]);
    console.log(`🧹 Cleared notifications for restaurant ${restaurantId}`);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error clearing notifications:", err);
    res.status(500).json({ error: "Failed to clear notifications" });
  }
});

module.exports = router;
