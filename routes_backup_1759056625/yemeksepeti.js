// routes/yemeksepeti.js

const express = require('express');
const router = express.Router();
const { pool } = require("../db");
const { emitOrderUpdate } = require('../utils/realtime');

// 1. Receive Yemeksepeti order (Webhook)
router.post('/orders', async (req, res) => {
  try {
    const { order_id, items, customer, address, payment_method, total } = req.body;

    // Insert order into Beypro as 'packet' type
    // Fetch auto_confirm_orders from settings
const settingsRes = await pool.query("SELECT integrations FROM settings WHERE key = 'global'");
const integrations = settingsRes.rows?.[0]?.integrations || {};
const autoConfirm = integrations.auto_confirm_orders === true;

const status = autoConfirm ? "confirmed" : "pending";

const orderRes = await pool.query(
  `INSERT INTO orders (status, order_type, total, customer_name, customer_address, payment_method, external_id, customer_phone)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
   RETURNING *`,
  [
    status,
    'packet',
    total,
    customer?.name || '',
    address || '',
    payment_method || 'Cash',
    order_id,
    customer?.phone || null
  ]
);


    const order = orderRes.rows[0];

    // Insert order items (loop)
    for (const item of items) {
      await pool.query(
  `INSERT INTO order_items (
    order_id, product_id, external_product_id, external_product_name, quantity, price, name, note, kitchen_status, confirmed
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  [
    order.id,
    isNaN(Number(item.product_id)) ? null : Number(item.product_id),
    item.product_id,
    item.name,
    item.quantity,
    item.price,
    item.name,
    item.note || null,
    'new',
    true // <-- ADD THIS!!
  ]
);





    }

    emitOrderUpdate(req.app.get('io'));
    io.emit('yemeksepeti_order', { orderId: order.id });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Yemeksepeti order webhook error:", err);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// 2. Update status from Beypro → Yemeksepeti (confirm, out_for_delivery, delivered)
router.put('/order-status/:external_id', async (req, res) => {
  const { external_id } = req.params;
  const { status } = req.body;

  // TODO: Call Yemeksepeti API with new status using external_id and your credentials
  // Example call:
  // await yemeksepetiApi.updateOrderStatus(external_id, status);

  res.json({ success: true, note: 'Stub: implement call to Yemeksepeti API here.' });
});

// 3. Push menu (Stub for now)
router.post('/push-menu', async (req, res) => {
  // TODO: Build payload from your DB, send to Yemeksepeti API with your merchant credentials
  res.json({ success: true, note: 'Stub: implement menu sync here.' });
});

// 4. (Optional) Manual sync or pull endpoints as needed

module.exports = router;
