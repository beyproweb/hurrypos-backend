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
        ingredients,
        extras,
        selected_extras_group,
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

// ✅ Public QR link endpoint (no auth required)
router.get("/qr-link/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const { rows } = await pool.query(
      "SELECT slug, qr_code_id FROM restaurants WHERE slug = $1 LIMIT 1",
      [slug]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const { slug: s, qr_code_id } = rows[0];
    const link = `https://pos.beypro.com/qr-menu/${s}/${qr_code_id}`;

    res.json({ success: true, link });
  } catch (err) {
    console.error("❌ Public qr-link error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// 🔹 NEW: Public tables for QR menu
router.get("/tables/:identifier", async (req, res) => {
  try {
    const identifier = (req.params.identifier || "").trim();
    if (!identifier) return res.json([]);

    const { rows } = await pool.query(
      `
      SELECT id
      FROM restaurants
      WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1
      LIMIT 1
      `,
      [identifier]
    );

    if (!rows.length) return res.json([]);
    const restaurantId = rows[0].id;

    const { rows: tables } = await pool.query(
      `
      SELECT number,
             color,
             label,
             seats,
             area,
             COALESCE(active, TRUE) AS active
      FROM tables
      WHERE restaurant_id = $1
      ORDER BY number ASC
      `,
      [restaurantId]
    );

    res.json(tables);
  } catch (err) {
    console.error("❌ Public tables failed:", err);
    res.json([]);
  }
});


// 🔹 NEW: Public extras-groups for QR menu
router.get("/extras-groups/:identifier", async (req, res) => {
  try {
    const identifier = (req.params.identifier || "").trim();
    if (!identifier) return res.json([]);

    const { rows } = await pool.query(
      `
      SELECT id
      FROM restaurants
      WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1
      LIMIT 1
      `,
      [identifier]
    );

    if (!rows.length) return res.json([]);
    const restaurantId = rows[0].id;

    const { rows: groups } = await pool.query(
      `
      SELECT id,
             group_name,
             items
      FROM extras_groups
      WHERE restaurant_id = $1
      ORDER BY id ASC
      `,
      [restaurantId]
    );

    res.json(groups);
  } catch (err) {
    console.error("❌ Public extras-groups failed:", err);
    res.json([]);
  }
});


// 🔹 NEW: Public category-images for QR menu
router.get("/category-images/:identifier", async (req, res) => {
  try {
    const identifier = (req.params.identifier || "").trim();
    if (!identifier) return res.json([]);

    const { rows } = await pool.query(
      `
      SELECT id
      FROM restaurants
      WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1
      LIMIT 1
      `,
      [identifier]
    );

    if (!rows.length) return res.json([]);
    const restaurantId = rows[0].id;

    const { rows: imgs } = await pool.query(
      `
      SELECT category,
             image
      FROM category_images
      WHERE restaurant_id = $1
      ORDER BY category
      `,
      [restaurantId]
    );

    res.json(imgs);
  } catch (err) {
    console.error("❌ Public category-images failed:", err);
    res.json([]);
  }
});

router.get("/qr-menu-customization/:slug", async (req, res) => {
  try {
    const slug = req.params.slug;

    // 1️⃣ Find restaurant ID
    const r1 = await pool.query(
      `SELECT id FROM restaurants WHERE slug = $1 LIMIT 1`,
      [slug]
    );

    if (!r1.rows.length) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const restaurantId = r1.rows[0].id;

    // 2️⃣ Load customization from settings
    const r2 = await pool.query(
      `
      SELECT qr_menu_customization, value
      FROM settings
      WHERE restaurant_id = $1 AND key = 'qr-menu-customization'
      LIMIT 1
      `,
      [restaurantId]
    );

    let data = {};

    if (r2.rows.length) {
      if (r2.rows[0].qr_menu_customization) {
        data = r2.rows[0].qr_menu_customization;
      } else if (r2.rows[0].value) {
        data = r2.rows[0].value;   // << FIXED: no JSON.parse
      }
    }

    res.json({
      success: true,
      customization: data
    });

  } catch (err) {
    console.error("❌ Public QR Menu Customization failed:", err);
    res.status(500).json({ error: "Public QR customization error" });
  }
});







module.exports = router;
