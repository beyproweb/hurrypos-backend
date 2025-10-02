const express = require("express");
const router = express.Router();
// routes/products.js
const { pool } = require("../db");   // ✅ destructure pool

const authMiddleware = require("../middleware/authMiddleware");

router.use(authMiddleware);
// optional: uncomment if you have a global logger
// const { logRequest } = require("../utils/logger");
// Tenant guard middleware
router.use((req, res, next) => {
  if (!req.user || !req.user.restaurant_id) {
    return res.status(401).json({
      status: "error",
      message: "Unauthorized: tenant not identified",
    });
  }
  next();
});
// simple safe logger fallback
const log = (path, method, data) =>
  console.log(`🧾 ${method} ${path}`, data ? JSON.stringify(data) : "");

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
// ✅ Update product (safe JSON handling)
router.put("/:id", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { id } = req.params;
  const updates = { ...req.body };

  // 🔒 Normalize JSON fields
  ["ingredients", "extras", "selected_extras_group"].forEach((key) => {
    if (updates[key]) {
      try {
        if (typeof updates[key] === "string") {
          updates[key] = JSON.parse(updates[key]);
        }
      } catch (e) {
        console.warn(`⚠️ Failed to parse ${key}, resetting to []`);
        updates[key] = [];
      }
    }
  });

  // Force extras numbers to be numeric
  if (Array.isArray(updates.extras)) {
    updates.extras = updates.extras.map((e) => ({
      name: e.name,
      extraPrice: Number(e.extraPrice) || 0,
    }));
  }

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
    return res
      .status(400)
      .json({ status: "error", message: "No valid fields provided for update" });
  }

  const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const values = [restaurantId, id, ...fields.map((f) => updates[f])];

  try {
    const result = await pool.query(
      `UPDATE products SET ${setClause} WHERE restaurant_id=$1 AND id=$2 RETURNING *`,
      values
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ status: "error", message: "Product not found" });
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

// ✅ Costs overview
router.get("/costs", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  try {
    const result = await pool.query(
      `
      SELECT
        p.id, p.name, p.category, p.cost, p.price, p.stock, p.unit,
        COALESCE(SUM(i.price * pi.quantity),0) AS ingredient_cost
      FROM products p
      LEFT JOIN product_ingredients pi
        ON pi.product_id=p.id AND pi.restaurant_id=p.restaurant_id
      LEFT JOIN ingredients i
        ON i.id=pi.ingredient_id AND i.restaurant_id=p.restaurant_id
      WHERE p.restaurant_id=$1
      GROUP BY p.id,p.name,p.category,p.cost,p.price,p.stock,p.unit
      ORDER BY p.category,p.name
      `,
      [restaurantId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Fetch cost error:", err);
    res.status(500).json({ status: "error", message: "Failed to fetch cost data" });
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

// ✅ Fetch all products (tenant-safe)
router.get("/", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  log("/api/products", "GET", { restaurantId });

  try {
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

// ----------------- CATEGORIES -----------------

// ✅ Get categories
router.get("/categories", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  try {
    const result = await pool.query(
      `
      SELECT DISTINCT category
      FROM products
      WHERE restaurant_id=$1 AND category IS NOT NULL AND TRIM(category)<>''
      ORDER BY category
      `,
      [restaurantId]
    );
    res.json(result.rows.map((r) => r.category));
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
    await pool.query(
      `
      INSERT INTO categories (restaurant_id,name)
      VALUES ($1,$2)
      ON CONFLICT (restaurant_id,name) DO NOTHING
      `,
      [restaurantId, category.trim()]
    );
    res.json({ status: "success", message: `Category "${category}" added` });
  } catch (err) {
    console.error("❌ Add category error:", err);
    res.status(500).json({ status: "error", message: "Failed to add category" });
  }
});

module.exports = router;
