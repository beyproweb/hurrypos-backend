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
        const candidates = Object.entries(prices).filter(([key]) =>
          key.startsWith(`${ing.ingredient}__`)
        );
        for (const [key, basePrice] of candidates) {
          const supplierUnit = key.split("__")[1];
          const converted = convertPrice(basePrice, supplierUnit, ing.unit);
          if (converted !== null) {
            totalCost += parseFloat(ing.quantity) * converted;
            break; // stop once we found a valid conversion
          }
        }
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

    let parsedIngredients = "[]";
    let parsedExtras = "[]";
    let parsedGroup = "[]";

    try {
      parsedIngredients = JSON.stringify(
        Array.isArray(ingredients) ? ingredients : []
      );
    } catch {
      return res.status(400).json({ error: "Invalid ingredients format" });
    }

    try {
      parsedExtras = JSON.stringify(Array.isArray(extras) ? extras : []);
    } catch {
      return res.status(400).json({ error: "Invalid extras format" });
    }

    try {
      parsedGroup = JSON.stringify(
        Array.isArray(selectedExtrasGroup) ? selectedExtrasGroup : []
      );
    } catch {
      return res
        .status(400)
        .json({ error: "Invalid selectedExtrasGroup format" });
    }

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
        parsedIngredients,
        parsedExtras,
        parsedGroup,
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
// PUT /api/products/:id  — robust to TEXT vs JSON(B) vs INT[] schemas
router.put("/:id", async (req, res) => {
  const { id } = req.params;
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
    image,
    ingredients,
    extras,
    selectedExtrasGroup,
  } = req.body;

  // Normalize inputs
  const safeNumber = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const prepTime = preparation_time !== null && preparation_time !== undefined
    ? (Number.isFinite(Number(preparation_time)) ? Number(preparation_time) : null)
    : null;

  const ingArr   = Array.isArray(ingredients) ? ingredients : [];
  const extraArr = Array.isArray(extras) ? extras : [];
  const groupArr = Array.isArray(selectedExtrasGroup)
    ? selectedExtrasGroup.map(n => Number(n)).filter(n => Number.isFinite(n))
    : [];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Look up actual column types so we cast correctly
    const typeRes = await client.query(
      `
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'products'
        AND column_name IN ('ingredients','extras','selected_extras_group')
      `
    );

    const col = {};
    for (const r of typeRes.rows) {
      col[r.column_name] = { data_type: r.data_type, udt_name: r.udt_name };
    }
    const isJsonLike  = (c) => c && (c.data_type === "json" || c.data_type === "jsonb");
    const isIntArray  = (c) => c && c.data_type === "ARRAY" && c.udt_name === "_int4"; // integer[]
    const isTextLike  = (c) => c && (c.data_type === "text" || c.data_type.startsWith("character"));

    // Build dynamic SET parts & values for the 3 tricky columns
    const setParts = [
      "name = $1",
      "price = $2",
      "category = $3",
      "preparation_time = $4",
      "description = $5",
      "discount_type = $6",
      "discount_value = $7",
      "visible = $8",
      "tags = $9",
      "allergens = $10",
      "promo_start = $11",
      "promo_end = $12",
      "image = $13",
    ];
    const vals = [
      name,
      safeNumber(price, 0),
      category,
      prepTime,
      description,
      discount_type || "none",
      safeNumber(discount_value, 0),
      typeof visible === "boolean" ? visible : visible === "true",
      tags,
      allergens,
      promo_start || null,
      promo_end || null,
      image || null,
    ];

    // ingredients
    if (isJsonLike(col.ingredients)) {
      setParts.push(`ingredients = $${vals.length + 1}::jsonb`);
      vals.push(JSON.stringify(ingArr));
    } else {
      // TEXT / VARCHAR fallback
      setParts.push(`ingredients = $${vals.length + 1}`);
      vals.push(JSON.stringify(ingArr));
    }

    // extras
    if (isJsonLike(col.extras)) {
      setParts.push(`extras = $${vals.length + 1}::jsonb`);
      vals.push(JSON.stringify(extraArr));
    } else {
      // TEXT / VARCHAR fallback
      setParts.push(`extras = $${vals.length + 1}`);
      vals.push(JSON.stringify(extraArr));
    }

    // selected_extras_group
    if (isIntArray(col.selected_extras_group)) {
      setParts.push(`selected_extras_group = $${vals.length + 1}::int[]`);
      vals.push(groupArr);
    } else if (isJsonLike(col.selected_extras_group)) {
      setParts.push(`selected_extras_group = $${vals.length + 1}::jsonb`);
      vals.push(JSON.stringify(groupArr));
    } else if (isTextLike(col.selected_extras_group)) {
      setParts.push(`selected_extras_group = $${vals.length + 1}`);
      vals.push(JSON.stringify(groupArr)); // store as JSON string in TEXT
    } else {
      // Safe default: store JSON string
      setParts.push(`selected_extras_group = $${vals.length + 1}`);
      vals.push(JSON.stringify(groupArr));
    }

    // WHERE id
    const sql = `
      UPDATE products
      SET ${setParts.join(", ")}
      WHERE id = $${vals.length + 1}
      RETURNING *
    `;
    vals.push(id);

    const result = await client.query(sql, vals);
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
