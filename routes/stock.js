// routes/stock.js
module.exports = (io) => {
  const express = require("express");
  const router = express.Router();
  const { pool } = require("../db");
  const authMiddleware = require("../middleware/authMiddleware");
  const {
    emitAlert,
    emitStockUpdate,
  } = require("../utils/realtime");
  const { maybeEmitExpiryAlert, normalizeExpiryDate } = require("../utils/expiryMonitor");

  // ---------- helpers for unit conversion ----------
  const normalizeUnit = (unit) => (unit || "").trim().toLowerCase();
  const UNIT_CONVERSIONS = {
    g: { g: 1, kg: 1 / 1000, mg: 1000 },
    kg: { kg: 1, g: 1000 },
    mg: { mg: 1, g: 1 / 1000 },
    ml: { ml: 1, l: 1 / 1000 },
    l: { l: 1, ml: 1000 },
    lt: { lt: 1, l: 1, ml: 1000 },
    pcs: { pcs: 1, piece: 1, unit: 1 },
    piece: { pcs: 1, piece: 1, unit: 1 },
    unit: { unit: 1, pcs: 1, piece: 1 },
  };
  const convertQuantity = (value, fromUnit, toUnit) => {
    const from = normalizeUnit(fromUnit);
    const to = normalizeUnit(toUnit);
    if (!UNIT_CONVERSIONS[from]) return null;
    const factor = UNIT_CONVERSIONS[from][to];
    if (typeof factor !== "number") return null;
    return value * factor;
  };

  // ✅ protect all stock routes
  router.use(authMiddleware);

  // ==============================
  // GET /stock - list all stock with price per unit
  // ==============================
  router.get("/", async (req, res) => {
    try {
      const restaurantId = req.user.restaurant_id;

      const notifRes = await pool.query(
        `SELECT value FROM settings WHERE restaurant_id = $1 AND key = 'notifications'`,
        [restaurantId]
      );
      let cooldownMinutes = 30;
      let stockAlertEnabled = true;

      if (notifRes.rows[0]) {
        const config = JSON.parse(notifRes.rows[0].value);
        cooldownMinutes = config.stockAlert?.cooldownMinutes ?? 30;
        stockAlertEnabled = config.stockAlert?.enabled !== false;
      }

      const result = await pool.query(
        `
        SELECT s.*, sp.name AS supplier_name,
          COALESCE(
            NULLIF(ip1.price_per_unit, 0),
            NULLIF(ip2.price_per_unit, 0),
            (SELECT ROUND(total_cost / NULLIF(quantity, 0), 4)
             FROM transactions
             WHERE restaurant_id = s.restaurant_id
               AND LOWER(ingredient) = LOWER(s.name)
               AND unit = s.unit
               AND quantity > 0
             ORDER BY delivery_date DESC LIMIT 1),
            0
          ) AS price_per_unit
        FROM stock s
        LEFT JOIN suppliers sp
          ON s.supplier_id = sp.id
         AND sp.restaurant_id = s.restaurant_id
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
          WHERE restaurant_id = s.restaurant_id
            AND LOWER(ingredient) = LOWER(s.name)
            AND unit = s.unit
          ORDER BY delivery_date DESC
          LIMIT 1
        ) ip2 ON true
        WHERE s.restaurant_id = $1
        ORDER BY s.name ASC
        `,
        [restaurantId]
      );

      res.json(result.rows);
    } catch (error) {
      console.error("❌ Error fetching stock:", error);
      res.status(500).json({ error: "Database error" });
    }
  });

  router.get("/critical", async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const restaurantId = req.user.restaurant_id;

      const result = await pool.query(
        "SELECT * FROM stock WHERE restaurant_id=$1 AND quantity < critical_quantity",
        [restaurantId]
      );
      res.json(result.rows);
    } catch (err) {
      console.error("❌ Stock critical fetch failed:", err);
      res.status(500).json({ error: "Database error" });
    }
  });

  // ==============================
  // GET /stock/:id
  // ==============================
  router.get("/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const restaurantId = req.user.restaurant_id;

      const result = await pool.query(
        "SELECT * FROM stock WHERE restaurant_id = $1 AND id = $2",
        [restaurantId, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Stock item not found." });
      }

      res.json({ stock: result.rows[0] });
    } catch (error) {
      console.error("❌ Error fetching stock by ID:", error);
      res.status(500).json({ error: "Database error fetching stock." });
    }
  });

  // ==============================
  // POST /stock - add/merge finished product
  // If from_production=true → also deduct recipe ingredients (tenant-safe)
  // ==============================
  router.post("/", async (req, res) => {
    const {
      name,
      quantity,
      unit,
      supplier_id,
      from_production,
      batch_count,         // optional; may be provided by frontend
      expiry_date,
      // restaurant_id   // ❌ ignore body: we trust JWT tenant
    } = req.body;

    const restaurantId = req.user.restaurant_id;
    const trimmedName = (name || "").trim();
    const trimmedUnit = (unit || "").trim();
    const parsedQty = parseFloat(quantity);
    const normalizedExpiry = normalizeExpiryDate(expiry_date);

    if (!trimmedName || !parsedQty || parsedQty <= 0 || !trimmedUnit) {
      return res.status(400).json({ error: "Missing or invalid fields." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 🔻 Ingredient deduction when coming from production workflow
      if (from_production) {
        // 1) Find recipe by product name (tenant-aware; allow shared NULL recipes)
        const recipeRes = await client.query(
          `SELECT id, name, base_quantity, output_unit
           FROM recipes
           WHERE LOWER(name) = LOWER($1)
             AND (restaurant_id = $2 OR restaurant_id IS NULL)
           ORDER BY (CASE WHEN restaurant_id = $2 THEN 0 ELSE 1 END), id DESC
           LIMIT 1`,
          [trimmedName, restaurantId]
        );

        if (recipeRes.rows.length > 0) {
          const recipe = recipeRes.rows[0];
          const baseQty = Number(recipe.base_quantity) || 1;

          // 2) Decide batchCount (prefer provided; else infer from produced quantity)
          const inferred = baseQty !== 0 ? parsedQty / baseQty : 1;
          const batches =
            Number(batch_count) > 0 ? Number(batch_count) :
            inferred > 0 ? inferred : 1;

          // 3) Log production for audit
          const prodLog = await client.query(
            `INSERT INTO production_logs (product_name, quantity_produced, produced_by)
             VALUES ($1, $2, $3)
             RETURNING id`,
            [recipe.name, parsedQty, "system"]
          );
          const productionId = prodLog.rows[0].id;

          // 4) Fetch recipe ingredients
          const ingsRes = await client.query(
            `SELECT ingredient_name, amount_per_batch, unit
             FROM recipe_ingredients
             WHERE recipe_id = $1`,
            [recipe.id]
          );

          // 5) Deduct each ingredient from this tenant's stock (with unit conversion)
          for (const row of ingsRes.rows) {
            const ingName = row.ingredient_name;
            const ingUnit = row.unit;
            const amountPerBatch = Number(row.amount_per_batch) || 0;
            const quantityUsed = amountPerBatch * batches;

            // log usage
            await client.query(
              `INSERT INTO ingredient_usages (production_id, ingredient_name, quantity_used, unit)
               VALUES ($1, $2, $3, $4)`,
              [productionId, ingName, quantityUsed, ingUnit]
            );

            // find stock row for this tenant
            const stockRes = await client.query(
              `SELECT id, unit
               FROM stock
               WHERE LOWER(name) = LOWER($1)
                 AND restaurant_id = $2
               LIMIT 1`,
              [ingName, restaurantId]
            );

            if (stockRes.rows.length === 0) {
              console.warn(`⚠️ No stock row for ingredient "${ingName}" in restaurant ${restaurantId}`);
              continue;
            }

            const stockRow = stockRes.rows[0];
            const adjusted = convertQuantity(
              quantityUsed,
              normalizeUnit(ingUnit),
              normalizeUnit(stockRow.unit)
            );
            if (adjusted == null) {
              console.warn(`⚠️ Unit conversion failed for "${ingName}": ${ingUnit} → ${stockRow.unit}`);
              continue;
            }

            await client.query(
              `UPDATE stock
               SET quantity = quantity - $1
               WHERE id = $2 AND restaurant_id = $3`,
              [adjusted, stockRow.id, restaurantId]
            );
          }
        } else {
          console.warn(`⚠️ from_production=true but no recipe found for "${trimmedName}" (tenant ${restaurantId}). Skipping deduction.`);
        }
      }

      // 🔺 Upsert finished product stock (tenant-safe)
      const upsertRes = await client.query(
        `INSERT INTO stock (name, quantity, unit, supplier_id, restaurant_id, expiry_date)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (name, unit, restaurant_id)
         DO UPDATE SET
           quantity = stock.quantity + EXCLUDED.quantity,
           supplier_id = EXCLUDED.supplier_id,
           expiry_date = CASE
             WHEN stock.expiry_date IS NULL THEN EXCLUDED.expiry_date
             WHEN EXCLUDED.expiry_date IS NULL THEN stock.expiry_date
             ELSE LEAST(stock.expiry_date, EXCLUDED.expiry_date)
           END
         RETURNING *`,
        [trimmedName, parsedQty, trimmedUnit, supplier_id || null, restaurantId, normalizedExpiry]
      );

      await client.query("COMMIT");

      // notify listeners
      const stockPayload = upsertRes.rows[0];
      emitStockUpdate(io, stockPayload.id);
      await maybeEmitExpiryAlert(
        io,
        restaurantId,
        stockPayload.id,
        stockPayload.name,
        stockPayload.expiry_date
      );
      return res.json(stockPayload);
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Error inserting/updating stock (with production deduction):", error);
      return res.status(500).json({ error: "Internal stock insert error." });
    } finally {
      client.release();
    }
  });

  // ==============================
  // PATCH /stock/:id
  // ==============================
  router.patch("/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { quantity, critical_quantity, reorder_quantity, expiry_date } = req.body;
      const restaurantId = req.user.restaurant_id;
      const normalizedExpiry = normalizeExpiryDate(expiry_date);

      const updateRes = await pool.query(
        `UPDATE stock
         SET quantity = COALESCE($1, quantity),
             critical_quantity = COALESCE($2, critical_quantity),
             reorder_quantity = COALESCE($3, reorder_quantity),
             expiry_date = COALESCE($4, expiry_date)
         WHERE restaurant_id = $5 AND id = $6
         RETURNING *`,
        [quantity, critical_quantity, reorder_quantity, normalizedExpiry, restaurantId, id]
      );

      const updated = updateRes.rows[0];
      if (!updated) {
        return res.status(404).json({ error: "Stock item not found." });
      }

      if (updated.critical_quantity && updated.quantity <= updated.critical_quantity) {
        emitAlert(
          io,
          restaurantId,
          `🧂 Stock Low: ${updated.name} (${updated.quantity} ${updated.unit})`,
          updated.id,
          "stock",
          { stockId: updated.id }
        );
      }

      emitStockUpdate(io, id);
      if (updated.expiry_date) {
        await maybeEmitExpiryAlert(
          io,
          restaurantId,
          updated.id,
          updated.name,
          updated.expiry_date
        );
      }
      res.json({ success: true, stock: updated });
    } catch (error) {
      console.error("❌ Error updating stock:", error);
      res.status(500).json({ error: "Database error updating stock." });
    }
  });

  // ==============================
  // DELETE /stock/:id
  // ==============================
  router.delete("/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const restaurantId = req.user.restaurant_id;

      const delRes = await pool.query(
        "DELETE FROM stock WHERE restaurant_id = $1 AND id = $2 RETURNING *",
        [restaurantId, id]
      );

      if (delRes.rows.length === 0) {
        return res.status(404).json({ error: "Stock item not found." });
      }

      emitStockUpdate(io, id);
      res.json({ success: true });
    } catch (error) {
      console.error("❌ Error deleting stock:", error);
      res.status(500).json({ error: "Database error deleting stock." });
    }
  });

  // ==============================
  // PATCH /stock/:id/flag-auto-added
  // ==============================
  router.patch("/:id/flag-auto-added", async (req, res) => {
    const { id } = req.params;
    const { last_auto_add_at } = req.body;
    const restaurantId = req.user.restaurant_id;

    try {
      const result = await pool.query(
        `UPDATE stock
         SET last_auto_add_at = $1
         WHERE restaurant_id = $2 AND id = $3
         RETURNING *`,
        [last_auto_add_at, restaurantId, id]
      );
      res.json({ updated: result.rows[0] });
    } catch (err) {
      console.error("❌ Error updating auto-add timestamp:", err);
      res.status(500).json({ error: "Failed to update auto-add timestamp" });
    }
  });

  return router;
};
