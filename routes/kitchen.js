const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const {
  emitOrderUpdate,
  emitStockUpdate,
  emitOrderConfirmed,
  emitOrderDelivered,
  emitAlert,
} = require("../utils/realtime");

const { getIO } = require("../utils/socket");
const authMiddleware = require("../middleware/authMiddleware");

router.options("*", (req, res) => res.sendStatus(204));

let ensuredTakeawayColumns = false;
async function ensureTakeawayColumns() {
  if (ensuredTakeawayColumns) return;
  try {
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS pickup_time TEXT`
    );
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS takeaway_notes TEXT`
    );
    ensuredTakeawayColumns = true;
  } catch (err) {
    console.warn("⚠️ Unable to ensure takeaway columns for kitchen:", err.message);
  }
}
/* ✅ PUBLIC endpoint used by GlobalOrderAlert */
router.get("/order-items/preparing", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id
      FROM order_items
      WHERE kitchen_status = 'preparing'
    `);
    res.json(result.rows.map((r) => r.id));
  } catch (err) {
    console.error("❌ Failed to fetch preparing items:", err);
    res.status(500).json({ error: "Failed to fetch preparing items" });
  }
});


/* 🔒 All routes below require token */
router.use(authMiddleware);


// ✅ GET all confirmed or paid order items for the kitchen
router.get("/kitchen-orders", authMiddleware, async (req, res) => {
  try {
    await ensureTakeawayColumns();
    const restaurantId = req.user?.restaurant_id;
    if (!restaurantId) {
      return res.status(401).json({ error: "Unauthorized: missing restaurant_id" });
    }

    const result = await pool.query(
      `
      SELECT
        oi.id AS item_id,
        oi.product_id,
        COALESCE(p.name, oi.external_product_name, oi.name, 'Unmatched Product') AS product_name,
        oi.quantity,
        oi.ingredients AS oi_ingredients,
        oi.extras AS oi_extras,
        oi.note,
        oi.kitchen_status,
        oi.confirmed,
        oi.paid_at,
        o.table_number,
        o.status AS order_status,
        o.created_at,
        o.order_type,
        o.customer_name,
        o.customer_phone,
        o.customer_address,
        o.pickup_time,
        o.takeaway_notes,
        o.id AS order_id,
        o.driver_id,
        s.name AS driver_name,
        p.ingredients AS p_ingredients,
        p.extras AS p_extras,
        p.category AS product_category,
        o.restaurant_id
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN products p ON oi.product_id = p.id
      LEFT JOIN staff s ON s.id = o.driver_id
      WHERE
        o.restaurant_id = $1
        AND oi.confirmed = true
        AND oi.kitchen_status IN ('new', 'preparing', 'ready')
        AND o.status IN ('occupied', 'confirmed', 'paid')
AND o.order_type IN ('phone', 'packet', 'table', 'takeaway')
      ORDER BY o.created_at ASC
      `,
      [restaurantId]
    );

    const settings = await pool.query(
      `SELECT excluded_categories, excluded_items
         FROM kitchen_compile_settings
         WHERE restaurant_id = $1
         ORDER BY id LIMIT 1`,
      [restaurantId]
    );

    const excludedCategories = settings.rows[0]?.excluded_categories || [];
    const excludedItems = settings.rows[0]?.excluded_items || [];

    const safeParse = (data, fallback = []) => {
      try {
        if (!data) return fallback;
        return typeof data === "string" ? JSON.parse(data) : data;
      } catch {
        return fallback;
      }
    };

    const orders = result.rows
      .filter(row => {
        if (excludedCategories?.includes(row.product_category)) return false;
        if (excludedItems?.includes(row.product_id)) return false;
        return true;
      })
      .map(row => ({
        item_id: row.item_id,
        product_id: row.product_id,
        product_name: row.product_name,
        quantity: row.quantity,
        ingredients:
          safeParse(row.oi_ingredients) || safeParse(row.p_ingredients),
        extras: safeParse(row.oi_extras) || safeParse(row.p_extras),
        note: row.note,
        kitchen_status: row.kitchen_status,
        confirmed: row.confirmed,
        paid_at: row.paid_at,
        table_number: row.table_number,
        order_status: row.order_status,
        created_at: row.created_at,
        order_type: row.order_type,
        customer_name: row.customer_name,
        customer_phone: row.customer_phone,
        customer_address: row.customer_address,
        pickup_time: row.pickup_time,
        takeaway_notes: row.takeaway_notes,
        order_id: row.order_id,
        driver_id: row.driver_id,
        driver_name: row.driver_name,
        restaurant_id: row.restaurant_id,
      }));

    res.json(orders);
  } catch (err) {
    console.error("❌ Kitchen route failed:", err);
    res.status(500).json({ error: "Kitchen order fetch failed" });
  }
});

// -----------------------------------------------------
// PATCH /orders/:id/status
// -----------------------------------------------------
router.patch("/orders/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status, total, payment_method } = req.body;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE orders
       SET status = $1,
           total = COALESCE($2, total),
           payment_method = CASE WHEN $3 IS NOT NULL THEN $3 ELSE payment_method END,
           is_paid = CASE WHEN $1 = 'paid' THEN true ELSE is_paid END
       WHERE restaurant_id = $4 AND id = $5
       RETURNING *`,
      [status, total, payment_method, req.user.restaurant_id, id]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    if (status === "paid") {
      const receipt_id = require("uuid").v4();
      await client.query(
        `UPDATE order_items
         SET paid_at = NOW(), confirmed = true, receipt_id = $2
         WHERE order_id = $1 AND paid_at IS NULL`,
        [id, receipt_id]
      );
    }

    await client.query("COMMIT");
    getIO().emit("orders_updated");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Error updating order status:", err);
    res.status(500).json({ error: "Failed to update order" });
  } finally {
    client.release();
  }
});

