// routes/printer.js
const express = require("express");
const router = express.Router();

// Try to load DB pool, but don't crash if it's unavailable
let pool = null;
try {
  pool = require("../db");
} catch (e) {
  console.warn("printer.js: DB module not available, will use file fallback. Reason:", e?.message || e);
}

const fs = require("fs");
const path = require("path");
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "printer_settings.json");

// === Keep in sync with src/pages/PrinterTab.jsx ===
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

function mergeWithDefaults(saved) {
  const merged = { ...DEFAULT_LAYOUT, ...(saved || {}) };
  if (!Array.isArray(merged.extras)) merged.extras = [];
  merged.extras = merged.extras
    .filter(e => e && typeof e === "object")
    .map(e => ({
      label: String(e.label || ""),
      value: String(e.value || ""),
    }));
  merged.fontSize = Number(merged.fontSize) || DEFAULT_LAYOUT.fontSize;
  merged.lineHeight = Number(merged.lineHeight) || DEFAULT_LAYOUT.lineHeight;
  if (!["left","center","right"].includes(merged.alignment)) merged.alignment = "left";
  if (!merged.receiptWidth) merged.receiptWidth = "80mm";
  return merged;
}

// ---------- File fallback helpers ----------
function ensureDataFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
  } catch (e) {
    console.warn("printer.js: ensureDataFile failed:", e?.message || e);
  }
}
function readFileStore() {
  try {
    ensureDataFile();
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch (e) {
    console.warn("printer.js: readFileStore failed:", e?.message || e);
    return {};
  }
}
function writeFileStore(obj) {
  try {
    ensureDataFile();
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj || {}, null, 2));
    return true;
  } catch (e) {
    console.warn("printer.js: writeFileStore failed:", e?.message || e);
    return false;
  }
}

// ---------- DB helpers ----------
async function ensureTable() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS printer_settings (
      shop_id    TEXT PRIMARY KEY,
      layout     JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// ---------- Routes ----------

/**
 * GET /api/printer-settings/:shopId
 * Always returns 200 with a valid layout.
 * Source: "db" | "file" | "default"
 */
router.get("/:shopId", async (req, res) => {
  const { shopId } = req.params;

  // Try DB first
  if (pool) {
    try {
      await ensureTable();
      const { rows } = await pool.query(
        "SELECT layout FROM printer_settings WHERE shop_id = $1",
        [shopId]
      );
      if (rows.length) {
        const merged = mergeWithDefaults(rows[0].layout);
        return res.json({ layout: merged, source: "db" });
      }
      // If not in DB, try file
      const store = readFileStore();
      if (store[shopId]) {
        return res.json({ layout: mergeWithDefaults(store[shopId]), source: "file" });
      }
      // Default
      return res.json({ layout: DEFAULT_LAYOUT, source: "default" });
    } catch (err) {
      console.error("GET /printer-settings DB error:", err?.message || err);
      // Fall through to file/default
    }
  }

  // File fallback
  const store = readFileStore();
  if (store[shopId]) {
    return res.json({ layout: mergeWithDefaults(store[shopId]), source: "file" });
  }
  return res.json({ layout: DEFAULT_LAYOUT, source: "default" });
});

/**
 * PUT /api/printer-settings/:shopId
 * Body: { layout: { ... } }
 * Upserts into DB, falls back to file if DB fails/unavailable.
 */
router.put("/:shopId", async (req, res) => {
  const { shopId } = req.params;
  const incoming = req.body?.layout;

  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return res.status(400).json({ error: "layout object is required" });
  }

  const cleaned = mergeWithDefaults(incoming);

  // Try DB first
  if (pool) {
    try {
      await ensureTable();
      await pool.query(
        `
        INSERT INTO printer_settings (shop_id, layout, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (shop_id)
        DO UPDATE SET layout = EXCLUDED.layout, updated_at = NOW()
        `,
        [shopId, cleaned]
      );
      return res.json({ ok: true, layout: cleaned, target: "db" });
    } catch (err) {
      console.error("PUT /printer-settings DB error:", err?.message || err);
      // Fall through to file
    }
  }

  // File fallback
  const store = readFileStore();
  store[shopId] = cleaned;
  const ok = writeFileStore(store);
  if (!ok) {
    return res.status(500).json({ error: "Failed to save printer settings (file fallback)" });
  }
  return res.json({ ok: true, layout: cleaned, target: "file" });
});

/**
 * Optional quick reset endpoint
 * POST /api/printer-settings/:shopId/reset
 */
router.post("/:shopId/reset", async (req, res) => {
  const { shopId } = req.params;

  // Try DB
  if (pool) {
    try {
      await ensureTable();
      await pool.query(
        `
        INSERT INTO printer_settings (shop_id, layout, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (shop_id)
        DO UPDATE SET layout = EXCLUDED.layout, updated_at = NOW()
        `,
        [shopId, DEFAULT_LAYOUT]
      );
      return res.json({ ok: true, layout: DEFAULT_LAYOUT, target: "db" });
    } catch (e) {
      console.error("POST /printer-settings reset DB error:", e?.message || e);
    }
  }

  // File fallback
  const store = readFileStore();
  store[shopId] = DEFAULT_LAYOUT;
  const ok = writeFileStore(store);
  if (!ok) return res.status(500).json({ error: "Reset failed (file fallback)" });
  return res.json({ ok: true, layout: DEFAULT_LAYOUT, target: "file" });
});

module.exports = router;
