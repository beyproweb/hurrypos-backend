// routes/migros.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { getIO } = require("../utils/socket");
const { emitAlert } = require("../utils/realtime");
const authMiddleware = require("../middleware/authMiddleware");
const extApiAuth = require("../middleware/externalApiAuth");
const { updateStockForOrder } = require("../utils/orderStock");
const {
  getMiddlewareBearerForCallbackUrl,
  clearMiddlewareBearerForCallbackUrl,
} = require("../utils/dhMiddlewareToken");

// ✅ NEW: Migros client helpers
const {
  postToMigros,
  mapBeyprosStatusToMigros,
  getMigrosApiKeyForRestaurant,
  recordMigrosApiError,
  updateMigrosLastSyncTime,
} = require("../utils/migrosClient");
const {
  syncMigrosRestaurantApiKeys,
  getMigrosIntegrationHealth,
} = require("../utils/migrosKeySync");

const MIGROS_PLATFORM = "migros";

const dlog = (...args) =>
  console.log(new Date().toISOString(), "[migros]", ...args);

// =========================================================
// HELPER: Ensure optional columns exist
// =========================================================
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

let ordersHasCancelSyncErrorColumn = null;
async function ensureOrdersCancelSyncErrorColumn() {
  if (ordersHasCancelSyncErrorColumn === true) return true;
  try {
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS cancel_sync_error TEXT`
    );
    ordersHasCancelSyncErrorColumn = true;
    return true;
  } catch (err) {
    console.warn(
      "⚠️ Unable to ensure orders.cancel_sync_error column:",
      err.message
    );
    ordersHasCancelSyncErrorColumn = false;
    return false;
  }
}

// =========================================================
// HELPER: Parse callback URLs
// =========================================================
const parseCallbackUrls = (value) => {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (err) {
      dlog("⚠️ Failed to parse external_callback_urls:", err.message);
      return null;
    }
  }
  return null;
};

// =========================================================
// HELPER: Resolve callback URLs (multiple possible keys)
// =========================================================
const resolveAcceptUrl = (callbackUrls) => {
  if (!callbackUrls || typeof callbackUrls !== "object") return null;
  return (
    callbackUrls.orderAcceptedUrl ||
    callbackUrls.acceptUrl ||
    callbackUrls.order_accepted_url ||
    callbackUrls.accepted ||
    null
  );
};

const resolveRejectUrl = (callbackUrls) => {
  if (!callbackUrls || typeof callbackUrls !== "object") return null;
  return (
    callbackUrls.orderRejectedUrl ||
    callbackUrls.rejectUrl ||
    callbackUrls.order_rejected_url ||
    callbackUrls.rejected ||
    null
  );
};

const resolvePreparedUrl = (callbackUrls) => {
  if (!callbackUrls || typeof callbackUrls !== "object") return null;
  return (
    callbackUrls.orderPreparedUrl ||
    callbackUrls.preparedUrl ||
    callbackUrls.order_prepared_url ||
    callbackUrls.prepared ||
    null
  );
};

const resolvePickedUpUrl = (callbackUrls) => {
  if (!callbackUrls || typeof callbackUrls !== "object") return null;
  return (
    callbackUrls.orderPickedUpUrl ||
    callbackUrls.pickupUrl ||
    callbackUrls.order_picked_up_url ||
    callbackUrls.picked_up ||
    null
  );
};

const resolveDeliveredUrl = (callbackUrls) => {
  if (!callbackUrls || typeof callbackUrls !== "object") return null;
  return (
    callbackUrls.orderDeliveredUrl ||
    callbackUrls.deliveredUrl ||
    callbackUrls.order_delivered_url ||
    callbackUrls.delivered ||
    null
  );
};

// =========================================================
// HELPER: Record sync errors
// =========================================================
const recordCancelSyncError = async (orderId, message) => {
  if (!orderId) return;
  try {
    await ensureOrdersCancelSyncErrorColumn();
    await pool.query(
      "UPDATE orders SET cancel_sync_error = $1 WHERE id = $2",
      [message || null, orderId]
    );
  } catch (err) {
    console.warn("⚠️ Failed to record cancel sync error:", err.message);
  }
};

// =========================================================
// HELPER: Auth header for callback URL
// =========================================================
const getAuthHeaderForCallbackUrl = async (url) => {
  try {
    return await getMiddlewareBearerForCallbackUrl(url);
  } catch (err) {
    dlog("❌ Middleware login failed:", err.message);
    return null;
  }
};

// =========================================================
// OUTGOING STATUS SYNC (Beypro -> Migros)
// =========================================================

/**
 * sendExternalOrderAccepted
 * Sends order_accepted status to Migros callback URL
 */
const sendExternalOrderAccepted = async ({ orderId }) => {
  if (!orderId) return { skipped: true, reason: "missing_order_id" };

  const { rows } = await pool.query(
    `SELECT restaurant_id, external_callback_urls, external_source, external_id, external_order_token
       FROM orders
      WHERE id = $1
      LIMIT 1`,
    [orderId]
  );

  if (!rows.length) {
    return { skipped: true, reason: "order_not_found" };
  }

  const order = rows[0];
  if (order.external_source !== MIGROS_PLATFORM) {
    return { skipped: true, reason: "not_migros_order" };
  }

  const callbackUrls = parseCallbackUrls(order.external_callback_urls);
  const acceptUrl = resolveAcceptUrl(callbackUrls);
  if (!acceptUrl) {
    dlog("⚠️ Missing acceptUrl for Migros order", orderId);
    return { skipped: true, reason: "missing_accept_url" };
  }

  const payload = { status: "order_accepted" };
  dlog("📤 Sending external order_accepted:", acceptUrl, payload);

  try {
    let authHeader = await getAuthHeaderForCallbackUrl(acceptUrl);
    let response = await fetch(acceptUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify(payload),
    });
    let responseBody = await response.text();

    if (response.status === 401 && authHeader) {
      clearMiddlewareBearerForCallbackUrl(acceptUrl);
      authHeader = await getAuthHeaderForCallbackUrl(acceptUrl);
      response = await fetch(acceptUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify(payload),
      });
      responseBody = await response.text();
    }

    dlog(
      "📥 External order_accepted response:",
      acceptUrl,
      response.status,
      responseBody
    );

    if (!response.ok) {
      await recordCancelSyncError(
        orderId,
        `External accept failed (${response.status}): ${responseBody}`
      );
      return { ok: false, status: response.status, body: responseBody };
    }

    await recordCancelSyncError(orderId, null);
    return { ok: true, status: response.status, body: responseBody };
  } catch (err) {
    dlog("❌ External order_accepted request failed:", err.message);
    await recordCancelSyncError(orderId, `External accept error: ${err.message}`);
    return { ok: false, error: err.message };
  }
};

/**
 * sendExternalOrderRejected
 * Sends order_rejected status to Migros callback URL
 */
const sendExternalOrderRejected = async ({ orderId, reason }) => {
  if (!orderId) return { skipped: true, reason: "missing_order_id" };

  const { rows } = await pool.query(
    `SELECT restaurant_id, external_callback_urls, external_source, external_id, external_order_token
       FROM orders
      WHERE id = $1
      LIMIT 1`,
    [orderId]
  );

  if (!rows.length) {
    return { skipped: true, reason: "order_not_found" };
  }

  const order = rows[0];
  if (order.external_source !== MIGROS_PLATFORM) {
    return { skipped: true, reason: "not_migros_order" };
  }

  const callbackUrls = parseCallbackUrls(order.external_callback_urls);
  const rejectUrl = resolveRejectUrl(callbackUrls);
  if (!rejectUrl) {
    dlog("⚠️ Missing rejectUrl for Migros order", orderId);
    return { skipped: true, reason: "missing_reject_url" };
  }

  const rejectionComment = reason || "cancelled_by_pos";
  const payload = {
    status: "order_rejected",
    reason: rejectionComment,
    rejectionReason: {
      code: "other",
      comment: rejectionComment,
    },
  };

  dlog("📤 Sending external order_rejected:", rejectUrl, payload);

  try {
    let authHeader = await getAuthHeaderForCallbackUrl(rejectUrl);
    let response = await fetch(rejectUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify(payload),
    });
    let responseBody = await response.text();

    if (response.status === 401 && authHeader) {
      clearMiddlewareBearerForCallbackUrl(rejectUrl);
      authHeader = await getAuthHeaderForCallbackUrl(rejectUrl);
      response = await fetch(rejectUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify(payload),
      });
      responseBody = await response.text();
    }

    dlog(
      "📥 External order_rejected response:",
      rejectUrl,
      response.status,
      responseBody
    );

    if (!response.ok) {
      await recordCancelSyncError(
        orderId,
        `External reject failed (${response.status}): ${responseBody}`
      );
      return { ok: false, status: response.status, body: responseBody };
    }

    await recordCancelSyncError(orderId, null);
    return { ok: true, status: response.status, body: responseBody };
  } catch (err) {
    dlog("❌ External order_rejected request failed:", err.message);
    await recordCancelSyncError(orderId, `External reject error: ${err.message}`);
    return { ok: false, error: err.message };
  }
};

/**
 * sendExternalOrderPrepared
 * Sends order_prepared status to Migros callback URL
 */
const sendExternalOrderPrepared = async ({ orderId }) => {
  if (!orderId) return { skipped: true, reason: "missing_order_id" };

  const { rows } = await pool.query(
    `SELECT restaurant_id, external_callback_urls, external_source, external_id, external_order_token
       FROM orders
      WHERE id = $1
      LIMIT 1`,
    [orderId]
  );

  if (!rows.length) {
    dlog("⚠️ External prepared skipped (order not found):", orderId);
    return { skipped: true, reason: "order_not_found" };
  }

  const order = rows[0];
  if (order.external_source !== MIGROS_PLATFORM) {
    dlog("ℹ️ External prepared skipped (not Migros):", orderId);
    return { skipped: true, reason: "not_migros_order" };
  }

  const callbackUrls = parseCallbackUrls(order.external_callback_urls);
  const preparedUrl = resolvePreparedUrl(callbackUrls);
  const pickedUpUrl = resolvePickedUpUrl(callbackUrls);
  
  if (!preparedUrl && !pickedUpUrl) {
    dlog(
      "⚠️ External prepared skipped (missing prepared & picked_up urls):",
      orderId,
      callbackUrls
    );
    return { skipped: true, reason: "missing_prepared_url" };
  }

  if (!preparedUrl && pickedUpUrl) {
    // Fallback: send picked_up if prepared URL not available
    dlog("↩️ No preparedUrl; sending order_picked_up as fallback:", pickedUpUrl);
    return sendExternalOrderPickedUp({ orderId });
  }

  const payload = { status: "order_prepared" };
  dlog("📤 Sending external order_prepared:", preparedUrl, payload);

  try {
    let authHeader = await getAuthHeaderForCallbackUrl(preparedUrl);
    let response = await fetch(preparedUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify(payload),
    });
    let responseBody = await response.text();

    if (response.status === 401 && authHeader) {
      clearMiddlewareBearerForCallbackUrl(preparedUrl);
      authHeader = await getAuthHeaderForCallbackUrl(preparedUrl);
      response = await fetch(preparedUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify(payload),
      });
      responseBody = await response.text();
    }

    dlog(
      "📥 External order_prepared response:",
      preparedUrl,
      response.status,
      responseBody
    );

    if (!response.ok) {
      await recordCancelSyncError(
        orderId,
        `External prepared failed (${response.status}): ${responseBody}`
      );
      return { ok: false, status: response.status, body: responseBody };
    }

    await recordCancelSyncError(orderId, null);
    return { ok: true, status: response.status, body: responseBody };
  } catch (err) {
    await recordCancelSyncError(orderId, `External prepared error: ${err.message}`);
    return { ok: false, error: err.message };
  }
};

/**
 * sendExternalOrderPickedUp
 * Sends order_picked_up status to Migros callback URL
 */
const sendExternalOrderPickedUp = async ({ orderId }) => {
  if (!orderId) return { skipped: true, reason: "missing_order_id" };

  const { rows } = await pool.query(
    `SELECT restaurant_id, external_callback_urls, external_source, external_id, external_order_token
       FROM orders
      WHERE id = $1
      LIMIT 1`,
    [orderId]
  );

  if (!rows.length) {
    return { skipped: true, reason: "order_not_found" };
  }

  const order = rows[0];
  if (order.external_source !== MIGROS_PLATFORM) {
    dlog(`ℹ️  Order ${orderId} is not Migros (external_source=${order.external_source})`);
    return { skipped: true, reason: "not_migros_order" };
  }

  dlog(`📋 Order ${orderId} is Migros - preparing to sync...`);
  const callbackUrls = parseCallbackUrls(order.external_callback_urls);
  const pickedUpUrl = resolvePickedUpUrl(callbackUrls);
  if (!pickedUpUrl) {
    dlog(`⚠️  No orderPickedUpUrl found in callback URLs for order ${orderId}`);
    return { skipped: true, reason: "missing_picked_up_url" };
  }

  const payload = { status: "order_picked_up" };
  dlog("📤 Sending external order_picked_up:", pickedUpUrl, payload);

  try {
    let authHeader = await getAuthHeaderForCallbackUrl(pickedUpUrl);
    if (!authHeader) {
      dlog(`⚠️  [CRITICAL] No auth header for Migros sync - check DH_MW_USERNAME/DH_MW_PASSWORD in .env`);
    }
    let response = await fetch(pickedUpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify(payload),
    });
    let responseBody = await response.text();

    if (response.status === 401 && authHeader) {
      clearMiddlewareBearerForCallbackUrl(pickedUpUrl);
      authHeader = await getAuthHeaderForCallbackUrl(pickedUpUrl);
      response = await fetch(pickedUpUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify(payload),
      });
      responseBody = await response.text();
    }
    dlog("📥 External order_picked_up response:", pickedUpUrl, response.status, responseBody);

    // Treat "already in that state" as OK for idempotency.
    if (response.status === 409) {
      await recordCancelSyncError(orderId, null);
      return { ok: true, status: response.status, body: responseBody, conflict: true };
    }

    if (!response.ok) {
      await recordCancelSyncError(
        orderId,
        `External picked_up failed (${response.status}): ${responseBody}`
      );
      dlog(`⚠️  FAILED TO SYNC order_picked_up - Migros may not show delivery!`);
      return { ok: false, status: response.status, body: responseBody };
    }

    await recordCancelSyncError(orderId, null);
    dlog(`✅ SUCCESS: Migros received order_picked_up status (delivery marked)`);
    return { ok: true, status: response.status, body: responseBody };
  } catch (err) {
    await recordCancelSyncError(orderId, `External picked_up error: ${err.message}`);
    return { ok: false, error: err.message };
  }
};

/**
 * sendExternalOrderDelivered
 * Sends order_delivered status to Migros callback URL (if supported)
 */
const sendExternalOrderDelivered = async ({ orderId }) => {
  if (!orderId) return { skipped: true, reason: "missing_order_id" };

  const { rows } = await pool.query(
    `SELECT restaurant_id, external_callback_urls, external_source, external_id, external_order_token
       FROM orders
      WHERE id = $1
      LIMIT 1`,
    [orderId]
  );

  if (!rows.length) {
    dlog("⚠️ External order_delivered skipped (order not found):", orderId);
    return { skipped: true, reason: "order_not_found" };
  }

  const order = rows[0];
  if (order.external_source !== MIGROS_PLATFORM) {
    dlog("ℹ️ External order_delivered skipped (not Migros):", orderId);
    return { skipped: true, reason: "not_migros_order" };
  }

  const callbackUrls = parseCallbackUrls(order.external_callback_urls);
  const deliveredUrl = resolveDeliveredUrl(callbackUrls);
  if (!deliveredUrl) {
    dlog(
      "⚠️ External order_delivered skipped (no orderDeliveredUrl in callbackUrls):",
      orderId
    );
    return { skipped: true, reason: "unsupported_no_delivered_url" };
  }

  const payload = { status: "order_delivered" };
  dlog("📤 Sending external order_delivered:", deliveredUrl, payload);

  try {
    let authHeader = await getAuthHeaderForCallbackUrl(deliveredUrl);
    let response = await fetch(deliveredUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify(payload),
    });
    let responseBody = await response.text();

    if (response.status === 401 && authHeader) {
      clearMiddlewareBearerForCallbackUrl(deliveredUrl);
      authHeader = await getAuthHeaderForCallbackUrl(deliveredUrl);
      response = await fetch(deliveredUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify(payload),
      });
      responseBody = await response.text();
    }

    dlog(
      "📥 External order_delivered response:",
      deliveredUrl,
      response.status,
      responseBody
    );

    if (!response.ok) {
      await recordCancelSyncError(
        orderId,
        `External delivered failed (${response.status}): ${responseBody}`
      );
      return { ok: false, status: response.status, body: responseBody };
    }

    await recordCancelSyncError(orderId, null);
    return { ok: true, status: response.status, body: responseBody };
  } catch (err) {
    await recordCancelSyncError(orderId, `External delivered error: ${err.message}`);
    return { ok: false, error: err.message };
  }
};

// =========================================================
// LOCAL TEST ENDPOINT (NO AUTH)
// =========================================================
router.post("/test", async (req, res) => {
  try {
    dlog("🧪 LOCAL TEST ORDER:", req.body);

    const restaurantId = 1; // your test restaurant

    const { order_id, total, customer, address, items } = req.body;

    const customerName = customer?.name || "Test Migros Customer";
    const customerPhone = customer?.phone || null;
    const fullAddress = address || "Local Migros Test Address";

    // 1) Insert order
    const orderRes = await pool.query(
      `INSERT INTO orders (
        restaurant_id, order_type, status, total,
        customer_name, customer_phone, customer_address,
        payment_method, external_id, external_source,
        is_paid, payment_status
      ) VALUES ($1,'packet','confirmed',$2,$3,$4,$5,'Online',$6,$7,true,'paid')
      RETURNING id`,
      [
        restaurantId,
        total,
        customerName,
        customerPhone,
        fullAddress,
        order_id || "MIGROS_LOCAL_TEST",
        MIGROS_PLATFORM
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

    const io = getIO();
    io.to(`restaurant_${restaurantId}`).emit("orders_updated");
    io.to(`restaurant_${restaurantId}`).emit("order_confirmed", {
      orderId,
      id: orderId,
      order: {
        id: orderId,
        status: "confirmed",
        order_type: "packet",
        external_source: "migros",
        external_id: order_id || "MIGROS_LOCAL_TEST"
      },
    });

    res.json({
      success: true,
      test: true,
      order_id: orderId
    });

  } catch (err) {
    console.error("❌ MIGROS LOCAL TEST ERROR:", err);
    res.status(500).json({ error: "MIGROS_LOCAL_TEST_FAILED" });
  }
});

// =========================================================
// INCOMING WEBHOOK (Migros -> Beypro)
// POST /api/integrations/migros/order/:remoteId
// =========================================================
router.post("/order/:remoteId", extApiAuth, async (req, res) => {
  try {
    const remoteId = req.params.remoteId;
    const body = req.body;
    const io = getIO();

    dlog("📥 MIGROS DISPATCH ORDER:", JSON.stringify(body, null, 2));

    // Map remoteId → restaurant_id
    // Priority: external_migros_remote_id (new dedicated field), fallback to external_remote_id
    const r = await pool.query(
      `SELECT id FROM restaurants 
       WHERE external_migros_remote_id = $1 
       OR external_remote_id = $1 
       LIMIT 1`,
      [remoteId]
    );

    if (!r.rows.length) {
      dlog(`❌ No restaurant mapped to Migros remoteId=${remoteId}`);
      return res.status(404).json({
        reason: "restaurant_not_found",
        message: `No restaurant mapped to remoteId=${remoteId}. Please configure Migros Remote ID in restaurant settings.`
      });
    }

    const restaurantId = r.rows[0].id;

    // Parse order fields defensively (support multiple possible Migros field names)
    const orderCode = body.code || body.orderId || body.id || body.order_id || null;
    const orderToken = body.token || body.orderToken || body.order_token || null;
    const callbackUrlsRaw = body.callbackUrls || body.callback_urls || body.callbacks || null;
    const expeditionType = body.expeditionType || body.deliveryType || body.delivery?.type || null;

    // Customer info
    let customerName = "";
    if (body.customer) {
      customerName = 
        body.customer.name ||
        body.customer.fullName ||
        `${body.customer.firstName || ""} ${body.customer.lastName || ""}`.trim() ||
        "Migros Customer";
    } else {
      customerName = "Migros Customer";
    }

    const customerPhone = 
      body.customer?.phone || 
      body.customer?.mobilePhone || 
      body.customer?.telephone ||
      null;

    // Address
    let fullAddress = "Migros Delivery";
    if (body.address && typeof body.address === "string") {
      fullAddress = body.address;
    } else if (body.delivery?.address) {
      const addr = body.delivery.address;
      fullAddress = [
        addr.street,
        addr.number,
        addr.city,
        addr.postcode,
        addr.district,
        addr.neighbourhood
      ]
        .filter(Boolean)
        .join(" ")
        .trim() || "Migros Delivery";
    } else if (body.address && typeof body.address === "object") {
      const addr = body.address;
      fullAddress = [
        addr.street,
        addr.number,
        addr.city,
        addr.postcode,
        addr.district,
        addr.neighbourhood
      ]
        .filter(Boolean)
        .join(" ")
        .trim() || "Migros Delivery";
    }

    // Total
    const total = parseFloat(
      body.price?.grandTotal || 
      body.total || 
      body.amount || 
      body.priceTotal ||
      0
    );

    // Payment method
    const paymentMethod = 
      body.payment?.type || 
      body.paymentType || 
      body.payment?.method ||
      "Online";

    // Parse callback URLs
    let externalCallbackUrls = null;
    if (callbackUrlsRaw) {
      if (typeof callbackUrlsRaw === "string") {
        try {
          externalCallbackUrls = JSON.parse(callbackUrlsRaw);
        } catch (err) {
          dlog("⚠️ Failed to parse callbackUrls:", err.message);
        }
      } else if (typeof callbackUrlsRaw === "object") {
        externalCallbackUrls = callbackUrlsRaw;
      }
    }

    // Notes / comments
    const noteParts = [
      body.notes,
      body.comment,
      body.delivery?.deliveryInstructions,
      body.delivery?.instructions,
      body.comments?.customerComment,
      body.comments?.vendorComment,
      body.customerComment,
      body.vendorComment
    ]
      .filter(Boolean)
      .map(v => String(v).trim());
    const uniqueNotes = Array.from(new Set(noteParts));
    const takeawayNotes = uniqueNotes.length ? uniqueNotes.join("\n") : null;

    // Check auto-confirm settings
    const settingsRes = await pool.query(
      "SELECT integrations FROM settings WHERE restaurant_id = $1 AND key = 'global'",
      [restaurantId]
    );
    const integrations = settingsRes.rows?.[0]?.integrations || {};
    const autoConfirm = integrations?.migros?.autoConfirmOrders === true;
    const status = autoConfirm ? "confirmed" : "pending";

    // Ensure optional columns exist
    await ensureOrdersTakeawayNotesColumn();
    await ensureOrdersExternalExpeditionTypeColumn();

    // ✅ IDEMPOTENCY CHECK: Prevent duplicate orders for same external_id
    // If order with same external_id already exists, return existing order
    const existingOrder = await pool.query(
      `SELECT id FROM orders 
       WHERE restaurant_id = $1 AND external_source = $2 AND external_id = $3
       LIMIT 1`,
      [restaurantId, MIGROS_PLATFORM, orderCode]
    );

    let orderId;
    let isNewOrder = false;

    if (existingOrder.rows.length > 0) {
      // Order already exists - return it (idempotent)
      orderId = existingOrder.rows[0].id;
      dlog(
        `ℹ️  Order already exists (idempotent): externalId=${orderCode}, orderId=${orderId}`
      );
    } else {
      // Insert new order
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
          orderCode,
          orderToken,
          externalCallbackUrls ? JSON.stringify(externalCallbackUrls) : null,
          MIGROS_PLATFORM,
          takeawayNotes,
          expeditionType,
        ]
      );

      orderId = orderRes.rows[0].id;
      isNewOrder = true;
      dlog(`✅ New Migros order created: orderId=${orderId}, externalId=${orderCode}`);
    }

    // If auto-confirmed, send acceptance callback immediately (only for new orders)
    if (isNewOrder && status === "confirmed" && externalCallbackUrls) {
      const acceptUrl = resolveAcceptUrl(externalCallbackUrls);
      if (acceptUrl) {
        try {
          let authHeader = await getMiddlewareBearerForCallbackUrl(acceptUrl);
          dlog("📤 Sending external order_accepted:", acceptUrl);
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
          dlog(
            "📥 External order_accepted response:",
            acceptUrl,
            response.status,
            responseBody
          );
        } catch (err) {
          console.error("❌ Failed to send order_accepted:", err);
        }
      }
    }

    // ✅ IDEMPOTENCY: Only insert items if it's a new order
    if (isNewOrder) {
      // Insert order items
      const itemsList = 
        body.items || 
        body.products || 
        body.orderItems ||
        [];
      
      dlog(`📋 Processing ${itemsList.length} items from order`);
      if (itemsList.length > 0) {
        dlog(`📋 First item: ${JSON.stringify(itemsList[0])}`);
      }

      for (const item of itemsList) {
        // Map Migros field names to standard names
        const itemName = 
          item.itemName ||  // Migros v1.2.0 field name
          item.name || 
          item.productName || 
          item.title || 
          "Unknown Item";
        
        const itemQuantity = Number.parseInt(item.quantity || item.qty || 1, 10);
        
        // Price: try unitPrice first (Migros), then other variants
        const itemPrice = parseFloat(
          item.unitPrice ||  // Migros v1.2.0 field name
          item.paidPrice || 
          item.price || 
          item.totalPrice ||
          0
        );
        
        const itemRemoteCode = 
          item.itemId ||     // Migros v1.2.0 field name
          item.remoteCode || 
          item.productCode || 
          item.sku ||
          null;
        
        const itemExternalId = 
          item.id || 
          item.productId ||
          null;

        dlog(`📦 Processing item: name='${itemName}', qty=${itemQuantity}, price=${itemPrice}, remoteCode='${itemRemoteCode}'`);

        // Try to match product by external_code
        let productId = null;
        if (itemRemoteCode) {
          const productRes = await pool.query(
            `SELECT id FROM products 
             WHERE restaurant_id = $1 AND external_code = $2 
             LIMIT 1`,
            [restaurantId, itemRemoteCode]
          );
          if (productRes.rows[0]) {
            productId = productRes.rows[0].id;
          }
        }

        // Handle extras/toppings
        let extrasJson = null;
        const toppings = 
          item.selectedToppings || 
          item.toppings || 
          item.extras || 
          item.options ||
          [];
        if (toppings.length > 0) {
          extrasJson = JSON.stringify(
            toppings.map(t => ({
              name: t.extraName || t.name || t.title,
              price: parseFloat(t.price || 0),
              quantity: Number.parseInt(t.quantity || 1, 10),
              remoteCode: t.extraId || t.remoteCode || t.code || null
            }))
          );
        }

        // Item-level notes (special requests)
        const itemNotes = item.notes || item.specialRequests || null;

        await pool.query(
          `INSERT INTO order_items (
            order_id, 
            product_id, 
            name, 
            quantity, 
            price, 
            confirmed, 
            kitchen_status,
            external_product_name,
            external_product_id,
            extras
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            orderId,
            productId,
            itemName,
            itemQuantity,
            itemPrice,
            true,
            "new",
            itemName,
            itemExternalId ? String(itemExternalId) : null,
            extrasJson
          ]
        );
      }
    } // ✅ End of isNewOrder block

    // Emit socket events
    io.to(`restaurant_${restaurantId}`).emit("orders_updated");
    io.to(`restaurant_${restaurantId}`).emit("order_confirmed", {
      id: orderId,
      order: {
        id: orderId,
        status,
        order_type: "packet",
        external_source: "migros",
        external_id: orderCode
      }
    });

    dlog(`✅ Migros order created: orderId=${orderId}, status=${status}`);

    res.json({
      success: true,
      orderId,
      status
    });

  } catch (err) {
    console.error("❌ MIGROS WEBHOOK ERROR:", err);
    res.status(500).json({ error: "MIGROS_WEBHOOK_FAILED", message: err.message });
  }
});