// -----------------------------------------------------
// DELETE test/closed orders
// -----------------------------------------------------
router.delete("/orders/dev-reset", async (req, res) => {
  try {
    await pool.query(`
      DELETE FROM order_items WHERE order_id IN (
        SELECT id FROM orders WHERE restaurant_id = $1 AND (status = 'paid' OR status = 'closed')
      )
    `, [req.user.restaurant_id]);
    await pool.query(`DELETE FROM sub_orders`);
    await pool.query(`
      DELETE FROM orders WHERE restaurant_id = $1 AND (status = 'paid' OR status = 'closed')
    `, [req.user.restaurant_id]);
    res.json({ message: "🧹 Old orders deleted (paid/closed)" });
  } catch (err) {
    console.error("❌ Cleanup failed:", err);
    res.status(500).json({ error: "Failed to clean up old orders" });
  }
});

// -----------------------------------------------------
// Kitchen timers CRUD
// -----------------------------------------------------
router.post("/kitchen-timers", async (req, res) => {
  const { id, name, secondsLeft, total, running } = req.body;
  try {
    if (id) {
      const result = await pool.query(
        `UPDATE kitchen_timers
         SET name = $1,
             seconds_left = $2,
             total_seconds = $3,
             running = $4,
             updated_at = NOW()
         WHERE restaurant_id = $5 AND id = $6
         RETURNING *`,
        [name, secondsLeft, total, running, req.user.restaurant_id, id]
      );
      return res.json(result.rows[0]);
    } else {
      const result = await pool.query(
        `INSERT INTO kitchen_timers (restaurant_id, name, seconds_left, total_seconds, running)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [req.user.restaurant_id, name, secondsLeft, total, running]
      );
      return res.json(result.rows[0]);
    }
  } catch (err) {
    console.error("❌ Failed to save kitchen timer:", err);
    return res.status(500).json({ error: "Failed to save kitchen timer" });
  }
});

router.get("/kitchen-timers", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM kitchen_timers WHERE restaurant_id = $1 ORDER BY created_at ASC`,
      [req.user.restaurant_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Failed to fetch kitchen timers:", err);
    res.status(500).json({ error: "Failed to fetch kitchen timers" });
  }
});

router.delete("/kitchen-timers/:id", async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM kitchen_timers WHERE restaurant_id = $1 AND id = $2`,
      [req.user.restaurant_id, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to delete kitchen timer:", err);
    res.status(500).json({ error: "Failed to delete kitchen timer" });
  }
});

// -----------------------------------------------------
// Compile settings (exclude ingredients/items)
// -----------------------------------------------------
router.get("/kitchen/compile-settings", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT excluded_ingredients, excluded_categories, excluded_items
       FROM kitchen_compile_settings
       WHERE restaurant_id = $1
       ORDER BY id LIMIT 1`,
      [req.user.restaurant_id]
    );
    res.json({
      excludedIngredients: rows[0]?.excluded_ingredients ?? [],
      excludedCategories: rows[0]?.excluded_categories ?? [],
      excludedItems: rows[0]?.excluded_items ?? [],
    });
  } catch (err) {
    console.error("❌ Failed to fetch compile settings:", err);
    res.status(500).json({ error: "Failed to fetch compile settings" });
  }
});

