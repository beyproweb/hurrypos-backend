// /routes/ingredient-prices.js
module.exports = (io) => {
  const express = require("express");
  const router = express.Router();
  const { pool } = require("../db");
  const { emitAlert } = require("../utils/realtime");
  const authMiddleware = require("../middleware/authMiddleware");

  // ✅ Require auth for all ingredient routes
  router.use(authMiddleware);

  // ✅ GET latest ingredient prices (tenant-safe)
  router.get("/", async (req, res) => {
    try {
      const restaurantId = req.user.restaurant_id;

      const result = await pool.query(
        `
        SELECT x.name, x.unit, x.supplier, x.price_per_unit, x.previous_price, x.reason, x.changed_at
        FROM (
          SELECT
            h.ingredient_name AS name,
            h.unit,
            h.supplier_name AS supplier,
            h.price AS price_per_unit,
            LAG(h.price) OVER (
              PARTITION BY h.restaurant_id, h.ingredient_name, h.unit, h.supplier_name
              ORDER BY h.changed_at
            ) AS previous_price,
            h.reason,
            h.changed_at,
            ROW_NUMBER() OVER (
              PARTITION BY h.restaurant_id, h.ingredient_name, h.unit, h.supplier_name
              ORDER BY h.changed_at DESC
            ) AS rn
          FROM ingredient_price_history h
          WHERE h.restaurant_id = $1
        ) x
        WHERE x.rn = 1
        ORDER BY x.name, x.supplier, x.unit
        `,
        [restaurantId]
      );

      res.json(result.rows);
    } catch (err) {
      console.error("❌ Error fetching ingredient prices:", err);
      res.status(500).json({ error: "Failed to fetch ingredient prices" });
    }
  });

  // ✅ GET single ingredient’s latest price
  router.get("/ingredient-price/:name", async (req, res) => {
    try {
      const restaurantId = req.user.restaurant_id;
      const { name } = req.params;

      const result = await pool.query(
        `
        SELECT ingredient AS name,
               unit,
               supplier_id,
               ROUND(total_cost / NULLIF(quantity, 0), 4) AS price_per_unit
        FROM transactions
        WHERE restaurant_id=$1 AND ingredient=$2
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [restaurantId, name]
      );

      if (result.rows.length === 0)
        return res.status(404).json({ error: "Not found" });
      res.json(result.rows[0]);
    } catch (error) {
      console.error("❌ Error fetching price for", req.params.name, error);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ✅ GET order history (optional, not tenant-sensitive but can filter)
  router.get("/orders/history", async (req, res) => {
    const { from, to } = req.query;
    const restaurantId = req.user.restaurant_id;

    if (!from || !to) {
      return res.status(400).json({ error: "Missing from/to query parameters" });
    }

    try {
      const result = await pool.query(
        `
        SELECT *
        FROM orders
        WHERE restaurant_id=$1
          AND status='closed'
          AND created_at >= $2::date
          AND created_at < ($3::date + INTERVAL '1 day')
        ORDER BY created_at DESC
        `,
        [restaurantId, from, to]
      );
      res.json(result.rows);
    } catch (err) {
      console.error("❌ Error fetching order history:", err);
      res.status(500).json({ error: "Failed to fetch order history" });
    }
  });

  // ✅ Add or update ingredient (tenant-safe)
  router.post("/", async (req, res) => {
    const { name, unit } = req.body;
    const restaurantId = req.user.restaurant_id;

    if (!name || !unit) {
      return res.status(400).json({ error: "Missing ingredient name or unit" });
    }

    try {
      const result = await pool.query(
        `
        INSERT INTO ingredients (restaurant_id, name, unit)
        VALUES ($1, $2, $3)
        ON CONFLICT (restaurant_id, name)
        DO UPDATE SET unit = EXCLUDED.unit
        RETURNING *
        `,
        [restaurantId, name.trim(), unit.trim()]
      );
      res.json(result.rows[0]);
    } catch (err) {
      console.error("❌ Error saving ingredient:", err);
      res.status(500).json({ error: "Failed to save ingredient" });
    }
  });

  // ✅ Update ingredient price + emit notification (tenant-safe)
  router.post("/update", async (req, res) => {
    const { name, unit, supplier, price, reason } = req.body;
    const restaurantId = req.user.restaurant_id;

    if (!name || !unit || !price) {
      return res.status(400).json({ error: "Missing fields" });
    }

    try {
      // Get previous price
      const prev = await pool.query(
        `
        SELECT price
        FROM ingredient_price_history
        WHERE restaurant_id=$1 AND ingredient_name=$2 AND unit=$3 AND supplier_name=$4
        ORDER BY changed_at DESC
        LIMIT 1
        `,
        [restaurantId, name, unit, supplier]
      );

      const previous_price = prev.rows.length
        ? Number(prev.rows[0].price)
        : null;

      // Insert new price
      await pool.query(
        `
        INSERT INTO ingredient_price_history
          (restaurant_id, ingredient_name, unit, price, changed_at, reason, supplier_name)
        VALUES ($1, $2, $3, $4, NOW(), $5, $6)
        `,
        [restaurantId, name, unit, price, reason || "Admin update", supplier]
      );

      // ✅ Emit alert if price changed
      if (previous_price !== null && price != previous_price) {
        const percent = previous_price
          ? (((price - previous_price) / previous_price) * 100).toFixed(1)
          : "-";
        const isUp = price > previous_price;
        const emoji = isUp ? "🔺" : "🟢";
        const upDown = isUp ? "up" : "down";

        emitAlert(
          io,
          `${emoji} Price ${upDown}: ${name} ₺${Number(price).toFixed(2)} (${percent}%) from ${supplier}`,
          restaurantId,
          "ingredient"
        );
      }

      res.json({ success: true });
    } catch (err) {
      console.error("❌ Admin price update failed:", err);
      res.status(500).json({ error: "Database error" });
    }
  });
// ✅ GET detailed price history (last N changes)
router.get("/history", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { name, unit, supplier, limit = 5 } = req.query;

  try {
    const result = await pool.query(
      `
      SELECT ingredient_name AS name,
             unit,
             supplier_name AS supplier,
             price,
             reason,
             changed_at
      FROM ingredient_price_history
      WHERE restaurant_id = $1
        AND LOWER(ingredient_name) = LOWER($2)
        AND ($3 = '' OR unit = $3)
        AND ($4 = '' OR supplier_name = $4)
      ORDER BY changed_at DESC
      LIMIT $5
      `,
      [restaurantId, name, unit || "", supplier || "", limit]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching ingredient price history:", err);
    res.status(500).json({ error: "Failed to fetch price history" });
  }
});

  return router;
};
