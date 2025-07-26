module.exports = (io) => {
  const express = require('express');
  const router = express.Router();
  const { pool } = require("../db");


  const { emitAlert, emitStockUpdate } = require('../utils/realtime');
// GET /stock - Returns all stock items + latest price per unit
router.get("/", async (req, res) => {
  try {
    const notifRes = await pool.query(`SELECT value FROM settings WHERE key = 'notifications'`);
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
  FROM stock s
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
    const result = await pool.query("SELECT * FROM stock WHERE id = $1", [id]);

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
router.post("/", async (req, res) => {
  const { name, quantity, unit, supplier_id } = req.body;

  const trimmedName = name.trim();
  const trimmedUnit = unit.trim();
  const parsedQty = parseFloat(quantity);

  if (!trimmedName || !parsedQty || parsedQty <= 0 || !trimmedUnit) {
    return res.status(400).json({ error: "Missing or invalid fields." });
  }

  try {
    const result = await pool.query(
      `INSERT INTO stock (name, quantity, unit, supplier_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name, unit)
       DO UPDATE SET
         quantity = stock.quantity + EXCLUDED.quantity,
         supplier_id = EXCLUDED.supplier_id
       RETURNING *`,
      [trimmedName, parsedQty, trimmedUnit, supplier_id || null]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("❌ Error inserting/updating stock:", error);
    res.status(500).json({ error: "Internal stock insert error." });
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
       WHERE id = $4
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
    const delRes = await pool.query("DELETE FROM stock WHERE id = $1 RETURNING *", [id]);
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
      `UPDATE stock SET last_auto_add_at = $1 WHERE id = $2 RETURNING *`,
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