// =========================================================
// PUBLIC ENDPOINTS FOR MANUAL STATUS TRIGGERING
// =========================================================

/**
 * POST /api/integrations/migros/:orderId/accept
 * Manually send order_accepted to Migros
 */
router.post("/:orderId/accept", authMiddleware, async (req, res) => {
  try {
    const orderId = Number.parseInt(req.params.orderId, 10);
    if (!orderId) {
      return res.status(400).json({ error: "Invalid orderId" });
    }

    dlog(`🔔 Manual accept triggered for order ${orderId}`);
    const result = await sendExternalOrderAccepted({ orderId });
    
    res.json({
      success: !result.skipped && result.ok !== false,
      result
    });
  } catch (err) {
    console.error("❌ Manual accept failed:", err);
    res.status(500).json({ error: "ACCEPT_FAILED", message: err.message });
  }
});

/**
 * POST /api/integrations/migros/:orderId/reject
 * Manually send order_rejected to Migros
 */
router.post("/:orderId/reject", authMiddleware, async (req, res) => {
  try {
    const orderId = Number.parseInt(req.params.orderId, 10);
    const reason = req.body.reason || "cancelled_by_admin";
    if (!orderId) {
      return res.status(400).json({ error: "Invalid orderId" });
    }

    dlog(`🔔 Manual reject triggered for order ${orderId}, reason: ${reason}`);
    const result = await sendExternalOrderRejected({ orderId, reason });
    
    res.json({
      success: !result.skipped && result.ok !== false,
      result
    });
  } catch (err) {
    console.error("❌ Manual reject failed:", err);
    res.status(500).json({ error: "REJECT_FAILED", message: err.message });
  }
});

