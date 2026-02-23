// routes/yemeksepeti.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { getIO } = require("../utils/socket");
const { emitAlert } = require("../utils/realtime");
const authMiddleware = require("../middleware/authMiddleware");
const { updateStockForOrder } = require("../utils/orderStock");
const {
  getMiddlewareBearerForCallbackUrl,
  clearMiddlewareBearerForCallbackUrl,
} = require("../utils/dhMiddlewareToken");

const YS_PLATFORM = "yemeksepeti";

const normalizeRemoteCode = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const isNumericRemoteCode = (value) => /^\d+$/.test(value);

async function upsertPlatformProductMap({
  restaurantId,
  platformProductId,
  beyproProductId,
  remoteCodeUsed,
}) {
  if (!restaurantId || !platformProductId || !beyproProductId) return;
  await pool.query(
    `INSERT INTO platform_product_map (
       restaurant_id,
       platform,
       platform_product_id,
       beypro_product_id,
       remote_code_used,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (restaurant_id, platform, platform_product_id)
     DO UPDATE SET
       beypro_product_id = EXCLUDED.beypro_product_id,
       remote_code_used = EXCLUDED.remote_code_used,
       updated_at = NOW()`,
    [
      restaurantId,
      YS_PLATFORM,
      String(platformProductId),
      beyproProductId,
      remoteCodeUsed || null,
    ]
  );
}

async function upsertPlatformExtraMap({
  restaurantId,
  platformExtraId,
  beyproExtraId,
  remoteCodeUsed,
}) {
  if (!restaurantId || !platformExtraId || !beyproExtraId) return;
  await pool.query(
    `INSERT INTO platform_extra_map (
       restaurant_id,
       platform,
       platform_extra_id,
       beypro_extra_id,
       remote_code_used,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (restaurant_id, platform, platform_extra_id)
     DO UPDATE SET
       beypro_extra_id = EXCLUDED.beypro_extra_id,
       remote_code_used = EXCLUDED.remote_code_used,
       updated_at = NOW()`,
    [
      restaurantId,
      YS_PLATFORM,
      String(platformExtraId),
      beyproExtraId,
      remoteCodeUsed || null,
    ]
  );
}

async function upsertUnmatchedPlatformItem({
  restaurantId,
  itemType,
  platformItemId,
  platformItemName,
  remoteCode,
  payload,
}) {
  if (!restaurantId || !itemType || !platformItemId) return;
  await pool.query(
    `INSERT INTO unmatched_platform_items (
       restaurant_id,
       platform,
       item_type,
       platform_item_id,
       platform_item_name,
       remote_code,
       payload,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     ON CONFLICT (restaurant_id, platform, item_type, platform_item_id)
     DO UPDATE SET
       platform_item_name = EXCLUDED.platform_item_name,
       remote_code = EXCLUDED.remote_code,
       payload = EXCLUDED.payload,
       updated_at = NOW()`,
    [
      restaurantId,
      YS_PLATFORM,
      itemType,
      String(platformItemId),
      platformItemName || null,
      remoteCode || null,
      payload ? JSON.stringify(payload) : null,
    ]
  );
}

async function resolveProductMatch({ restaurantId, platformProductId, remoteCode }) {
  const mapRes = await pool.query(
    `SELECT beypro_product_id, remote_code_used
     FROM platform_product_map
     WHERE restaurant_id = $1 AND platform = $2 AND platform_product_id = $3
     LIMIT 1`,
    [restaurantId, YS_PLATFORM, String(platformProductId)]
  );
  if (mapRes.rows[0]?.beypro_product_id) {
    return {
      productId: mapRes.rows[0].beypro_product_id,
      matchPath: "platform_map",
      remoteCodeUsed: mapRes.rows[0].remote_code_used || null,
    };
  }

  const normalized = normalizeRemoteCode(remoteCode);
  if (normalized) {
    if (isNumericRemoteCode(normalized)) {
      const productId = Number.parseInt(normalized, 10);
      const prodRes = await pool.query(
        "SELECT id FROM products WHERE restaurant_id = $1 AND id = $2 LIMIT 1",
        [restaurantId, productId]
      );
      if (prodRes.rows[0]?.id) {
        return {
          productId: prodRes.rows[0].id,
          matchPath: "remoteCode:id",
          remoteCodeUsed: normalized,
        };
      }
    } else {
      const prodRes = await pool.query(
        "SELECT id FROM products WHERE restaurant_id = $1 AND sku = $2 LIMIT 1",
        [restaurantId, normalized]
      );
      if (prodRes.rows[0]?.id) {
        return {
          productId: prodRes.rows[0].id,
          matchPath: "remoteCode:sku",
          remoteCodeUsed: normalized,
        };
      }
    }
    return { productId: null, matchPath: "remoteCode:unmatched", remoteCodeUsed: normalized };
  }

  return { productId: null, matchPath: "unmatched", remoteCodeUsed: null };
}

