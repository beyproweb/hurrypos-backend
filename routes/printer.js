// routes/printer.js
const express = require("express");
const router = express.Router();
const pool = require("../db"); // adjust if your db module lives elsewhere

// IMPORTANT: keep this in sync with src/pages/PrinterTab.jsx defaultLayout
const DEFAULT_LAYOUT = {
  shopAddress: "",
  receiptWidth: "80mm",
  customReceiptWidth: "",
  receiptHeight: "",
  fontSize: 14,
  lineHeight: 1.2,
  alignment: "left",
  showLogo: false,
  showHeader: false,
  showFooter: false,
  showQr: false,
  headerText: "",
  footerText: "",
  showPacketCustomerInfo: false,
  extras: [],
};

// Create table if it doesn't exist (PostgreSQL)
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS printer_settings (
      shop_id    TEXT PRIMARY KEY,
      layout     JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// Merge helper: fill missing/new keys with backend defaults
function mergeWithDefaults(saved) {
  const merged = { ...DEFAULT_LAYOUT, ...(saved || {}) };
  if (!Array.isArray(merged.extras)) merged.extras = [];
  merged.extras = merged.extras
    .filter(e => e && typeof e === "object")
    .map(e => ({
      label: String(e.label || ""),
      value: String(e.value || ""),
    }));
  // coerce some numeric fields
  merged.fontSize = Number(merged.fontSize) || DEFAULT_LAYOUT.fontSize;
  merged.lineHeight = Number(merged.lineHeight) || DEFAULT_LAYOUT.lineHeight;
  return merged;
}

/**
 * GET /api/printer-settings/:shopId
 * Returns saved layout; if not found (or on DB error) returns DEFAULT_LAYOUT.
 * Always 200 so the frontend doesn't break.
 */
router.get("/:shopId", async (req, res) => {
  const { shopId } = req.params;
  try {
    await ensureTable();

    const { rows } = await pool.query(
      "SELECT layout FROM printer_settings WHERE shop_id = $1",
      [shopId]
    );

    if (!rows.length) {
      // nothing saved yet
      return res.json({ layout: DEFAULT_LAYOUT, source: "default" });
    }

    const merged = mergeWithDefaults(rows[0].layout);
    return res.json({ layout: merged, source: "db" });
  } catch (err) {
    console.error("GET /api/printer-settings error:", err?.message || err);
    // Fallback to defaults to avoid 500 in UI
    return res.json({
      layout: DEFAULT_LAYOUT,
      source: "default-db-error",
      warning: "DB unavailable; using defaults",
    });
  }
});

/**
 * PUT /api/printer-settings/:shopId
 * Body: { layout: { ... } }
 * Upserts the layout. Returns sanitized+merged payload.
 */
router.put("/:shopId", async (req, res) => {
  const { shopId } = req.params;
  const incoming = req.body?.layout;

  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return res.status(400).json({ error: "layout object is required" });
  }

  try {
    await ensureTable();

    const cleaned = mergeWithDefaults(incoming);

    await pool.query(
      `
      INSERT INTO printer_settings (shop_id, layout, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (shop_id)
      DO UPDATE SET layout = EXCLUDED.layout, updated_at = NOW()
      `,
      [shopId, cleaned]
    );

    return res.json({ ok: true, layout: cleaned });
  } catch (err) {
    console.error("PUT /api/printer-settings error:", err?.message || err);
    return res.status(500).json({ error: "Failed to save printer settings" });
  }
});

module.exports = router;
