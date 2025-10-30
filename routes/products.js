const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");

async function resolveRestaurantId(req) {
  const identifier = req.query.identifier;
  let restaurantId = req.user?.restaurant_id;

  if (identifier) {
    if (/^\d+$/.test(identifier)) {
      restaurantId = Number(identifier);
    } else {
      const result = await pool.query("SELECT id FROM restaurants WHERE slug = $1", [identifier]);
      restaurantId = result.rows[0]?.id;
    }
  }

  return restaurantId;
}
// optional: uncomment if you have a global logger
// const { logRequest } = require("../utils/logger");
// simple safe logger fallback
const log = (path, method, data) =>
  console.log(`🧾 ${method} ${path}`, data ? JSON.stringify(data) : "");

async function ensureCategoriesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (restaurant_id, name)
    );
  `);
}

router.use((req, res, next) => {
  if (req.method === "GET" && req.query.identifier) {
    return next();
  }
  return authMiddleware(req, res, () => {
    if (!req.user || !req.user.restaurant_id) {
      return res.status(401).json({
        status: "error",
        message: "Unauthorized: tenant not identified",
      });
    }
    next();
  });
});

// ✅ Get all products for current restaurant

router.get("/", async (req, res) => {
  try {
    const identifier = (req.query.identifier || "").toString().trim();

    // ✅ Public path for QR menu requests (identifier present)
    if (identifier) {
      let restaurantId;
      if (/^\d+$/.test(identifier)) {
        restaurantId = Number(identifier);
      } else {
        const { rows } = await pool.query("SELECT id FROM restaurants WHERE slug = $1", [identifier]);
        restaurantId = rows[0]?.id;
      }
      if (!restaurantId) return res.status(400).json({ error: "Invalid restaurant" });

      const { rows } = await pool.query(
        `SELECT *
           FROM products
          WHERE restaurant_id = $1
            AND visible = true
          ORDER BY id ASC`,
        [restaurantId]
      );
      return res.json(rows);
    }

    // ✅ Authenticated dashboard path (no identifier → rely on JWT)
    const restaurantId = await resolveRestaurantId(req);
    if (!restaurantId) {
      return res.status(400).json({ error: "Invalid restaurant" });
    }

    log("/api/products", "GET", { restaurantId });

    const result = await pool.query(
      `
      SELECT id, name, category, price, preparation_time, description,
             discount_type, discount_value, visible, tags, allergens,
             promo_start, promo_end, image, image_url, ingredients, extras,
             selected_extras_group, created_at
        FROM products
       WHERE restaurant_id = $1
       ORDER BY id DESC
      `,
      [restaurantId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Fetch products error:", err);
    res.status(500).json({ status: "error", message: "Failed to fetch products" });
  }
});

// ----------------- PRODUCTS -----------------







// ✅ Add new product
router.post("/", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const {
    name,
    category,
    price,
    preparation_time,
    description,
    discount_type,
    discount_value,
    visible,
    tags,
    allergens,
    promo_start,
    promo_end,
    image,
    image_url,
    ingredients,
    extras,
    selected_extras_group, // frontend field
  } = req.body;

  if (!name || !price || !category) {
    return res.status(400).json({
      status: "error",
      message: "Name, price, and category are required",
    });
  }

    // 👇 ADD THIS DEBUG LINE HERE
  console.log("🛠️ Incoming product payload:", req.body);

  try {
    const result = await pool.query(
      `
      INSERT INTO products (
        restaurant_id, name, category, price, preparation_time,
        description, discount_type, discount_value, visible, tags, allergens,
        promo_start, promo_end, image, image_url, ingredients, extras, selected_extras_group
      )
      VALUES ($1,$2,$3,$4,$5,
              $6,$7,$8,$9,$10,$11,
              $12,$13,$14,$15,$16,$17,$18)
      RETURNING *
      `,
      [
        restaurantId,
        name,
        category,
        price,
        preparation_time || null,
        description || "",
        discount_type || "none",
        discount_value || 0,
        visible !== false, // default true
        tags || "",
        allergens || "",
        promo_start || null,
        promo_end || null,
        image || null,
        image_url || null,
        ingredients || [],
        extras || [],
        selected_extras_group || [], // ✅ mapped correctly now
      ]
    );

    res.json({
      status: "success",
      message: "Product added",
      product: result.rows[0],
    });
  } catch (err) {
    console.error("❌ Add product error:", err);
    res.status(500).json({ status: "error", message: "Failed to add product" });
  }
});



// ✅ Update product
router.put("/:id", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { id } = req.params;
  const updates = req.body;

  const allowed = [
    "name",
    "category",
    "price",
    "preparation_time",
    "description",
    "discount_type",
    "discount_value",
    "visible",
    "tags",
    "allergens",
    "promo_start",
    "promo_end",
    "image",
    "image_url",
    "ingredients",
    "extras",
    "selected_extras_group",
  ];

  const fields = Object.keys(updates).filter((k) => allowed.includes(k));
  if (fields.length === 0) {
    return res.status(400).json({
      status: "error",
      message: "No valid fields provided for update",
    });
  }

  // 🔑 Ensure JSON fields are properly stringified
  ["ingredients", "extras", "selected_extras_group"].forEach((f) => {
    if (updates[f] !== undefined && typeof updates[f] !== "string") {
      updates[f] = JSON.stringify(updates[f]);
    }
  });

  const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const values = [restaurantId, id, ...fields.map((f) => updates[f])];

  try {
    const result = await pool.query(
      `UPDATE products
       SET ${setClause}
       WHERE restaurant_id=$1 AND id=$2
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ status: "error", message: "Product not found" });
    }

    res.json({
      status: "success",
      message: "Product updated",
      product: result.rows[0],
    });
  } catch (err) {
    console.error("❌ Update product error:", err);
    res
      .status(500)
      .json({ status: "error", message: "Failed to update product" });
  }
});




