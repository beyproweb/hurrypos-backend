const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// POST /stock - Add or merge quantity; if from_production, also log production & deduct ingredients
router.post("/", async (req, res) => {
  const { name, quantity, unit, supplier_id, from_production } = req.body;

  const trimmedName = (name || '').trim();
  const trimmedUnit = (unit || '').trim();
  const parsedQty = parseFloat(quantity);

  if (!trimmedName || !parsedQty || parsedQty <= 0 || !trimmedUnit) {
    return res.status(400).json({ error: "Missing or invalid fields." });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (from_production) {
      // 1) Try to find a recipe by product name (case-insensitive)
      const recipeRes = await client.query(
        `SELECT id, name, base_quantity, output_unit
         FROM recipes
         WHERE LOWER(name) = LOWER($1)
         LIMIT 1`,
        [trimmedName]
      );

      if (recipeRes.rows.length) {
        const recipe = recipeRes.rows[0];

        if (!recipe.base_quantity || Number(recipe.base_quantity) <= 0) {
          console.warn("⚠️ Recipe has invalid base_quantity, skipping deduction:", recipe);
        } else {
          const batchCount = parsedQty / Number(recipe.base_quantity);

          // 2) Log production
          const prodLog = await client.query(
            `INSERT INTO production_logs (product_name, quantity_produced, produced_by)
             VALUES ($1, $2, $3)
             RETURNING id`,
            [recipe.name, parsedQty, 'system'] // produced_by can be adapted
          );
          const productionId = prodLog.rows[0].id;

          // 3) Fetch ingredients for that recipe
          const ingsRes = await client.query(
            `SELECT ingredient_name, amount_per_batch, unit
             FROM recipe_ingredients
             WHERE recipe_id = $1`,
            [recipe.id]
          );

          // 4) Deduct each ingredient
          for (const row of ingsRes.rows) {
            const ingName = row.ingredient_name;
            const ingUnit = row.unit;
            const amountPerBatch = Number(row.amount_per_batch) || 0;
            const quantityUsed = amountPerBatch * batchCount;

            // Insert usage log
            await client.query(
              `INSERT INTO ingredient_usages (production_id, ingredient_name, quantity_used, unit)
               VALUES ($1, $2, $3, $4)`,
              [productionId, ingName, quantityUsed, ingUnit]
            );

            // Deduct from stock by (name, unit)
            const upd = await client.query(
              `UPDATE stock
               SET quantity = quantity - $1
               WHERE LOWER(name) = LOWER($2) AND LOWER(unit) = LOWER($3)
               RETURNING id, name, quantity, unit`,
              [quantityUsed, ingName, ingUnit]
            );

            if (upd.rowCount === 0) {
              console.warn(`⚠️ No stock row matched for ingredient "${ingName}" (${ingUnit}). Deduction skipped!`);
            } else {
              console.log("📉 Stock deducted:", upd.rows[0]);
            }
          }
        }
      } else {
        console.warn(`⚠️ from_production=true but no recipe found for "${trimmedName}". Skipping deduction.`);
      }
    }

    // 5) Upsert finished product stock
    const upsertRes = await client.query(
      `INSERT INTO stock (name, quantity, unit, supplier_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name, unit)
       DO UPDATE SET
         quantity = stock.quantity + EXCLUDED.quantity,
         supplier_id = EXCLUDED.supplier_id
       RETURNING *`,
      [trimmedName, parsedQty, trimmedUnit, supplier_id || null]
    );

    await client.query('COMMIT');
    return res.json(upsertRes.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("❌ Error inserting/updating stock (with production fallback):", error);
    return res.status(500).json({ error: "Internal stock insert error." });
  } finally {
    client.release();
  }
});


router.get('/recipes', async (req, res) => {
  try {
    const recipesRes = await pool.query(`SELECT * FROM recipes ORDER BY id`);
    const ingredientsRes = await pool.query(`SELECT * FROM recipe_ingredients`);

    const recipes = recipesRes.rows.map((r) => ({
      ...r,
      ingredients: ingredientsRes.rows
        .filter((i) => i.recipe_id === r.id)
        .map((i) => ({
          name: i.ingredient_name,
          amountPerBatch: parseFloat(i.amount_per_batch),
          unit: i.unit
        }))
    }));

    res.json(recipes);
  } catch (err) {
    console.error('❌ Failed to fetch recipes:', err);
    res.status(500).json({ error: 'Failed to fetch recipes' });
  }
});

router.post('/recipes', async (req, res) => {
  const { name, emoji, base_quantity, output_unit, ingredients } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const recipeRes = await client.query(
      `INSERT INTO recipes (name, emoji, base_quantity, output_unit)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, emoji, base_quantity, output_unit]
    );

    const recipeId = recipeRes.rows[0].id;

    for (const ing of ingredients) {
      await client.query(
        `INSERT INTO recipe_ingredients (recipe_id, ingredient_name, amount_per_batch, unit)
         VALUES ($1, $2, $3, $4)`,
        [recipeId, ing.name, ing.amountPerBatch, ing.unit]
      );
    }

    await client.query('COMMIT');
    res.status(200).json({ message: 'Recipe created.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to create recipe:', err);
    res.status(500).json({ error: 'Failed to create recipe' });
  } finally {
    client.release();
  }
});


router.put('/recipes/:id', async (req, res) => {
  const recipeId = parseInt(req.params.id);
  const { name, emoji, base_quantity, output_unit, ingredients } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE recipes
       SET name = $1, emoji = $2, base_quantity = $3, output_unit = $4
       WHERE id = $5`,
      [name, emoji, base_quantity, output_unit, recipeId]
    );

    await client.query(`DELETE FROM recipe_ingredients WHERE recipe_id = $1`, [recipeId]);

    for (const ing of ingredients) {
      await client.query(
        `INSERT INTO recipe_ingredients (recipe_id, ingredient_name, amount_per_batch, unit)
         VALUES ($1, $2, $3, $4)`,
        [recipeId, ing.name, ing.amountPerBatch, ing.unit]
      );
    }

    await client.query('COMMIT');
    res.status(200).json({ message: 'Recipe updated.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to update recipe:', err);
    res.status(500).json({ error: 'Failed to update recipe' });
  } finally {
    client.release();
  }
});

// GET /production-log/history?product=Buns&limit=5
router.get('/production-log/history', async (req, res) => {
  const { product, limit } = req.query;

  if (!product) {
    return res.status(400).json({ error: "Missing 'product' parameter" });
  }

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

// GET /production-log/unstocked?product=Buns
router.get('/production-log/unstocked', async (req, res) => {
  const { product } = req.query;

  if (!product) {
    return res.status(400).json({ error: 'Missing product name in query.' });
  }

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
    console.error('❌ Failed to fetch unstocked logs:', err);
    res.status(500).json({ error: 'Failed to fetch unstocked logs.' });
  }
});


router.delete('/recipes/:id', async (req, res) => {
  const recipeId = parseInt(req.params.id);
  try {
    await pool.query(`DELETE FROM recipes WHERE id = $1`, [recipeId]);
    res.status(200).json({ message: 'Recipe deleted.' });
  } catch (err) {
    console.error('❌ Failed to delete recipe:', err);
    res.status(500).json({ error: 'Failed to delete recipe' });
  }
});

module.exports = router;