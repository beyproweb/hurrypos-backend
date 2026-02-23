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
      const restaurantId = req.user && req.user.restaurant_id;

      let rows = [];

      try {
        // Prefer tenant-aware query when restaurant_id is available
        if (!restaurantId) {
          throw new Error("NO_TENANT_ID");
        }

        const tenantResult = await pool.query(
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
                ORDER BY h.changed_at, h.ctid
              ) AS previous_price,
              h.reason,
              h.changed_at,
              ROW_NUMBER() OVER (
                PARTITION BY h.restaurant_id, h.ingredient_name, h.unit, h.supplier_name
                ORDER BY h.changed_at DESC, h.ctid DESC
              ) AS rn
            FROM ingredient_price_history h
            WHERE h.restaurant_id = $1
          ) x
          WHERE x.rn = 1
          ORDER BY x.name, x.supplier, x.unit
          `,
          [restaurantId]
        );

        rows = tenantResult.rows;
      } catch (innerErr) {
        // Fallback for legacy databases without restaurant_id on ingredient_price_history
        console.warn(
          "⚠️ Tenant-aware ingredient price query failed, falling back to legacy global query:",
          innerErr.message
        );

        const legacyResult = await pool.query(
          `
          SELECT x.name, x.unit, x.supplier, x.price_per_unit, x.previous_price, x.reason, x.changed_at
          FROM (
            SELECT
              h.ingredient_name AS name,
              h.unit,
              h.supplier_name AS supplier,
              h.price AS price_per_unit,
              LAG(h.price) OVER (
                PARTITION BY h.ingredient_name, h.unit, h.supplier_name
                ORDER BY h.changed_at, h.ctid
              ) AS previous_price,
              h.reason,
              h.changed_at,
              ROW_NUMBER() OVER (
                PARTITION BY h.ingredient_name, h.unit, h.supplier_name
                ORDER BY h.changed_at DESC, h.ctid DESC
              ) AS rn
            FROM ingredient_price_history h
          ) x
          WHERE x.rn = 1
          ORDER BY x.name, x.supplier, x.unit
          `
        );

        rows = legacyResult.rows;
      }

      // If still no rows (fresh DB or no history yet), fall back to stock/transactions
      if (!rows || rows.length === 0) {
        try {
          if (!restaurantId) {
            throw new Error("NO_RESTAURANT_FOR_STOCK_FALLBACK");
          }

		          const stockResult = await pool.query(
		            `
		            SELECT
		              s.name,
		              s.unit,
		              sp.name AS supplier,
		              COALESCE(
		                NULLIF(MAX(ip1.price_per_unit), 0),
		                NULLIF(MAX(ip_items.price_per_unit), 0),
		                NULLIF(MAX(ip2.price_per_unit), 0),
		                MAX((
		                  SELECT ROUND(total_cost / NULLIF(quantity, 0), 4)
		                  FROM transactions
		                  WHERE restaurant_id = s.restaurant_id
		                    AND LOWER(ingredient) = LOWER(s.name)
		                    AND unit = s.unit
		                    AND quantity > 0
		                  ORDER BY delivery_date DESC
		                  LIMIT 1
		                )),
		                0
		              ) AS price_per_unit,
		              COALESCE(
		                NULLIF(MAX(ip_items.previous_price), 0),
		                NULLIF(MAX(ip2.previous_price), 0),
		                NULL
		              ) AS previous_price,
		              CASE
		                WHEN MAX(CASE WHEN ip1.price_per_unit IS NOT NULL AND ip1.price_per_unit <> 0 THEN 1 ELSE 0 END) = 1
		                  THEN 'From price history'
		                WHEN MAX(CASE WHEN ip_items.price_per_unit IS NOT NULL AND ip_items.price_per_unit <> 0 THEN 1 ELSE 0 END) = 1
		                  THEN 'From receipt'
		                WHEN MAX(CASE WHEN ip2.price_per_unit IS NOT NULL AND ip2.price_per_unit <> 0 THEN 1 ELSE 0 END) = 1
		                  THEN 'From transaction'
		                ELSE 'No price'
		              END AS reason,
		              COALESCE(
		                MAX(ip1.changed_at),
		                MAX(ip_items.changed_at),
		                MAX(ip2.changed_at),
		                NOW()
		              ) AS changed_at
	            FROM stock s
	            LEFT JOIN suppliers sp
	              ON s.supplier_id = sp.id
	             AND sp.restaurant_id = s.restaurant_id
		            LEFT JOIN LATERAL (
		              SELECT price AS price_per_unit, changed_at
		              FROM ingredient_price_history
		              WHERE restaurant_id = s.restaurant_id
		                AND LOWER(BTRIM(ingredient_name)) = LOWER(BTRIM(s.name))
		                AND LOWER(BTRIM(unit)) = LOWER(BTRIM(s.unit))
		              ORDER BY changed_at DESC
		              LIMIT 1
		            ) ip1 ON true
		            LEFT JOIN LATERAL (
		              SELECT
		                price_per_unit,
		                previous_price,
		                changed_at
		              FROM (
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
		                  ) AS price_per_unit,
		                  LEAD(
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
		                    )
		                  ) OVER (
		                    ORDER BY COALESCE(t.delivery_date, t.created_at) DESC
		                  ) AS previous_price,
		                  COALESCE(t.delivery_date, t.created_at) AS changed_at,
		                  ROW_NUMBER() OVER (
		                    ORDER BY COALESCE(t.delivery_date, t.created_at) DESC
		                  ) AS rn
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
		              ) q
		              WHERE q.rn = 1
		            ) ip_items ON true
		            LEFT JOIN LATERAL (
		              SELECT
		                price_per_unit,
		                previous_price,
		                changed_at
		              FROM (
		                SELECT
		                  ROUND(total_cost / NULLIF(quantity, 0), 4) AS price_per_unit,
		                  LEAD(ROUND(total_cost / NULLIF(quantity, 0), 4)) OVER (
		                    ORDER BY COALESCE(delivery_date, created_at) DESC
		                  ) AS previous_price,
		                  COALESCE(delivery_date, created_at) AS changed_at,
		                  ROW_NUMBER() OVER (
		                    ORDER BY COALESCE(delivery_date, created_at) DESC
		                  ) AS rn
		                FROM transactions
		                WHERE restaurant_id = s.restaurant_id
		                  AND LOWER(BTRIM(ingredient)) = LOWER(BTRIM(s.name))
		                  AND LOWER(BTRIM(unit)) = LOWER(BTRIM(s.unit))
		                  AND quantity > 0
		              ) q
		              WHERE q.rn = 1
		            ) ip2 ON true
	            WHERE s.restaurant_id = $1
	              AND s.name IS NOT NULL
	              AND s.name <> ''
            GROUP BY s.name, s.unit, sp.name
            ORDER BY LOWER(s.name) ASC
            `,
            [restaurantId]
          );

          rows = stockResult.rows;
        } catch (fallbackErr) {
          console.warn(
            "⚠️ Ingredient price stock fallback failed:",
            fallbackErr.message
          );
        }
      }

      res.json(rows || []);
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
          restaurantId,
          `${emoji} Price ${upDown}: ${name} ₺${Number(price).toFixed(2)} (${percent}%) from ${supplier}`,
          null,
          "ingredient",
          {
            ingredient: name,
            unit,
            supplier,
            previous_price,
            new_price: Number(price),
            percent: percent === "-" ? null : Number(percent),
            direction: upDown,
          }
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
	      ORDER BY changed_at DESC, ctid DESC
	      LIMIT $5
	      `,
	      [restaurantId, name, unit || "", supplier || "", limit]
	    );
	
	    if (result.rows && result.rows.length > 0) {
	      return res.json(result.rows);
	    }
	
	    const txnResult = await pool.query(
	      `
	      WITH txn_item_rows AS (
	        SELECT
	          NULLIF(BTRIM(item->>'ingredient'), '') AS name,
	          NULLIF(BTRIM(item->>'unit'), '') AS unit,
	          sp.name AS supplier,
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
	          ) AS price,
	          'From receipt'::text AS reason,
	          COALESCE(t.delivery_date, t.created_at, NOW()) AS changed_at
	        FROM transactions t
	        LEFT JOIN suppliers sp
	          ON sp.id = t.supplier_id
	         AND sp.restaurant_id = t.restaurant_id
	        CROSS JOIN LATERAL jsonb_array_elements(
	          CASE
	            WHEN t.items IS NULL THEN '[]'::jsonb
	            WHEN jsonb_typeof(t.items::jsonb) = 'array' THEN t.items::jsonb
	            ELSE '[]'::jsonb
	          END
	        ) AS item
	        WHERE t.restaurant_id = $1
	          AND LOWER(BTRIM(item->>'ingredient')) = LOWER(BTRIM($2))
	          AND ($3 = '' OR LOWER(BTRIM(item->>'unit')) = LOWER(BTRIM($3)))
	          AND ($4 = '' OR sp.name = $4)
	      ),
	      txn_direct_rows AS (
	        SELECT
	          NULLIF(BTRIM(t.ingredient), '') AS name,
	          NULLIF(BTRIM(t.unit), '') AS unit,
	          sp.name AS supplier,
	          ROUND(t.total_cost / NULLIF(t.quantity, 0), 4) AS price,
	          'From transaction'::text AS reason,
	          COALESCE(t.delivery_date, t.created_at, NOW()) AS changed_at
	        FROM transactions t
	        LEFT JOIN suppliers sp
	          ON sp.id = t.supplier_id
	         AND sp.restaurant_id = t.restaurant_id
	        WHERE t.restaurant_id = $1
	          AND LOWER(BTRIM(t.ingredient)) = LOWER(BTRIM($2))
	          AND t.quantity > 0
	          AND ($3 = '' OR LOWER(BTRIM(t.unit)) = LOWER(BTRIM($3)))
	          AND ($4 = '' OR sp.name = $4)
	      )
	      SELECT name, unit, supplier, price, reason, changed_at
	      FROM (
	        SELECT * FROM txn_item_rows
	        UNION ALL
	        SELECT * FROM txn_direct_rows
	      ) x
	      WHERE x.name IS NOT NULL
	        AND x.unit IS NOT NULL
	      ORDER BY changed_at DESC
	      LIMIT $5
	      `,
	      [restaurantId, name, unit || "", supplier || "", limit]
	    );
	
	    return res.json(txnResult.rows || []);
	  } catch (err) {
	    console.error("❌ Error fetching ingredient price history:", err);
	    res.status(500).json({ error: "Failed to fetch price history" });
	  }
	});

  return router;
};
