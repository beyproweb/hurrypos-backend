const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");

function normalizePlan(plan) {
  const p = String(plan || "").trim().toLowerCase();
  return p === "basic" || p === "pro" || p === "enterprise" ? p : "basic";
}

let internalSettingsReady = null;
async function ensureInternalSettingsTable() {
  if (!internalSettingsReady) {
    internalSettingsReady = (async () => {
      await pool.query(
        `
        CREATE TABLE IF NOT EXISTS internal_settings (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        `
      );
      await pool.query(
        `
        CREATE INDEX IF NOT EXISTS internal_settings_updated_at_idx
          ON internal_settings (updated_at DESC)
        `
      );
    })().catch((err) => {
      internalSettingsReady = null;
      throw err;
    });
  }
  return internalSettingsReady;
}

async function getInternalSetting(key) {
  await ensureInternalSettingsTable();
  const { rows } = await pool.query(
    "SELECT value FROM internal_settings WHERE key = $1 LIMIT 1",
    [key]
  );
  return rows && rows[0] ? rows[0].value : null;
}

router.get("/plan-modules", authMiddleware, async (req, res) => {
  try {
    const restaurantId = req.user?.restaurant_id;
    if (!restaurantId) {
      return res.status(400).json({ status: "error", message: "Missing restaurant_id" });
    }

    const { rows } = await pool.query("SELECT plan FROM restaurants WHERE id = $1 LIMIT 1", [
      restaurantId
    ]);
    const plan = normalizePlan(rows && rows[0] ? rows[0].plan : "basic");

    const stored = await getInternalSetting("plan_modules");
    const enabledKeys = Array.isArray(stored?.[plan]) ? stored[plan] : null;

    return res.json({
      plan,
      allowedModuleKeys: Array.isArray(enabledKeys)
        ? enabledKeys.filter((k) => typeof k === "string").map((k) => String(k))
        : null
    });
  } catch (err) {
    console.error("❌ GET /api/plan-modules failed:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

module.exports = router;
