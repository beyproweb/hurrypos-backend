// /routes/ingredient-prices.js

module.exports = (io) => {
  const express = require("express");
  const router = express.Router();
  const { pool } = require("../db");
  const { emitAlert } = require("../utils/realtime");


  // GET /api/ingredient-prices - fetch latest ingredient prices from transactions
  router.get("/", async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT x.name, x.unit, x.supplier, x.price_per_unit, x.previous_price, x.reason, x.changed_at
        FROM (
          SELECT
            h.ingredient_name AS name,
            h.unit,
            h.supplier_name AS supplier,
            h.price AS price_per_unit,
            LAG(h.price) OVER (
              PARTITION BY h.ingredient_name, h.unit, h.supplier_name
              ORDER BY h.changed_at
            ) AS previous_price,
            h.reason,
            h.changed_at,
            ROW_NUMBER() OVER (
              PARTITION BY h.ingredient_name, h.unit, h.supplier_name
              ORDER BY h.changed_at DESC
            ) AS rn
          FROM ingredient_price_history h
        ) x
        WHERE x.rn = 1
        ORDER BY x.name, x.supplier, x.unit
      `);

      const latestPrices = result.rows;



      res.json(latestPrices);

    } catch (err) {
      console.error("❌ Error fetching ingredient prices:", err);
      res.status(500).json({ error: "Failed to fetch ingredient prices" });
    }
  });

  router.get("/ingredient-price/:name", async (req, res) => {
    try {
      const { name } = req.params;
      const result = await pool.query(`
        SELECT ingredient AS name,
               unit,
               supplier_id,
               ROUND(total_cost / NULLIF(quantity, 0), 4) AS price_per_unit
        FROM transactions
        WHERE ingredient = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [name]);

      if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
      res.json(result.rows[0]);
    } catch (error) {
      console.error("❌ Error fetching price for", req.params.name, error);
      res.status(500).json({ error: "Internal error" });
    }
  });

router.get("/orders/history", async (req, res) => {
  const { from, to } = req.query;

  if (!from || !to) {
    return res.status(400).json({ error: "Missing from/to query parameters" });
  }

  try {
    const result = await pool.query(
      `
        SELECT * FROM orders
        WHERE status = 'closed'
        AND created_at >= $1::date
        AND created_at < ($2::date + INTERVAL '1 day')
        ORDER BY created_at DESC
      `,
      [from, to]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching order history:", err);
    res.status(500).json({ error: "Failed to fetch order history" });
  }
});

router.post("/", async (req, res) => {
  const { name, unit } = req.body;
  if (!name || !unit) {
    return res.status(400).json({ error: "Missing ingredient name or unit" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO ingredients (name, unit)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET unit = EXCLUDED.unit
       RETURNING *`,
      [name.trim(), unit.trim()]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error saving ingredient:", err);
    res.status(500).json({ error: "Failed to save ingredient" });
  }
});

router.post("/update", async (req, res) => {
  const { name, unit, supplier, price, reason } = req.body;
  if (!name || !unit || !price) {
    return res.status(400).json({ error: "Missing fields" });
  }
  try {
    // Get previous price
    const prev = await pool.query(
      `SELECT price FROM ingredient_price_history
       WHERE ingredient_name = $1 AND unit = $2 AND supplier_name = $3
       ORDER BY changed_at DESC LIMIT 1`,
      [name, unit, supplier]
    );
    const previous_price = prev.rows.length ? Number(prev.rows[0].price) : null;

    // Insert new price
    await pool.query(
      `INSERT INTO ingredient_price_history
        (ingredient_name, unit, price, changed_at, reason, supplier_name)
       VALUES ($1, $2, $3, NOW(), $4, $5)`,
      [name, unit, price, reason || "Admin update", supplier]
    );

    // Emit notification only if price actually changed
   if (previous_price !== null && price != previous_price) {
  const percent = previous_price
    ? (((price - previous_price) / previous_price) * 100).toFixed(1)
    : "-";
  const isUp = price > previous_price;
  const emoji = isUp ? "🔺" : "🟢";
  const upDown = isUp ? "up" : "down";
  const { emitAlert } = require("../utils/realtime");
emitAlert(
  io,
  `${emoji} Price ${upDown}: ${name} ₺${Number(price).toFixed(2)} (${percent}%) from ${supplier}`,
  null,
  "ingredient"
);

}


    res.json({ success: true });
  } catch (err) {
    console.error("❌ Admin price update failed:", err);
    res.status(500).json({ error: "Database error" });
  }
});


  return router;
};