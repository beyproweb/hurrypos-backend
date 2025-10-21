// routes/stock.js
module.exports = (io) => {
  const express = require("express");
  const router = express.Router();
  const { pool } = require("../db");
  const authMiddleware = require("../middleware/authMiddleware");
  const { emitAlert, emitStockUpdate } = require("../utils/realtime");

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
  // POST /stock - add/merge stock
  // ==============================
  router.post("/", async (req, res) => {
    const { name, quantity, unit, supplier_id } = req.body;
    const restaurantId = req.user.restaurant_id;

    const trimmedName = (name || "").trim();
    const trimmedUnit = (unit || "").trim();
    const parsedQty = parseFloat(quantity);

    if (!trimmedName || !parsedQty || parsedQty <= 0 || !trimmedUnit) {
      return res.status(400).json({ error: "Missing or invalid fields." });
    }

    try {
      const upsertRes = await pool.query(
        `INSERT INTO stock (name, quantity, unit, supplier_id, restaurant_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name, unit, restaurant_id)
         DO UPDATE SET
           quantity = stock.quantity + EXCLUDED.quantity,
           supplier_id = EXCLUDED.supplier_id
         RETURNING *`,
        [trimmedName, parsedQty, trimmedUnit, supplier_id || null, restaurantId]
      );

      return res.json(upsertRes.rows[0]);
    } catch (error) {
      console.error("❌ Error inserting/updating stock:", error);
      return res.status(500).json({ error: "Internal stock insert error." });
    }
  });

  // ==============================
  // PATCH /stock/:id
  // ==============================
  router.patch("/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { quantity, critical_quantity, reorder_quantity } = req.body;
      const restaurantId = req.user.restaurant_id;

      const updateRes = await pool.query(
        `UPDATE stock
         SET quantity = COALESCE($1, quantity),
             critical_quantity = COALESCE($2, critical_quantity),
             reorder_quantity = COALESCE($3, reorder_quantity)
         WHERE restaurant_id = $4 AND id = $5
         RETURNING *`,
        [quantity, critical_quantity, reorder_quantity, restaurantId, id]
      );

      const updated = updateRes.rows[0];
      if (!updated) {
        return res.status(404).json({ error: "Stock item not found." });
      }

      // Alert if stock low
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

  // ==============================
  // GET /stock/critical
  // ==============================


  return router;
};