/**
 * POST /api/integrations/migros/:orderId/prepared
 * Manually send order_prepared to Migros
 */
router.post("/:orderId/prepared", authMiddleware, async (req, res) => {
  try {
    const orderId = Number.parseInt(req.params.orderId, 10);
    if (!orderId) {
      return res.status(400).json({ error: "Invalid orderId" });
    }

    dlog(`🔔 Manual prepared triggered for order ${orderId}`);
    const result = await sendExternalOrderPrepared({ orderId });
    
    res.json({
      success: !result.skipped && result.ok !== false,
      result
    });
  } catch (err) {
    console.error("❌ Manual prepared failed:", err);
    res.status(500).json({ error: "PREPARED_FAILED", message: err.message });
  }
});

/**
 * POST /api/integrations/migros/:orderId/picked-up
 * Manually send order_picked_up to Migros
 */
router.post("/:orderId/picked-up", authMiddleware, async (req, res) => {
  try {
    const orderId = Number.parseInt(req.params.orderId, 10);
    if (!orderId) {
      return res.status(400).json({ error: "Invalid orderId" });
    }

    dlog(`🔔 Manual picked-up triggered for order ${orderId}`);
    const result = await sendExternalOrderPickedUp({ orderId });
    
    res.json({
      success: !result.skipped && result.ok !== false,
      result
    });
  } catch (err) {
    console.error("❌ Manual picked-up failed:", err);
    res.status(500).json({ error: "PICKED_UP_FAILED", message: err.message });
  }
});

