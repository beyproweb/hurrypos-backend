// routes/publicQR.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");

router.get("/qr-resolve/:code", async (req, res) => {
  try {
    const { code } = req.params;
    const { rows } = await pool.query(
      "SELECT id, slug, qr_token FROM restaurants WHERE qr_code_id = $1",
      [code]
    );
    if (!rows.length) return res.status(404).json({ error: "Invalid QR code" });
    res.json(rows[0]); // send { id, slug, qr_token }
  } catch (err) {
    console.error("❌ QR resolve failed:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ New: GET /api/public/products/:slugOrCode
router.get("/products/:identifier", async (req, res) => {
  try {
    const identifier = (req.params.identifier || "").trim();
    if (!identifier) {
      return res.status(400).json({ error: "Missing identifier" });
    }

    // identifier may be slug, qr_code_id, or numeric id
    const { rows } = await pool.query(
      `
      SELECT id
      FROM restaurants
      WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1
      LIMIT 1
      `,
      [identifier]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Invalid restaurant" });
    }
    const restaurantId = rows[0].id;

    const { rows: products } = await pool.query(
      `
      SELECT
        id,
        name,
        price,
        category,
        description,
        image,
        COALESCE(visible, true) AS visible
      FROM products
      WHERE restaurant_id = $1
        AND COALESCE(visible, true) = true
      ORDER BY category, name, id
      `,
      [restaurantId]
    );

    res.json(products);
  } catch (err) {
    console.error("❌ Public products fetch failed:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ New: GET /api/public/restaurant-info?identifier=slugOrId
router.get("/restaurant-info", async (req, res) => {
  try {
    const { identifier } = req.query;
    if (!identifier) {
      return res.status(400).json({ error: "Missing identifier" });
    }

    const { rows } = await pool.query(
      `
      SELECT id, name, slug, description, banner_url, logo_url, tagline
      FROM restaurants
      WHERE slug = $1 OR id::text = $1
      LIMIT 1
      `,
      [identifier]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("❌ Public restaurant-info failed:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