// ✅ Delete product
router.delete("/:id", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM products WHERE restaurant_id=$1 AND id=$2 RETURNING id, group_name AS name`,
      [restaurantId, id]
    );
    if (result.rowCount === 0)
      return res.status(404).json({ status: "error", message: "Product not found" });

    res.json({ status: "success", message: "Product deleted", product: result.rows[0] });
  } catch (err) {
    console.error("❌ Delete product error:", err);
    res.status(500).json({ status: "error", message: "Failed to delete product" });
  }
});

// ✅ Bulk delete
router.delete("/", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0)
    return res
      .status(400)
      .json({ status: "error", message: "No product IDs provided for deletion" });

  try {
    const result = await pool.query(
      `DELETE FROM products WHERE restaurant_id=$1 AND id=ANY($2::int[]) RETURNING id, group_name AS name`,
      [restaurantId, ids]
    );
    res.json({
      status: "success",
      message: `${result.rowCount} product(s) deleted`,
      deleted: result.rows,
    });
  } catch (err) {
    console.error("❌ Bulk delete error:", err);
    res.status(500).json({ status: "error", message: "Failed to delete products" });
  }
});

router.get("/costs", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  try {
    const result = await pool.query(
      `
      SELECT
        p.id,
        p.name,
        p.category,
        p.price,
        COALESCE((
          SELECT SUM(
            (ing->>'quantity')::numeric *
            COALESCE((
              SELECT t.price_per_unit
              FROM transactions t
              WHERE t.restaurant_id = p.restaurant_id
                AND LOWER(TRIM(t.ingredient)) = LOWER(TRIM(ing->>'ingredient'))
                AND (
                  LOWER(TRIM(t.unit)) = LOWER(TRIM(ing->>'unit'))
                  OR t.unit IS NULL
                  OR ing->>'unit' IS NULL
                )
              ORDER BY t.delivery_date DESC
              LIMIT 1
            ), (
              -- fallback: any latest price for ingredient (ignore unit mismatch)
              SELECT t2.price_per_unit
              FROM transactions t2
              WHERE t2.restaurant_id = p.restaurant_id
                AND LOWER(TRIM(t2.ingredient)) = LOWER(TRIM(ing->>'ingredient'))
              ORDER BY t2.delivery_date DESC
              LIMIT 1
            ), 0)
          )
          FROM jsonb_array_elements(p.ingredients) AS ing
        ), 0) AS ingredient_cost,
        COALESCE((
          SELECT SUM(
            (ing->>'quantity')::numeric *
            COALESCE((
              SELECT t.price_per_unit
              FROM transactions t
              WHERE t.restaurant_id = p.restaurant_id
                AND LOWER(TRIM(t.ingredient)) = LOWER(TRIM(ing->>'ingredient'))
              ORDER BY t.delivery_date DESC
              LIMIT 1
            ), 0)
          )
          FROM jsonb_array_elements(p.ingredients) AS ing
        ), 0) AS cost
      FROM products p
      WHERE p.restaurant_id = $1
      ORDER BY p.category, p.name
      `,
      [restaurantId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Fetch cost error:", err);
    res
      .status(500)
      .json({ status: "error", message: "Failed to fetch cost data" });
  }
});





// ----------------- EXTRAS GROUPS -----------------

// ✅ Get extras groups
router.get("/extras-group", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  try {
    const groups = await pool.query(
      `
      SELECT id, group_name AS name, required, max_selection, created_at
      FROM extras_groups
      WHERE restaurant_id=$1
      ORDER BY group_name
      `,
      [restaurantId]
    );
    if (groups.rowCount === 0) return res.json([]);

    const ids = groups.rows.map((g) => g.id);
    const items = await pool.query(
      `
      SELECT id, group_id, ingredient_name AS name, price, amount, unit
      FROM extras_group_items
      WHERE restaurant_id=$1 AND group_id=ANY($2::int[])
      ORDER BY group_id, ingredient_name
      `,
      [restaurantId, ids]
    );

    const map = {};
    for (const item of items.rows) {
      if (!map[item.group_id]) map[item.group_id] = [];
      map[item.group_id].push(item);
    }

    const data = groups.rows.map((g) => ({ ...g, items: map[g.id] || [] }));
    res.json(data);
  } catch (err) {
    console.error("❌ Fetch extras groups error:", err);
    res.status(500).json({ status: "error", message: "Failed to fetch extras groups" });
  }
});

// ✅ Create extras group
router.post("/extras-group", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { name, required = false, max_selection = 1, items = [] } = req.body;
  if (!name)
    return res.status(400).json({ status: "error", message: "Group name required" });

  try {
    const group = await pool.query(
      `
     INSERT INTO extras_groups (restaurant_id, group_name, required, max_selection)
 VALUES ($1,$2,$3,$4)
 RETURNING id, group_name AS name, required, max_selection, created_at
      `,
      [restaurantId, name, required, max_selection]
    );

    if (items.length > 0) {
      await pool.query(
        `
        INSERT INTO extras_group_items (restaurant_id, group_id, ingredient_name, price, amount, unit)
        VALUES ${items
          .map((_, i) => `($1,$2,$${i * 4 + 3},$${i * 4 + 4},$${i * 4 + 5},$${i * 4 + 6})`)
          .join(", ")}
        `,
        [
          restaurantId,
          group.rows[0].id,
          ...items.flatMap((x) => [
            x.name,
            x.price || 0,
            x.amount || 1,
            x.unit || null,
          ]),
        ]
      );
    }

    res.json({ status: "success", message: "Extras group created", group: group.rows[0] });
  } catch (err) {
    console.error("❌ Create extras group error:", err);
    res.status(500).json({ status: "error", message: "Failed to create extras group" });
  }
});

// ✅ Update extras group
router.put("/extras-group/:id", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { id } = req.params;
  const { name, required, max_selection, items = [] } = req.body;

  try {
    const check = await pool.query(
      `SELECT id FROM extras_groups WHERE restaurant_id=$1 AND id=$2`,
      [restaurantId, id]
    );
    if (check.rowCount === 0)
      return res
        .status(404)
        .json({ status: "error", message: "Extras group not found" });

    await pool.query(
      `
      UPDATE extras_groups
      SET group_name=$3, required=$4, max_selection=$5
      WHERE restaurant_id=$1 AND id=$2
      `,
      [restaurantId, id, name, required, max_selection]
    );

    await pool.query(
      `DELETE FROM extras_group_items WHERE restaurant_id=$1 AND group_id=$2`,
      [restaurantId, id]
    );

    if (items.length > 0) {
      await pool.query(
        `
        INSERT INTO extras_group_items (restaurant_id, group_id, ingredient_name, price, amount, unit)
        VALUES ${items
          .map((_, i) => `($1,$2,$${i * 4 + 3},$${i * 4 + 4},$${i * 4 + 5},$${i * 4 + 6})`)
          .join(", ")}
        `,
        [
          restaurantId,
          id,
          ...items.flatMap((x) => [
            x.name,
            x.price || 0,
            x.amount || 1,
            x.unit || null,
          ]),
        ]
      );
    }

    res.json({ status: "success", message: "Extras group updated" });
  } catch (err) {
    console.error("❌ Update extras group error:", err);
    res.status(500).json({ status: "error", message: "Failed to update extras group" });
  }
});


// ✅ Delete extras group
router.delete("/extras-group/:id", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { id } = req.params;
  try {
    await pool.query(
      `DELETE FROM extras_group_items WHERE restaurant_id=$1 AND group_id=$2`,
      [restaurantId, id]
    );
    const del = await pool.query(
      `DELETE FROM extras_groups WHERE restaurant_id=$1 AND id=$2 RETURNING id, group_name AS name`,
      [restaurantId, id]
    );
    if (del.rowCount === 0)
      return res.status(404).json({ status: "error", message: "Group not found" });

    res.json({ status: "success", message: "Extras group deleted", group: del.rows[0] });
  } catch (err) {
    console.error("❌ Delete extras group error:", err);
    res.status(500).json({ status: "error", message: "Failed to delete extras group" });
  }
});


// ✅ Get categories
router.get("/categories", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  if (!restaurantId) {
    return res
      .status(400)
      .json({ status: "error", message: "Invalid restaurant" });
  }

  try {
    await ensureCategoriesTable();
    const restaurantIdAsText = restaurantId.toString();
    const { rows } = await pool.query(
      `
      SELECT name
      FROM (
        SELECT DISTINCT category AS name
        FROM products
        WHERE restaurant_id::text = $1
          AND category IS NOT NULL
          AND TRIM(category) <> ''
        UNION
        SELECT DISTINCT name
        FROM categories
        WHERE restaurant_id = $1
      ) AS combined
      ORDER BY name
      `,
      [restaurantIdAsText]
    );
    res.json(rows.map((r) => r.name));
  } catch (err) {
    console.error("❌ Fetch categories error:", err);
    res.status(500).json({ status: "error", message: "Failed to fetch categories" });
  }
});

// ✅ Add category
router.post("/categories", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { category } = req.body;
  if (!category || !category.trim())
    return res.status(400).json({ status: "error", message: "Category required" });

  try {
    await ensureCategoriesTable();
    const normalizedCategory = category.trim();
    await pool.query(
      `
      INSERT INTO categories (restaurant_id,name)
      VALUES ($1,$2)
      ON CONFLICT (restaurant_id,name) DO NOTHING
      `,
      [restaurantId.toString(), normalizedCategory]
    );
    res.json({ status: "success", message: `Category "${normalizedCategory}" added` });
  } catch (err) {
    console.error("❌ Add category error:", err);
    res.status(500).json({ status: "error", message: "Failed to add category" });
  }
});

router.get("/:id", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { id } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT id, name, category, price, cost, image, stock, unit, description, status, created_at
      FROM products
      WHERE restaurant_id = $1 AND id = $2
      `,
      [restaurantId, id]
    );
    if (result.rowCount === 0)
      return res.status(404).json({ status: "error", message: "Product not found" });

    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Fetch product error:", err);
    res.status(500).json({ status: "error", message: "Failed to fetch product" });
  }
});

// ✅ Protected routes below
module.exports = router;
