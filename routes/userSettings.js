// In routes/userSettings.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// GET user appearance settings
router.get("/:userId/appearance", async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      `SELECT appearance FROM user_settings WHERE user_id = $1`,
      [userId]
    );
    res.json(result.rows[0]?.appearance || {});
  } catch (err) {
    console.error("❌ Failed to fetch user appearance:", err);
    res.status(500).json({ error: "Failed to fetch user appearance" });
  }
});

// POST user appearance settings
router.post("/:userId/appearance", async (req, res) => {
  const { userId } = req.params;
  const appearance = req.body;
  try {
    await pool.query(
      `INSERT INTO user_settings (user_id, appearance)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET appearance = $2`,
      [userId, JSON.stringify(appearance)]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to save user appearance:", err);
    res.status(500).json({ error: "Failed to save user appearance" });
  }
});

module.exports = router;
