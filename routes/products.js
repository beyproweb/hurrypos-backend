const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
const { attachAllowedModules } = require("../middleware/moduleGuard");
const jwt = require("jsonwebtoken");

const PRIMARY_JWT_SECRET = process.env.JWT_SECRET || "beypro_secret_2025";
const LEGACY_JWT_SECRET =
  process.env.NODE_ENV !== "production" ? process.env.JWT_SECRET_LEGACY : "";

const verifyJwt = (token) => {
  try {
    return jwt.verify(token, PRIMARY_JWT_SECRET);
  } catch (err) {
    if (LEGACY_JWT_SECRET && LEGACY_JWT_SECRET !== PRIMARY_JWT_SECRET) {
      return jwt.verify(token, LEGACY_JWT_SECRET);
    }
    throw err;
  }
};

const decodeOptionalAuth = (req) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return { user: null, error: null };
  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, error: "Malformed Authorization header" };
  }

  try {
    const token = authHeader.slice(7).trim();
    const decoded = verifyJwt(token);
    if (!decoded?.restaurant_id) {
      return { user: null, error: "Token missing restaurant_id" };
    }
    return {
      user: {
        id: decoded.id,
        name: decoded.name,
        role: decoded.role,
        restaurant_id: decoded.restaurant_id,
      },
      error: null,
    };
  } catch (err) {
    return { user: null, error: "Invalid or expired token" };
  }
};