async function resolveExtraMatch({ restaurantId, platformExtraId, remoteCode }) {
  const mapRes = await pool.query(
    `SELECT beypro_extra_id, remote_code_used
     FROM platform_extra_map
     WHERE restaurant_id = $1 AND platform = $2 AND platform_extra_id = $3
     LIMIT 1`,
    [restaurantId, YS_PLATFORM, String(platformExtraId)]
  );
  if (mapRes.rows[0]?.beypro_extra_id) {
    const extraRes = await pool.query(
      `SELECT id, ingredient_name, amount, unit
       FROM extras_group_items
       WHERE restaurant_id = $1 AND id = $2
       LIMIT 1`,
      [restaurantId, mapRes.rows[0].beypro_extra_id]
    );
    return {
      extraId: mapRes.rows[0].beypro_extra_id,
      matchPath: "platform_map",
      remoteCodeUsed: mapRes.rows[0].remote_code_used || null,
      extraRow: extraRes.rows[0] || null,
    };
  }

  const normalized = normalizeRemoteCode(remoteCode);
  if (normalized) {
    if (isNumericRemoteCode(normalized)) {
      const extraId = Number.parseInt(normalized, 10);
      const extraRes = await pool.query(
        `SELECT id, ingredient_name, amount, unit
         FROM extras_group_items
         WHERE restaurant_id = $1 AND id = $2
         LIMIT 1`,
        [restaurantId, extraId]
      );
      if (extraRes.rows[0]?.id) {
        return {
          extraId: extraRes.rows[0].id,
          matchPath: "remoteCode:id",
          remoteCodeUsed: normalized,
          extraRow: extraRes.rows[0],
        };
      }
    } else {
      const extraRes = await pool.query(
        `SELECT id, ingredient_name, amount, unit
         FROM extras_group_items
         WHERE restaurant_id = $1 AND sku = $2
         LIMIT 1`,
        [restaurantId, normalized]
      );
      if (extraRes.rows[0]?.id) {
        return {
          extraId: extraRes.rows[0].id,
          matchPath: "remoteCode:sku",
          remoteCodeUsed: normalized,
          extraRow: extraRes.rows[0],
        };
      }
    }
    return { extraId: null, matchPath: "remoteCode:unmatched", remoteCodeUsed: normalized };
  }

  return { extraId: null, matchPath: "unmatched", remoteCodeUsed: null };
}
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
    // 🔔 Trigger POS bell/toast (frontend listens to `order_confirmed` for "new order")
    getIO().to(`restaurant_${restaurantId}`).emit("order_confirmed", {
      orderId,
      id: orderId,
      order: { id: orderId, status: "confirmed", order_type: "packet" },
    });

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

let ordersHasTakeawayNotesColumn = null;
async function ensureOrdersTakeawayNotesColumn() {
  if (ordersHasTakeawayNotesColumn === true) return true;
  try {
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS takeaway_notes TEXT`
    );
    ordersHasTakeawayNotesColumn = true;
    return true;
  } catch (err) {
    console.warn("⚠️ Unable to ensure orders.takeaway_notes column:", err.message);
    ordersHasTakeawayNotesColumn = false;
    return false;
  }
}

let ordersHasExternalExpeditionTypeColumn = null;
async function ensureOrdersExternalExpeditionTypeColumn() {
  if (ordersHasExternalExpeditionTypeColumn === true) return true;
  try {
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS external_expedition_type TEXT`
    );
    ordersHasExternalExpeditionTypeColumn = true;
    return true;
  } catch (err) {
    console.warn(
      "⚠️ Unable to ensure orders.external_expedition_type column:",
      err.message
    );
    ordersHasExternalExpeditionTypeColumn = false;
    return false;
  }
}

