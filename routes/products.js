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
router.put(
  "/api/products/:id",
  upload.single("image"), // ok if no file is sent
  async (req, res) => {
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);

      // If the form is multipart, non-file fields arrive as strings:
      const {
        name,
        price,
        category,
        preparation_time,
        description,
        visible,
        discount_type,
        discount_value,
        tags,
        allergens,
        promo_start,
        promo_end,
        // Arrays coming as JSON strings:
        ingredients,
        extras,
        extras_group_ids, // ← array of group IDs
      } = req.body;

      // Parse arrays that come as JSON strings (safe if already arrays)
      const parseMaybeJson = (v) => {
        if (v == null || v === "") return [];
        if (Array.isArray(v)) return v;
        try { return JSON.parse(v); } catch { return []; }
      };

      const ingredientsArr = parseMaybeJson(ingredients);       // [{id, qty}...]
      const extrasArr = parseMaybeJson(extras);                 // [extraId, ...] or [{id, price}...]
      const extrasGroupIds = parseMaybeJson(extras_group_ids);  // [groupId, ...]

      // Convert types that PG needs strictly
      const priceNum = price === "" || price == null ? null : Number(price);
      const prepTimeNum = preparation_time === "" || preparation_time == null ? null : Number(preparation_time);
      const visibleBool = typeof visible === "boolean"
        ? visible
        : String(visible).toLowerCase() !== "false"; // treat "true"/"1"/undefined as true

      // Optional: handle image upload if you store on Cloudinary/S3/etc.
      // If you store raw buffer in DB, do it here. Otherwise, use your existing uploader.
      let image_url = null;
      if (req.file) {
        // TODO: replace with your uploader; the line below is a placeholder
        // image_url = await uploadToCloud(req.file);
        // For now, prevent crashes if you haven't wired this yet:
        image_url = null;
      }

      await client.query("BEGIN");

      // 1) Update main product
      const updateSql = `
        UPDATE products SET
          name = $1,
          price = $2,
          category = $3,
          preparation_time = $4,
          description = $5,
          visible = $6,
          discount_type = $7,
          discount_value = $8,
          tags = $9,
          allergens = $10,
          promo_start = $11,
          promo_end = $12,
          image_url = COALESCE($13, image_url) -- keep old if no new image
        WHERE id = $14
        RETURNING id
      `;
      const updateVals = [
        name ?? "",
        priceNum,
        category ?? "",
        prepTimeNum,
        description ?? "",
        visibleBool,
        discount_type ?? "none",
        discount_value === "" || discount_value == null ? 0 : Number(discount_value),
        tags ?? "",
        allergens ?? "",
        promo_start || null,
        promo_end || null,
        image_url, // null will keep prior via COALESCE
        id,
      ];
      const upRes = await client.query(updateSql, updateVals);
      if (upRes.rowCount === 0) throw new Error("Product not found");

      // 2) Replace product_extras pivot (adapt table/columns to yours)
      // If your extras have prices per product, store them; otherwise store just extra_id.
      await client.query(`DELETE FROM product_extras WHERE product_id = $1`, [id]);
      for (const e of extrasArr) {
        const extraId = typeof e === "object" ? e.id : e;
        const extraPrice = typeof e === "object" && e.price != null ? Number(e.price) : null;
        await client.query(
          `INSERT INTO product_extras (product_id, extra_id, price_override) VALUES ($1, $2, $3)`,
          [id, Number(extraId), extraPrice]
        );
      }

      // 3) Replace product_extras_groups pivot (adapt table/columns to yours)
      await client.query(`DELETE FROM product_extras_groups WHERE product_id = $1`, [id]);
      for (const gid of extrasGroupIds) {
        await client.query(
          `INSERT INTO product_extras_groups (product_id, group_id) VALUES ($1, $2)`,
          [id, Number(gid)]
        );
      }

      // 4) Optionally replace product_ingredients pivot if you maintain costs
      await client.query(`DELETE FROM product_ingredients WHERE product_id = $1`, [id]);
      for (const ing of ingredientsArr) {
        if (!ing?.id) continue;
        await client.query(
          `INSERT INTO product_ingredients (product_id, ingredient_id, qty) VALUES ($1, $2, $3)`,
          [id, Number(ing.id), Number(ing.qty ?? 0)]
        );
      }

      await client.query("COMMIT");
      res.json({ ok: true, id });

    } catch (err) {
      await client.query("ROLLBACK");
      // Return the real error so you can see EXACTLY what broke
      console.error("PUT /api/products error:", err);
      res.status(400).json({ ok: false, error: String(err.message || err) });
    } finally {
      client.release();
    }
  }
);


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
