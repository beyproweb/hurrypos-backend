const express = require("express");
const router = express.Router();
const { pool } = require("../db");

router.post('/production-log', async (req, res) => {
  const { product_name, base_quantity, batch_count, ingredients, produced_by, product_unit } = req.body;
  console.log('📥 Incoming production request:', req.body);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Log production
    const result = await client.query(
      `INSERT INTO production_logs (product_name, quantity_produced, produced_by)
       VALUES ($1, $2, $3) RETURNING id`,
      [product_name, base_quantity * batch_count, produced_by || 'system']
    );

    const productionId = result.rows[0].id;

    // 2. Deduct ingredients and log usage
    for (const ing of ingredients) {
      const quantityUsed = parseFloat(ing.amountPerBatch) * batch_count;

      await client.query(
        `INSERT INTO ingredient_usages (production_id, ingredient_name, quantity_used, unit)
         VALUES ($1, $2, $3, $4)`,
        [productionId, ing.name, quantityUsed, ing.unit]
      );

      await client.query(
        `UPDATE stock
         SET quantity = quantity - $1
         WHERE LOWER(name) = LOWER($2)`,
        [quantityUsed, ing.name]
      );
    }

    // 3. Add finished product to stock (only once!)
    const producedQty = base_quantity * batch_count;
    console.log(`📦 Adding to stock → ${product_name}: +${producedQty} ${product_unit}`);



    await client.query('COMMIT');
    res.status(200).json({ message: 'Production logged and stock updated.' });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Production logging failed:', err);
    res.status(500).json({ error: 'Internal error during production log.' });
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