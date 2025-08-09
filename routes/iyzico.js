// routes/iyzico.js
const express = require("express");
const router = express.Router();
const Iyzipay = require("iyzipay");
const { pool } = require("../db");
const { emitOrderUpdate } = require("../utils/realtime");

const iyzipay = new Iyzipay({
  apiKey: process.env.IYZI_API_KEY,
  secretKey: process.env.IYZI_SECRET_KEY,
  uri: process.env.IYZI_BASE_URL || "https://sandbox-api.iyzipay.com",
});

// Build basket items from DB rows
function toBasketItems(items) {
  return items.map((it, idx) => ({
    id: String(idx + 1),
    name: it.product_name || it.order_item_name || "Item",
    category1: "Food",
    itemType: Iyzipay.BASKET_ITEM_TYPE.PHYSICAL,
    price: String((parseFloat(it.price) * Number(it.quantity || 1)).toFixed(2)),
  }));
}

// POST /api/payments/iyzico/checkout
// Creates an Iyzico Checkout Form session for a given order_id
router.post("/payments/iyzico/checkout", async (req, res) => {
  const { order_id } = req.body;
  if (!order_id) return res.status(400).json({ error: "order_id required" });

  try {
    const { rows: orderRows } = await pool.query("SELECT * FROM orders WHERE id = $1", [order_id]);
    if (!orderRows.length) return res.status(404).json({ error: "Order not found" });
    const order = orderRows[0];

    const { rows: itemRows } = await pool.query(
      `SELECT
         oi.quantity, oi.price,
         oi.name AS order_item_name,
         p.name AS product_name
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1`,
      [order_id]
    );

    const price = itemRows.reduce((s, i) => s + Number(i.quantity) * parseFloat(i.price), 0);
    const basketItems = toBasketItems(itemRows);

    const reqBody = {
      locale: Iyzipay.LOCALE.TR,
      conversationId: String(order_id),
      price: String(price.toFixed(2)),
      paidPrice: String(price.toFixed(2)),
      currency: Iyzipay.CURRENCY.TRY,
      basketId: String(order.receipt_id || order.id),
      paymentGroup: Iyzipay.PAYMENT_GROUP.PRODUCT,
      callbackUrl: `${process.env.PUBLIC_API_BASE}/api/payments/iyzico/callback`,
      // Buyer
      buyer: {
        id: order.customer_phone || `guest-${order_id}`,
        name: order.customer_name || "Musteri",
        surname: "-",
        gsmNumber: order.customer_phone ? `+90${order.customer_phone}` : undefined,
        email: order.customer_email || "guest@example.com",
        identityNumber: "11111111110",
        registrationAddress: order.customer_address || "Address",
        city: "Istanbul",
        country: "Turkey",
        ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "127.0.0.1",
      },
      // Shipping/Billing
      shippingAddress: {
        contactName: order.customer_name || "Musteri",
        city: "Istanbul",
        country: "Turkey",
        address: order.customer_address || "Address",
      },
      billingAddress: {
        contactName: order.customer_name || "Musteri",
        city: "Istanbul",
        country: "Turkey",
        address: order.customer_address || "Address",
      },
      basketItems,
      // Optional UI flags
      enabledInstallments: [1], // cash-like; open this up if you want taksit
    };

    iyzipay.checkoutFormInitialize.create(reqBody, (err, result) => {
      if (err) {
        console.error("iyzico init error:", err);
        return res.status(502).json({ error: "Iyzico init failed" });
      }
      // Return form content (HTML) and token. You can render the HTML or redirect.
      res.json({
        token: result?.token,
        checkoutFormContent: result?.checkoutFormContent, // <script> snippet from iyzico
        paymentPageUrl: result?.paymentPageUrl,          // sometimes present
      });
    });
  } catch (e) {
    console.error("checkout init failed:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// Iyzico callback (set the same URL in the init above)
// Iyzico POSTs { token } -> we verify it, mark order paid, then redirect customer
router.post("/payments/iyzico/callback", async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).send("Missing token");

  iyzipay.checkoutForm.retrieve({ locale: Iyzipay.LOCALE.TR, token }, async (err, result) => {
    if (err) {
      console.error("iyzico retrieve error:", err);
      return res.redirect(`${process.env.FRONTEND_BASE}/payment/failed`);
    }

    const orderId = Number(result?.conversationId || 0);
    try {
      if (result?.paymentStatus !== "SUCCESS" || !orderId) {
        return res.redirect(`${process.env.FRONTEND_BASE}/payment/failed?order=${orderId || ""}`);
      }

      // pull masked card details & vault tokens (if user agreed)
      const cardBrand = result.cardAssociation || null;
      const last4 = result.lastFourDigits || null;
      const expMonth = result.cardExpireMonth || null;
      const expYear = result.cardExpireYear || null;
      const cardUserKey = result.cardUserKey || null;
      const cardToken = result.cardToken || null;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Insert a payment line
        await client.query(
          `INSERT INTO payments (order_id, amount, payment_method)
           VALUES ($1, $2, $3)`,
          [orderId, Number(result.paidPrice || 0), "card"]
        );

        // Mark order paid (keep status flow intact)
        await client.query(
          `UPDATE orders
             SET payment_method = 'card',
                 is_paid = TRUE,
                 receipt_id = COALESCE(receipt_id, gen_random_uuid())
           WHERE id = $1`,
          [orderId]
        );

        // OPTIONAL: save card token for future (requires a small table)
        if (cardUserKey && cardToken) {
          await client.query(
            `INSERT INTO customer_cards
               (customer_phone, card_user_key, card_token, brand, last4, exp_month, exp_year)
             SELECT o.customer_phone, $2, $3, $4, $5, $6, $7
             FROM orders o
             WHERE o.id = $1
             ON CONFLICT DO NOTHING`,
            [orderId, cardUserKey, cardToken, cardBrand, last4, expMonth, expYear]
          );
        }

        await client.query("COMMIT");
      } catch (dbErr) {
        await client.query("ROLLBACK");
        console.error("Payment finalize failed:", dbErr);
        return res.redirect(`${process.env.FRONTEND_BASE}/payment/failed?order=${orderId}`);
      } finally {
        client.release();
      }

      // Let dashboards refresh
      try { emitOrderUpdate(req.app.get("io")); } catch (_) {}

      // Send customer back
      return res.redirect(`${process.env.FRONTEND_BASE}/payment/success?order=${orderId}`);
    } catch (e2) {
      console.error("Callback error:", e2);
      return res.redirect(`${process.env.FRONTEND_BASE}/payment/failed?order=${orderId || ""}`);
    }
  });
});

module.exports = router;
