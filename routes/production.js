const express = require("express");
const router = express.Router();
const { pool } = require("../db");

const normalizeUnit = (unit) => (unit || "").trim().toLowerCase();

const UNIT_CONVERSIONS = {
  g: { g: 1, kg: 1 / 1000, mg: 1000 },
  kg: { kg: 1, g: 1000 },
  mg: { mg: 1, g: 1 / 1000 },
  ml: { ml: 1, l: 1 / 1000 },
  l: { l: 1, ml: 1000 },
  lt: { lt: 1, l: 1, ml: 1000 },
  pcs: { pcs: 1, piece: 1 },
  piece: { pcs: 1, piece: 1 },
  unit: { unit: 1 },
};

const convertQuantity = (value, fromUnit, toUnit) => {
  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(toUnit);
  if (!UNIT_CONVERSIONS[from]) return null;
  const factor = UNIT_CONVERSIONS[from][to];
  if (typeof factor !== "number") return null;
  return value * factor;
};

// Legacy stub for backward compatibility
router.post("/production-log", (req, res) => {
  console.info("[production-log] Compatibility endpoint hit", {
    restaurant_id: req.body?.restaurant_id ?? null,
    product_name: req.body?.product_name,
    batch_count: req.body?.batch_count,
  });
  return res
    .status(200)
    .json({ ok: true, message: "production-log handled by compatibility stub" });
});

