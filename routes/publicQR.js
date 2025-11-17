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
        COALESCE(visible, true) AS visible,
        COALESCE(show_add_to_cart_modal, true) AS show_add_to_cart_modal
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
      `
      SELECT id
      FROM restaurants
      WHERE slug = $1
         OR qr_code_id = $1
         OR id::text = $1
      LIMIT 1
      `,
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





// =========================
// Popular This Week
// =========================
router.get("/popular/:identifier", async (req, res) => {
  try {
    const identifier = (req.params.identifier || "").trim();
    if (!identifier) return res.status(400).json({ error: "Missing identifier" });

    // Resolve restaurant id (slug, qr_code_id, or id)
    const r = await pool.query(
      `SELECT id FROM restaurants WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1 LIMIT 1`,
      [identifier]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Restaurant not found" });
    const restaurantId = r.rows[0].id;

    const { rows } = await pool.query(
      `
      SELECT oi.product_id::int AS product_id, SUM(oi.quantity) AS cnt
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.restaurant_id = $1
        AND o.created_at >= NOW() - INTERVAL '7 days'
        AND COALESCE(o.status,'') <> 'cancelled'
      GROUP BY oi.product_id
      ORDER BY cnt DESC
      LIMIT 6
      `,
      [restaurantId]
    );

    return res.json({ product_ids: rows.map(r => r.product_id), items: rows });
  } catch (err) {
    console.error("❌ Public popular failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
});


// =========================
// QR Loyalty Card System
// =========================
async function ensureLoyaltyTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qr_loyalty (
      id SERIAL PRIMARY KEY,
      restaurant_id INT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      points INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (restaurant_id, fingerprint)
    );
  `);
}

async function resolveRestaurantId(identifier) {
  const { rows } = await pool.query(
    `SELECT id FROM restaurants WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1 LIMIT 1`,
    [identifier]
  );
  return rows[0]?.id || null;
}

router.get("/loyalty/:identifier", async (req, res) => {
  try {
    const identifier = (req.params.identifier || "").trim();
    const fingerprint = (req.query.fp || "").trim();
    if (!identifier) return res.status(400).json({ error: "Missing identifier" });
    const restaurantId = await resolveRestaurantId(identifier);
    if (!restaurantId) return res.status(404).json({ error: "Restaurant not found" });

    // Load customization for loyalty config
    const r = await pool.query(
      `SELECT qr_menu_customization FROM settings WHERE restaurant_id = $1 AND key = 'qr-menu-customization' LIMIT 1`,
      [restaurantId]
    );
    const c = r.rows[0]?.qr_menu_customization || {};

    const enabled = !!c.loyalty_enabled;
    const goal = Number(c.loyalty_goal || 10);
    const reward_text = c.loyalty_reward_text || "Free Menu Item";
    const color = c.loyalty_color || "#F59E0B";

    let points = 0;
    if (fingerprint) {
      await ensureLoyaltyTable();
      const q = await pool.query(
        `SELECT points FROM qr_loyalty WHERE restaurant_id = $1 AND fingerprint = $2 LIMIT 1`,
        [restaurantId, fingerprint]
      );
      points = Number(q.rows[0]?.points || 0);
    }

    return res.json({ enabled, points, goal, reward_text, color });
  } catch (err) {
    console.error("❌ Public loyalty GET failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/loyalty/:identifier/add", async (req, res) => {
  try {
    const identifier = (req.params.identifier || "").trim();
    const { fingerprint, points: addPoints } = req.body || {};
    if (!identifier) return res.status(400).json({ error: "Missing identifier" });
    if (!fingerprint) return res.status(400).json({ error: "Missing fingerprint" });
    const delta = Number(addPoints || 1);

    const restaurantId = await resolveRestaurantId(identifier);
    if (!restaurantId) return res.status(404).json({ error: "Restaurant not found" });

    await ensureLoyaltyTable();

    const up = await pool.query(
      `
      INSERT INTO qr_loyalty (restaurant_id, fingerprint, points)
      VALUES ($1, $2, $3)
      ON CONFLICT (restaurant_id, fingerprint)
      DO UPDATE SET points = qr_loyalty.points + EXCLUDED.points, updated_at = NOW()
      RETURNING points
      `,
      [restaurantId, fingerprint, delta]
    );

    return res.json({ success: true, points: Number(up.rows[0]?.points || 0) });
  } catch (err) {
    console.error("❌ Public loyalty ADD failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
});



module.exports = router;
