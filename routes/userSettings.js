// routes/userSettings.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");

// ✅ Require authentication for all settings routes
router.use(authMiddleware);

/* ------------------------------------------------------------------
   🔹 Save or update user settings (e.g. roles, permissions, appearance)
   This route handles dynamic sections like:
   POST /api/settings/users
   POST /api/settings/appearance
------------------------------------------------------------------ */
router.post("/:section", async (req, res) => {
  const section = req.params.section; // e.g. "users"
  const restaurantId = req.user?.restaurant_id || req.body.restaurant_id;
  const settings = req.body;

  if (!restaurantId) {
    return res.status(400).json({ error: "restaurant_id is required" });
  }

  try {
    await pool.query(
      `
      INSERT INTO user_settings (restaurant_id, section, settings)
      VALUES ($1, $2, $3)
      ON CONFLICT (restaurant_id, section)
      DO UPDATE SET settings = EXCLUDED.settings
      `,
      [restaurantId, section, JSON.stringify(settings)]
    );

    console.log(`✅ Saved ${section} settings for restaurant ${restaurantId}`);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to save settings:", err);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

/* ------------------------------------------------------------------
   🔹 Fetch specific settings (tenant-safe)
   GET /api/settings/users
   GET /api/settings/appearance
------------------------------------------------------------------ */
router.get("/:section", async (req, res) => {
  const section = req.params.section;
  const restaurantId = req.user?.restaurant_id || req.query.restaurant_id;

  if (!restaurantId) {
    return res.status(400).json({ error: "restaurant_id is required" });
  }

  try {
    const result = await pool.query(
      `
      SELECT settings
      FROM user_settings
      WHERE restaurant_id = $1 AND section = $2
      `,
      [restaurantId, section]
    );

    res.json(result.rows[0]?.settings || {});
  } catch (err) {
    console.error("❌ Failed to fetch settings:", err);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

/* ------------------------------------------------------------------
   🔹 Optional: delete a section (used for deleting a role group)
   DELETE /api/settings/roles/:role
------------------------------------------------------------------ */
router.delete("/roles/:role", async (req, res) => {
  const restaurantId = req.user?.restaurant_id;
  const roleToDelete = req.params.role.toLowerCase();

  if (!restaurantId) {
    return res.status(400).json({ error: "restaurant_id is required" });
  }

  try {
    const result = await pool.query(
      `
      SELECT settings
      FROM user_settings
      WHERE restaurant_id = $1 AND section = 'users'
      `,
      [restaurantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "No user settings found" });
    }

    const settings = result.rows[0].settings;
    if (settings.roles && settings.roles[roleToDelete]) {
      delete settings.roles[roleToDelete];
      await pool.query(
        `
        UPDATE user_settings
        SET settings = $3
        WHERE restaurant_id = $1 AND section = 'users'
        `,
        [restaurantId, "users", JSON.stringify(settings)]
      );
      console.log(`🗑️ Deleted role '${roleToDelete}' for restaurant ${restaurantId}`);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to delete role:", err);
    res.status(500).json({ error: "Failed to delete role" });
  }
});

module.exports = router;
