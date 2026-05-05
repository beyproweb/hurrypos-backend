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

  const toNumberSafe = (value) => {
    if (value === null || value === undefined) return 0;
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const normalized = parseFloat(String(value).replace(",", "."));
    return Number.isFinite(normalized) ? normalized : 0;
  };

  const verifyManagerPin = async (client, restaurantId, pin) => {
    if (!pin) return null;

    // 1) Staff PINs (manager/admin/owner)
    const staffRes = await client.query(
      `SELECT id, name, role
         FROM staff
        WHERE restaurant_id = $1
          AND pin = $2
          AND status = 'active'
        LIMIT 1`,
      [restaurantId, String(pin)]
    );
    const staff = staffRes.rows[0];
    if (staff) {
      const role = String(staff.role || "").toLowerCase();
      if (["manager", "admin", "owner"].includes(role)) return staff;
    }

    // 2) Admin user PIN/password fallback (use users table)
    try {
      const userRes = await client.query(
        `SELECT id, full_name AS name, role
           FROM users
          WHERE restaurant_id = $1
            AND password = $2
          LIMIT 1`,
        [restaurantId, String(pin)]
      );
      const userRow = userRes.rows[0];
      if (userRow) {
        const role = String(userRow.role || "").toLowerCase();
        if (["admin", "owner", "manager"].includes(role)) return userRow;
      }
    } catch (err) {
      // older schemas might not have password exposed; ignore
      console.warn("PIN fallback on users failed:", err.message);
    }

    return null;
  };

  // ✅ protect all stock routes
  router.use(authMiddleware);

  let ensuredStockColumns = false;
  async function ensureStockColumns(client) {
    if (ensuredStockColumns) return;
    const runner = client || pool;
    try {
      await runner.query(`
        ALTER TABLE stock
          ADD COLUMN IF NOT EXISTS is_cleaning_supply BOOLEAN DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      `);
      ensuredStockColumns = true;
    } catch (err) {
      console.warn("⚠️ stock column ensure failed:", err.message);
    }
  }

  // ==============================
  // GET /stock - list all stock with price per unit
  // ==============================
  router.get("/", async (req, res) => {
    try {
      await ensureStockColumns();
      const restaurantId = req.user.restaurant_id;
      const sinceRaw = String(req.query.since || "").trim();
      const sinceDate = sinceRaw
        ? /^\d+$/.test(sinceRaw)
          ? new Date(Number(sinceRaw))
          : new Date(sinceRaw)
        : null;
      const sinceIso = sinceDate && Number.isFinite(sinceDate.getTime()) ? sinceDate.toISOString() : null;

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

      const params = [restaurantId];
      let sinceClause = "";
      if (sinceIso) {
        params.push(sinceIso);
        sinceClause = `AND COALESCE(s.updated_at, NOW()) >= $${params.length}`;
      }

      const result = await pool.query(
        `
	        SELECT s.*, sp.name AS supplier_name,
	          COALESCE(
	            NULLIF(ip1.price_per_unit, 0),
	            NULLIF(ip_items.price_per_unit, 0),
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
	          WHERE LOWER(BTRIM(ingredient_name)) = LOWER(BTRIM(s.name))
	            AND LOWER(BTRIM(unit)) = LOWER(BTRIM(s.unit))
	          ORDER BY changed_at DESC, ctid DESC
	          LIMIT 1
	        ) ip1 ON true
	        LEFT JOIN LATERAL (
	          SELECT
	            COALESCE(
	              NULLIF(BTRIM(item->>'price_per_unit'), '')::numeric,
	              CASE
	                WHEN COALESCE(NULLIF(BTRIM(item->>'quantity'), '')::numeric, 0) > 0
	                  THEN ROUND(
	                    COALESCE(NULLIF(BTRIM(item->>'total_cost'), '')::numeric, 0) /
	                    NULLIF(NULLIF(BTRIM(item->>'quantity'), '')::numeric, 0),
	                    4
	                  )
	              END,
	              0
	            ) AS price_per_unit
	          FROM transactions t
	          CROSS JOIN LATERAL jsonb_array_elements(
	            CASE
	              WHEN t.items IS NULL THEN '[]'::jsonb
	              WHEN jsonb_typeof(t.items::jsonb) = 'array' THEN t.items::jsonb
	              ELSE '[]'::jsonb
	            END
	          ) AS item
	          WHERE t.restaurant_id = s.restaurant_id
	            AND (s.supplier_id IS NULL OR t.supplier_id = s.supplier_id)
	            AND LOWER(BTRIM(item->>'ingredient')) = LOWER(BTRIM(s.name))
	            AND LOWER(BTRIM(item->>'unit')) = LOWER(BTRIM(s.unit))
	          ORDER BY t.delivery_date DESC NULLS LAST, t.created_at DESC NULLS LAST
	          LIMIT 1
	        ) ip_items ON true
	        LEFT JOIN LATERAL (
	          SELECT ROUND(total_cost / NULLIF(quantity, 0), 4) AS price_per_unit
	          FROM transactions
	          WHERE restaurant_id = s.restaurant_id
	            AND LOWER(BTRIM(ingredient)) = LOWER(BTRIM(s.name))
	            AND LOWER(BTRIM(unit)) = LOWER(BTRIM(s.unit))
	          ORDER BY delivery_date DESC
	          LIMIT 1
	        ) ip2 ON true
        WHERE s.restaurant_id = $1
          ${sinceClause}
        ORDER BY s.name ASC
        `,
        params
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
               SET quantity = quantity - $1,
                   updated_at = NOW()
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
        `INSERT INTO stock (name, quantity, unit, supplier_id, restaurant_id, expiry_date, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (name, unit, restaurant_id)
         DO UPDATE SET
           quantity = stock.quantity + EXCLUDED.quantity,
           supplier_id = EXCLUDED.supplier_id,
           updated_at = NOW(),
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
      emitStockUpdate(io, restaurantId, stockPayload.id, stockPayload);
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
             expiry_date = COALESCE($4, expiry_date),
             updated_at = NOW()
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

      emitStockUpdate(io, restaurantId, updated.id, updated);
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

      emitStockUpdate(io, restaurantId, id, delRes.rows[0], { deleted: true });
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
         SET last_auto_add_at = $1,
             updated_at = NOW()
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

  // ==============================
  // GET /stock/batches/:stockId (tenant-safe)
  // ==============================
  router.get("/batches/:stockId", async (req, res) => {
    const restaurantId = req.user.restaurant_id;
    const { stockId } = req.params;
    try {
      const { rows } = await pool.query(
        `
        SELECT id, batch_ref, expiry_date, remaining_quantity, cost_price, created_at
        FROM stock_batches
        WHERE restaurant_id = $1
          AND stock_id = $2
          AND remaining_quantity > 0
        ORDER BY expiry_date NULLS LAST, created_at ASC
        `,
        [restaurantId, stockId]
      );
      res.json({ batches: rows });
    } catch (err) {
      console.error("❌ Failed to fetch batches:", err);
      res.status(500).json({ error: "Failed to fetch batches" });
    }
  });

  // ==============================
  // POST /stock/verify-manager-pin
  // ==============================
  router.post("/verify-manager-pin", async (req, res) => {
    const restaurantId = req.user.restaurant_id;
    const pin = req.body?.pin;
    const client = await pool.connect();
    try {
      const manager = await verifyManagerPin(client, restaurantId, pin);
      if (!manager) {
        return res.status(403).json({ error: "Invalid manager PIN" });
      }
      res.json({ ok: true, manager: { id: manager.id, name: manager.name, role: manager.role } });
    } catch (err) {
      console.error("❌ Manager PIN check failed:", err);
      res.status(500).json({ error: "PIN verification failed" });
    } finally {
      client.release();
    }
  });

  // ==============================
  // POST /stock/waste  (waste + adjustment corrections)
  // ==============================
  router.post("/waste", async (req, res) => {
    const {
      stock_id,
      quantity,
      reason,
      notes,
      other_reason_note,
      batch_id,
      expiry_date,
      supplier_batch_ref,
      image_url,
      manager_pin,
      type,
    } = req.body || {};

    const restaurantId = req.user.restaurant_id;
    const qty = toNumberSafe(quantity);
    const movementType =
      String(type || "waste").toLowerCase() === "adjustment_correction"
        ? "adjustment_correction"
        : "waste";

    if (!(qty > 0)) {
      return res.status(400).json({ error: "Quantity must be greater than zero." });
    }
    if (movementType === "waste" && !reason) {
      return res.status(400).json({ error: "Waste reason is required." });
    }
    if (movementType === "waste" && String(reason).toLowerCase() === "other" && !other_reason_note) {
      return res.status(400).json({ error: "Other reason note is required." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const currentRole = String(req.user?.role || "").toLowerCase();
      const currentUserIsManager = ["manager", "admin", "owner"].includes(currentRole);
      let manager =
        currentUserIsManager && req.user
          ? {
              id: req.user.id,
              name:
                req.user.full_name ||
                req.user.name ||
                req.user.email ||
                req.user.username ||
                "current user",
              role: req.user.role || currentRole,
            }
          : null;

      if (!manager) {
        manager = await verifyManagerPin(client, restaurantId, manager_pin);
      }

      if (!manager) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Manager PIN required" });
      }

      const stockRes = await client.query(
        `SELECT * FROM stock WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
        [stock_id, restaurantId]
      );
      const stockRow = stockRes.rows[0];
      if (!stockRow) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Stock item not found." });
      }

      const currentQty = toNumberSafe(stockRow.quantity);
      if (movementType === "waste" && qty > currentQty) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Not enough stock to waste." });
      }

      const pricePerUnit = toNumberSafe(
        stockRow.price_per_unit ??
          stockRow.unit_price ??
          stockRow.cost_per_unit ??
          stockRow.purchase_price ??
          stockRow.cost_price ??
          stockRow.price
      );

      const normalizedExpiry = normalizeExpiryDate(expiry_date);
      const appliedRows = [];
      let remaining = qty;

      if (movementType === "waste") {
        const batchRes = await client.query(
          `
          SELECT id, remaining_quantity, cost_price, expiry_date, batch_ref
          FROM stock_batches
          WHERE restaurant_id = $1 AND stock_id = $2 AND remaining_quantity > 0
          ORDER BY expiry_date NULLS LAST, created_at ASC
          FOR UPDATE
        `,
          [restaurantId, stock_id]
        );

        const batches = Array.isArray(batchRes.rows) ? [...batchRes.rows] : [];
        const targetBatchId = batch_id ? Number(batch_id) : null;
        if (targetBatchId) {
          batches.sort((a, b) => {
            if (a.id === targetBatchId) return -1;
            if (b.id === targetBatchId) return 1;
            return 0;
          });
        }

        for (const b of batches) {
          if (remaining <= 0) break;
          const available = toNumberSafe(b.remaining_quantity);
          if (!(available > 0)) continue;
          const useQty = Math.min(available, remaining);
          const cost = toNumberSafe(b.cost_price) || pricePerUnit;
          const totalValue = useQty * cost;

          await client.query(
            `UPDATE stock_batches SET remaining_quantity = remaining_quantity - $1 WHERE id = $2`,
            [useQty, b.id]
          );

          appliedRows.push({
            batch_id: b.id,
            qty: useQty,
            cost_price: cost,
            total_value: totalValue,
            meta: {
              supplier_batch_ref: supplier_batch_ref || b.batch_ref || null,
              expiry_date: b.expiry_date || normalizedExpiry || stockRow.expiry_date || null,
              other_reason_note:
                String(reason).toLowerCase() === "other" ? other_reason_note || null : null,
            },
          });

          remaining -= useQty;
        }

        if (remaining > 0) {
          const fallbackCost = pricePerUnit || 0;
          appliedRows.push({
            batch_id: batch_id || null,
            qty: remaining,
            cost_price: fallbackCost,
            total_value: remaining * fallbackCost,
            meta: {
              supplier_batch_ref: supplier_batch_ref || null,
              expiry_date: normalizedExpiry || stockRow.expiry_date || null,
              other_reason_note:
                String(reason).toLowerCase() === "other" ? other_reason_note || null : null,
            },
          });
          remaining = 0;
        }

        const nextQty = Math.max(0, currentQty - qty);
        await client.query(
          `UPDATE stock
              SET quantity = $1,
                  updated_at = NOW()
            WHERE id = $2 AND restaurant_id = $3`,
          [nextQty, stock_id, restaurantId]
        );
      } else {
        const cost = pricePerUnit || 0;
        let correctionBatchId = null;
        try {
          const ins = await client.query(
            `INSERT INTO stock_batches
             (restaurant_id, stock_id, supplier_id, supplier_name, batch_ref, expiry_date, quantity, remaining_quantity, cost_price, total_cost, source_transaction_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10)
             RETURNING id`,
            [
              restaurantId,
              stock_id,
              stockRow.supplier_id || null,
              stockRow.supplier_name || null,
              supplier_batch_ref || null,
              normalizedExpiry || stockRow.expiry_date || null,
              qty,
              cost || null,
              cost ? qty * cost : null,
              null,
            ]
          );
          correctionBatchId = ins.rows?.[0]?.id || null;
        } catch (err) {
          console.warn("⚠️ Failed to insert correction batch:", err.message);
        }

        const nextQty = currentQty + qty;
        await client.query(
          `UPDATE stock
           SET quantity = $1,
               expiry_date = CASE
                 WHEN expiry_date IS NULL THEN $2
                 WHEN $2 IS NULL THEN expiry_date
                 ELSE LEAST(expiry_date, $2)
               END
           WHERE id = $3 AND restaurant_id = $4`,
          [nextQty, normalizedExpiry || stockRow.expiry_date || null, stock_id, restaurantId]
        );

        appliedRows.push({
          batch_id: correctionBatchId,
          qty,
          cost_price: cost,
          total_value: qty * cost * -1,
          meta: {
            supplier_batch_ref: supplier_batch_ref || null,
            expiry_date: normalizedExpiry || stockRow.expiry_date || null,
            other_reason_note: null,
          },
        });
      }

      const inserted = [];
      for (const row of appliedRows) {
        const ins = await client.query(
          `INSERT INTO stock_movements
            (restaurant_id, stock_id, batch_id, movement_type, qty, unit, cost_price, total_value, reason, notes, image_url, user_id, manager_id, meta)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING *`,
          [
            restaurantId,
            stock_id,
            row.batch_id,
            movementType,
            row.qty,
            stockRow.unit,
            row.cost_price,
            row.total_value,
            reason || movementType,
            notes || null,
            image_url || null,
            req.user?.id || null,
            manager.id,
            row.meta ? row.meta : null,
          ]
        );
        inserted.push(ins.rows[0]);
      }

      await client.query("COMMIT");
      emitStockUpdate(io, restaurantId, stock_id, stockRow);

      return res.json({
        success: true,
        movement_type: movementType,
        total_loss_value: inserted
          .filter((r) => r.movement_type === "waste")
          .reduce((sum, r) => sum + toNumberSafe(r.total_value), 0),
        rows: inserted,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("❌ Waste entry failed:", err);
      res
        .status(500)
        .json({ error: err?.message || "Failed to create waste entry. Please try again." });
    } finally {
      client.release();
    }
  });

  // ==============================
  // GET /stock/waste/logs
  // ==============================
  router.get("/waste/logs", async (req, res) => {
    const restaurantId = req.user.restaurant_id;
    const { from, to, reason } = req.query;
    const clauses = ["sm.restaurant_id = $1"];
    const params = [restaurantId];
    let idx = 2;

    if (from) {
      clauses.push(`sm.created_at >= $${idx}`);
      params.push(new Date(from));
      idx += 1;
    }
    if (to) {
      clauses.push(`sm.created_at <= $${idx}`);
      params.push(new Date(`${to}T23:59:59.999Z`));
      idx += 1;
    }
    if (reason) {
      clauses.push(`LOWER(COALESCE(sm.reason, '')) = LOWER($${idx})`);
      params.push(String(reason));
      idx += 1;
    }

    try {
      const { rows } = await pool.query(
        `
        SELECT
          sm.*,
          s.name AS product_name,
          s.unit AS product_unit,
          b.batch_ref,
          b.expiry_date
        FROM stock_movements sm
        LEFT JOIN stock s ON s.id = sm.stock_id
        LEFT JOIN stock_batches b ON b.id = sm.batch_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY sm.created_at DESC
        LIMIT 300
      `,
        params
      );
      res.json({ items: rows });
    } catch (err) {
      console.error("❌ Failed to load waste logs:", err);
      res.status(500).json({ error: "Failed to load waste logs" });
    }
  });

  // ==============================
  // GET /stock/waste/metrics
  // ==============================
  router.get("/waste/metrics", async (req, res) => {
    const restaurantId = req.user.restaurant_id;
    const { from, to } = req.query;

    const start =
      from && !Number.isNaN(new Date(from).getTime())
        ? new Date(from)
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end =
      to && !Number.isNaN(new Date(to).getTime())
        ? new Date(`${to}T23:59:59.999Z`)
        : new Date();

    try {
      const [wasteAgg, salesAgg, topProducts, reasonRows] = await Promise.all([
        pool.query(
          `
          SELECT
            COALESCE(SUM(total_value), 0) AS total_waste,
            COUNT(*) AS waste_count
          FROM stock_movements
          WHERE restaurant_id = $1
            AND movement_type = 'waste'
            AND created_at BETWEEN $2 AND $3
        `,
          [restaurantId, start, end]
        ),
        pool.query(
          `
          SELECT COALESCE(SUM(total), 0) AS total_sales
          FROM orders
          WHERE restaurant_id = $1
            AND (is_paid = TRUE OR LOWER(COALESCE(status, '')) IN ('paid', 'closed', 'confirmed'))
            AND created_at BETWEEN $2 AND $3
        `,
          [restaurantId, start, end]
        ),
        pool.query(
          `
          SELECT
            sm.stock_id,
            s.name AS product_name,
            SUM(sm.qty) AS total_qty,
            SUM(sm.total_value) AS total_loss
          FROM stock_movements sm
          LEFT JOIN stock s ON s.id = sm.stock_id
          WHERE sm.restaurant_id = $1
            AND sm.movement_type = 'waste'
            AND sm.created_at BETWEEN $2 AND $3
          GROUP BY sm.stock_id, s.name
          ORDER BY total_loss DESC NULLS LAST
          LIMIT 5
        `,
          [restaurantId, start, end]
        ),
        pool.query(
          `
          SELECT
            COALESCE(NULLIF(reason, ''), 'unspecified') AS reason,
            SUM(total_value) AS total_loss,
            SUM(qty) AS total_qty
          FROM stock_movements
          WHERE restaurant_id = $1
            AND movement_type = 'waste'
            AND created_at BETWEEN $2 AND $3
          GROUP BY COALESCE(NULLIF(reason, ''), 'unspecified')
          ORDER BY total_loss DESC NULLS LAST
        `,
          [restaurantId, start, end]
        ),
      ]);

      const totalWaste = toNumberSafe(wasteAgg.rows?.[0]?.total_waste);
      const totalSales = toNumberSafe(salesAgg.rows?.[0]?.total_sales);
      const wastePctOfSales = totalSales > 0 ? (totalWaste / totalSales) * 100 : 0;

      res.json({
        from: start,
        to: end,
        totalWaste,
        wastePctOfSales,
        topProducts: topProducts.rows || [],
        byReason: reasonRows.rows || [],
      });
    } catch (err) {
      console.error("❌ Failed to load waste metrics:", err);
      res.status(500).json({ error: "Failed to load waste metrics" });
    }
  });

  return router;
};
