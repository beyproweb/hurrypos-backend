// routes/printer.js
const express = require("express");
const router = express.Router();

// Robust JSON parsing for this router
router.use(express.json({ limit: "256kb" }));

// ✅ Correctly import pool from ../db
let pool = null;
try {
  // Your db.js exports { pool }, so destructure it:
  ({ pool } = require("../db"));
} catch (e) {
  console.warn(
    "printer.js: DB module not available; will use file fallback. Reason:",
    e?.message || e
  );
}

const fs = require("fs");
const path = require("path");
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "printer_settings.json");


// ---- DEFAULTS (keep in sync with frontend) ----
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
    .map(e => ({ label: String(e.label || ""), value: String(e.value || "") }));
  merged.fontSize = Number(merged.fontSize) || DEFAULT_LAYOUT.fontSize;
  merged.lineHeight = Number(merged.lineHeight) || DEFAULT_LAYOUT.lineHeight;
  if (!["left","center","right"].includes(merged.alignment)) merged.alignment = "left";
  if (!merged.receiptWidth) merged.receiptWidth = "80mm";
  return merged;
}

// ---------- File fallback ----------
function ensureDataFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
  } catch (e) { console.warn("ensureDataFile failed:", e?.message || e); }
}
function readFileStore() {
  try {
    ensureDataFile();
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch (e) { console.warn("readFileStore failed:", e?.message || e); return {}; }
}
function writeFileStore(obj) {
  try {
    ensureDataFile();
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj || {}, null, 2));
    return true;
  } catch (e) { console.warn("writeFileStore failed:", e?.message || e); return false; }
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

// Unified handlers (work with or without shopId)
async function handleGet(req, res, shopId) {
  const key = shopId || "default";

  // Try DB
  if (pool) {
    try {
      await ensureTable();
      const { rows } = await pool.query("SELECT layout FROM printer_settings WHERE shop_id = $1", [key]);
      if (rows.length) return res.json({ layout: mergeWithDefaults(rows[0].layout), source: "db" });
      // fall back to file
      const store = readFileStore();
      if (store[key]) return res.json({ layout: mergeWithDefaults(store[key]), source: "file" });
      return res.json({ layout: DEFAULT_LAYOUT, source: "default" });
    } catch (e) {
      console.error("GET printer-settings DB error:", e?.message || e);
    }
  }

  // File fallback
  const store = readFileStore();
  if (store[key]) return res.json({ layout: mergeWithDefaults(store[key]), source: "file" });
  return res.json({ layout: DEFAULT_LAYOUT, source: "default" });
}

async function handlePut(req, res, shopId) {
  const key = shopId || "default";
  const incoming = req.body?.layout;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return res.status(400).json({ error: "layout object is required" });
  }
  const cleaned = mergeWithDefaults(incoming);

  // Try DB
  if (pool) {
    try {
      await ensureTable();
      await pool.query(
        `INSERT INTO printer_settings (shop_id, layout, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (shop_id) DO UPDATE SET layout = EXCLUDED.layout, updated_at = NOW()`,
        [key, cleaned]
      );
      return res.json({ ok: true, layout: cleaned, target: "db" });
    } catch (e) {
      console.error("PUT printer-settings DB error:", e?.message || e);
    }
  }

  // File fallback
  const store = readFileStore();
  store[key] = cleaned;
  const ok = writeFileStore(store);
  if (!ok) return res.status(500).json({ error: "Failed to save printer settings (file fallback)" });
  return res.json({ ok: true, layout: cleaned, target: "file" });
}

// ---- Routes without shopId (your frontend will use these) ----
router.get("/", (req, res) => { handleGet(req, res, null); });
router.put("/", (req, res) => { handlePut(req, res, null); });

// ---- Also support routes WITH shopId (backwards compatible) ----
router.get("/:shopId", (req, res) => { handleGet(req, res, req.params.shopId); });
router.put("/:shopId", (req, res) => { handlePut(req, res, req.params.shopId); });

// Optional: reset to defaults
router.post("/:shopId/reset", async (req, res) => handlePut({ ...req, body: { layout: DEFAULT_LAYOUT } }, res, req.params.shopId));
router.post("/reset", async (req, res) => handlePut({ ...req, body: { layout: DEFAULT_LAYOUT } }, res, null));

module.exports = router;