let orderItemsHasStockDeductedColumn = null;
async function ensureOrderItemsStockDeductedColumn() {
  if (orderItemsHasStockDeductedColumn === true) return true;
  try {
    await pool.query(
      `ALTER TABLE order_items
         ADD COLUMN IF NOT EXISTS stock_deducted BOOLEAN DEFAULT FALSE`
    );
    orderItemsHasStockDeductedColumn = true;
    return true;
  } catch (err) {
    console.warn(
      "⚠️ Unable to ensure order_items.stock_deducted column:",
      err.message
    );
    orderItemsHasStockDeductedColumn = false;
    return false;
  }
}

async function retroactivelyDeductStockForMappedProduct({
  restaurantId,
  platformProductId,
  beyproProductId,
}) {
  if (!restaurantId || !platformProductId || !beyproProductId) return;
  await ensureOrderItemsStockDeductedColumn();

  const { rows: pendingItems } = await pool.query(
    `SELECT oi.id, oi.order_id, oi.quantity, oi.ingredients, oi.extras
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.restaurant_id = $1
       AND o.external_source = $2
       AND COALESCE(LOWER(o.status), '') NOT IN ('cancelled', 'canceled', 'closed')
       AND oi.external_product_id = $3
       AND oi.product_id IS NULL
       AND COALESCE(oi.stock_deducted, FALSE) = FALSE`,
    [restaurantId, YS_PLATFORM, String(platformProductId)]
  );

  if (!pendingItems.length) return;

  const { rows: updatedItems } = await pool.query(
    `UPDATE order_items
     SET product_id = $1
     WHERE id = ANY($2::int[])
     RETURNING id, order_id, product_id, quantity, ingredients, extras`,
    [beyproProductId, pendingItems.map((row) => row.id)]
  );

  const itemsByOrder = new Map();
  for (const item of updatedItems) {
    if (!itemsByOrder.has(item.order_id)) {
      itemsByOrder.set(item.order_id, []);
    }
    itemsByOrder.get(item.order_id).push(item);
  }

  const io = getIO();
  const processedOrders = [];
  for (const [orderId, items] of itemsByOrder.entries()) {
    try {
      await updateStockForOrder(items, restaurantId, io);
      await pool.query(
        `UPDATE order_items
         SET stock_deducted = TRUE
         WHERE id = ANY($1::int[])`,
        [items.map((row) => row.id)]
      );
      processedOrders.push(orderId);
    } catch (err) {
      console.error(
        "❌ [ys] retroactive stock deduction failed:",
        { orderId, beyproProductId },
        err
      );
    }
  }

  if (processedOrders.length) {
    io.to(`restaurant_${restaurantId}`).emit("orders_updated");
    console.log("[ys] retroactive stock deduction after mapping", {
      restaurantId,
      platformProductId,
      beyproProductId,
      orderIds: processedOrders,
    });
  }
}


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
    const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stripPaymentFromText = (text, tokens) => {
      const raw = text === null || text === undefined ? "" : String(text);
      if (!raw.trim()) return "";
      let cleaned = raw;
      const list = Array.isArray(tokens) ? tokens : [];
      for (const token of list) {
        const t = token === null || token === undefined ? "" : String(token).trim();
        if (!t) continue;
        cleaned = cleaned.replace(new RegExp(escapeRegExp(t), "gi"), "");
      }
      cleaned = cleaned
        .replace(/\s{2,}/g, " ")
        .replace(/[;,\-|–—]+\s*[;,\-|–—]+/g, "; ")
        .replace(/^[;,\-|–—\s]+/g, "")
        .replace(/[;,\-|–—\s]+$/g, "")
        .trim();
      return cleaned;
    };

    const paymentTokens = [
      body.payment?.type,
      body.payment?.remoteCode,
    ]
      .map((v) => (v === null || v === undefined ? "" : String(v).trim()))
      .filter(Boolean);

    const noteParts = [
      deliveryAddress?.deliveryInstructions,
      body.comments?.customerComment,
      body.comments?.vendorComment,
    ]
      .map((value) => stripPaymentFromText(value, paymentTokens))
      .filter((value) => value);
    const uniqueNotes = Array.from(new Set(noteParts));
    const takeawayNotes = uniqueNotes.length ? uniqueNotes.join("\n") : null;

    // Prices
    const total = parseFloat(body.price.grandTotal || 0);
    const paymentMethod = body.payment?.type || "Online";
    const externalOrderToken =
      body.token || body.orderToken || body.order_token || null;
    const externalCallbackUrlsRaw =
      body.callbackUrls || body.callback_urls || null;
    const externalExpeditionType =
      body.expeditionType || body.expedition_type || null;
    let externalCallbackUrls = null;
    if (externalCallbackUrlsRaw) {
      if (typeof externalCallbackUrlsRaw === "string") {
        try {
          externalCallbackUrls = JSON.parse(externalCallbackUrlsRaw);
        } catch (err) {
          console.warn("⚠️ Failed to parse callbackUrls:", err.message);
        }
      } else if (typeof externalCallbackUrlsRaw === "object") {
        externalCallbackUrls = externalCallbackUrlsRaw;
      }
    }

    // Auto-confirm settings
    const settingsRes = await pool.query(
      "SELECT integrations FROM settings WHERE restaurant_id = $1 AND key = 'global'",
      [restaurantId]
    );
    const integrations = settingsRes.rows?.[0]?.integrations || {};
    // Only respect the provider-specific toggle; default to false if unset.
    const autoConfirm = integrations?.yemeksepeti?.autoConfirmOrders === true;

    const status = autoConfirm ? "confirmed" : "pending";

    // Ensure optional columns exist on older DBs
    await ensureOrdersTakeawayNotesColumn();
    await ensureOrdersExternalExpeditionTypeColumn();

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
        external_id,
        external_order_token,
        external_callback_urls,
        external_source,
        takeaway_notes,
        external_expedition_type,
        is_paid,
        payment_status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,'paid')
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
        body.code,
        externalOrderToken,
        externalCallbackUrls ? JSON.stringify(externalCallbackUrls) : null,
        "yemeksepeti",
        takeawayNotes,
        externalExpeditionType,
      ]
    );

    const orderId = orderRes.rows[0].id;

    // If we auto-confirmed, notify middleware (YS) that the order is accepted.
    if (status === "confirmed" && externalCallbackUrls?.orderAcceptedUrl) {
      try {
        let authHeader = await getMiddlewareBearerForCallbackUrl(
          externalCallbackUrls.orderAcceptedUrl
        );
        const acceptUrl = externalCallbackUrls.orderAcceptedUrl;
        console.log("📤 Sending external order_accepted:", acceptUrl);
        let response = await fetch(acceptUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authHeader ? { Authorization: authHeader } : {}),
          },
          body: JSON.stringify({ status: "order_accepted" }),
        });
        let responseBody = await response.text();
        if (response.status === 401 && authHeader) {
          clearMiddlewareBearerForCallbackUrl(acceptUrl);
          authHeader = await getMiddlewareBearerForCallbackUrl(acceptUrl);
          response = await fetch(acceptUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(authHeader ? { Authorization: authHeader } : {}),
            },
            body: JSON.stringify({ status: "order_accepted" }),
          });
          responseBody = await response.text();
        }
        console.log(
          "📥 External order_accepted response:",
          acceptUrl,
          response.status,
          responseBody
        );
      } catch (err) {
        console.error("❌ Failed to send order_accepted:", err);
      }
    }

    // Insert items
    const orderItemsForStock = [];
    for (const p of body.products || []) {
      const productMatch = await resolveProductMatch({
        restaurantId,
        platformProductId: p.id,
        remoteCode: p.remoteCode,
      });
      const productId = productMatch.productId || null;

      if (productId) {
        await upsertPlatformProductMap({
          restaurantId,
          platformProductId: p.id,
          beyproProductId: productId,
          remoteCodeUsed: productMatch.remoteCodeUsed || normalizeRemoteCode(p.remoteCode),
        });
      } else {
        await upsertUnmatchedPlatformItem({
          restaurantId,
          itemType: "product",
          platformItemId: p.id,
          platformItemName: p.name,
          remoteCode: normalizeRemoteCode(p.remoteCode),
          payload: p,
        });
      }

      console.log("🔎 [ys-match] product", {
        orderId,
        platformProductId: p.id,
        remoteCode: normalizeRemoteCode(p.remoteCode) || null,
        matchPath: productMatch.matchPath,
        productId,
      });

      const extras = [];
      for (const t of p.selectedToppings || []) {
        const extraMatch = await resolveExtraMatch({
          restaurantId,
          platformExtraId: t.id,
          remoteCode: t.remoteCode,
        });
        const extraMatched = Boolean(extraMatch.extraId && productId);

        if (extraMatch.extraId) {
          await upsertPlatformExtraMap({
            restaurantId,
            platformExtraId: t.id,
            beyproExtraId: extraMatch.extraId,
            remoteCodeUsed: extraMatch.remoteCodeUsed || normalizeRemoteCode(t.remoteCode),
          });
        } else {
          await upsertUnmatchedPlatformItem({
            restaurantId,
            itemType: "extra",
            platformItemId: t.id,
            platformItemName: t.name,
            remoteCode: normalizeRemoteCode(t.remoteCode),
            payload: t,
          });
        }

        console.log("🔎 [ys-match] extra", {
          orderId,
          platformExtraId: t.id,
          remoteCode: normalizeRemoteCode(t.remoteCode) || null,
          matchPath: extraMatch.matchPath,
          extraId: extraMatch.extraId || null,
          productMatched: Boolean(productId),
        });

        if (extraMatched && extraMatch.extraRow) {
          extras.push({
            name: extraMatch.extraRow.ingredient_name || t.name,
            ingredient_name: extraMatch.extraRow.ingredient_name || t.name,
            amount: extraMatch.extraRow.amount,
            unit: extraMatch.extraRow.unit,
            quantity: t.quantity,
            price: t.price,
            matched: true,
            beypro_extra_id: extraMatch.extraRow.id,
            external_id: t.id,
            remoteCode: normalizeRemoteCode(t.remoteCode),
          });
        } else {
          extras.push({
            name: t.name,
            price: t.price,
            quantity: t.quantity,
            external_id: t.id,
            remoteCode: normalizeRemoteCode(t.remoteCode),
            matched: false,
          });
        }
      }

      const insertRes = await pool.query(
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
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'new',true)
        RETURNING id`,
        [
          orderId,
          productId,
          p.id,
          p.name,
          p.name,
          parseInt(p.quantity || 1),
          parseFloat(p.paidPrice),
          JSON.stringify(extras),
          p.comment || null,
        ]
      );

      orderItemsForStock.push({
        id: insertRes.rows[0]?.id,
        product_id: productId,
        quantity: parseInt(p.quantity || 1),
        extras,
      });
    }

    if (status === "confirmed" && orderItemsForStock.length) {
      const matchedItems = orderItemsForStock.filter((it) => Boolean(it.product_id));
      const skippedCount = orderItemsForStock.length - matchedItems.length;
      try {
        if (matchedItems.length) {
          await updateStockForOrder(matchedItems, restaurantId, io);
          const ids = matchedItems.map((it) => it.id).filter(Boolean);
          if (ids.length) {
            await ensureOrderItemsStockDeductedColumn();
            await pool.query(
              `UPDATE order_items
               SET stock_deducted = TRUE
               WHERE id = ANY($1::int[])`,
              [ids]
            );
          }
        }
        console.log("📦 [ys] stock deducted on auto-accept", {
          orderId,
          items: matchedItems.length,
          skipped_unmatched: skippedCount,
        });
      } catch (err) {
        console.error("❌ [ys] stock deduction failed on auto-accept:", err);
      }
    }

    // Notify POS
    io.to(`restaurant_${restaurantId}`).emit("orders_updated");
    // 🔔 Trigger POS bell/toast (frontend listens to `order_confirmed` for "new order")
    io.to(`restaurant_${restaurantId}`).emit("order_confirmed", {
      orderId,
      id: orderId,
      order: { id: orderId, status, order_type: "packet" },
    });
    emitAlert(io, restaurantId, `Yemeksepeti order #${orderId} accepted`, null, "order", {
      event: "ys_order_accepted",
      orderId,
      source: "yemeksepeti",
    });
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
      const orderSuffix = order?.order_number ? `#${order.order_number}` : `#${orderId}`;
      const emitYsStatus = (label) => {
        emitAlert(io, restaurantId, `Yemeksepeti order ${orderSuffix} ${label}`, null, "order", {
          event: `ys_order_${label}`,
          orderId: Number(orderId),
          order_number: order?.order_number ?? null,
          source: "yemeksepeti",
        });
      };

      if (status === "ORDER_CANCELLED") {
        emitYsStatus("cancelled");
      }
      if (status === "ORDER_PICKED_UP") {
        emitYsStatus("picked_up");
      }
      io.to(`restaurant_${restaurantId}`).emit("orders_updated");

      return res.status(200).send();

    } catch (err) {
      console.error("❌ Status update error:", err);
      return res.status(500).send();
    }
  }
);

