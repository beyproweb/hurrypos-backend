  module.exports = function(io) {
  const express = require('express');
  const router = express.Router();
  const { pool } = require("../db");
  const { getIO } = require("../utils/socket");
  const { v4: uuidv4 } = require("uuid");


  const { emitAlert, emitStockUpdate,emitOrderUpdate,emitOrderConfirmed,emitOrderDelivered} = require('../utils/realtime');




// GET /orders - Returns all active orders or filters by table_number if provided
// AFTER: join in receipt_methods so every order row carries its own array
router.get("/", async (req, res) => {
  try {
    const { table_number, type } = req.query;
    const clauses = [];
    const params = [];
    if (table_number) {
      params.push(table_number);
      clauses.push(`o.table_number = $${params.length}`);
      clauses.push(`o.status != 'closed'`);
    }
    if (type) {
      params.push(type);
      clauses.push(`o.order_type = $${params.length}`);
      clauses.push(`o.status != 'closed'`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `
      SELECT
        o.*,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'payment_method', r.payment_method,
              'amount',         r.amount
            ) ORDER BY r.id
          ) FILTER (WHERE r.id IS NOT NULL),
          '[]'
        ) AS receipt_methods
      FROM orders o
      LEFT JOIN receipt_methods r
        ON r.receipt_id = o.receipt_id
      ${where}
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});




// POST /orders - Create new order (table or phone), status 'occupied'
router.post("/", async (req, res) => {
  console.log("💬 /orders payload:", req.body);

  // --- TIMEZONE-SAFE REGISTER OPEN LOGIC ---
  const { rows: openLogs } = await pool.query(`
    SELECT * FROM cash_register_logs WHERE type = 'open' ORDER BY created_at DESC LIMIT 1
  `);
  const lastOpen = openLogs[0];

  if (!lastOpen) {
    return res.status(403).json({ error: "Register is closed. Cannot place order." });
  }

  const { rows: closeLogs } = await pool.query(`
    SELECT * FROM cash_register_logs WHERE type = 'close' AND created_at > $1 ORDER BY created_at ASC LIMIT 1
  `, [lastOpen.created_at]);
  const lastClose = closeLogs[0] || null;

  if (lastClose) {
    return res.status(403).json({ error: "Register is closed. Cannot place order." });
  }
  // --- END REGISTER CHECK ---

  // ...rest of your order creation logic...
  const client = await pool.connect();
  try {
    const {
      table_number,
      total,
      items = [],
      order_type,          // 'table' or 'phone'
      customer_name,
      customer_phone,
      customer_address,
      payment_method       // <-- ADDED HERE
    } = req.body;
    console.log('ORDER TYPE from payload:', order_type);
    await client.query("BEGIN");

    // Insert with all possible fields including payment_method
    const hasItems = items && items.length > 0;
    const initialStatus = hasItems ? 'confirmed' : 'occupied'; // was 'closed', now 'occupied'

    const orderResult = await client.query(
      `
      INSERT INTO orders (
        table_number, status, total, order_type,
        customer_name, customer_phone, customer_address, payment_method
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        table_number || null,
        initialStatus,
        total,
        order_type || null,
        customer_name || null,
        customer_phone || null,
        customer_address || null,
        payment_method || null
      ]
    );
    console.log('ORDER TYPE after insert:', orderResult.rows[0].order_type);

    const order = orderResult.rows[0];

    if (items && items.length > 0) {
      await saveOrderItems(order.id, items);
    }

    await client.query("COMMIT");
    if (typeof emitOrderUpdate === 'function') emitOrderUpdate(io);

    res.json(order);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Error creating order:", err);
    res.status(500).json({ error: "Database error" });
  } finally {
    client.release();
  }
});




// PUT /orders/:id/pay - Update payment info and insert a payment record
router.put("/:id/pay", async (req, res) => {
  const { id } = req.params;
  const { payment_method, total } = req.body;
  const orderId = parseInt(id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1️⃣ Insert payment
    const paymentResult = await client.query(
      `INSERT INTO payments (order_id, amount, payment_method)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [orderId, total, payment_method]
    );

    // 2️⃣ Update order
    const orderResult = await client.query(
      `UPDATE orders
       SET payment_method = $1,
           total = $2,
           is_paid = true
       WHERE id = $3
       RETURNING *`,
      [payment_method, total, orderId]
    );

    // 3️⃣ Mark unpaid items as paid
    await client.query(
      `UPDATE order_items
       SET paid_at = NOW(),
           confirmed = true
       WHERE order_id = $1 AND paid_at IS NULL`,
      [orderId]
    );

    // ✅ FIX: DO NOT deliver anything here - keep kitchen_status unchanged!

    const kitchenCheck = await client.query(
      `SELECT id, product_id, kitchen_status, paid_at
       FROM order_items
       WHERE order_id = $1`,
      [orderId]
    );

    console.log("🔍 Kitchen status after PAY:", kitchenCheck.rows);

    await client.query("COMMIT");
    emitOrderUpdate(io); // Pass io if needed
    res.json({
      order: orderResult.rows[0],
      payment: paymentResult.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to update payment info:", err);
    res.status(500).json({ error: "Failed to mark order as paid" });
  } finally {
    client.release();
  }
});



// ✅ PUT /orders/:id/status
router.put("/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status, total, payment_method } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE orders
       SET status = $1,
           total = COALESCE($2, total),
           payment_method = COALESCE($3, payment_method),
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
      await client.query(
        `UPDATE order_items
         SET paid_at = NOW(), confirmed = true
         WHERE order_id = $1 AND paid_at IS NULL`,
        [id]
      );
    }

   // ✅ FIX in orders.js
await client.query("COMMIT");

if (status === "confirmed") {
  setTimeout(() => emitOrderConfirmed(io, parseInt(id)), 500); // 500ms delay for DB commit
}

emitOrderUpdate(io);


    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Error updating order status:", err);
    res.status(500).json({ error: "Failed to update order" });
  } finally {
    client.release();
  }
});




// In orders.js after your other routes

// GET /api/driver-report?driver_id=1&date=YYYY-MM-DD
// GET /api/driver-report?driver_id=1&date=YYYY-MM-DD
router.get("/driver-report", async (req, res) => {
  const { driver_id, date } = req.query;
  if (!driver_id || !date) {
    return res.status(400).json({ error: "driver_id and date are required" });
  }

  try {
    // 👇 Add customer_name, customer_address to SELECT
    const ordersRes = await pool.query(`
      SELECT
        id, payment_method, status, driver_status,
        created_at, picked_up_at, delivered_at, kitchen_delivered_at,
        customer_name, customer_address
      FROM orders
      WHERE driver_id = $1
        AND DATE(delivered_at) = $2
        AND driver_status = 'delivered'
        AND status = 'closed'
      ORDER BY delivered_at ASC
    `, [driver_id, date]);
    const orders = ordersRes.rows;

    let total_sales = 0;
    const sales_by_method = {};
    const order_details = [];
    for (const order of orders) {
      const { rows: items } = await pool.query(
        "SELECT price, quantity FROM order_items WHERE order_id = $1",
        [order.id]
      );
      const orderTotal = items.reduce((sum, i) => sum + parseFloat(i.price) * i.quantity, 0);
      total_sales += orderTotal;
      order_details.push({
        ...order,
        total: orderTotal,
        delivery_time_seconds:
          order.picked_up_at && order.delivered_at
            ? (new Date(order.delivered_at) - new Date(order.picked_up_at)) / 1000
            : null,
        kitchen_to_delivery_seconds:
          order.kitchen_delivered_at && order.delivered_at
            ? (new Date(order.delivered_at) - new Date(order.kitchen_delivered_at)) / 1000
            : null,
      });
      if (order.payment_method) {
        sales_by_method[order.payment_method] = (sales_by_method[order.payment_method] || 0) + orderTotal;
      }
    }

    res.json({
      packets_delivered: orders.length,
      total_sales,
      sales_by_method,
      orders: order_details,
    });
  } catch (err) {
    console.error("❌ Error in /driver-report:", err);
    res.status(500).json({ error: "DB error" });
  }
});


// POST order items (with upsert for existing items)
router.post("/order-items", async (req, res) => {
  const { order_id, items, receipt_id } = req.body;

  const preparedItems = items.map((item, idx) => {

    return {
      ...item,
      receipt_id: item.receipt_id || receipt_id || null,
      kitchen_status: item.confirmed && !item.paid_at ? 'new' : item.kitchen_status || null // ✅ only if confirmed and not yet paid
    };
  });

  try {
    await saveOrderItems(order_id, preparedItems);
     // --- ADD THIS BLOCK:
    const orderRes = await pool.query("SELECT status FROM orders WHERE id = $1", [order_id]);
    if (["closed", "occupied"].includes(orderRes.rows[0]?.status)) {
  await pool.query("UPDATE orders SET status = 'confirmed' WHERE id = $1", [order_id]);
}

    emitOrderUpdate(io); // <-- ADD THIS
    res.json({ message: "Order items saved successfully" });
  } catch (err) {
    console.error("❌ Error saving order items:", err);
    res.status(500).json({ error: "Failed to save order items" });
  }
});


async function saveOrderItems(orderId, items) {
  for (const item of items) {
    const extrasString = JSON.stringify(item.extras || []);
    const unique_id = item.unique_id || uuidv4();

    const existing = await pool.query(
      "SELECT id FROM order_items WHERE unique_id = $1 AND order_id = $2",
      [unique_id, orderId]
    );

    if (existing.rowCount > 0) {
      await pool.query(
        "UPDATE order_items SET discount_type = $1, discount_value = $2 WHERE id = $3",
        [item.discountType || null, item.discountValue || 0, existing.rows[0].id]
      );
      continue;
    }

    // 🔥 FIXED INSERT STATEMENT (with kitchen_status)
    await pool.query(
      `INSERT INTO order_items (
        order_id, product_id, quantity, price,
        ingredients, extras, unique_id,
        confirmed, kitchen_status, payment_method, receipt_id, note,
        discount_type, discount_value,
        external_product_id, external_product_name, name
      )
      VALUES (
        $1, $2, $3, $4,
        $5::jsonb, $6::jsonb, $7,
        $8, $9, $10, $11, $12,
        $13, $14,
        $15, $16, $17
      )`,
      [
        orderId,
        Number(item.product_id) || null,
        item.quantity,
        parseFloat(item.price),
        JSON.stringify(item.ingredients || []),
        extrasString,
        unique_id,

        !!item.confirmed,          // new, always boolean
       // confirmed always true
        item.kitchen_status || 'new',   // kitchen_status now correctly inserted

        item.payment_method || null,
        item.receipt_id || null,
        item.note || null,

        item.discountType || null,
        item.discountValue || 0,

        item.product_id || null,
        item.name || null,
        item.name || null
      ]
    );
  }
}

// GET /order-items/preparing - Returns IDs of order_items still preparing
router.get("/order-items/preparing", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM order_items WHERE kitchen_status = 'preparing'`
    );
    // Return just the IDs as an array of numbers
    res.json(rows.map(r => r.id));
  } catch (err) {
    console.error("❌ Error in /order-items/preparing:", err);
    res.status(500).json({ error: "Failed to fetch preparing items" });
  }
});


router.put('/:id', async (req, res) => {

  const { id } = req.params;
  const { total, payment_method, driver_id, receipt_id, changed_by } = req.body; // changed_by is optional (send from frontend if you want)
    // 💡 GUARD: Only allow string as payment_method
  let _payment_method = payment_method;
  if (_payment_method && Array.isArray(_payment_method)) {
    _payment_method = _payment_method[0]?.payment_method || _payment_method[0] || null;
  }

  try {
    // 1. Fetch old payment method before updating
    let old_method = undefined;
    if (payment_method !== undefined) {
      const oldOrder = await pool.query('SELECT payment_method FROM orders WHERE id = $1', [id]);
      old_method = oldOrder.rows[0]?.payment_method;
    }

    // 2. Build dynamic SET clause (so we don't overwrite fields with undefined/null)
    let setClauses = [];
    let params = [];
    let idx = 1;

    if (total !== undefined) {
      setClauses.push(`total = $${idx++}`);
      params.push(total);
    }
 if (_payment_method !== undefined) {
  setClauses.push(`payment_method = $${idx++}`);
  params.push(_payment_method);
}

    if (driver_id !== undefined) {
      setClauses.push(`driver_id = $${idx++}`);
      params.push(driver_id);
    }
    if (receipt_id !== undefined) {
      setClauses.push(`receipt_id = $${idx++}`);
      params.push(receipt_id);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    params.push(id);

    // 3. Update the order
    const result = await pool.query(
      `UPDATE orders
       SET ${setClauses.join(", ")}
       WHERE id = $${params.length}
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    // 4. Log payment method change
    if (payment_method !== undefined && payment_method !== old_method) {
      await pool.query(
        `INSERT INTO payment_method_changes (order_id, old_method, new_method, changed_by)
         VALUES ($1, $2, $3, $4)`,
        [id, old_method, payment_method, changed_by || 'system']
      );
    }

    setTimeout(() => {
      emitOrderUpdate(req.app.get('io'));
    }, 250); // 250ms delay guarantees DB is fully committed

    res.json({ success: true });
  } catch (err) {
    console.error("Failed to update order:", err);
    res.status(500).json({ error: "Update failed" });
  }
});



// POST /orders/:id/close
router.post("/:id/close", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Double-check all items are delivered (optional, or skip if frontend guarantees this)
    // const itemsRes = await client.query(
    //   `SELECT COUNT(*) FROM order_items WHERE order_id = $1 AND kitchen_status != 'delivered'`,
    //   [id]
    // );
    // if (parseInt(itemsRes.rows[0].count, 10) > 0) {
    //   await client.query("ROLLBACK");
    //   return res.status(400).json({ error: "Not all items delivered" });
    // }

    // 2. Set order status to closed
    const result = await client.query(
  `UPDATE orders
   SET status = 'closed'
   WHERE id = $1
   RETURNING *`,
  [id]
);


    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    // 3. (Optional) Free the table if order has a table_number
    const order = result.rows[0];
    if (order.table_number) {
      await client.query(
        `UPDATE tables SET is_occupied = FALSE WHERE number = $1`,
        [order.table_number]
      );
    }

    // 4. (Optional) Deduct stock for ingredients/extras if not done by kitchen

    await client.query("COMMIT");
    emitOrderUpdate(io);
    res.json({ message: "✅ Order closed, stock updated, and table freed." });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Error in closing order:", err);
    res.status(500).json({ error: "Failed to close and update stock." });
  } finally {
    client.release();
  }
});



// Add to routes/orders.js or a debug file
router.get('/debug/order-item-discounts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, order_id, product_id, discount_type, discount_value
       FROM order_items
       WHERE discount_value IS NOT NULL AND discount_value > 0
       ORDER BY id DESC
       LIMIT 20`
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ Debug discount check failed:', err);
    res.status(500).json({ error: 'Failed to fetch discounted items' });
  }
});



// ✅ Update stock based on ingredients and extras
async function updateStockForOrder(orderItems) {
  console.log("🧾 Received order items:", orderItems);

  for (const item of orderItems) {
    const quantityMultiplier = parseInt(item.quantity);

    const ingredients = Array.isArray(item.ingredients)
      ? item.ingredients
      : JSON.parse(item.ingredients || "[]");

    const extras = Array.isArray(item.extras)
      ? item.extras
      : JSON.parse(item.extras || "[]");

for (const ing of ingredients) {
  const usedQty = parseFloat(ing.quantity) * quantityMultiplier;
  console.log(`🔻 Deducting Ingredient: ${ing.ingredient} -${usedQty} ${ing.unit}`);

  const res = await pool.query(
    `UPDATE stock
     SET quantity = quantity - $1
     WHERE LOWER(name) = LOWER($2) AND unit = $3
     RETURNING *`,
    [usedQty, ing.ingredient, ing.unit]
  );

  const updatedStock = res.rows[0];
  if (res.rowCount > 0 && updatedStock) {
    emitStockUpdate(io, updatedStock.id);
    // Reset auto_added_to_cart if now above critical
    if (
      updatedStock.quantity > updatedStock.critical_quantity &&
      updatedStock.auto_added_to_cart
    ) {
      await pool.query(
        "UPDATE stock SET auto_added_to_cart = FALSE WHERE id = $1",
        [updatedStock.id]
      );
    }
    // 🧂 Emit Stock Low alert if now below or equal to critical (and critical is set)
    if (
      updatedStock.critical_quantity &&
      updatedStock.quantity <= updatedStock.critical_quantity
    ) {
      emitAlert(
        io,
        `🧂 Stock Low: ${updatedStock.name} (${updatedStock.quantity} ${updatedStock.unit})`,
        updatedStock.id,
        "stock",
        { stockId: updatedStock.id }
      );
    }
  } else {
    console.warn(`⚠️ No matching stock found for ingredient: ${ing.ingredient}`);
  }
}

  }
}



// GET order items by order ID
router.get("/:id/items", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
  `SELECT
     oi.product_id,
     oi.external_product_id,
     oi.quantity,
     oi.price,
     oi.ingredients,
     oi.extras,
     oi.unique_id,
     oi.paid_at,
     oi.confirmed,
     oi.payment_method,
     oi.receipt_id,
     oi.note,
     oi.kitchen_status,
     oi.discount_type,
     oi.discount_value,
     oi.name AS order_item_name,
     oi.external_product_name,
     p.name AS product_name
   FROM order_items oi
   LEFT JOIN products p ON oi.product_id = p.id
   WHERE oi.order_id = $1`,
  [id]
);

    const items = result.rows.map(item => ({
  ...item,
  extras: typeof item.extras === 'string' ? JSON.parse(item.extras) : (item.extras || [])
}));

res.json(items);

  } catch (err) {
    console.error("❌ Error fetching order items:", err);
    res.status(500).json({ error: "Failed to load order items" });
  }
});


// PATCH /orders/:id/reset-if-empty
router.patch("/:id/reset-if-empty", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    const itemsRes = await client.query("SELECT COUNT(*) FROM order_items WHERE order_id = $1", [id]);
    const itemCount = parseInt(itemsRes.rows[0].count, 10);

    if (itemCount === 0) {
      await client.query("UPDATE orders SET status = 'closed' WHERE id = $1", [id]);
        emitOrderUpdate(io); // <-- ADD THIS

      return res.json({ message: "Order status reset to closed" });
    }

    res.json({ message: "Order has items, not resetting" });
  } catch (error) {
    console.error("❌ Error resetting order:", error);
    res.status(500).json({ error: "Failed to reset order" });
  } finally {
    client.release();
  }
});



