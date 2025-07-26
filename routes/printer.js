const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// GET /api/printer-settings/:shop_id?key=default
router.get("/:shop_id", async (req, res) => {
  const { shop_id } = req.params;
  const { key = "default" } = req.query;
  try {
    const { rows } = await pool.query(
      "SELECT * FROM printer_settings WHERE shop_id = $1 AND key = $2 ORDER BY updated_at DESC LIMIT 1",
      [shop_id, key]
    );
    if (!rows.length) return res.status(404).json({ error: "No printer settings found." });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "DB error" });
  }
});

// POST /api/printer-settings/:shop_id
router.post("/:shop_id", async (req, res) => {
  const { shop_id } = req.params;
  const { key = "default", layout } = req.body;
  if (!layout) return res.status(400).json({ error: "Missing layout" });
  try {
    const { rows } = await pool.query(
      `INSERT INTO printer_settings (shop_id, key, layout, updated_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING *`,
      [shop_id, key, layout]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Insert failed" });
  }
});

// PUT /api/printer-settings/:shop_id
router.put("/:shop_id", async (req, res) => {
  const { shop_id } = req.params;
  const { key = "default", layout } = req.body;
  if (!layout) return res.status(400).json({ error: "Missing layout" });
  try {
    const { rows } = await pool.query(
      `UPDATE printer_settings
         SET layout = $1, updated_at = NOW()
       WHERE shop_id = $2 AND key = $3
       RETURNING *`,
      [layout, shop_id, key]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Update failed" });
  }
});

module.exports = router;