// ✅ Public + Auth route for fetching products (supports QR identifier)
router.get("/", async (req, res, next) => {
  try {
    const identifier = req.query.identifier;
    let restaurantId = null;

    // 1️⃣ If logged-in POS user (token optional but preferred)
    const { user, error } = decodeOptionalAuth(req);
    if (error) {
      return res.status(401).json({ error });
    }

    if (user?.restaurant_id) {
      req.user = user;
      restaurantId = user.restaurant_id;
    }

    // 2️⃣ Else via public QR link
    else if (identifier) {
      const r = await pool.query(
        "SELECT id FROM restaurants WHERE slug = $1 OR id::text = $1 LIMIT 1",
        [identifier]
      );
if (r.rows.length === 0) {
  return res.status(404).json({ error: "Restaurant not found" });
}

      restaurantId = r.rows[0].id;
    } else {
      return res
        .status(400)
        .json({ error: "Missing restaurant identifier or auth token" });
    }

    // 3️⃣ Fetch products
    // - Authenticated POS users: return full fields (needed for edit screens), include hidden items.
    // - Public QR users: return a limited set and only visible items.
    const isAuthed = !!user?.restaurant_id;

    const { rows } = await pool.query(
      isAuthed
        ? `SELECT
             id,
             name,
             price,
             category,
             preparation_time,
             description,
             discount_type,
             discount_value,
             COALESCE(visible, true) AS visible,
             tags,
             allergens,
             promo_start,
             promo_end,
             image,
             image_url,
             COALESCE(show_add_to_cart_modal, true) AS show_add_to_cart_modal,
             ingredients,
             extras,
             selected_extras_group
           FROM products
           WHERE restaurant_id = $1
           ORDER BY category, name`
        : `SELECT
             id,
             name,
             price,
             category,
             description,
             image,
             COALESCE(visible, true) AS visible,
             COALESCE(show_add_to_cart_modal, true) AS show_add_to_cart_modal,
             ingredients,
             extras,
             selected_extras_group
           FROM products
           WHERE restaurant_id = $1
             AND COALESCE(visible, true) = true
           ORDER BY category, name`,
      [restaurantId]
    );

    return res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching products:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// 🛡️ All other product routes remain protected
router.use(authMiddleware);
router.use(async (req, res, next) => {
  const allowed = await attachAllowedModules(req);
  if (Array.isArray(allowed) && !allowed.includes("pos_core")) {
    const isAllowedWrite = req.method === "POST" && /^\/?$/.test(req.path || "");
    if (!isAllowedWrite) {
      return res.status(403).json({ error: "MODULE_NOT_ALLOWED" });
    }
  }
  return next();
});


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




// ----------------- PRODUCTS -----------------







const parseJsonDeep = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return fallback;

  const raw = value.trim();
  if (!raw) return fallback;

  try {
    let parsed = JSON.parse(raw);
    // Handle double-stringified payloads: "\"[ {...} ]\""
    for (let i = 0; i < 2 && typeof parsed === "string"; i++) {
      parsed = JSON.parse(parsed);
    }
    return parsed;
  } catch {
    return fallback;
  }
};

const ensureArray = (value) => (Array.isArray(value) ? value : []);

// ✅ Add new product
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
    show_add_to_cart_modal,
  } = req.body;

  const showAddToCartModal = show_add_to_cart_modal === false ? false : true;

  if (!name || !price || !category) {
    return res.status(400).json({
      status: "error",
      message: "Name, price, and category are required",
    });
  }

	  // 🧩 Normalize promo date fields
	  const normalizedPromoStart =
	    promo_start && promo_start.trim() !== "" ? promo_start : null;
	  const normalizedPromoEnd =
	    promo_end && promo_end.trim() !== "" ? promo_end : null;

	  console.log("🛠️ Incoming product payload:", req.body);

	  const parsedIngredients = parseJsonDeep(ingredients, ingredients);
	  const parsedExtras = parseJsonDeep(extras, extras);
	  const parsedGroups = parseJsonDeep(selected_extras_group, selected_extras_group);

	  const normalizedIngredients = ensureArray(parsedIngredients);
	  const normalizedExtras = ensureArray(parsedExtras);
	  const normalizedGroups = ensureArray(parsedGroups);

	  if (
	    (typeof ingredients === "string" && normalizedIngredients.length === 0 && ingredients.trim() !== "[]") ||
	    (typeof extras === "string" && normalizedExtras.length === 0 && extras.trim() !== "[]") ||
	    (typeof selected_extras_group === "string" &&
	      normalizedGroups.length === 0 &&
	      selected_extras_group.trim() !== "[]")
	  ) {
	    return res.status(400).json({
	      status: "error",
	      message: "Invalid JSON format for ingredients/extras/selected_extras_group",
	    });
	  }

	  try {
	    const result = await pool.query(
	      `
	      INSERT INTO products (
        restaurant_id, name, category, price, preparation_time,
        description, discount_type, discount_value, visible, tags, allergens,
        promo_start, promo_end, image, image_url, ingredients, extras, selected_extras_group,
        show_add_to_cart_modal
      )
      VALUES ($1,$2,$3,$4,$5,
              $6,$7,$8,$9,$10,$11,
              $12,$13,$14,$15,$16,$17,$18,$19)
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
	        normalizedPromoStart, // ✅ safe timestamps
	        normalizedPromoEnd,   // ✅ safe timestamps
	        image || null,
	        image_url || null,
	        JSON.stringify(normalizedIngredients),
	        JSON.stringify(normalizedExtras),
	        JSON.stringify(normalizedGroups), // ✅ mapped correctly now
	        showAddToCartModal,
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
		router.put("/:id(\\d+)", async (req, res) => {
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
    "show_add_to_cart_modal",
  ];

  const fields = Object.keys(updates).filter((k) => allowed.includes(k));
  if (fields.length === 0) {
    return res.status(400).json({
      status: "error",
      message: "No valid fields provided for update",
    });
  }

	  // ✅ Normalize timestamp fields before update
	  if (updates.promo_start === "") updates.promo_start = null;
	  if (updates.promo_end === "") updates.promo_end = null;

	  // ✅ Normalize JSON fields (accept arrays/objects, or JSON strings)
	  for (const f of ["ingredients", "extras", "selected_extras_group"]) {
	    if (updates[f] === undefined) continue;
	    if (typeof updates[f] === "string") {
	      const parsed = parseJsonDeep(updates[f], null);
	      if (parsed === null) {
	        return res.status(400).json({
	          status: "error",
	          message: `Invalid JSON format for ${f}`,
	        });
	      }
	      updates[f] = parsed;
	    }
	    // Ensure arrays for fields that are meant to be lists
	    if (f === "ingredients" || f === "extras" || f === "selected_extras_group") {
	      updates[f] = JSON.stringify(ensureArray(updates[f]));
	    }
	  }

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
  if (!restaurantId) {
    return res.status(401).json({ error: "Unauthorized: restaurant_id missing" });
  }

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
            COALESCE(NULLIF(TRIM(ing->>'quantity'), '')::numeric, 0) *
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
            ), 0)
          )
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(p.ingredients) = 'array' THEN p.ingredients
              ELSE '[]'::jsonb
            END
          ) AS ing
        ), 0) AS ingredient_cost
      FROM products p
      WHERE p.restaurant_id = $1
      ORDER BY p.category, p.name
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


// =============================
// 🔧 CATEGORY ROUTES (safe version)
// =============================
router.get("/categories", authMiddleware, async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const idText = restaurantId?.toString();

  try {
    await ensureCategoriesTable();

    // fetch all categories for this tenant
    const { rows } = await pool.query(
      `SELECT name FROM categories WHERE restaurant_id = $1 ORDER BY name`,
      [idText]
    );
    const names = rows.map((r) => r.name);
    res.json(names);
  } catch (err) {
    console.error("❌ Fetch categories error:", err);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

router.post("/categories", authMiddleware, async (req, res) => {
  const restaurantId = req.user?.restaurant_id;
  const { category } = req.body;

  console.log("📥 [POST /categories] Incoming body:", req.body);
  console.log("🏷️ restaurant_id from token:", restaurantId);

  if (!restaurantId) {
    return res.status(400).json({ error: "Missing restaurant_id in token" });
  }

  if (!category || !category.trim()) {
    return res.status(400).json({ error: "Category name required" });
  }

  try {
    await ensureCategoriesTable();

    const result = await pool.query(
      `INSERT INTO categories (restaurant_id, name)
       VALUES ($1, $2)
       ON CONFLICT (restaurant_id, name) DO NOTHING
       RETURNING *`,
      [restaurantId.toString(), category.trim()]
    );

    console.log("✅ Insert result:", result.rows);

    res.json({
      success: true,
      inserted: result.rows,
      category: category.trim(),
    });
  } catch (err) {
    console.error("❌ Add category error:", err);
    res.status(500).json({ error: "Failed to add category" });
  }
});


// ✏️ RENAME CATEGORY
router.put("/categories", authMiddleware, async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const idText = restaurantId?.toString();
  const { oldName, newName } = req.body;

  if (!oldName || !newName) {
    console.warn("⚠️ Rename category missing payload", req.body);
    return res.status(400).json({ error: "Missing oldName or newName" });
  }

  try {
    const client = await pool.connect();
    await client.query("BEGIN");

    // rename in categories table
    await client.query(
      `UPDATE categories
       SET name = $1
       WHERE restaurant_id = $2 AND name = $3`,
      [newName.trim(), idText, oldName.trim()]
    );

    // rename in products table for this tenant
    await client.query(
      `UPDATE products
       SET category = $1
       WHERE restaurant_id = $2 AND category = $3`,
      [newName.trim(), restaurantId, oldName.trim()]
    );

    await client.query("COMMIT");
    client.release();

    res.json({ success: true, oldName, newName });
  } catch (err) {
    console.error("❌ Rename category error:", err);
    res.status(500).json({ error: "Failed to rename category" });
  }
});

// 🗑 DELETE CATEGORY
router.delete("/categories", authMiddleware, async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const idText = restaurantId?.toString();
  const { category } = req.body;

  if (!category) {
    return res.status(400).json({ error: "Missing category name" });
  }

  try {
    const client = await pool.connect();
    await client.query("BEGIN");

    // remove from categories
    await client.query(
      `DELETE FROM categories WHERE restaurant_id = $1 AND name = $2`,
      [idText, category.trim()]
    );

    // remove category label from products but keep product
    await client.query(
      `UPDATE products SET category = NULL
       WHERE restaurant_id = $1 AND category = $2`,
      [restaurantId, category.trim()]
    );

    await client.query("COMMIT");
    client.release();

    res.json({ success: true, deleted: category });
  } catch (err) {
    console.error("❌ Delete category error:", err);
    res.status(500).json({ error: "Failed to delete category" });
  }
});


router.get("/:id(\\d+)", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { id } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT id, name, category, price, cost, image, stock, unit, description, status,
             COALESCE(show_add_to_cart_modal, true) AS show_add_to_cart_modal,
             ingredients, extras, selected_extras_group,
             created_at
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

// 📦 Public QR Menu fetch
router.get("/public/products", async (req, res) => {
  try {
    const identifier = (req.query.identifier || "").trim();
    if (!identifier) {
      return res.status(400).json({ error: "Missing identifier" });
    }

    const { rows } = await pool.query(
      `
      SELECT id
      FROM restaurants
      WHERE slug = $1 OR id::text = $1 OR qr_code_id = $1
      LIMIT 1
      `,
      [identifier]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

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
      [rows[0].id]
    );

    res.json(products);
  } catch (err) {
    console.error("❌ Public products fetch failed:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Delete product
router.delete("/:id(\\d+)", async (req, res) => {
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
// ✅ Protected routes below
module.exports = router;