// POST /sub-orders
router.post("/sub-orders", async (req, res) => {
  const { order_id, total, payment_method, items, receipt_id } = req.body;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO sub_orders (order_id, total, payment_method, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id AS sub_order_id`,
      [order_id, total, payment_method]
    );
    const subOrderId = rows[0].sub_order_id;

    const itemsWithReceipt = items.map((item) => ({
      ...item,
      receipt_id: receipt_id || null,
      payment_method: item.payment_method || payment_method,
      product_id: item.product_id
      // kitchen_status is intentionally NOT touched ✅
    }));

    await saveOrderItems(order_id, itemsWithReceipt);

    const uniqueIds = itemsWithReceipt.map((i) => i.unique_id);

    const updateRes = await client.query(
      `UPDATE order_items
       SET sub_order_id = $1,
           paid_at = NOW(),
           confirmed = true,
           receipt_id = $4,
           payment_method = $5
       WHERE order_id = $2
         AND unique_id = ANY($3::text[])`,
      [subOrderId, order_id, uniqueIds, receipt_id, payment_method]
    );

    console.log(`✅ Updated ${updateRes.rowCount} item(s) in order_items`);

    await client.query(
      `UPDATE orders
       SET total = total + $1
       WHERE id = $2`,
      [total, order_id]
    );

    await client.query("COMMIT");
    emitOrderUpdate(io); // Pass io if needed

    res.json({ sub_order_id: subOrderId });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Sub-order failed:", err);
    res.status(500).json({ error: "Sub-order creation failed" });
  } finally {
    client.release();
  }
});


// GET /orders/:orderId/suborders
router.get("/:orderId/suborders", async (req, res) => {
  const { orderId } = req.params;
  try {
    const result = await pool.query(`
      SELECT
        so.id AS sub_order_id,
        so.payment_method,
        so.total,
        so.created_at,
        json_agg(
          json_build_object(
  'product_id', oi.product_id,
  'name', p.name,
  'quantity', oi.quantity,
  'price', oi.price,
  'ingredients', oi.ingredients,
  'extras', oi.extras,
  'unique_id', oi.unique_id,
  'payment_method', oi.payment_method,
  'paid_at', oi.paid_at,
  'receipt_id', oi.receipt_id     -- ✅ ADD THIS LINE
)

        ) AS items
      FROM sub_orders so
      JOIN order_items oi ON so.id = oi.sub_order_id
      JOIN products p ON oi.product_id = p.id
      WHERE so.order_id = $1
      GROUP BY so.id
      ORDER BY so.created_at ASC
    `, [orderId]);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching sub-orders:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


// Get order header
router.get("/:id", async (req, res) => {
  try {
    const orderRes = await pool.query(
      `SELECT id, status, table_number, order_type, total, created_at
       FROM orders WHERE id = $1`,
      [req.params.id]
    );
    if (!orderRes.rows.length) return res.status(404).json({ error: "Order not found" });

    const itemsRes = await pool.query(
      `SELECT
         oi.product_id,
         oi.name AS order_item_name,
         p.name AS product_name,
         oi.quantity,
         oi.price,
         oi.extras,
         oi.kitchen_status
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1`,
      [req.params.id]
    );

    const items = itemsRes.rows.map(it => ({
      ...it,
      extras: typeof it.extras === "string" ? JSON.parse(it.extras) : (it.extras || [])
    }));

    res.json({ ...orderRes.rows[0], items });
  } catch (e) {
    console.error("GET /orders/:id failed", e);
    res.status(500).json({ error: "Failed to fetch order" });
  }
});



// ✅ PATCH /orders/:id/reopen
router.patch("/:id/reopen", async (req, res) => {
  const { id } = req.params;

  try {
    // Fetch the order to ensure it exists
    const result = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Set status back to "occupied" to trigger cart rehydration on the client
    const update = await pool.query(
      `UPDATE orders
       SET status = 'occupied'
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    res.json(update.rows[0]);
  } catch (err) {
    console.error("❌ Failed to reopen order:", err);
    res.status(500).json({ error: "Failed to reopen order" });
  }
});

