const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Storage for uploaded product images
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "..", "public", "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `product_${Date.now()}${ext}`);
  }
});

const upload = multer({ storage });
// GET /api/products - fetch all products
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY name ASC');
    const products = result.rows.map(product => ({
      ...product,
      ingredients: typeof product.ingredients === "string" ? JSON.parse(product.ingredients) : product.ingredients || [],
      extras: typeof product.extras === "string" ? JSON.parse(product.extras) : product.extras || [],
      selectedExtrasGroup: (() => {
        // For text[], jsonb, or stringified arrays
        if (Array.isArray(product.selected_extras_group)) return product.selected_extras_group;
        if (typeof product.selected_extras_group === "string" && product.selected_extras_group.trim()) {
          try { return JSON.parse(product.selected_extras_group); } catch { return []; }
        }
        return [];
      })(),
    }));
    res.json(products);
  } catch (err) {
    console.error('❌ Error fetching products:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// GET /api/products/costs
router.get("/costs", async (req, res) => {
  try {
    // 1. Get all products with their ingredients (as JSON)
    const productsRes = await pool.query("SELECT id, ingredients FROM products");
    // 2. Get all latest ingredient prices (includes production/supplier!)
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
    pricesRes.rows.forEach(p => {
      prices[`${p.name}__${p.unit}`] = parseFloat(p.price_per_unit);
    });

    // 3. Calculate cost for each product
    const costs = {};
    productsRes.rows.forEach(prod => {
      let totalCost = 0;
      let ingredientsArr = [];
      if (Array.isArray(prod.ingredients)) {
        ingredientsArr = prod.ingredients;
      } else if (typeof prod.ingredients === "string") {
        try {
          ingredientsArr = JSON.parse(prod.ingredients);
        } catch { ingredientsArr = []; }
      }
      ingredientsArr.forEach(ing => {
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




// GET /api/products/:id - fetch product by ID
// GET /api/products/:id - fetch product by ID (with mapped fields)
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Product not found' });

    const product = result.rows[0];

    // Patch: ensure correct fields/array mapping
    const mappedProduct = {
      ...product,
      ingredients: typeof product.ingredients === "string"
        ? JSON.parse(product.ingredients)
        : product.ingredients || [],
      extras: typeof product.extras === "string"
        ? JSON.parse(product.extras)
        : product.extras || [],
      selectedExtrasGroup: (() => {
        if (Array.isArray(product.selected_extras_group)) return product.selected_extras_group;
        if (typeof product.selected_extras_group === "string" && product.selected_extras_group.trim()) {
          try { return JSON.parse(product.selected_extras_group); } catch { return []; }
        }
        return [];
      })(),
    };

    res.json(mappedProduct);
  } catch (err) {
    console.error('❌ Error fetching product:', err);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// POST /api/products - create new product
// POST /api/products - create new product
router.post("/", upload.single("image"), async (req, res) => {
  try {
    const {
      name,
      price,
      category,
      preparationTime,
      description,
      discountType,
      discountValue,
      visible,
      tags,
      allergens,
      promoStart,
      promoEnd,
    } = req.body;

    // Always store JSON columns as stringified JSON
    let parsedIngredients, parsedExtras, parsedGroup;
    try {
      parsedIngredients = req.body.ingredients ? JSON.stringify(JSON.parse(req.body.ingredients)) : "[]";
    } catch (err) {
      console.error("❌ Invalid JSON in ingredients:", req.body.ingredients);
      return res.status(400).json({ error: "Invalid JSON in ingredients" });
    }
    try {
      parsedExtras = req.body.extras ? JSON.stringify(JSON.parse(req.body.extras)) : "[]";
    } catch (err) {
      console.error("❌ Invalid JSON in extras:", req.body.extras);
      return res.status(400).json({ error: "Invalid JSON in extras" });
    }
    // --- THIS PART IS CHANGED ---
    try {
      const groupArr = req.body.selectedExtrasGroup ? JSON.parse(req.body.selectedExtrasGroup) : [];
      if (Array.isArray(groupArr) && groupArr.length) {
        parsedGroup = `{${groupArr.map((g) => `"${g}"`).join(",")}}`;
      } else {
        parsedGroup = null;
      }
    } catch (err) {
      console.error("❌ Invalid JSON in selectedExtrasGroup:", req.body.selectedExtrasGroup);
      return res.status(400).json({ error: "Invalid JSON in selectedExtrasGroup" });
    }
    // ---------------------------

    const imageFile = req.file ? req.file.filename : null;

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
        price,
        category,
        preparationTime || null,
        description,
        discountType,
        discountValue,
        visible === "true", // from FormData
        tags,
        allergens,
        promoStart || null,
        promoEnd || null,
        imageFile,
        parsedIngredients,
        parsedExtras,
        parsedGroup
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error creating product:", err);
    res.status(500).json({ error: "Failed to create product" });
  }
});




router.put("/:id", upload.single("image"), async (req, res) => {
  const { id } = req.params;
  const imageFilename = req.file ? req.file.filename : req.body.existingImage || null;

  let parsedIngredients = [];
  let parsedExtras = [];
  let selectedExtrasGroupArray = [];

  // ✅ Safely parse JSON fields
  try {
    parsedIngredients = JSON.parse(req.body.ingredients || "[]");
    parsedExtras = JSON.parse(req.body.extras || "[]");
    selectedExtrasGroupArray = JSON.parse(req.body.selectedExtrasGroup || "[]");
  } catch (e) {
    console.error("❌ Invalid JSON format:", e);
    return res.status(400).json({ error: "Invalid JSON format in ingredients/extras/groups" });
  }

  // ✅ Convert selectedExtrasGroupArray to PostgreSQL-compatible text[]
  const pgExtrasGroup = selectedExtrasGroupArray.length
    ? `{${selectedExtrasGroupArray.map((g) => `"${g}"`).join(",")}}`
    : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE products SET
        name = $1,
        price = $2,
        category = $3,
        preparation_time = $4,
        description = $5,
        discount_type = $6,
        discount_value = $7,
        visible = $8,
        tags = $9,
        allergens = $10,
        promo_start = $11,
        promo_end = $12,
        image = $13,
        ingredients = $14,
        extras = $15,
        selected_extras_group = $16
      WHERE id = $17
      RETURNING *`,
      [
        req.body.name,
        parseFloat(req.body.price) || 0,
        req.body.category,
        parseInt(req.body.preparationTime) || 0,
        req.body.description,
        req.body.discountType || "none",
        parseFloat(req.body.discountValue) || 0,
        req.body.visible === "true",
        req.body.tags,
        req.body.allergens,
        req.body.promoStart || null,
        req.body.promoEnd || null,
        imageFilename,
        JSON.stringify(parsedIngredients),
        JSON.stringify(parsedExtras),
        pgExtrasGroup,
        id,
      ]
    );

    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Error updating product:", err);
    res.status(500).json({ error: "Failed to update product" });
  } finally {
    client.release();
  }
});


// DELETE /api/extras-groups/:groupId/items/:itemId
router.delete("/:groupId/items/:itemId", async (req, res) => {
  const { groupId, itemId } = req.params;
  try {
    await pool.query("DELETE FROM extras_group_items WHERE group_id = $1 AND id = $2", [groupId, itemId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete extra item" });
  }
});


// DELETE /api/products/:id - delete product
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM products WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error deleting product:', err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// DELETE /api/products - delete all or by category
router.delete("/", async (req, res) => {
  const { category } = req.query;

  try {
    if (category) {
      await pool.query("DELETE FROM products WHERE category = $1", [category]);
      return res.json({ success: true, message: `Deleted products in category: ${category}` });
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
