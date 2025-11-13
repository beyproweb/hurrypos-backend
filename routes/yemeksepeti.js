// routes/yemeksepeti.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { getIO } = require("../utils/socket");
// =========================================================
// LOCAL TEST ENDPOINT (NO AUTH) — DOES NOT USE extApiAuth
// =========================================================
router.post("/test", async (req, res) => {
  try {
    console.log("🧪 LOCAL TEST ORDER:", req.body);

    const restaurantId = 1; // your test restaurant

    const { order_id, total, customer, address, items } = req.body;

    const customerName = customer?.name || "Test Customer";
    const customerPhone = customer?.phone || null;

    const fullAddress = address || "Local Test Address";

    // 1) Insert order
    const orderRes = await pool.query(
      `INSERT INTO orders (
        restaurant_id, order_type, status, total,
        customer_name, customer_phone, customer_address,
        payment_method, external_id
      ) VALUES ($1,'packet','confirmed',$2,$3,$4,$5,'Online',$6)
      RETURNING id`,
      [
        restaurantId,
        total,
        customerName,
        customerPhone,
        fullAddress,
        order_id || "LOCAL_TEST"
      ]
    );

    const orderId = orderRes.rows[0].id;

    // 2) Insert items
    for (const item of items || []) {
      await pool.query(
        `INSERT INTO order_items (
          order_id, name, quantity, price, confirmed, kitchen_status
        ) VALUES ($1,$2,$3,$4,true,'new')`,
        [orderId, item.name, item.quantity, item.price]
      );
    }

    getIO().to(`restaurant_${restaurantId}`).emit("orders_updated");

    res.json({
      success: true,
      test: true,
      order_id: orderId
    });

  } catch (err) {
    console.error("❌ LOCAL TEST ERROR:", err);
    res.status(500).json({ error: "LOCAL_TEST_FAILED" });
  }
});

const extApiAuth = require("../middleware/externalApiAuth");
const { emitOrderUpdate } = require("../utils/realtime");


//
// 1️⃣ RECEIVE ORDER (Dispatch Order)
//    POST /api/integrations/yemeksepeti/order/:remoteId
//
router.post("/order/:remoteId", extApiAuth, async (req, res) => {
  try {
    const remoteId = req.params.remoteId;
    const body = req.body;
    const io = getIO();

    console.log("📥 YS DISPATCH ORDER:", JSON.stringify(body, null, 2));

    // Map remoteId → restaurant_id in your DB
    const r = await pool.query(
      "SELECT id FROM restaurants WHERE external_remote_id = $1 LIMIT 1",
      [remoteId]
    );

    if (!r.rows.length) {
      return res.status(404).json({
        reason: "restaurant_not_found",
        message: `No restaurant mapped to remoteId=${remoteId}`
      });
    }

    const restaurantId = r.rows[0].id;

    // Customer info
    const customerName = `${body.customer.firstName || ""} ${body.customer.lastName || ""}`.trim();
    const customerPhone = body.customer.mobilePhone || null;

    // Address
    const deliveryAddress = body.delivery?.address;
    const fullAddress = deliveryAddress
      ? `${deliveryAddress.street} ${deliveryAddress.number}, ${deliveryAddress.city} ${deliveryAddress.postcode}`
      : "Pickup Order";

    // Prices
    const total = parseFloat(body.price.grandTotal || 0);
    const paymentMethod = body.payment?.type || "Online";

    // Auto-confirm settings
    const settingsRes = await pool.query(
      "SELECT integrations FROM settings WHERE restaurant_id = $1 AND key = 'global'",
      [restaurantId]
    );
    const integrations = settingsRes.rows?.[0]?.integrations || {};
    const autoConfirm = integrations.auto_confirm_orders === true;

    const status = autoConfirm ? "confirmed" : "pending";

    // Insert order
    const orderRes = await pool.query(
      `INSERT INTO orders (
        restaurant_id,
        order_type,
        status,
        total,
        customer_name,
        customer_phone,
        customer_address,
        payment_method,
        external_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id`,
      [
        restaurantId,
        "packet",
        status,
        total,
        customerName,
        customerPhone,
        fullAddress,
        paymentMethod,
        body.code
      ]
    );

    const orderId = orderRes.rows[0].id;

    // Insert items
    for (const p of body.products) {
      const extras = (p.selectedToppings || []).map((t) => ({
        name: t.name,
        price: t.price,
        quantity: t.quantity,
        external_id: t.id,
        remoteCode: t.remoteCode
      }));

      let productId = null;
      if (p.remoteCode) {
        const prodRes = await pool.query(
          "SELECT id FROM products WHERE restaurant_id = $1 AND external_code = $2 LIMIT 1",
          [restaurantId, p.remoteCode]
        );
        productId = prodRes.rows[0]?.id || null;
      }

      await pool.query(
        `INSERT INTO order_items (
          order_id,
          product_id,
          external_product_id,
          external_product_name,
          name,
          quantity,
          price,
          extras,
          note,
          kitchen_status,
          confirmed
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'new',true)`,
        [
          orderId,
          productId,
          p.id,
          p.name,
          p.name,
          parseInt(p.quantity || 1),
          parseFloat(p.paidPrice),
          JSON.stringify(extras),
          p.comment || null
        ]
      );
    }

    // Notify POS
    io.to(`restaurant_${restaurantId}`).emit("orders_updated");
    emitOrderUpdate(io, restaurantId);

    //
    // REQUIRED RESPONSE — includes remoteOrderId
    //
    const remoteOrderId = `POS_${restaurantId}_ORDER_${orderId}`;

    return res.status(200).json({
      remoteResponse: {
        remoteOrderId
      }
    });

  } catch (err) {
    console.error("❌ Dispatch Order Error:", err);
    return res.status(500).json({
      reason: "internal_error",
      message: "Could not process order"
    });
  }
});


