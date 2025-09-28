module.exports = (io) => {
  const express = require('express');
  const router = express.Router();
  const { pool } = require("../db");


  const { emitAlert, emitStockUpdate } = require('../utils/realtime');
// GET /stock - Returns all stock items + latest price per unit
router.get("/", async (req, res) => {
  try {
    const notifRes = await pool.query(`SELECT value FROM settings WHERE restaurant_id = $1 AND key = 'notifications'`);
    let cooldownMinutes = 30;
    let stockAlertEnabled = true;

    if (notifRes.rows[0]) {
      const config = JSON.parse(notifRes.rows[0].value);
      cooldownMinutes = config.stockAlert?.cooldownMinutes ?? 30;
      stockAlertEnabled = config.stockAlert?.enabled !== false;
    }

    // 🟢 JOIN latest price per unit per (name, unit)
// 🟢 JOIN latest price per unit per (name, unit), fallback to transactions if missing
const result = await pool.query(`
  SELECT s.*, sp.name AS supplier_name,
    COALESCE(
  NULLIF(ip1.price_per_unit, 0),
  NULLIF(ip2.price_per_unit, 0),
  (SELECT ROUND(total_cost / NULLIF(quantity, 0), 4)
   FROM transactions
   WHERE LOWER(ingredient) = LOWER(s.name) AND unit = s.unit AND quantity > 0
   ORDER BY delivery_date DESC LIMIT 1),
  0
) AS price_per_unit
  FROM stock WHERE restaurant_id = $1 WHERE restaurant_id = $1 s
  LEFT JOIN suppliers sp ON s.supplier_id = sp.id
LEFT JOIN LATERAL (
  SELECT price AS price_per_unit
  FROM ingredient_price_history
  WHERE LOWER(ingredient_name) = LOWER(s.name) AND unit = s.unit
  ORDER BY changed_at DESC
  LIMIT 1
) ip1 ON true
LEFT JOIN LATERAL (
  SELECT ROUND(total_cost / NULLIF(quantity, 0), 4) AS price_per_unit
  FROM transactions
  WHERE LOWER(ingredient) = LOWER(s.name) AND unit = s.unit
  ORDER BY delivery_date DESC
  LIMIT 1
) ip2 ON true

  ORDER BY s.name ASC
`);


    const stockItems = result.rows;
    const io = req.app.get("io");

    res.json(stockItems);
  } catch (error) {
    console.error("❌ Error fetching stock:", error);
    res.status(500).json({ error: "Database error" });
  }
});


// GET /stock/:id - Fetch stock by ID
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM stock WHERE restaurant_id = $1 WHERE restaurant_id = $1 WHERE restaurant_id = $1 AND id = $1", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Stock item not found." });
    }

    res.json({ stock: result.rows[0] });
  } catch (error) {
    console.error("❌ Error fetching stock by ID:", error);
    res.status(500).json({ error: "Database error fetching stock." });
  }
});

// POST /stock - Add or merge quantity if item already exists
// stock.js
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
      console.log("🧾 from_production flow for:", { name: trimmedName, quantity: parsedQty, unit: trimmedUnit });

      // 1) Find recipe by product name
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
            [recipe.name, parsedQty, 'system']
          );
          const productionId = prodLog.rows[0].id;

          // 3) Fetch ingredients
          const ingsRes = await client.query(
            `SELECT ingredient_name, amount_per_batch, unit
             FROM recipe_ingredients
             WHERE recipe_id = $1`,
            [recipe.id]
          );

          // 4) Deduct each ingredient by (name, unit)
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

            const upd = await client.query(
              `UPDATE stock
               SET quantity = quantity - $1
               WHERE LOWER(name) = LOWER($2) AND LOWER(unit) = LOWER($3)
               RETURNING id, name, quantity, unit`,
              [quantityUsed, ingName, ingUnit]
            );

            if (upd.rowCount === 0) {
              console.warn(`⚠️ No stock row matched for ingredient "${ingName}" (${igUnit}). Deduction skipped!`);
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


// PATCH /stock/:id - Update stock item
// PATCH /stock/:id - Update stock item and emit alerts only when needed
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, critical_quantity, reorder_quantity } = req.body;

    const updateRes = await pool.query(
      `UPDATE stock
       SET quantity = COALESCE($1, quantity),
           critical_quantity = COALESCE($2, critical_quantity),
           reorder_quantity = COALESCE($3, reorder_quantity)
       WHERE restaurant_id = $1 AND id = $4
       RETURNING *`,
      [quantity, critical_quantity, reorder_quantity, id]
    );

    const updated = updateRes.rows[0];
    const io = req.app.get("io");

    // >>> ADD THIS LOG BEFORE THE IF!
    console.log(">> PATCHED STOCK", {
      id: updated.id,
      name: updated.name,
      db_quantity: updated.quantity,
      db_critical: updated.critical_quantity,
      db_reorder: updated.reorder_quantity,
      received: { quantity, critical_quantity, reorder_quantity }
    });

    // 🟢 EMIT Stock Low alert if now below or equal to critical (and critical is set)
    if (
      updated.critical_quantity &&
      updated.quantity <= updated.critical_quantity
    ) {
      console.log(">>>> ABOUT TO EMIT ALERT", updated);
      emitAlert(
        io,
        `🧂 Stock Low: ${updated.name} (${updated.quantity} ${updated.unit})`,
        updated.id,
        "stock",
        { stockId: updated.id }
      );
    }

    // Always emit stock update event for UI refresh
    emitStockUpdate(io, id);

    res.json({ success: true, stock: updated });
  } catch (error) {
    console.error("❌ Error updating stock:", error);
    res.status(500).json({ error: "Database error updating stock." });
  }
});

// DELETE /stock/:id
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const delRes = await pool.query("DELETE FROM stock WHERE restaurant_id = $1 WHERE restaurant_id = $1 WHERE restaurant_id = $1 AND id = $1 RETURNING *", [id]);
    if (delRes.rows.length === 0) {
      return res.status(404).json({ error: "Stock item not found." });
    }
    // Optionally emit event for real-time update:
    const io = req.app.get("io");
    emitStockUpdate(io, id);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ Error deleting stock:", error);
    res.status(500).json({ error: "Database error deleting stock." });
  }
});


// PATCH /stock/:id/flag-auto-added
router.patch("/:id/flag-auto-added", async (req, res) => {
  const { id } = req.params;
  const { last_auto_add_at } = req.body;

  try {
    const result = await pool.query(
      `UPDATE stock SET last_auto_add_at = $1 WHERE restaurant_id = $1 AND id = $2 RETURNING *`,
      [last_auto_add_at, id]
    );
    res.json({ updated: result.rows[0] });
  } catch (err) {
    console.error("❌ Error updating auto-add timestamp:", err);
    res.status(500).json({ error: "Failed to update auto-add timestamp" });
  }
});

 return router;
};