// ✅ POST /production — Add finished stock & deduct ingredients
router.post("/", async (req, res) => {
  const {
    name,
    quantity,
    unit,
    supplier_id,
    from_production,
    restaurant_id,
    batch_count,
  } = req.body;

  const trimmedName = (name || "").trim();
  const trimmedUnit = (unit || "").trim();
  const parsedQty = parseFloat(quantity);

  if (!trimmedName || !parsedQty || parsedQty <= 0 || !trimmedUnit) {
    return res.status(400).json({ error: "Missing or invalid fields." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (from_production) {
      // 1️⃣ Find matching recipe
      const recipeRes = await client.query(
        `SELECT id, name, base_quantity, output_unit
         FROM recipes
         WHERE LOWER(name) = LOWER($1)
           AND ($2::int IS NULL OR restaurant_id = $2)
         ORDER BY created_at DESC
         LIMIT 1`,
        [trimmedName, restaurant_id || null]
      );

      if (recipeRes.rows.length) {
        const recipe = recipeRes.rows[0];

        if (!recipe.base_quantity || Number(recipe.base_quantity) <= 0) {
          console.warn("⚠️ Invalid base_quantity, skipping deduction:", recipe);
        } else {
          const batchesRequested = Number(batch_count) || 0;
          const baseQty = Number(recipe.base_quantity) || 1;
          const inferredBatches = baseQty !== 0 ? parsedQty / baseQty : 1;
          const batchCount =
            batchesRequested > 0
              ? batchesRequested
              : inferredBatches > 0
              ? inferredBatches
              : 1;

          console.log("[production] recipe match", {
            stockName: trimmedName,
            recipeName: recipe.name,
            batchCount,
            parsedQty,
            restaurant_id,
          });

          // 2️⃣ Log production
          const prodLog = await client.query(
            `INSERT INTO production_logs (product_name, quantity_produced, produced_by)
             VALUES ($1, $2, $3)
             RETURNING id`,
            [recipe.name, parsedQty, "system"]
          );
          const productionId = prodLog.rows[0].id;

          // 3️⃣ Fetch ingredients
          const ingsRes = await client.query(
            `SELECT ingredient_name, amount_per_batch, unit
             FROM recipe_ingredients
             WHERE recipe_id = $1`,
            [recipe.id]
          );

          // 4️⃣ Deduct each ingredient (tenant-safe)
          for (const row of ingsRes.rows) {
            const ingName = row.ingredient_name;
            const ingUnit = row.unit;
            const amountPerBatch = Number(row.amount_per_batch) || 0;
            const quantityUsed = amountPerBatch * batchCount;

            await client.query(
              `INSERT INTO ingredient_usages (production_id, ingredient_name, quantity_used, unit)
               VALUES ($1, $2, $3, $4)`,
              [productionId, ingName, quantityUsed, ingUnit]
            );

            // Tenant-safe lookup
            const stockRes = await client.query(
              `SELECT id, unit
               FROM stock
               WHERE LOWER(name) = LOWER($1)
                 AND restaurant_id = $2
               LIMIT 1`,
              [ingName, restaurant_id]
            );

            if (stockRes.rows.length === 0) {
              console.warn(
                `⚠️ No stock found for ${ingName} in restaurant ${restaurant_id}`
              );
              continue;
            }

            const stockRow = stockRes.rows[0];
            const adjusted = convertQuantity(
              quantityUsed,
              normalizeUnit(ingUnit),
              normalizeUnit(stockRow.unit)
            );

            if (adjusted == null) {
              console.warn(
                `⚠️ Unit conversion failed for ${ingName}: ${ingUnit} → ${stockRow.unit}`
              );
              continue;
            }

            const updateRes = await client.query(
              `UPDATE stock
               SET quantity = quantity - $1
               WHERE id = $2 AND restaurant_id = $3
               RETURNING id, name, quantity, unit`,
              [adjusted, stockRow.id, restaurant_id]
            );

            if (updateRes.rowCount > 0) {
              console.log("📉 Stock deducted:", updateRes.rows[0]);
            }
          }
        }
      } else {
        console.warn(
          `⚠️ from_production=true but no recipe found for "${trimmedName}". Skipping deduction.`
        );
      }
    }

    // 5️⃣ Upsert finished product stock (tenant-safe)
    const upsertRes = await client.query(
      `INSERT INTO stock (name, quantity, unit, supplier_id, restaurant_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name, unit, restaurant_id)
       DO UPDATE SET
         quantity = stock.quantity + EXCLUDED.quantity,
         supplier_id = EXCLUDED.supplier_id
       RETURNING *`,
      [trimmedName, parsedQty, trimmedUnit, supplier_id || null, restaurant_id]
    );

    await client.query("COMMIT");
    return res.json(upsertRes.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error inserting/updating stock:", error);
    return res.status(500).json({ error: "Internal stock insert error." });
  } finally {
    client.release();
  }
});

// ✅ GET /production/recipes
router.get("/recipes", async (req, res) => {
  const { restaurant_id } = req.query;
  try {
    let recipeQuery = `SELECT * FROM recipes`;
    const params = [];
    if (restaurant_id) {
      recipeQuery += ` WHERE restaurant_id = $1`;
      params.push(restaurant_id);
    }
    recipeQuery += ` ORDER BY id`;

    const recipesRes = await pool.query(recipeQuery, params);
    const ingredientsRes = await pool.query(`SELECT * FROM recipe_ingredients`);

    const recipes = recipesRes.rows.map((r) => ({
      ...r,
      ingredients: ingredientsRes.rows
        .filter((i) => i.recipe_id === r.id)
        .map((i) => ({
          name: i.ingredient_name,
          amountPerBatch: parseFloat(i.amount_per_batch),
          unit: i.unit,
        })),
    }));

    res.json(recipes);
  } catch (err) {
    console.error("❌ Failed to fetch recipes:", err);
    res.status(500).json({ error: "Failed to fetch recipes" });
  }
});

// ✅ POST /production/recipes
router.post("/recipes", async (req, res) => {
  const { name, emoji, base_quantity, output_unit, ingredients, restaurant_id } =
    req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const recipeRes = await client.query(
      `INSERT INTO recipes (name, emoji, base_quantity, output_unit, restaurant_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, emoji, base_quantity, output_unit, restaurant_id || null]
    );
    const recipeId = recipeRes.rows[0].id;

    for (const ing of ingredients) {
      await client.query(
        `INSERT INTO recipe_ingredients (recipe_id, ingredient_name, amount_per_batch, unit)
         VALUES ($1, $2, $3, $4)`,
        [recipeId, ing.name, ing.amountPerBatch, ing.unit]
      );
    }

    await client.query("COMMIT");
    res.status(200).json({ message: "Recipe created." });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to create recipe:", err);
    res.status(500).json({ error: "Failed to create recipe" });
  } finally {
    client.release();
  }
});

router.put("/recipes/:id", async (req, res) => {
  const recipeId = parseInt(req.params.id, 10);
  const { name, emoji, base_quantity, output_unit, ingredients, restaurant_id } =
    req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (!name || !base_quantity || !output_unit || !Array.isArray(ingredients)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Invalid recipe payload." });
    }

    const updateValues = [name, emoji || null, base_quantity, output_unit, recipeId];
    let updateQuery = `
      UPDATE recipes
      SET name = $1, emoji = $2, base_quantity = $3, output_unit = $4
      WHERE id = $5
    `;
    if (restaurant_id) {
      updateQuery += ` AND (restaurant_id = $6 OR restaurant_id IS NULL)`;
      updateValues.push(restaurant_id);
    }

    const updateRes = await client.query(updateQuery, updateValues);
    if (updateRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Recipe not found for update." });
    }

    await client.query(`DELETE FROM recipe_ingredients WHERE recipe_id = $1`, [
      recipeId,
    ]);

    for (const ing of ingredients) {
      await client.query(
        `INSERT INTO recipe_ingredients (recipe_id, ingredient_name, amount_per_batch, unit)
         VALUES ($1, $2, $3, $4)`,
        [recipeId, ing.name, ing.amountPerBatch, ing.unit]
      );
    }

    await client.query("COMMIT");
    res.status(200).json({ message: "Recipe updated." });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to update recipe:", err);
    res.status(500).json({ error: "Failed to update recipe" });
  } finally {
    client.release();
  }
});

// ✅ Production history
router.get("/production-log/history", async (req, res) => {
  const { product, limit } = req.query;
  if (!product) return res.status(400).json({ error: "Missing 'product'" });
  try {
    const result = await pool.query(
      `SELECT quantity_produced, created_at
       FROM production_logs
       WHERE LOWER(product_name) = LOWER($1)
       ORDER BY created_at DESC
       LIMIT $2`,
      [product, limit || 5]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Failed to fetch production history:", err);
    res.status(500).json({ error: "Could not fetch history" });
  }
});

router.get("/production-log/unstocked", async (req, res) => {
  const { product } = req.query;
  if (!product)
    return res.status(400).json({ error: "Missing product name in query." });
  try {
    const result = await pool.query(
      `SELECT product_name, quantity_produced, created_at, 'pcs' AS unit
       FROM production_logs
       WHERE product_name = $1 AND is_stocked = FALSE
       ORDER BY created_at DESC
       LIMIT 1`,
      [product]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Failed to fetch unstocked logs:", err);
    res.status(500).json({ error: "Failed to fetch unstocked logs." });
  }
});

router.delete("/recipes/:id", async (req, res) => {
  const recipeId = parseInt(req.params.id, 10);
  const { restaurant_id } = req.query;
  try {
    const params = [recipeId];
    let query = `DELETE FROM recipes WHERE id = $1`;
    if (restaurant_id) {
      query += ` AND restaurant_id = $2`;
      params.push(restaurant_id);
    }
    const result = await pool.query(query, params);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Recipe not found for deletion." });
    }
    res.status(200).json({ message: "Recipe deleted." });
  } catch (err) {
    console.error("❌ Failed to delete recipe:", err);
    res.status(500).json({ error: "Failed to delete recipe" });
  }
});

module.exports = router;