//
// 2️⃣ STATUS UPDATE (YS → POS)
//    PUT /api/integrations/yemeksepeti/remoteId/:remoteId/remoteOrder/:remoteOrderId/posOrderStatus
//
router.put(
  "/remoteId/:remoteId/remoteOrder/:remoteOrderId/posOrderStatus",
  extApiAuth,
  async (req, res) => {
    try {
      const remoteOrderId = req.params.remoteOrderId;
      const body = req.body;
      const status = body.status;
      const updatedOrder = body.updatedOrder;

      console.log("📥 YS STATUS UPDATE:", JSON.stringify(body, null, 2));

      // Extract real POS orderId
      const parts = remoteOrderId.split("_");
      const orderId = parts[parts.length - 1];

      const orderRes = await pool.query("SELECT * FROM orders WHERE id = $1 LIMIT 1", [
        orderId
      ]);

      if (!orderRes.rows.length) {
        return res.status(404).send();
      }

      const order = orderRes.rows[0];
      const restaurantId = order.restaurant_id;

      // Map YS status → POS status
      let newStatus = order.status;
      let driverStatus = order.driver_status || null;

      switch (status) {
        case "ORDER_CANCELLED":
          newStatus = "cancelled";
          break;

        case "ORDER_PICKED_UP":
          driverStatus = "picked_up";
          break;

        case "COURIER_ARRIVED_AT_VENDOR":
          driverStatus = "arrived";
          break;

        case "PRODUCT_ORDER_MODIFICATION_SUCCESSFUL":
          // YS sends updatedOrder
          break;

        case "PRODUCT_ORDER_MODIFICATION_FAILED":
          // log error code inside body.message
          break;
      }

      await pool.query(
        `UPDATE orders SET status = $1, driver_status = $2 WHERE id = $3`,
        [newStatus, driverStatus, orderId]
      );

      const io = getIO();
      io.to(`restaurant_${restaurantId}`).emit("orders_updated");

      return res.status(200).send();

    } catch (err) {
      console.error("❌ Status update error:", err);
      return res.status(500).send();
    }
  }
);

module.exports = router;
