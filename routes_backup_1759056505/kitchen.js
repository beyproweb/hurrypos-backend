const express = require("express");
const router = express.Router();
const { pool } = require("../db"); // REMOVE io here!
const {
  emitOrderUpdate,
  emitStockUpdate,
  emitOrderConfirmed,
  emitOrderDelivered,
  emitAlert,
} = require("../utils/realtime");

const { getIO } = require("../utils/socket");

// ✅ GET all confirmed or paid order items for the kitchen

router.get("/kitchen-orders", async (req, res) => {
  try {
    const result = await pool.query(`
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
    o.id AS order_id,
    p.ingredients AS p_ingredients,
    p.extras AS p_extras,
    p.category AS product_category
  FROM order_items oi
  JOIN orders o ON oi.order_id = o.id
  LEFT JOIN products p ON oi.product_id = p.id
  WHERE oi.confirmed = true
  AND oi.kitchen_status IN ('new', 'preparing', 'ready')
  AND o.status IN ('occupied', 'confirmed', 'paid')
  AND (o.order_type = 'phone' OR o.order_type = 'packet' OR o.order_type = 'table')

  ORDER BY o.created_at ASC
`);


       // 🚨 FETCH EXCLUSIONS
    const settings = await pool.query(
      `SELECT excluded_categories, excluded_items FROM kitchen_compile_settings ORDER BY id LIMIT 1`
    );
    const excludedCategories = settings.rows[0]?.excluded_categories || [];
    const excludedItems = settings.rows[0]?.excluded_items || [];
        const orders = result.rows.filter(row => {
      // category check (string in array)
      if (excludedCategories?.includes(row.product_category)) return false;
      // item check (number or string id in array)
      if (excludedItems?.includes(row.product_id)) return false;
      return true;
    }).map(row => {
      let ingredients = [];
      try {
        ingredients =
          row.oi_ingredients
            ? (typeof row.oi_ingredients === "string" ? JSON.parse(row.oi_ingredients) : row.oi_ingredients)
            : (row.p_ingredients
              ? (typeof row.p_ingredients === "string" ? JSON.parse(row.p_ingredients) : row.p_ingredients)
              : []);
      } catch {
        ingredients = [];
      }

      let extras = [];
      try {
        extras =
          row.oi_extras
            ? (typeof row.oi_extras === "string" ? JSON.parse(row.oi_extras) : row.oi_extras)
            : (row.p_extras
              ? (typeof row.p_extras === "string" ? JSON.parse(row.p_extras) : row.p_extras)
              : []);
      } catch {
        extras = [];
      }

       return {
        item_id: row.item_id,
        product_id: row.product_id,
        product_name: row.product_name,
        quantity: row.quantity,
        ingredients,
        extras,
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
        order_id: row.order_id,
      };
    });

    res.json(orders);
  } catch (err) {
    console.error("❌ Kitchen route failed:", err);
    res.status(500).json({ error: "Kitchen order fetch failed" });
  }
});