// ✅ GET all payment methods used for a specific receipt
router.get("/receipt-methods/:receipt_id", async (req, res) => {
  const { receipt_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT payment_method, amount
       FROM receipt_methods
       WHERE receipt_id = $1
       ORDER BY id ASC`,
      [receipt_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching receipt methods:", err);
    res.status(500).json({ error: "Failed to fetch receipt methods" });
  }
});

// ✅ INSERT receipt_methods for a given receipt
async function insertReceiptMethods(receiptId, methodAmounts = {}) {
  // Always delete old methods for this receipt before inserting new ones!
  await pool.query(
    `DELETE FROM receipt_methods WHERE receipt_id = $1`, [receiptId]
  );
  const entries = Object.entries(methodAmounts).filter(([_, amount]) => parseFloat(amount) > 0);
  for (const [method, amount] of entries) {
    await pool.query(
      `INSERT INTO receipt_methods (receipt_id, payment_method, amount)
       VALUES ($1, $2, $3)`,
      [receiptId, method, amount]
    );
  }
}


// ✅ Support both single and sub-orders in split receipts
// PATCHED: Always save receipt_id to the order when posting split payments

router.post("/receipt-methods", async (req, res) => {
  let { receipt_id, methods, order_id } = req.body;

  try {
    // If missing, generate new receipt_id and update order
    if ((!receipt_id || receipt_id === "null") && order_id) {
      const { rows } = await pool.query(
        "UPDATE orders SET receipt_id = gen_random_uuid() WHERE id = $1 RETURNING receipt_id",
        [order_id]
      );
      receipt_id = rows[0].receipt_id;
    }

    // PATCH: Always set the receipt_id on the order (even if already present)
    if (order_id && receipt_id) {
      await pool.query(
        "UPDATE orders SET receipt_id = $1 WHERE id = $2",
        [receipt_id, order_id]
      );
    }

    // Validate input
    if (!receipt_id || typeof methods !== "object") {
      return res.status(400).json({ error: "Invalid payload: missing receipt_id" });
    }

    // Remove existing methods for this receipt
    await pool.query(`DELETE FROM receipt_methods WHERE receipt_id = $1`, [receipt_id]);

    // Insert all split methods for this receipt
    for (const [method, amount] of Object.entries(methods)) {
      if (parseFloat(amount) > 0) {
        await pool.query(
          `INSERT INTO receipt_methods (receipt_id, payment_method, amount) VALUES ($1, $2, $3)`,
          [receipt_id, method, amount]
        );
      }
    }

    // Optionally update payment_method string on order for clarity
    const paymentMethodStr = Object.keys(methods)
      .filter((k) => parseFloat(methods[k]) > 0)
      .join("+");
    await pool.query(
      `UPDATE orders SET payment_method = $1 WHERE receipt_id = $2`,
      [paymentMethodStr, receipt_id]
    );

    res.json({ message: "Receipt methods saved", receipt_id });
  } catch (err) {
    console.error("❌ Error inserting receipt methods:", err);
    res.status(500).json({ error: "Failed to insert receipt methods" });
  }
});


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





// PATCH /orders/:id/driver-status
router.patch("/:id/driver-status", async (req, res) => {
  const { id } = req.params;
  let { driver_status } = req.body;
  const client = await pool.connect();

  // Defensive type casting
  if (typeof driver_status !== "string") {
    driver_status = String(driver_status || "");
  }

  try {
    await client.query("BEGIN");

    // 🛑 Block driver status change if driver_id is not assigned
    const driverCheck = await client.query(
      `SELECT driver_id FROM orders WHERE id = $1`,
      [id]
    );
    const order = driverCheck.rows[0];
    if (!order || !order.driver_id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Cannot change driver status: no driver assigned!" });
    }

    // 1. Always update driver_status
    await client.query(
      `UPDATE orders
       SET driver_status = $1
       WHERE id = $2`,
      [driver_status, id]
    );

    // 2. If delivered, set delivered_at
    if (driver_status === "delivered") {
      await client.query(
        `UPDATE orders
         SET delivered_at = NOW()
         WHERE id = $1 AND delivered_at IS NULL`,
        [id]
      );
    }

    await client.query("COMMIT");
    getIO().emit("orders_updated");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Driver status update failed:", err);
    res.status(500).json({ error: "Failed to update driver status" });
  } finally {
    client.release();
  }
});


// PATCH /api/orders/:id/move-table
router.patch("/:id/move-table", async (req, res) => {
  const { id } = req.params;
  const { new_table_number } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Find current table number
    const orderRes = await client.query(
      `SELECT table_number FROM orders WHERE id = $1`,
      [id]
    );
    const currentTable = orderRes.rows[0]?.table_number;
    if (!currentTable) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order or table not found" });
    }

    // Check if destination table is occupied
    const destRes = await client.query(
      `SELECT is_occupied FROM tables WHERE number = $1`,
      [new_table_number]
    );
    if (destRes.rows[0]?.is_occupied) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Destination table is occupied" });
    }

    // Move order to new table
    await client.query(
      `UPDATE orders SET table_number = $1 WHERE id = $2`,
      [new_table_number, id]
    );

    // Mark old table as free, new as occupied
    await client.query(
      `UPDATE tables SET is_occupied = FALSE WHERE number = $1`,
      [currentTable]
    );
    await client.query(
      `UPDATE tables SET is_occupied = TRUE WHERE number = $1`,
      [new_table_number]
    );

    await client.query("COMMIT");
    if (typeof emitOrderUpdate === 'function') emitOrderUpdate(req.app.get('io'));
    res.json({ success: true, new_table_number });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Failed to move table" });
  } finally {
    client.release();
  }
});



// PATCH /api/orders/:id/merge-table
router.patch("/:id/merge-table", async (req, res) => {
  const { id } = req.params; // Source order ID (from table being merged)
  const { target_table_number } = req.body; // Destination table number

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Find target order (must be active and not closed)
    const targetOrderRes = await client.query(
      `SELECT * FROM orders WHERE table_number = $1 AND status != 'closed' ORDER BY created_at DESC LIMIT 1`,
      [target_table_number]
    );
    if (targetOrderRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Target table has no active order" });
    }
    const targetOrder = targetOrderRes.rows[0];

    // 2. Get all source order items
    const { rows: sourceItems } = await client.query(
      `SELECT * FROM order_items WHERE order_id = $1`,
      [id]
    );

    // 3. For each source item: try to merge into target or move
    for (const item of sourceItems) {
      // Check for duplicate in target order
      const { rows: dup } = await client.query(
        `SELECT id, quantity FROM order_items WHERE order_id = $1 AND unique_id = $2`,
        [targetOrder.id, item.unique_id]
      );

      if (dup.length > 0) {
        // Combine quantities
        await client.query(
          `UPDATE order_items SET quantity = quantity + $1 WHERE id = $2`,
          [item.quantity, dup[0].id]
        );
        // Remove the source item
        await client.query(
          `DELETE FROM order_items WHERE id = $1`,
          [item.id]
        );
      } else {
        // Move the item to the target order
        await client.query(
          `UPDATE order_items SET order_id = $1 WHERE id = $2`,
          [targetOrder.id, item.id]
        );
      }
    }

    // 4. Close the source order and free its table
    const sourceOrderRes = await client.query(
      `SELECT table_number FROM orders WHERE id = $1`,
      [id]
    );
    const sourceTable = sourceOrderRes.rows[0]?.table_number;

    await client.query(
      `UPDATE orders SET status = 'closed' WHERE id = $1`,
      [id]
    );
    if (sourceTable) {
      await client.query(
        `UPDATE tables SET is_occupied = FALSE WHERE number = $1`,
        [sourceTable]
      );
    }

    await client.query("COMMIT");
    if (typeof emitOrderUpdate === "function") emitOrderUpdate(req.app.get("io"));
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Merge table error:", err);
    res.status(500).json({ error: "Failed to merge table" });
  } finally {
    client.release();
  }
});

// POST /api/orders/:id/confirm-online
router.post("/:id/confirm-online", async (req, res) => {
console.log("✅ confirm-online route loaded");

  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Get order
    const { rows } = await client.query("SELECT * FROM orders WHERE id = $1", [id]);
    const order = rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    // 2. Check order type (packet/phone only)
    if (!["packet", "phone"].includes(order.order_type)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Only online orders can be auto-confirmed." });
    }

    // 3. Only confirm if not already confirmed/closed
    if (order.status === "confirmed" || order.status === "closed") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Order already confirmed or closed." });
    }

    // 4. Update status to "confirmed"
    const updateRes = await client.query(
      `UPDATE orders SET status = 'confirmed' WHERE id = $1 RETURNING *`,
      [id]
    );
    await client.query("COMMIT");

    // 5. Emit socket event
    emitOrderConfirmed(req.app.get("io"), parseInt(id));
    emitOrderUpdate(req.app.get("io"));

    res.json({ message: "Order confirmed", order: updateRes.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Error confirming online order:", err);
    res.status(500).json({ error: "Failed to confirm order" });
  } finally {
    client.release();
  }
});

// GET /api/orders/:id/payment-changes
router.get('/:id/payment-changes', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT old_method, new_method, changed_by, changed_at
         FROM payment_method_changes
         WHERE order_id = $1
         ORDER BY changed_at ASC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching payment method changes:', err);
    res.status(500).json({ error: 'Failed to fetch payment method changes' });
  }
});

return router;
};