// =========================================================
// ADMIN ENDPOINTS: KEY SYNC & HEALTH
// =========================================================

/**
 * POST /api/integrations/migros/admin/sync-keys
 * Sync Migros API keys (admin-only)
 * Requires: Authorization header with admin JWT
 */
router.post("/admin/sync-keys", authMiddleware, async (req, res) => {
  try {
    // Verify admin access (restaurant_id check or admin role)
    if (!req.user || !req.user.restaurant_id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const secretKey = process.env.MIGROS_SECRET_KEY || req.body.secretKey;
    if (!secretKey) {
      return res.status(400).json({
        error: "Missing MIGROS_SECRET_KEY",
        message: "Set MIGROS_SECRET_KEY in environment or provide in request body"
      });
    }

    dlog("🔄 Admin requested key sync");
    const result = await syncMigrosRestaurantApiKeys(secretKey);

    // Record sync attempt
    if (result.success) {
      dlog(`✅ Key sync successful: ${result.synced} keys synced`);
    } else {
      await recordMigrosApiError("sync-keys", 500, result.message);
      dlog(`❌ Key sync failed: ${result.message}`);
    }

    res.json(result);
  } catch (err) {
    dlog("❌ Key sync error:", err.message);
    await recordMigrosApiError("sync-keys", 500, err.message);
    res.status(500).json({ error: "SYNC_FAILED", message: err.message });
  }
});

/**
 * GET /api/integrations/migros/admin/health
 * Get integration health status
 */
router.get("/admin/health", authMiddleware, async (req, res) => {
  try {
    if (!req.user || !req.user.restaurant_id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const health = await getMigrosIntegrationHealth();
    dlog("📊 Health check:", health);

    res.json({
      success: true,
      health
    });
  } catch (err) {
    dlog("❌ Health check error:", err.message);
    res.status(500).json({ error: "HEALTH_CHECK_FAILED", message: err.message });
  }
});

module.exports = router;