function safeParse(data) {
  try {
    if (!data) return [];
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch (e) {
    return [];
  }
}

// ✅ UPDATE kitchen_status for multiple order_items
router.put("/order-items/kitchen-status", async (req, res) => {
  const { ids, status } = req.body;
  if (!Array.isArray(ids) || !status) {
    return res.status(400).json({ error: "Missing ids or status" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Update kitchen_status for all items
    await client.query(
      `UPDATE order_items SET kitchen_status = $1 WHERE id = ANY($2::int[])`,
      [status, ids]
    );

    // 2. Find affected order IDs
    const { rows: itemOrders } = await client.query(
      `SELECT DISTINCT order_id FROM order_items WHERE id = ANY($1::int[])`,
      [ids]
    );
    const orderIds = itemOrders.map((r) => r.order_id);

    // 3. For each order, set prep_started_at / estimated_ready_at / kitchen_delivered_at
    const deliveredOrderIds = [];
    const penaltyPerBatch = (orderIds.length - 1) * 2 * 60; // +2min per extra order in the batch

    for (const orderId of orderIds) {
      // Fetch all items for this order
      const { rows: allItems } = await client.query(
        `SELECT kitchen_status FROM order_items WHERE order_id = $1`,
        [orderId]
      );
      const statuses = allItems.map((i) => i.kitchen_status);

      // --- PENALTY LOGIC ---
      if (statuses.includes("preparing")) {
        // Calculate max prep time among all products in this order,
        // including per-item (quantity) penalty!
        const { rows: itemsWithPrep } = await client.query(
          `SELECT oi.quantity, p.preparation_time
           FROM order_items oi
           JOIN products p ON oi.product_id = p.id
           WHERE oi.order_id = $1`,
          [orderId]
        );

        const penaltyPerExtra = 2 * 60; // 2min per extra of same product
        let itemTimes = [];

        for (const row of itemsWithPrep) {
          const prep = parseInt(row.preparation_time, 10) || 1; // minutes
          const qty = parseInt(row.quantity, 10) || 1;
          // Each product: first one prep time, others add penalty only
          const timeForThisProduct = (prep * 60) + ((qty - 1) * penaltyPerExtra);
          itemTimes.push(timeForThisProduct);
        }

        // Take the max product time as totalSeconds for the order
        let totalSeconds = itemTimes.length ? Math.max(...itemTimes) : 0;
        if (itemsWithPrep.length >= 3) totalSeconds = Math.round(totalSeconds * 1.2);

        // Add batch penalty if preparing multiple orders together
        totalSeconds += penaltyPerBatch;

        const estReadyAt = new Date(Date.now() + totalSeconds * 1000);

        // Save to DB
        await client.query(
          `UPDATE orders
           SET prep_started_at = COALESCE(prep_started_at, NOW()),
               estimated_ready_at = $1
           WHERE id = $2`,
          [estReadyAt, orderId]
        );
      } else {
        await client.query(
          `UPDATE orders SET estimated_ready_at = NULL WHERE id = $1`,
          [orderId]
        );
      }

      // a) PREP STARTED (prep_started_at always set above)
      // b) ALL DELIVERED
      if (statuses.length && statuses.every((s) => s === "delivered")) {
        await client.query(
          `UPDATE orders SET kitchen_delivered_at = NOW() WHERE id = $1`,
          [orderId]
        );
        deliveredOrderIds.push(orderId);
      }
    }

    await client.query("COMMIT");

    // 4. EMIT SOCKETS
    const io = getIO();
    io.emit("orders_updated");

    if (status === "ready") {
      io.emit("order_ready", { orderIds });
    }

    if (status === "delivered" && deliveredOrderIds.length) {
      emitOrderDelivered(io, deliveredOrderIds);
    }

    res.json({ updated: ids.length });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to update kitchen_status:", err);
    res.status(500).json({ error: "Database update error" });
  } finally {
    client.release();
  }
});


// PATCH /orders/:id/status
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
       WHERE id = $4
       RETURNING *`,
      [status, total, payment_method, id]
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
    getIO().emit("orders_updated"); // Or: const io = getIO(); io.emit(...);
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Error updating order status:", err);
    res.status(500).json({ error: "Failed to update order" });
  } finally {
    client.release();
  }
});

// DELETE all test/closed orders (use only during testing)
router.delete("/orders/dev-reset", async (req, res) => {
  try {
    await pool.query(`
      DELETE FROM order_items WHERE order_id IN (
        SELECT id FROM orders WHERE status = 'paid' OR status = 'closed'
      );
    `);
    await pool.query(`DELETE FROM sub_orders;`);
    await pool.query(`DELETE FROM orders WHERE status = 'paid' OR status = 'closed';`);
    res.json({ message: "🧹 Old orders deleted (paid/closed)" });
  } catch (err) {
    console.error("❌ Cleanup failed:", err);
    res.status(500).json({ error: "Failed to clean up old orders" });
  }
});

// GET /order-items/preparing
router.get("/order-items/preparing", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT unique_id
      FROM order_items
      WHERE kitchen_status = 'preparing'
    `);
    res.json(result.rows.map(row => row.unique_id));
  } catch (err) {
    console.error("❌ Failed to fetch preparing items", err);
    res.status(500).json({ error: "Failed to fetch preparing items" });
  }
});

// --- CREATE or UPDATE a timer ---
router.post("/kitchen-timers", async (req, res) => {
  const { id, name, secondsLeft, total, running } = req.body;
  try {
    if (id) {
      // Update existing timer
      const result = await pool.query(
        `UPDATE kitchen_timers SET
          name = $1,
          seconds_left = $2,
          total_seconds = $3,
          running = $4,
          updated_at = NOW()
         WHERE id = $5
         RETURNING *`,
        [name, secondsLeft, total, running, id]
      );
      return res.json(result.rows[0]);
    } else {
      // Insert new timer
      const result = await pool.query(
        `INSERT INTO kitchen_timers (name, seconds_left, total_seconds, running)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [name, secondsLeft, total, running]
      );
      return res.json(result.rows[0]);
    }
  } catch (err) {
    console.error("❌ Failed to save kitchen timer:", err);
    return res.status(500).json({ error: "Failed to save kitchen timer" });
  }
});

// --- GET all timers ---
router.get("/kitchen-timers", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM kitchen_timers ORDER BY created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Failed to fetch kitchen timers:", err);
    res.status(500).json({ error: "Failed to fetch kitchen timers" });
  }
});

// --- DELETE a timer ---
router.delete("/kitchen-timers/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM kitchen_timers WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to delete kitchen timer:", err);
    res.status(500).json({ error: "Failed to delete kitchen timer" });
  }
});


router.get("/kitchen/compile-settings", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT excluded_ingredients, excluded_categories, excluded_items FROM kitchen_compile_settings ORDER BY id LIMIT 1`
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


// POST: Update excluded ingredients
router.post("/kitchen/compile-settings", async (req, res) => {
  const { excludedIngredients = [], excludedCategories = [], excludedItems = [] } = req.body;
  try {
    await pool.query(
      `UPDATE kitchen_compile_settings
       SET excluded_ingredients = $1,
           excluded_categories = $2,
           excluded_items = $3,
           updated_at = NOW()
       WHERE id = 1`,
      [
        JSON.stringify(excludedIngredients),
        JSON.stringify(excludedCategories),
        JSON.stringify(excludedItems)
      ]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to update compile settings:", err);
    res.status(500).json({ error: "Failed to update compile settings" });
  }
});



module.exports = router;
