// routes/printer.js
const express = require("express");
const router = express.Router();
const pool = require("../db"); // adjust path if your db file lives elsewhere

// Keep this in sync with src/pages/PrinterTab.jsx
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

// Ensure table exists
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS printer_settings (
      shop_id   TEXT PRIMARY KEY,
      layout    JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
ensureTable().catch(err => console.error("printer_settings ensureTable error:", err));

/**
 * GET /api/printer-settings/:shopId
 * Returns saved layout or DEFAULT_LAYOUT if not found.
 * If found, merges with DEFAULT_LAYOUT to include any newly added keys.
 */
router.get("/:shopId", async (req, res) => {
  const { shopId } = req.params;
  try {
    const { rows } = await pool.query(
      "SELECT layout FROM printer_settings WHERE shop_id = $1",
      [shopId]
    );

    if (!rows.length) {
      return res.json({
        layout: DEFAULT_LAYOUT,
        source: "default",
      });
    }

    // Merge to ensure newly added fields have defaults
    const merged = { ...DEFAULT_LAYOUT, ...(rows[0].layout || {}) };
    return res.json({
      layout: merged,
      source: "db",
    });
  } catch (err) {
    console.error("GET /printer-settings error:", err);
    return res.status(500).json({ error: "Failed to load printer settings" });
  }
});

/**
 * PUT /api/printer-settings/:shopId
 * Body: { layout: { ... } }
 * Saves (UPSERT) sanitized layout.
 */
router.put("/:shopId", async (req, res) => {
  const { shopId } = req.params;
  const incoming = req.body?.layout;

  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return res.status(400).json({ error: "layout object is required" });
  }

  // Sanitize and fill defaults
  const cleaned = { ...DEFAULT_LAYOUT, ...incoming };
  if (!Array.isArray(cleaned.extras)) cleaned.extras = [];
  cleaned.extras = cleaned.extras
    .filter(e => e && typeof e === "object")
    .map(e => ({
      label: String(e.label || ""),
      value: String(e.value || ""),
    }));

  try {
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
    console.error("PUT /printer-settings error:", err);
    return res.status(500).json({ error: "Failed to save printer settings" });
  }
});

module.exports = router;
