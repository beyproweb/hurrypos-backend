const express = require("express");
const router = express.Router();
const pool = require("../db"); // adjust path if needed

// Get the latest N notifications
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM notifications ORDER BY time DESC LIMIT 100"
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching notifications:", err);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// Add a new notification
router.post("/", async (req, res) => {
  const { message, type, stock_id, extra } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO notifications (message, type, stock_id, extra)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [message, type, stock_id, extra ? JSON.stringify(extra) : null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error inserting notification:", err);
    res.status(500).json({ error: "Failed to insert notification" });
  }
});


// Optionally: delete/clear old notifications, etc.

module.exports = router;