// ✅ Admin: list unmatched Yemeksepeti items
router.get("/unmatched", authMiddleware, async (req, res) => {
  const restaurantId = req.user?.restaurant_id;
  if (!restaurantId) return res.status(401).json({ error: "Unauthorized" });
  const itemType = String(req.query.itemType || "").toLowerCase();
  try {
    const params = [restaurantId, YS_PLATFORM];
    let whereType = "";
    if (itemType === "product" || itemType === "extra") {
      params.push(itemType);
      whereType = " AND item_type = $3";
    }
    const { rows } = await pool.query(
      `SELECT id, item_type, platform_item_id, platform_item_name, remote_code, payload, created_at, updated_at
       FROM unmatched_platform_items
       WHERE restaurant_id = $1 AND platform = $2 AND resolved_at IS NULL${whereType}
       ORDER BY updated_at DESC, created_at DESC`,
      params
    );
    res.json({ items: rows });
  } catch (err) {
    console.error("❌ Failed to list unmatched Yemeksepeti items:", err);
    res.status(500).json({ error: "Failed to fetch unmatched items" });
  }
});

// ✅ Admin: map unmatched item to internal product/extra
router.post("/unmatched/:id/map", authMiddleware, async (req, res) => {
  const restaurantId = req.user?.restaurant_id;
  if (!restaurantId) return res.status(401).json({ error: "Unauthorized" });
  const unmatchedId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(unmatchedId)) {
    return res.status(400).json({ error: "Invalid unmatched item id" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT *
       FROM unmatched_platform_items
       WHERE id = $1 AND restaurant_id = $2 AND platform = $3
       LIMIT 1`,
      [unmatchedId, restaurantId, YS_PLATFORM]
    );
    const item = rows[0];
    if (!item) return res.status(404).json({ error: "Unmatched item not found" });

    const itemType = String(req.body.itemType || item.item_type || "").toLowerCase();
    if (!["product", "extra"].includes(itemType)) {
      return res.status(400).json({ error: "Invalid item type" });
    }

    if (itemType === "product") {
      const beyproProductId = Number.parseInt(req.body.beyproProductId, 10);
      if (!Number.isFinite(beyproProductId)) {
        return res.status(400).json({ error: "Missing beyproProductId" });
      }
      await upsertPlatformProductMap({
        restaurantId,
        platformProductId: item.platform_item_id,
        beyproProductId,
        remoteCodeUsed: item.remote_code || null,
      });
      await pool.query(
        `UPDATE unmatched_platform_items
         SET resolved_at = NOW(),
             resolved_by = $3,
             mapped_beypro_id = $4,
             updated_at = NOW()
         WHERE id = $1 AND restaurant_id = $2`,
        [unmatchedId, restaurantId, req.user?.id || null, beyproProductId]
      );
    } else {
      const beyproExtraId = Number.parseInt(req.body.beyproExtraId, 10);
      if (!Number.isFinite(beyproExtraId)) {
        return res.status(400).json({ error: "Missing beyproExtraId" });
      }
      await upsertPlatformExtraMap({
        restaurantId,
        platformExtraId: item.platform_item_id,
        beyproExtraId,
        remoteCodeUsed: item.remote_code || null,
      });
      await pool.query(
        `UPDATE unmatched_platform_items
         SET resolved_at = NOW(),
             resolved_by = $3,
             mapped_beypro_id = $4,
             updated_at = NOW()
         WHERE id = $1 AND restaurant_id = $2`,
        [unmatchedId, restaurantId, req.user?.id || null, beyproExtraId]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Failed to map unmatched item:", err);
    res.status(500).json({ error: "Failed to map unmatched item" });
  }
});

// ✅ Admin: map platform item to internal product/extra
router.post("/map", authMiddleware, async (req, res) => {
  const restaurantId = req.user?.restaurant_id;
  if (!restaurantId) return res.status(401).json({ error: "Unauthorized" });
  const itemType = String(req.body.itemType || "").toLowerCase();
  const platformItemId = req.body.platformItemId;
  const beyproId = Number.parseInt(req.body.beyproId, 10);
  const remoteCodeUsed = normalizeRemoteCode(req.body.remoteCodeUsed || "");

  if (!platformItemId || !Number.isFinite(beyproId)) {
    return res.status(400).json({ error: "Missing platformItemId or beyproId" });
  }
  if (!["product", "extra"].includes(itemType)) {
    return res.status(400).json({ error: "Invalid itemType" });
  }

  try {
    if (itemType === "product") {
      await upsertPlatformProductMap({
        restaurantId,
        platformProductId: platformItemId,
        beyproProductId: beyproId,
        remoteCodeUsed: remoteCodeUsed || null,
      });
    } else {
      await upsertPlatformExtraMap({
        restaurantId,
        platformExtraId: platformItemId,
        beyproExtraId: beyproId,
        remoteCodeUsed: remoteCodeUsed || null,
      });
    }

    await pool.query(
      `UPDATE unmatched_platform_items
       SET resolved_at = NOW(),
           resolved_by = $3,
           mapped_beypro_id = $4,
           updated_at = NOW()
       WHERE restaurant_id = $1
         AND platform = $2
         AND item_type = $5
         AND platform_item_id = $6`,
      [
        restaurantId,
        YS_PLATFORM,
        req.user?.id || null,
        beyproId,
        itemType,
        String(platformItemId),
      ]
    );

    if (itemType === "product") {
      try {
        await retroactivelyDeductStockForMappedProduct({
          restaurantId,
          platformProductId: platformItemId,
          beyproProductId: beyproId,
        });
      } catch (err) {
        console.error(
          "❌ [ys] retroactive stock deduction error:",
          { platformItemId, beyproId },
          err
        );
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Failed to map Yemeksepeti item:", err);
    res.status(500).json({ error: "Failed to map item" });
  }
});

// ✅ Admin: list existing mappings
router.get("/mappings", authMiddleware, async (req, res) => {
  const restaurantId = req.user?.restaurant_id;
  if (!restaurantId) return res.status(401).json({ error: "Unauthorized" });
  const itemType = String(req.query.itemType || "").toLowerCase();
  if (!["product", "extra"].includes(itemType)) {
    return res.status(400).json({ error: "Invalid itemType" });
  }

  try {
    if (itemType === "product") {
      const { rows } = await pool.query(
        `SELECT
           ppm.platform_product_id AS platform_item_id,
           ppm.beypro_product_id AS beypro_id,
           ppm.remote_code_used,
           ppm.updated_at,
           p.name AS beypro_name
         FROM platform_product_map ppm
         LEFT JOIN products p ON p.id = ppm.beypro_product_id
         WHERE ppm.restaurant_id = $1 AND ppm.platform = $2
         ORDER BY ppm.updated_at DESC`,
        [restaurantId, YS_PLATFORM]
      );
      return res.json({ items: rows });
    }

    const { rows } = await pool.query(
      `SELECT
         pem.platform_extra_id AS platform_item_id,
         pem.beypro_extra_id AS beypro_id,
         pem.remote_code_used,
         pem.updated_at,
         i.ingredient_name AS beypro_name
       FROM platform_extra_map pem
       LEFT JOIN extras_group_items i ON i.id = pem.beypro_extra_id
       WHERE pem.restaurant_id = $1 AND pem.platform = $2
       ORDER BY pem.updated_at DESC`,
      [restaurantId, YS_PLATFORM]
    );
    return res.json({ items: rows });
  } catch (err) {
    console.error("❌ Failed to list Yemeksepeti mappings:", err);
    res.status(500).json({ error: "Failed to fetch mappings" });
  }
});

// ✅ Admin: delete mapping
router.delete("/map/:itemType/:platformItemId", authMiddleware, async (req, res) => {
  const restaurantId = req.user?.restaurant_id;
  if (!restaurantId) return res.status(401).json({ error: "Unauthorized" });
  const itemType = String(req.params.itemType || "").toLowerCase();
  const platformItemId = String(req.params.platformItemId || "").trim();
  if (!platformItemId || !["product", "extra"].includes(itemType)) {
    return res.status(400).json({ error: "Invalid itemType or platformItemId" });
  }

  try {
    if (itemType === "product") {
      await pool.query(
        `DELETE FROM platform_product_map
         WHERE restaurant_id = $1 AND platform = $2 AND platform_product_id = $3`,
        [restaurantId, YS_PLATFORM, platformItemId]
      );
    } else {
      await pool.query(
        `DELETE FROM platform_extra_map
         WHERE restaurant_id = $1 AND platform = $2 AND platform_extra_id = $3`,
        [restaurantId, YS_PLATFORM, platformItemId]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Failed to delete Yemeksepeti mapping:", err);
    res.status(500).json({ error: "Failed to delete mapping" });
  }
});

module.exports = router;