router.post("/kitchen/compile-settings", async (req, res) => {
  const { excludedIngredients = [], excludedCategories = [], excludedItems = [] } = req.body;
  try {
    const restaurantId = req.user?.restaurant_id;
    if (!restaurantId) {
      return res.status(401).json({ error: "Unauthorized: missing restaurant" });
    }

    const updateResult = await pool.query(
      `UPDATE kitchen_compile_settings
         SET excluded_ingredients = $2,
             excluded_categories = $3,
             excluded_items = $4,
             updated_at = NOW()
       WHERE restaurant_id = $1`,
      [
        restaurantId,
        JSON.stringify(excludedIngredients),
        JSON.stringify(excludedCategories),
        JSON.stringify(excludedItems)
      ]
    );

    if (updateResult.rowCount === 0) {
      await pool.query(
        `INSERT INTO kitchen_compile_settings (
           restaurant_id,
           excluded_ingredients,
           excluded_categories,
           excluded_items,
           updated_at
         )
         VALUES ($1, $2, $3, $4, NOW())`,
        [
          restaurantId,
          JSON.stringify(excludedIngredients),
          JSON.stringify(excludedCategories),
          JSON.stringify(excludedItems)
        ]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to update compile settings:", err);
    res.status(500).json({ error: "Failed to update compile settings" });
  }
});

// ✅ PUT /order-items/kitchen-status
// Updates kitchen_status for multiple order_items (Preparing / Delivered)
router.put("/order-items/kitchen-status", async (req, res) => {
  const { ids, status } = req.body;
  console.log("🧾 Kitchen status update request received:", { ids, status, user: req.user?.id });

  if (!Array.isArray(ids) || ids.length === 0 || !status) {
    return res.status(400).json({ error: "Missing ids or status" });
  }

  try {
    const restaurantId = req.user?.restaurant_id;
    if (!restaurantId) {
      console.error("❌ Missing restaurant_id in req.user");
      return res.status(401).json({ error: "Unauthorized: missing restaurant_id" });
    }

    console.log(`🔧 Updating ${ids.length} item(s) to status '${status}' for restaurant ${restaurantId}`);

    const result = await pool.query(
  `UPDATE order_items AS oi
   SET kitchen_status = $1
   FROM orders o
   WHERE oi.order_id = o.id
   AND o.restaurant_id = $2
   AND oi.id = ANY($3::int[])
   RETURNING oi.id, oi.kitchen_status`,
  [status, restaurantId, ids]
);


    console.log("✅ Kitchen status DB result:", result.rowCount, "rows updated");

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "No items updated" });
    }

    // 🔊 Emit socket update
    try {
      const io = require("../utils/socket").getIO();
      io.emit(`order_${status}`, { ids, status });
      console.log("📡 Socket emitted:", `order_${status}`);
    } catch (emitErr) {
      console.warn("⚠️ Socket emit failed:", emitErr.message);
    }

    res.json({
      success: true,
      updatedCount: result.rowCount,
      updatedItems: result.rows,
    });
  } catch (err) {
    console.error("❌ Failed to update kitchen_status:", err);
    res.status(500).json({ error: "Database update error" });
  }
});


module.exports = router;
