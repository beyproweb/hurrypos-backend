const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// GET /api/products - fetch all products
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM products ORDER BY name ASC");
    const products = result.rows.map((product) => ({
      ...product,
      ingredients:
        typeof product.ingredients === "string"
          ? JSON.parse(product.ingredients)
          : product.ingredients || [],
      extras:
        typeof product.extras === "string"
          ? JSON.parse(product.extras)
          : product.extras || [],
      selectedExtrasGroup: (() => {
        if (Array.isArray(product.selected_extras_group))
          return product.selected_extras_group;
        if (
          typeof product.selected_extras_group === "string" &&
          product.selected_extras_group.trim()
        ) {
          try {
            return JSON.parse(product.selected_extras_group);
          } catch {
            return [];
          }
        }
        return [];
      })(),
    }));
    res.json(products);
  } catch (err) {
    console.error("❌ Error fetching products:", err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// GET /api/products/costs
router.get("/costs", async (req, res) => {
  try {
    const productsRes = await pool.query("SELECT id, ingredients FROM products");
    const pricesRes = await pool.query(`
      SELECT x.name, x.unit, x.price_per_unit
      FROM (
        SELECT
          h.ingredient_name AS name,
          h.unit,
          h.price AS price_per_unit,
          ROW_NUMBER() OVER (
            PARTITION BY h.ingredient_name, h.unit
            ORDER BY h.changed_at DESC
          ) AS rn
        FROM ingredient_price_history h
      ) x
      WHERE x.rn = 1
    `);
    const prices = {};
    pricesRes.rows.forEach((p) => {
      prices[`${p.name}__${p.unit}`] = parseFloat(p.price_per_unit);
    });

    const costs = {};
    productsRes.rows.forEach((prod) => {
      let totalCost = 0;
      let ingredientsArr = [];
      if (Array.isArray(prod.ingredients)) {
        ingredientsArr = prod.ingredients;
      } else if (typeof prod.ingredients === "string") {
        try {
          ingredientsArr = JSON.parse(prod.ingredients);
        } catch {
          ingredientsArr = [];
        }
      }
      ingredientsArr.forEach((ing) => {
        if (!ing.ingredient || !ing.quantity || !ing.unit) return;
        const key = `${ing.ingredient}__${ing.unit}`;
        const price = prices[key] || 0;
        totalCost += parseFloat(ing.quantity) * price;
      });
      costs[prod.id] = totalCost;
    });

    res.json(costs);
  } catch (err) {
    console.error("❌ Failed to calculate product costs:", err);
    res.status(500).json({ error: "Failed to calculate product costs" });
  }
});

// GET /api/products/:id
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM products WHERE id = $1", [
      id,
    ]);
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Product not found" });

    const product = result.rows[0];
    const mappedProduct = {
      ...product,
      ingredients:
        typeof product.ingredients === "string"
          ? JSON.parse(product.ingredients)
          : product.ingredients || [],
      extras:
        typeof product.extras === "string"
          ? JSON.parse(product.extras)
          : product.extras || [],
      selectedExtrasGroup: (() => {
        if (Array.isArray(product.selected_extras_group))
          return product.selected_extras_group;
        if (
          typeof product.selected_extras_group === "string" &&
          product.selected_extras_group.trim()
        ) {
          try {
            return JSON.parse(product.selected_extras_group);
          } catch {
            return [];
          }
        }
        return [];
      })(),
    };

    res.json(mappedProduct);
  } catch (err) {
    console.error("❌ Error fetching product:", err);
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

// POST /api/products
// POST /api/products
router.post("/", async (req, res) => {
  try {
    const {
      name,
      price,
      category,
      preparation_time,
      description,
      discount_type,
      discount_value,
      visible,
      tags,
      allergens,
      promo_start,
      promo_end,
      image: image_url,
      ingredients,
      extras,
      selectedExtrasGroup,
    } = req.body;

    // keep ingredients/extras as JSON strings (as your table stores TEXT/JSONB)
    let parsedIngredients = "[]";
    let parsedExtras = "[]";

    try {
      parsedIngredients = JSON.stringify(Array.isArray(ingredients) ? ingredients : []);
    } catch {
      return res.status(400).json({ error: "Invalid ingredients format" });
    }
    try {
      parsedExtras = JSON.stringify(Array.isArray(extras) ? extras : []);
    } catch {
      return res.status(400).json({ error: "Invalid extras format" });
    }

    // BUT: groups should be an int[] (to match your PUT behavior)
    const toIntArray = (v) =>
      Array.isArray(v) ? v.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
    const groupArr = toIntArray(selectedExtrasGroup); // e.g., [1,2,5]

    const result = await pool.query(
      `INSERT INTO products (
        name, price, category, preparation_time, description,
        discount_type, discount_value, visible, tags, allergens,
        promo_start, promo_end, image, ingredients, extras, selected_extras_group
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16
      ) RETURNING *`,
      [
        name,
        parseFloat(price) || 0,
        category,
        preparation_time ? parseInt(preparation_time) : null,
        description,
        discount_type || "none",
        parseFloat(discount_value) || 0,
        typeof visible === "boolean" ? visible : visible === "true",
        tags,
        allergens,
        promo_start || null,
        promo_end || null,
        image_url,
        parsedIngredients, // JSON (TEXT/JSONB)
        parsedExtras,      // JSON (TEXT/JSONB)
        groupArr,          // <-- int[] not JSON string
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error creating product:", err);
    res.status(500).json({ error: "Failed to create product" });
  }
});


// PUT /api/products/:id
// PUT /api/products/:id
// products.js
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: 'Invalid product id' });
  }

  try {
    const {
      name,
      price,
      category,
      preparation_time,
      description,
      image,
      ingredients,
      extras,              // <- comes as string/array when you add extras
      discount_type,
      discount_value,
      visible,
      tags,
      allergens,
      promo_start,
      promo_end,
    } = req.body;

    // Normalize possible FormData/stringified JSON
    const parseMaybeJson = (v, fallback) => {
      if (v == null || v === '') return fallback;
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return fallback; }
      }
      return v;
    };

    const normIngredients = parseMaybeJson(ingredients, []);
    const normExtras = parseMaybeJson(extras, []); // <- critical: avoid 500 when extras present

    const normPrice = price == null || price === '' ? null : Number(price);
    const normPrep = preparation_time == null || preparation_time === '' ? null : Number(preparation_time);
    const normDiscountValue = discount_value == null || discount_value === '' ? 0 : Number(discount_value);
    const normVisible = typeof visible === 'string' ? visible === 'true' : (visible ?? true);

    const sql = `
      UPDATE products SET
        name = $1,
        price = $2,
        category = $3,
        preparation_time = $4,
        description = $5,
        image = $6,
        ingredients = $7::jsonb,
        extras = $8::jsonb,
        discount_type = $9,
        discount_value = $10,
        visible = $11,
        tags = $12,
        allergens = $13,
        promo_start = $14,
        promo_end = $15,
        updated_at = NOW()
      WHERE id = $16
      RETURNING *;
    `;

    const params = [
      name ?? '',
      normPrice,
      category ?? '',
      normPrep,
      description ?? '',
      image ?? null,
      JSON.stringify(normIngredients),
      JSON.stringify(normExtras), // <- store as jsonb
      (discount_type && discount_type !== '') ? discount_type : 'none',
      normDiscountValue,
      normVisible,
      tags ?? '',
      allergens ?? '',
      promo_start || null,
      promo_end || null,
      id,
    ];

    const { rows } = await pool.query(sql, params);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Product not found' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /api/products/:id error:', err);
    res.status(500).json({ ok: false, error: 'Internal Server Error', detail: err.message });
  }
});


// DELETE /api/extras-groups/:groupId/items/:itemId
router.delete("/:groupId/items/:itemId", async (req, res) => {
  const { groupId, itemId } = req.params;
  try {
    await pool.query(
      "DELETE FROM extras_group_items WHERE group_id = $1 AND id = $2",
      [groupId, itemId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete extra item" });
  }
});

// DELETE /api/products/:id
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM products WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error deleting product:", err);
    res.status(500).json({ error: "Failed to delete product" });
  }
});

// DELETE /api/products (all or by category)
router.delete("/", async (req, res) => {
  const { category } = req.query;
  try {
    if (category) {
      await pool.query("DELETE FROM products WHERE category = $1", [category]);
      return res.json({
        success: true,
        message: `Deleted products in category: ${category}`,
      });
    } else {
      await pool.query("DELETE FROM products");
      return res.json({ success: true, message: "Deleted all products" });
    }
  } catch (err) {
    console.error("❌ Error deleting products:", err);
    res.status(500).json({ error: "Failed to delete products" });
  }
});

module.exports = router;
