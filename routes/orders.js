module.exports = function(io) {
  const express = require("express");
  const router = express.Router();

  const { pool } = require("../db");
  const { getIO } = require("../utils/socket");
  const { v4: uuidv4 } = require("uuid");
  const { performance } = require("perf_hooks");
  const jwt = require("jsonwebtoken");
  const moment = require("moment-timezone");
  const {
    getMiddlewareBearerForCallbackUrl,
    clearMiddlewareBearerForCallbackUrl,
  } = require("../utils/dhMiddlewareToken");
  const { sendYsPartnerFulfillment } = require("../utils/ysPartnerFulfillment");
  const dlog = (...args) =>
    console.log(new Date().toISOString(), "[orders]", ...args);
  const authMiddleware = require("../middleware/authMiddleware");
  const {
    ensureCustomerDebtColumn,
    increaseCustomerDebt,
    decreaseCustomerDebt,
  } = require("../utils/customerDebt");
  const { emitAlert } = require("../utils/realtime");
  const { updateStockForOrder } = require("../utils/orderStock");
  const { ensureConcertTables } = require("../utils/concertsService");
  const {
    CONFIRMATION_TYPES,
    sendOrderCustomerConfirmationEmail,
    sendOrderCustomerDeliveredEmail,
    sendOrderCustomerCancellationEmail,
    sendTableReservationOwnerNotificationEmail,
    sendDeliveryOwnerOrderNotificationEmail,
  } = require("../utils/customerConfirmationEmail");
  const { attachAllowedModules } = require("../middleware/moduleGuard");
  const DEFAULT_TZ = process.env.REPORTS_TIMEZONE || "Europe/Istanbul";

  const getAuthHeaderForCallbackUrl = async (url) => {
    try {
      return await getMiddlewareBearerForCallbackUrl(url);
    } catch (err) {
      dlog("❌ Middleware login failed:", err.message);
      return null;
    }
  };

  const parseCallbackUrls = (value) => {
    if (!value) return null;
    if (typeof value === "object") return value;
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch (err) {
        console.warn("⚠️ Failed to parse external_callback_urls:", err.message);
        return null;
      }
    }
    return null;
  };

  const resolveRejectUrl = (callbackUrls) => {
    if (!callbackUrls || typeof callbackUrls !== "object") return null;
    return (
      callbackUrls.orderRejectedUrl ||
      callbackUrls.order_rejected_url ||
      callbackUrls.orderRejectedURL ||
      callbackUrls.order_rejected ||
      null
    );
  };

  const resolveAcceptUrl = (callbackUrls) => {
    if (!callbackUrls || typeof callbackUrls !== "object") return null;
    return (
      callbackUrls.orderAcceptedUrl ||
      callbackUrls.order_accepted_url ||
      callbackUrls.orderAcceptedURL ||
      callbackUrls.order_accepted ||
      null
    );
  };

  const resolvePickedUpUrl = (callbackUrls) => {
    if (!callbackUrls || typeof callbackUrls !== "object") return null;
    return (
      callbackUrls.orderPickedUpUrl ||
      callbackUrls.order_picked_up_url ||
      callbackUrls.orderPickedUpURL ||
      callbackUrls.order_picked_up ||
      null
    );
  };

  const resolveDeliveredUrl = (callbackUrls) => {
    if (!callbackUrls || typeof callbackUrls !== "object") return null;
    return (
      callbackUrls.orderDeliveredUrl ||
      callbackUrls.order_delivered_url ||
      callbackUrls.orderDeliveredURL ||
      callbackUrls.order_delivered ||
      null
    );
  };

  const resolvePreparedUrl = (callbackUrls) => {
    if (!callbackUrls || typeof callbackUrls !== "object") return null;
    return (
      callbackUrls.orderPreparedUpUrl ||
      callbackUrls.orderPreparedUrl ||
      callbackUrls.orderPreparedURL ||
      callbackUrls.order_prepared_url ||
      callbackUrls.order_prepared ||
      null
    );
  };

  const resolveStatusUrl = (callbackUrls) => {
    if (!callbackUrls || typeof callbackUrls !== "object") return null;
    return (
      resolvePickedUpUrl(callbackUrls) ||
      resolveAcceptUrl(callbackUrls) ||
      resolveRejectUrl(callbackUrls) ||
      null
    );
  };

  const recordCancelSyncError = async (orderId, message) => {
    if (!orderId) return;
    try {
      await pool.query(
        "UPDATE orders SET cancel_sync_error = $1 WHERE id = $2",
        [message || null, orderId]
      );
    } catch (err) {
      console.warn("⚠️ Failed to record cancel sync error:", err.message);
    }
  };

  const emitYsOrderStatus = (restaurantId, orderId, status, meta = {}) => {
    if (!restaurantId || !orderId || !status) return;
    const ioRef = getIO();
    const normalizedStatus = String(status).toLowerCase();
    const orderNumber = meta.order_number ?? meta.orderNumber ?? null;
    const orderSuffix = orderNumber ? `#${orderNumber}` : `#${orderId}`;
    const label = normalizedStatus.replace(/_/g, " ");
    emitAlert(ioRef, restaurantId, `Yemeksepeti order ${orderSuffix} ${label}`, null, "order", {
      event: `ys_order_${normalizedStatus}`,
      orderId,
      order_number: orderNumber,
      source: "yemeksepeti",
    });
  };

  const sendExternalOrderRejection = async ({ orderId, reason }) => {
    if (!orderId) return { skipped: true, reason: "missing_order_id" };

    const { rows } = await pool.query(
      `SELECT restaurant_id, external_order_token, external_callback_urls, external_source, external_id
         FROM orders
        WHERE id = $1
        LIMIT 1`,
      [orderId]
    );

    if (!rows.length) {
      return { skipped: true, reason: "order_not_found" };
    }

    const order = rows[0];
    const isYsOrder = String(order.external_source || "").toLowerCase() === "yemeksepeti";
    const isExternalOrder = Boolean(
      order.external_source === "yemeksepeti" ||
        order.external_order_token ||
        order.external_callback_urls ||
        order.external_id
    );

    if (!isExternalOrder) {
      return { skipped: true, reason: "not_external" };
    }

    if (isYsOrder) {
      emitYsOrderStatus(order.restaurant_id, orderId, "cancelled", {});
    }

    const callbackUrls = parseCallbackUrls(order.external_callback_urls);
    const rejectUrl = resolveRejectUrl(callbackUrls);

    if (!rejectUrl) {
      dlog("⚠️ Missing orderRejectedUrl for external order", orderId);
      return { skipped: true, reason: "missing_reject_url" };
    }

    const rejectionComment = reason || "cancelled_by_pos";
    const payload = {
      status: "order_rejected",
      rejectionReason: {
        code: "other",
        comment: rejectionComment,
      },
      reason: rejectionComment,
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
          `External cancel failed (${response.status}): ${responseBody}`
        );
        return {
          ok: false,
          status: response.status,
          body: responseBody,
        };
      }

      await recordCancelSyncError(orderId, null);
      return { ok: true, status: response.status, body: responseBody };
    } catch (err) {
      dlog("❌ External order_rejected request failed:", err.message);
      await recordCancelSyncError(orderId, `External cancel error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  };

  const sendExternalOrderAccepted = async ({ orderId }) => {
    if (!orderId) return { skipped: true, reason: "missing_order_id" };

    const { rows } = await pool.query(
      `SELECT restaurant_id, external_callback_urls, external_source, external_id
         FROM orders
        WHERE id = $1
        LIMIT 1`,
      [orderId]
    );

    if (!rows.length) return { skipped: true, reason: "order_not_found" };

    const order = rows[0];
    const isExternalOrder = Boolean(
      order.external_source === "yemeksepeti" ||
        order.external_callback_urls ||
        order.external_id
    );

    if (!isExternalOrder) return { skipped: true, reason: "not_external" };

    const callbackUrls = parseCallbackUrls(order.external_callback_urls);
    const acceptUrl = resolveAcceptUrl(callbackUrls);
    if (!acceptUrl) {
      dlog("⚠️ Missing orderAcceptedUrl for external order", orderId);
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
      dlog("📥 External order_accepted response:", acceptUrl, response.status, responseBody);

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

  const normalizeCustomerEmail = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return "";
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : "";
  };

  const isQrMenuRequest = (req) => {
    const role = String(req?.user?.role || "").toLowerCase();
    const identifier = String(req?.query?.identifier || "").trim();
    const mode = String(req?.query?.mode || "").trim().toLowerCase();
    return Boolean(
      identifier ||
        role === "qr-guest" ||
        role === "qr-table" ||
        mode === "table" ||
        mode === "delivery"
    );
  };

  const QR_ORDER_ORIGIN_DELIVERY = "qr_menu_delivery";

  const resolveQrOrderOrigin = (req, orderType) => {
    if (!isQrMenuRequest(req)) return null;
    const normalizedOrderType = String(orderType || "").trim().toLowerCase();
    if (["packet", "delivery", "online"].includes(normalizedOrderType)) {
      return QR_ORDER_ORIGIN_DELIVERY;
    }
    if (normalizedOrderType === "takeaway") return "qr_menu_pickup";
    if (["table", "reservation"].includes(normalizedOrderType)) return "qr_menu_table";
    return "qr_menu";
  };

  const isQrDeliveryOrder = (order = {}) =>
    String(order?.order_origin || "").trim().toLowerCase() === QR_ORDER_ORIGIN_DELIVERY;

  const sendExternalPreparationCompleted = async ({ orderId }) => {
    if (!orderId) return { skipped: true, reason: "missing_order_id" };

    const { rows } = await pool.query(
      `SELECT restaurant_id, external_callback_urls, external_source, external_id
         FROM orders
        WHERE id = $1
        LIMIT 1`,
      [orderId]
    );

    if (!rows.length) {
      dlog("⚠️ External prep-completed skipped (order not found):", orderId);
      return { skipped: true, reason: "order_not_found" };
    }

    const order = rows[0];
    const isExternalOrder = Boolean(
      order.external_source === "yemeksepeti" ||
        order.external_callback_urls ||
        order.external_id
    );

    if (!isExternalOrder) {
      dlog("ℹ️ External prep-completed skipped (not external):", orderId);
      return { skipped: true, reason: "not_external" };
    }

    const callbackUrls = parseCallbackUrls(order.external_callback_urls);
    const preparedUrl = resolvePreparedUrl(callbackUrls);
    const pickedUpUrl = resolvePickedUpUrl(callbackUrls);
    if (!preparedUrl && !pickedUpUrl) {
      dlog(
        "⚠️ External prep-completed skipped (missing prepared & picked_up urls):",
        orderId,
        callbackUrls
      );
      return { skipped: true, reason: "missing_prepared_url" };
    }

    if (!preparedUrl && pickedUpUrl) {
      // Fallback for vendor-delivery platforms that don't expose a prep URL; send picked_up to move tracking forward.
      dlog("↩️ No preparedUrl; sending order_picked_up as fallback:", pickedUpUrl);
      return sendExternalOrderPickedUp({ orderId });
    }

    dlog("📤 Sending external preparation-completed:", preparedUrl);
    try {
      let authHeader = await getAuthHeaderForCallbackUrl(preparedUrl);
      let response = await fetch(preparedUrl, {
        method: "POST",
        headers: {
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
      });
      let responseBody = await response.text();
      if (response.status === 401 && authHeader) {
        clearMiddlewareBearerForCallbackUrl(preparedUrl);
        authHeader = await getAuthHeaderForCallbackUrl(preparedUrl);
        response = await fetch(preparedUrl, {
          method: "POST",
          headers: {
            ...(authHeader ? { Authorization: authHeader } : {}),
          },
        });
        responseBody = await response.text();
      }
      dlog(
        "📥 External preparation-completed response:",
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

  const sendExternalOrderPickedUp = async ({ orderId }) => {
    if (!orderId) return { skipped: true, reason: "missing_order_id" };

    const { rows } = await pool.query(
      `SELECT restaurant_id, external_callback_urls, external_source, external_id
         FROM orders
        WHERE id = $1
        LIMIT 1`,
      [orderId]
    );

    if (!rows.length) return { skipped: true, reason: "order_not_found" };

    const order = rows[0];
    const isExternalOrder = Boolean(
      order.external_source === "yemeksepeti" ||
        order.external_callback_urls ||
        order.external_id
    );

    if (!isExternalOrder) {
      dlog(`ℹ️  Order ${orderId} is not external (local order)`);
      return { skipped: true, reason: "not_external" };
    }

    dlog(`📋 Order ${orderId} is external [${order.external_source}] - preparing to sync...`);
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
        dlog(`⚠️  [CRITICAL] No auth header for Yemeksepeti sync - check DH_MW_USERNAME/DH_MW_PASSWORD in .env`);
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
        dlog(`⚠️  FAILED TO SYNC order_picked_up - Yemeksepeti may not show delivery!`);
        return { ok: false, status: response.status, body: responseBody };
      }

      await recordCancelSyncError(orderId, null);
      dlog(`✅ SUCCESS: Yemeksepeti received order_picked_up status (delivery marked)`);
      return { ok: true, status: response.status, body: responseBody };
    } catch (err) {
      await recordCancelSyncError(orderId, `External picked_up error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  };

  const sendExternalOrderDelivered = async ({ orderId }) => {
    if (!orderId) return { skipped: true, reason: "missing_order_id" };

    const { rows } = await pool.query(
      `SELECT restaurant_id, external_callback_urls, external_source, external_id
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
    const isExternalOrder = Boolean(
      order.external_source === "yemeksepeti" ||
        order.external_callback_urls ||
        order.external_id
    );

    if (!isExternalOrder) {
      dlog("ℹ️ External order_delivered skipped (not external):", orderId);
      return { skipped: true, reason: "not_external" };
    }

    const callbackUrls = parseCallbackUrls(order.external_callback_urls);
    const deliveredUrl = resolveDeliveredUrl(callbackUrls);
    if (!deliveredUrl) {
      // Delivery Hero middlewareExternalApi.yaml does not define an "order_delivered" status update for callbacks.
      // Supported statuses: order_accepted / order_rejected / order_picked_up (+ preparation-completed endpoint).
      // Without a dedicated delivered callback URL we should not attempt to "deliver" the order externally, as it
      // can lead to confusing UX (200 responses that don't affect customer tracking).
      dlog(
        "⚠️ External order_delivered skipped (no orderDeliveredUrl in callbackUrls):",
        orderId
      );
      return { skipped: true, reason: "unsupported_no_delivered_url" };
    }

    const primaryPayload = { status: "order_delivered" };
    dlog("📤 Sending external order_delivered:", deliveredUrl, primaryPayload);

    try {
      let authHeader = await getAuthHeaderForCallbackUrl(deliveredUrl);
      let response = await fetch(deliveredUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify(primaryPayload),
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
          body: JSON.stringify(primaryPayload),
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

  const TABLE_QR_SECRET =
    process.env.TABLE_QR_SECRET ||
    process.env.JWT_SECRET ||
    "table_qr_secret_2025";

  let hasOrderDebtTracking = null;
  async function ensureOrderDebtTracking() {
    if (hasOrderDebtTracking !== null) return hasOrderDebtTracking;
    try {
      await pool.query(
        `ALTER TABLE orders
           ADD COLUMN IF NOT EXISTS debt_recorded_total NUMERIC(12,2) NOT NULL DEFAULT 0`
      );
      await pool.query(
        `ALTER TABLE orders
           ADD COLUMN IF NOT EXISTS debt_paid_at TIMESTAMPTZ`
      );
      hasOrderDebtTracking = true;
    } catch (err) {
      console.warn("⚠️ Unable to ensure orders debt tracking columns:", err.message);
      hasOrderDebtTracking = false;
    }
    return hasOrderDebtTracking;
  }

  // ✅ Ensure payments table has previous_payment_method column for change tracking
  let hasPaymentChangeTracking = null;
  async function ensurePaymentChangeTracking() {
    if (hasPaymentChangeTracking !== null) return hasPaymentChangeTracking;
    try {
      await pool.query(
        `ALTER TABLE payments
           ADD COLUMN IF NOT EXISTS previous_payment_method VARCHAR(255)`
      );
      hasPaymentChangeTracking = true;
      console.log("✅ Payment change tracking column added/verified");
    } catch (err) {
      console.warn("⚠️ Unable to ensure payments change tracking column:", err.message);
      hasPaymentChangeTracking = false;
    }
    return hasPaymentChangeTracking;
  }

  let hasPaymentMethodChangesTracking = null;
  async function ensurePaymentMethodChangesTracking() {
    if (hasPaymentMethodChangesTracking !== null) return hasPaymentMethodChangesTracking;
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS payment_method_changes (
          id BIGSERIAL PRIMARY KEY,
          order_id BIGINT NOT NULL,
          old_method TEXT,
          new_method TEXT,
          changed_by TEXT,
          changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(
        `ALTER TABLE payment_method_changes
           ADD COLUMN IF NOT EXISTS changed_at TIMESTAMPTZ`
      );
      await pool.query(
        `ALTER TABLE payment_method_changes
           ADD COLUMN IF NOT EXISTS changed_by TEXT`
      );
      await pool.query(
        `ALTER TABLE payment_method_changes
           ALTER COLUMN changed_at SET DEFAULT NOW()`
      );
      await pool.query(
        `UPDATE payment_method_changes
           SET changed_at = NOW()
         WHERE changed_at IS NULL`
      );
      await pool.query(
        `ALTER TABLE payment_method_changes
           ALTER COLUMN changed_at SET NOT NULL`
      );
      hasPaymentMethodChangesTracking = true;
    } catch (err) {
      console.warn("⚠️ Unable to ensure payment_method_changes tracking table:", err.message);
      hasPaymentMethodChangesTracking = false;
    }
    return hasPaymentMethodChangesTracking;
  }

  const toMoney = (value) => {
    const num = Number.parseFloat(value);
    if (!Number.isFinite(num)) return 0;
    return Math.round(num * 100) / 100;
  };

  const ORDER_LIST_COLUMNS = Object.freeze([
    "id",
    "restaurant_id",
    "table_number",
    "status",
    "total",
    "order_type",
    "customer_name",
    "customer_phone",
    "customer_address",
    "payment_method",
    "receipt_id",
    "is_paid",
    "tax_type",
    "tax_value",
    "discount_type",
    "discount_value",
    "driver_id",
    "driver_status",
    "picked_up_at",
    "delivered_at",
    "kitchen_delivered_at",
    "pickup_time",
    "takeaway_notes",
    "reservation_date",
    "reservation_time",
    "reservation_clients",
    "reservation_notes",
    "external_id",
    "external_source",
    "external_expedition_type",
    "cancelled_at",
    "cancellation_reason",
    "created_at",
    "updated_at",
  ]);
  let orderListSelectCache = null;
  let orderListSelectPromise = null;

  async function getOrderListSelectSql() {
    if (orderListSelectCache) return orderListSelectCache;
    if (!orderListSelectPromise) {
      orderListSelectPromise = (async () => {
        const { rows } = await pool.query(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'orders'
          `
        );
        const existingCols = new Set(rows.map((row) => String(row.column_name || "").toLowerCase()));
        const plain = ORDER_LIST_COLUMNS.map((col) =>
          existingCols.has(col.toLowerCase()) ? col : `NULL AS ${col}`
        ).join(", ");
        const aliased = ORDER_LIST_COLUMNS.map((col) =>
          existingCols.has(col.toLowerCase()) ? `o.${col}` : `NULL AS ${col}`
        ).join(", ");
        orderListSelectCache = { plain, aliased };
        return orderListSelectCache;
      })().catch((err) => {
        console.warn("⚠️ Failed to introspect orders columns for list projection:", err?.message || err);
        const fallbackCols = [
          "id",
          "restaurant_id",
          "table_number",
          "status",
          "total",
          "order_type",
          "customer_name",
          "customer_phone",
          "customer_address",
          "payment_method",
          "receipt_id",
          "is_paid",
          "created_at",
          "updated_at",
        ];
        orderListSelectCache = {
          plain: fallbackCols.join(", "),
          aliased: fallbackCols.map((col) => `o.${col}`).join(", "),
        };
        return orderListSelectCache;
      });
    }
    return orderListSelectPromise;
  }

  const IDENTIFIER_CACHE_TTL_MS = 60_000;
  const IDENTIFIER_CACHE_MAX = 1000;
  const restaurantIdentifierCache = new Map();

  const getIdentifierCacheKey = (identifier) => String(identifier || "").trim();

  function readIdentifierCache(identifier) {
    const key = getIdentifierCacheKey(identifier);
    if (!key) return null;
    const cached = restaurantIdentifierCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      restaurantIdentifierCache.delete(key);
      return null;
    }
    return cached.restaurantId;
  }

  function writeIdentifierCache(identifier, restaurantId) {
    const key = getIdentifierCacheKey(identifier);
    if (!key) return;
    if (!restaurantIdentifierCache.has(key) && restaurantIdentifierCache.size >= IDENTIFIER_CACHE_MAX) {
      const oldestKey = restaurantIdentifierCache.keys().next().value;
      if (oldestKey) restaurantIdentifierCache.delete(oldestKey);
    }
    restaurantIdentifierCache.set(key, {
      restaurantId: restaurantId ?? null,
      expiresAt: Date.now() + IDENTIFIER_CACHE_TTL_MS,
    });
  }

  async function lookupRestaurantIdByIdentifier(identifier) {
    const normalized = String(identifier || "").trim();
    if (!normalized) return null;
    if (/^\d+$/.test(normalized)) return Number(normalized);

    const cached = readIdentifierCache(normalized);
    if (cached !== null) return cached;

    const { rows } = await pool.query(
      "SELECT id FROM restaurants WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1 LIMIT 1",
      [normalized]
    );
    const restaurantId = rows[0]?.id ? Number(rows[0].id) : null;
    writeIdentifierCache(normalized, restaurantId);
    return restaurantId;
  }

  const PUBLIC_GET_PATTERNS = [/^\/$/, /^\/\d+$/, /^\/\d+\/items$/];

  // Authentication layer:
  // - Public GETs with ?identifier=... stay public (for dashboards)
  // - Table QR mode (?mode=table) uses a lightweight table JWT
  // - Everything else falls back to normal staff authMiddleware
  router.use((req, res, next) => {
    const mode =
      typeof req.query.mode === "string"
        ? req.query.mode.toLowerCase()
        : String(req.query.mode || "").toLowerCase();

    // 1) Public GETs for non-table QR flows
    if (req.method === "GET" && mode !== "table") {
      const identifier =
        typeof req.query.identifier === "string"
          ? req.query.identifier.trim()
          : String(req.query.identifier || "").trim();
      if (identifier && PUBLIC_GET_PATTERNS.some((re) => re.test(req.path))) {
        return next();
      }
    }

    // 2) Table QR mode – require a table-scoped JWT and attach limited context
    if (mode === "table") {
      const authHeader = req.headers.authorization || "";
      if (!authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Missing table token" });
      }

      const token = authHeader.slice(7).trim();
      try {
        const decoded = jwt.verify(token, TABLE_QR_SECRET);
        if (
          !decoded ||
          decoded.type !== "table" ||
          !decoded.restaurant_id ||
          typeof decoded.table_number === "undefined"
        ) {
          return res.status(401).json({ error: "Invalid table token" });
        }

        req.qrTable = {
          restaurant_id: decoded.restaurant_id,
          table_number: Number(decoded.table_number),
        };

        // Minimal req.user so requireRestaurantId() continues to work
        req.user = {
          ...(req.user || {}),
          id: null,
          name: "QR Table",
          role: "qr-table",
          restaurant_id: decoded.restaurant_id,
        };

        return next();
      } catch (err) {
        console.warn("⚠️ Table QR token verification failed:", err.message);
        return res
          .status(401)
          .json({ error: "Invalid or expired table token" });
      }
    }

    // 3) Public QR POST (identifier without auth) – allow standalone module
    const identifier =
      typeof req.query.identifier === "string"
        ? req.query.identifier.trim()
        : String(req.query.identifier || "").trim();
    if (
      req.method === "POST" &&
      identifier &&
      !(req.headers.authorization || "").startsWith("Bearer ")
    ) {
      return (async () => {
        try {
          const restaurant_id = await lookupRestaurantIdByIdentifier(identifier);
          if (!restaurant_id) {
            return res.status(404).json({ error: "Invalid restaurant" });
          }
          req.user = {
            id: null,
            name: "qr-guest",
            role: "qr-guest",
            restaurant_id,
            allowed_modules: ["qr_kitchen"],
          };
          req.allowed_modules = ["qr_kitchen"];
          return next();
        } catch (err) {
          console.error("❌ QR guest order auth failed:", err.message);
          return res.status(500).json({ error: "Internal server error" });
        }
      })();
    }

    // 4) Default: staff / backend tokens
    return authMiddleware(req, res, async () => {
      const allowed = await attachAllowedModules(req);
      if (Array.isArray(allowed) && !allowed.includes("pos_core")) {
        if (allowed.includes("qr_kitchen")) {
          return next();
        }
        const isAllowed =
          req.method === "GET" && /^\/reservations\/[^/]+$/.test(req.path || "");
        if (!isAllowed) {
          return res.status(403).json({ error: "MODULE_NOT_ALLOWED" });
        }
      }
      return next();
    });
  });


async function resolveRestaurantId(req) {
  const identifier = req.query.identifier;
  let restaurant_id = req.user?.restaurant_id;

  if (identifier) {
    const resolvedByIdentifier = await lookupRestaurantIdByIdentifier(identifier);
    // If identifier doesn't match, don't clobber an already-authenticated restaurant_id.
    restaurant_id = resolvedByIdentifier ?? restaurant_id;
  }

  return restaurant_id;
}

async function requireRestaurantId(req, res) {
  const restaurantId = await resolveRestaurantId(req);
  if (!restaurantId) {
    res.status(400).json({ error: "Invalid restaurant" });
    return null;
  }
  return restaurantId;
}

const OPEN_ORDER_MODES = Object.freeze({
  packet: ["packet", "phone"],
  kitchen: ["table", "phone", "packet", "takeaway"],
  both: ["table", "phone", "packet", "takeaway"],
});

const getReservationFinalizeResetSql = (statusSqlExpr, options = {}) => {
  const { includeClients = true } = options;
  const assignments = [
    `reservation_date = CASE
                WHEN ${statusSqlExpr} IN ('closed', 'completed')
                  AND LOWER(COALESCE(order_type, '')) <> 'reservation'
                THEN NULL
                ELSE reservation_date
              END`,
    `reservation_time = CASE
                WHEN ${statusSqlExpr} IN ('closed', 'completed')
                  AND LOWER(COALESCE(order_type, '')) <> 'reservation'
                THEN NULL
                ELSE reservation_time
              END`,
    `reservation_notes = CASE
                WHEN ${statusSqlExpr} IN ('closed', 'completed')
                  AND LOWER(COALESCE(order_type, '')) <> 'reservation'
                THEN NULL
                ELSE reservation_notes
              END`,
  ];

  if (includeClients) {
    assignments.splice(
      2,
      0,
      `reservation_clients = CASE
                WHEN ${statusSqlExpr} IN ('closed', 'completed')
                  AND LOWER(COALESCE(order_type, '')) <> 'reservation'
                THEN NULL
                ELSE reservation_clients
              END`
    );
  }

  return assignments.join(",\n              ");
};

async function cancelLinkedConcertBookings(
  client,
  restaurantId,
  orderIds,
  { cancellationReason = "linked_order_closed", bookingTypes = ["table"] } = {}
) {
  const normalizedOrderIds = Array.from(
    new Set(
      (Array.isArray(orderIds) ? orderIds : [orderIds])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
    )
  );
  if (!restaurantId || !normalizedOrderIds.length) return [];
  const normalizedBookingTypes = Array.from(
    new Set(
      (Array.isArray(bookingTypes) ? bookingTypes : [bookingTypes])
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean)
    )
  );
  if (!normalizedBookingTypes.length) return [];

  await ensureConcertTables(pool);

  const { rows } = await client.query(
    `
      UPDATE concert_bookings cb
         SET payment_status = 'cancelled',
             booking_status = 'cancelled',
             cancelled_at = NOW(),
             updated_at = NOW(),
             customer_note = CASE
               WHEN NULLIF(TRIM(COALESCE(cb.customer_note, '')), '') IS NULL THEN $3
               WHEN POSITION($3 IN COALESCE(cb.customer_note, '')) > 0 THEN cb.customer_note
               ELSE CONCAT(cb.customer_note, ' | ', $3)
             END
       WHERE cb.restaurant_id = $1
         AND cb.reservation_order_id = ANY($2::int[])
         AND LOWER(COALESCE(cb.booking_type, '')) = ANY($4::text[])
         AND LOWER(COALESCE(cb.payment_status, '')) <> 'cancelled'
         AND LOWER(COALESCE(cb.booking_status, '')) <> 'cancelled'
       RETURNING cb.id, cb.reservation_order_id, cb.reserved_table_number
    `,
    [restaurantId, normalizedOrderIds, cancellationReason, normalizedBookingTypes]
  );

  return rows || [];
}

async function closeStaleReservations(restaurantId) {
  if (!restaurantId) return [];
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `
          UPDATE orders o
             SET status = 'closed',
                 ${getReservationFinalizeResetSql("'closed'")},
                 total = 0,
                 updated_at = NOW()
           WHERE o.restaurant_id = $1
             AND o.reservation_date IS NOT NULL
             AND o.reservation_date < CURRENT_DATE
             AND COALESCE(o.total, 0) = 0
             AND LOWER(COALESCE(o.status, '')) NOT IN ('closed', 'cancelled', 'canceled')
             AND (
               LOWER(COALESCE(o.status, '')) = 'reserved'
               OR LOWER(COALESCE(o.order_type, '')) = 'reservation'
             )
             AND NOT EXISTS (
               SELECT 1 FROM order_items oi WHERE oi.order_id = o.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM sub_orders so WHERE so.order_id = o.id
             )
           RETURNING o.id, o.table_number, o.reservation_date
        `,
        [restaurantId]
      );
      await cancelLinkedConcertBookings(client, restaurantId, rows.map((row) => row.id), {
        cancellationReason: "stale_reservation_closed",
      });
      await client.query("COMMIT");
      return rows || [];
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn("⚠️ Failed to close stale reservations:", err?.message || err);
    return [];
  }
}

const STALE_RESERVATION_CLEANUP_INTERVAL_MS = (() => {
  const raw = Number.parseInt(
    String(process.env.STALE_RESERVATION_CLEANUP_INTERVAL_MS || ""),
    10
  );
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 5 * 60 * 1000; // default: 5 minutes
})();
const staleReservationCleanupState = new Map();

const isConnectionTimeoutError = (err) => {
  const message = String(err?.message || "").toLowerCase();
  return (
    message.includes("timeout exceeded when trying to connect") ||
    message.includes("connection terminated unexpectedly") ||
    message.includes("connect etimedout")
  );
};

function scheduleCloseStaleReservations(restaurantId, options = {}) {
  const normalizedRestaurantId = Number(restaurantId);
  if (!Number.isFinite(normalizedRestaurantId) || normalizedRestaurantId <= 0) return;

  const force = options?.force === true;
  const now = Date.now();
  const previousState = staleReservationCleanupState.get(normalizedRestaurantId) || {
    inFlight: false,
    lastAttemptAt: 0,
  };

  if (previousState.inFlight) return;
  if (!force && now - Number(previousState.lastAttemptAt || 0) < STALE_RESERVATION_CLEANUP_INTERVAL_MS) {
    return;
  }

  staleReservationCleanupState.set(normalizedRestaurantId, {
    ...previousState,
    inFlight: true,
    lastAttemptAt: now,
  });

  closeStaleReservations(normalizedRestaurantId)
    .then((rows) => {
      staleReservationCleanupState.set(normalizedRestaurantId, {
        inFlight: false,
        lastAttemptAt: now,
      });
      if (Array.isArray(rows) && rows.length > 0) {
        console.log(
          `🧹 Closed ${rows.length} stale reservations for restaurant ${normalizedRestaurantId}`
        );
      }
    })
    .catch((err) => {
      console.warn("⚠️ closeStaleReservations (throttled) failed:", err?.message || err);
      staleReservationCleanupState.set(normalizedRestaurantId, {
        inFlight: false,
        lastAttemptAt: now,
      });
    });
}

function parseGeoValue(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function getQrMenuCustomization(restaurantId) {
  try {
    const { rows } = await pool.query(
      `SELECT qr_menu_customization, value
       FROM settings
       WHERE restaurant_id = $1 AND key = 'qr-menu-customization'
       LIMIT 1`,
      [restaurantId]
    );
    if (!rows.length) return {};
    const raw = rows[0].qr_menu_customization ?? rows[0].value ?? {};
    if (typeof raw === "string") {
      return JSON.parse(raw);
    }
    return raw && typeof raw === "object" ? raw : {};
  } catch (err) {
    console.warn("⚠️ Failed to load QR menu customization:", err?.message || err);
    return {};
  }
}

function parseReservationGuestCompositionValue(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function hasReservationGuestCompositionValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function normalizeReservationGuestCompositionFieldMode(value, fallback = "hidden") {
  const normalized = String(value || fallback).trim().toLowerCase();
  return ["hidden", "optional", "required"].includes(normalized) ? normalized : fallback;
}

function normalizeReservationGuestCompositionRestrictionRule(
  value,
  fallback = "no_restriction"
) {
  const normalized = String(value || fallback).trim().toLowerCase();
  return [
    "no_restriction",
    "male_only_groups_not_allowed",
    "female_only_groups_not_allowed",
    "at_least_1_female_required",
    "couple_only",
    "custom_rule_later",
  ].includes(normalized)
    ? normalized
    : fallback;
}

function getDefaultReservationGuestCompositionMessage(rule) {
  switch (normalizeReservationGuestCompositionRestrictionRule(rule)) {
    case "male_only_groups_not_allowed":
      return "Male-only groups are not allowed for this reservation.";
    case "female_only_groups_not_allowed":
      return "Female-only groups are not allowed for this reservation.";
    case "at_least_1_female_required":
      return "At least 1 female guest is required for this reservation.";
    case "couple_only":
      return "Only mixed couples with equal men and women are allowed for this reservation.";
    default:
      return "Guest composition does not match the reservation policy.";
  }
}

function reservationRestrictionRuleRequiresInput(rule) {
  const normalized = normalizeReservationGuestCompositionRestrictionRule(
    rule,
    "no_restriction"
  );
  return [
    "male_only_groups_not_allowed",
    "female_only_groups_not_allowed",
    "at_least_1_female_required",
    "couple_only",
  ].includes(normalized);
}

function validateReservationGuestComposition({
  config,
  guestCount,
  reservationMen,
  reservationWomen,
}) {
  const enabled = Boolean(config?.reservation_guest_composition_enabled);
  const restrictionRule = normalizeReservationGuestCompositionRestrictionRule(
    config?.reservation_guest_composition_restriction_rule,
    "no_restriction"
  );
  const fieldMode = normalizeReservationGuestCompositionFieldMode(
    config?.reservation_guest_composition_field_mode,
    enabled ? "optional" : "hidden"
  );
  const effectiveFieldMode = reservationRestrictionRuleRequiresInput(restrictionRule)
    ? "required"
    : fieldMode;
  if (!enabled || effectiveFieldMode === "hidden") {
    return {
      reservationMenCount: null,
      reservationWomenCount: null,
    };
  }

  const hasInput =
    hasReservationGuestCompositionValue(reservationMen) ||
    hasReservationGuestCompositionValue(reservationWomen);
  const totalGuests = parseReservationGuestCompositionValue(guestCount);
  const validationMessage =
    String(config?.reservation_guest_composition_validation_message || "").trim() ||
    getDefaultReservationGuestCompositionMessage(restrictionRule);
  if (restrictionRule === "couple_only" && totalGuests > 0 && totalGuests % 2 !== 0) {
    return {
      error: validationMessage,
    };
  }
  if (effectiveFieldMode === "optional" && !hasInput) {
    return {
      reservationMenCount: null,
      reservationWomenCount: null,
    };
  }
  if (!hasInput) {
    return {
      error: reservationRestrictionRuleRequiresInput(restrictionRule)
        ? validationMessage
        : "Guest composition must match guest count.",
    };
  }

  const reservationMenCount = parseReservationGuestCompositionValue(reservationMen);
  const reservationWomenCount = parseReservationGuestCompositionValue(reservationWomen);
  if (
    totalGuests <= 0 ||
    reservationMenCount + reservationWomenCount !== totalGuests
  ) {
    return {
      error: "Guest composition must match guest count.",
    };
  }

  let blocked = false;
  switch (restrictionRule) {
    case "male_only_groups_not_allowed":
      blocked = reservationMenCount > 0 && reservationWomenCount === 0;
      break;
    case "female_only_groups_not_allowed":
      blocked = reservationWomenCount > 0 && reservationMenCount === 0;
      break;
    case "at_least_1_female_required":
      blocked = reservationWomenCount < 1;
      break;
    case "couple_only":
      blocked =
        totalGuests % 2 !== 0 ||
        reservationMenCount !== reservationWomenCount ||
        reservationMenCount < 1 ||
        reservationWomenCount < 1;
      break;
    case "custom_rule_later":
    case "no_restriction":
    default:
      blocked = false;
      break;
  }

  if (blocked) {
    return {
      error: validationMessage,
    };
  }

  return {
    reservationMenCount,
    reservationWomenCount,
  };
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 6371000 * c;
}

async function enforceTableGeo(req, res, restaurantId) {
  const config = await getQrMenuCustomization(restaurantId);
  if (!config?.table_geo_enabled) return true;

  const radiusRaw = Number(config?.table_geo_radius_meters);
  const radiusMeters = Number.isFinite(radiusRaw) && radiusRaw > 0 ? radiusRaw : 150;

  const lat =
    parseGeoValue(req.body?.table_geo_lat) ??
    parseGeoValue(req.body?.geo_lat) ??
    parseGeoValue(req.body?.lat);
  const lng =
    parseGeoValue(req.body?.table_geo_lng) ??
    parseGeoValue(req.body?.geo_lng) ??
    parseGeoValue(req.body?.lng);

  if (lat === null || lng === null) {
    res.status(403).json({
      error: "Location required for table orders. Please rescan at the restaurant.",
    });
    return false;
  }

  const { rows } = await pool.query(
    "SELECT pos_location_lat, pos_location_lng FROM restaurants WHERE id = $1 LIMIT 1",
    [restaurantId]
  );
  const restaurantLat = parseGeoValue(rows[0]?.pos_location_lat);
  const restaurantLng = parseGeoValue(rows[0]?.pos_location_lng);

  if (restaurantLat === null || restaurantLng === null) {
    res.status(400).json({
      error: "Restaurant location is not configured for table orders.",
    });
    return false;
  }

  const distance = haversineMeters(lat, lng, restaurantLat, restaurantLng);
  if (distance > radiusMeters) {
    res.status(403).json({
      error: `Table orders are only allowed within ${Math.round(radiusMeters)} meters of the restaurant.`,
    });
    return false;
  }

  return true;
}

// Track the last write/update time per order id to spot read-after-write timing
const ORDER_TOUCH = new Map(); // id:number -> { when:number(ms), source:string }
function touch(id, source) {
  if (id == null) return;
  const n = Number(id);
  if (!Number.isFinite(n)) return;
  ORDER_TOUCH.set(n, { when: Date.now(), source });
}
function since(id) {
  const n = Number(id);
  const info = ORDER_TOUCH.get(n);
  return info ? { ms: Date.now() - info.when, source: info.source } : null;
}


const {
  emitOrderUpdate,
  emitOrderConfirmed,
  emitOrderDelivered,
  emitOrderCancelled,
  emitPaymentMade,
  emitOrderPreparing,
  emitDriverAssigned,
  emitDriverOnRoad,
} = require('../utils/realtime');

let ordersHasCreatedByColumn = null;
async function hasOrdersCreatedByColumn() {
  if (ordersHasCreatedByColumn !== null) return ordersHasCreatedByColumn;
  try {
    const { rows } = await pool.query(
      `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'orders'
          AND column_name = 'created_by'
      ) AS exists
      `
    );
    ordersHasCreatedByColumn = !!rows?.[0]?.exists;
  } catch (err) {
    console.warn("⚠️ Unable to detect orders.created_by column:", err.message);
    ordersHasCreatedByColumn = false;
  }
  return ordersHasCreatedByColumn;
}

let ordersHasTakeawayFields = null;
async function ensureTakeawayFields() {
  if (ordersHasTakeawayFields === true) return true;
  try {
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS pickup_time TEXT`
    );
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS takeaway_notes TEXT`
    );
    ordersHasTakeawayFields = true;
    return true;
  } catch (err) {
    console.warn("⚠️ Unable to ensure takeaway columns:", err.message);
    ordersHasTakeawayFields = false;
    return false;
  }
}

let ordersHasReservationGuestCompositionFields = null;
async function ensureReservationGuestCompositionFields() {
  if (ordersHasReservationGuestCompositionFields === true) return true;
  try {
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS reservation_men INTEGER`
    );
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS reservation_women INTEGER`
    );
    ordersHasReservationGuestCompositionFields = true;
    return true;
  } catch (err) {
    console.warn(
      "⚠️ Unable to ensure reservation guest composition columns:",
      err.message
    );
    ordersHasReservationGuestCompositionFields = false;
    return false;
  }
}

let ordersHasTrafficLoggedColumn = null;
async function ensureOrdersTrafficLoggedColumn() {
  if (ordersHasTrafficLoggedColumn === true) return true;
  try {
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS traffic_logged_at TIMESTAMPTZ`
    );
    ordersHasTrafficLoggedColumn = true;
    return true;
  } catch (err) {
    console.warn("⚠️ Unable to ensure orders.traffic_logged_at column:", err.message);
    ordersHasTrafficLoggedColumn = false;
    return false;
  }
}

let trafficTablesEnsured = false;
async function ensureCustomerTrafficTables(client) {
  if (trafficTablesEnsured) return true;
  const runner = client || pool;
  try {
    await runner.query(`
      CREATE TABLE IF NOT EXISTS customer_traffic_daily (
        id SERIAL PRIMARY KEY,
        restaurant_id INTEGER NOT NULL,
        date DATE NOT NULL,
        customer_count INTEGER NOT NULL DEFAULT 0,
        source TEXT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(restaurant_id, date)
      );
    `);
    await runner.query(`
      CREATE TABLE IF NOT EXISTS customer_traffic_events (
        id SERIAL PRIMARY KEY,
        restaurant_id INTEGER NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delta INTEGER NOT NULL,
        table_id INTEGER NULL,
        order_id INTEGER NULL,
        source TEXT NULL,
        meta JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await runner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_traffic_events_order_unique
        ON customer_traffic_events(restaurant_id, order_id)
        WHERE order_id IS NOT NULL;
    `);
    trafficTablesEnsured = true;
    return true;
  } catch (err) {
    console.warn("⚠️ Unable to ensure customer traffic tables:", err.message);
    return false;
  }
}

const toLocalYmd = (value) => {
  const m = value ? moment.tz(value, DEFAULT_TZ) : moment.tz(DEFAULT_TZ);
  if (!m.isValid()) return moment.tz(DEFAULT_TZ).format("YYYY-MM-DD");
  return m.format("YYYY-MM-DD");
};

async function fetchTableGuests(client, restaurantId, tableNumber) {
  if (!Number.isFinite(Number(tableNumber))) return null;
  try {
    const { rows } = await client.query(
      `SELECT guests FROM tables WHERE restaurant_id = $1 AND number = $2 LIMIT 1`,
      [restaurantId, Number(tableNumber)]
    );
    const guests = Number(rows?.[0]?.guests);
    if (!Number.isFinite(guests)) return null;
    return guests;
  } catch (err) {
    console.warn("⚠️ fetchTableGuests failed:", err.message);
    return null;
  }
}

async function logCustomerTraffic(client, { restaurantId, orderId, tableNumber, delta, source, meta = null, forDate = null }) {
  const safeDelta = Number(delta);
  if (!Number.isFinite(safeDelta) || safeDelta <= 0) {
    return { skipped: true, reason: "no_delta" };
  }

  const ymd = toLocalYmd(forDate || undefined);

  try {
    await client.query(
      `
        INSERT INTO customer_traffic_events (restaurant_id, occurred_at, delta, table_id, order_id, source, meta)
        VALUES ($1, NOW(), $2, $3, $4, $5, $6)
        ON CONFLICT (restaurant_id, order_id)
        WHERE order_id IS NOT NULL
        DO NOTHING
      `,
      [restaurantId, safeDelta, tableNumber || null, orderId || null, source || null, meta]
    );
  } catch (err) {
    console.warn("⚠️ Failed to insert customer traffic event:", err.message);
  }

  let customerCount = safeDelta;
  try {
    const { rows } = await client.query(
      `
        INSERT INTO customer_traffic_daily (restaurant_id, date, customer_count, source, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (restaurant_id, date)
        DO UPDATE SET
          customer_count = customer_traffic_daily.customer_count + EXCLUDED.customer_count,
          updated_at = NOW(),
          source = COALESCE(EXCLUDED.source, customer_traffic_daily.source)
        RETURNING customer_count
      `,
      [restaurantId, ymd, safeDelta, source || null]
    );
    customerCount = Number(rows?.[0]?.customer_count || safeDelta);
  } catch (err) {
    console.warn("⚠️ Failed to upsert customer_traffic_daily:", err.message);
  }

  try {
    await client.query(
      `UPDATE orders
         SET traffic_logged_at = COALESCE(traffic_logged_at, NOW())
       WHERE id = $1 AND restaurant_id = $2`,
      [orderId, restaurantId]
    );
  } catch (err) {
    console.warn("⚠️ Failed to stamp orders.traffic_logged_at:", err.message);
  }

  return { date: ymd, customer_count: customerCount };
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

let ordersHasKitchenTimingFields = null;
function parseExtrasField(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function computeExtrasTotalForItem(item) {
  const extras = parseExtrasField(item.extras);
  return extras.reduce((acc, extra) => {
    const price = Number(extra?.price ?? extra?.extraPrice ?? 0) || 0;
    const extraQty =
      extra?.quantity ??
      extra?.qty ??
      extra?.count ??
      extra?.amount ??
      1;
    const qty = Number(extraQty) || 1;
    return acc + price * qty;
  }, 0);
}

async function computeOrderTotalWithExtras(dbClient, orderId) {
  if (!orderId) return 0;
  const executor = dbClient && typeof dbClient.query === "function" ? dbClient : pool;
  try {
    const { rows } = await executor.query(
      `SELECT price, quantity, extras
         FROM order_items
        WHERE order_id = $1`,
      [orderId]
    );
    return rows.reduce((sum, item) => {
      const quantity = Number(item.quantity) || 1;
      const basePrice = Number.parseFloat(item.price) || 0;
      const extrasTotal = computeExtrasTotalForItem(item);
      return sum + (basePrice + extrasTotal) * quantity;
    }, 0);
  } catch (err) {
    console.warn(`⚠️ Failed to compute extras for order ${orderId}:`, err?.message || err);
    return 0;
  }
}
async function ensureKitchenTimingFields() {
  if (ordersHasKitchenTimingFields === true) return true;
  try {
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS prep_started_at TIMESTAMP`
    );
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS estimated_ready_at TIMESTAMP`
    );
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS kitchen_delivered_at TIMESTAMP`
    );
    ordersHasKitchenTimingFields = true;
  } catch (err) {
    console.warn("⚠️ Unable to ensure kitchen timing columns:", err.message);
    ordersHasKitchenTimingFields = false;
  }
  return ordersHasKitchenTimingFields;
}

let ordersHasCancellationFields = null;
async function ensureCancellationFields() {
  if (ordersHasCancellationFields === true) return true;
  try {
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS cancellation_reason TEXT`
    );
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`
    );
    ordersHasCancellationFields = true;
    return true;
  } catch (err) {
    console.warn("⚠️ Unable to ensure cancellation columns:", err.message);
    ordersHasCancellationFields = false;
    return false;
  }
}

let orderItemsHasCancellationFields = null;
let orderItemsCancellationColumns = null;

async function getOrderItemsCancellationColumns() {
  if (orderItemsCancellationColumns) return orderItemsCancellationColumns;
  try {
    const { rows } = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'order_items'`
    );
    const cols = new Set(rows.map((r) => String(r.column_name || "").toLowerCase()));
    orderItemsCancellationColumns = {
      hasCancelledAt: cols.has("cancelled_at"),
      hasCancellationReason: cols.has("cancellation_reason"),
    };
    return orderItemsCancellationColumns;
  } catch {
    orderItemsCancellationColumns = {
      hasCancelledAt: false,
      hasCancellationReason: false,
    };
    return orderItemsCancellationColumns;
  }
}

async function ensureOrderItemCancellationFields() {
  if (orderItemsHasCancellationFields !== null) return orderItemsHasCancellationFields;
  try {
    const existing = await getOrderItemsCancellationColumns();
    if (existing.hasCancelledAt && existing.hasCancellationReason) {
      orderItemsHasCancellationFields = true;
      return true;
    }

    await pool.query(
      `ALTER TABLE order_items
         ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`
    );
    await pool.query(
      `ALTER TABLE order_items
         ADD COLUMN IF NOT EXISTS cancellation_reason TEXT`
    );
    orderItemsCancellationColumns = { hasCancelledAt: true, hasCancellationReason: true };
    orderItemsHasCancellationFields = true;
    return true;
  } catch (err) {
    console.warn(
      "⚠️ Unable to ensure order_items cancellation columns:",
      err.message
    );
    orderItemsHasCancellationFields = false;
    return false;
  }
}

let ordersRouteSchemaBootstrapPromise = null;
function bootstrapOrdersRouteSchema() {
  if (ordersRouteSchemaBootstrapPromise) return ordersRouteSchemaBootstrapPromise;
  ordersRouteSchemaBootstrapPromise = (async () => {
    const bootstrapSteps = [
      ["ensureCustomerDebtColumn", () => ensureCustomerDebtColumn()],
      ["ensureOrderDebtTracking", () => ensureOrderDebtTracking()],
      ["ensurePaymentChangeTracking", () => ensurePaymentChangeTracking()],
      ["ensurePaymentMethodChangesTracking", () => ensurePaymentMethodChangesTracking()],
      ["ensureTakeawayFields", () => ensureTakeawayFields()],
      ["ensureOrdersTrafficLoggedColumn", () => ensureOrdersTrafficLoggedColumn()],
      ["ensureCustomerTrafficTables", () => ensureCustomerTrafficTables()],
      ["ensureKitchenTimingFields", () => ensureKitchenTimingFields()],
      ["ensureCancellationFields", () => ensureCancellationFields()],
      ["ensureOrderItemCancellationFields", () => ensureOrderItemCancellationFields()],
      ["ensureOrderItemsStockDeductedColumn", () => ensureOrderItemsStockDeductedColumn()],
    ];
    for (const [name, runner] of bootstrapSteps) {
      try {
        await runner();
      } catch (err) {
        console.warn(`⚠️ ${name} bootstrap failed:`, err?.message || err);
      }
    }
  })();
  return ordersRouteSchemaBootstrapPromise;
}

bootstrapOrdersRouteSchema();


// ---- Shared payload builder for printer (no order_number) ----
async function buildFullOrderPayload(orderId, restaurantId) {
  const { rows: orderRows } = await pool.query(
    `SELECT
       id,
       status,
       table_number,
       order_type,
       total,
       created_at,
       customer_name,
       customer_phone,
       customer_address,
       payment_method,
       takeaway_notes,
       receipt_id,
       external_id,
       external_source,
       external_expedition_type
     FROM orders WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, orderId]
  );

  if (!orderRows.length) throw new Error(`Order ${orderId} not found`);

  const { rows: itemRows } = await pool.query(
    `SELECT
       oi.product_id,
       oi.unique_id,
       oi.name AS order_item_name,
       oi.external_product_name,
       p.name  AS product_name,
       oi.quantity,
       oi.price,
       oi.extras,
       oi.note,
       oi.kitchen_status,
       oi.paid_at
     FROM order_items oi
     LEFT JOIN products p ON oi.product_id = p.id
     WHERE oi.order_id = $1
     ORDER BY oi.id ASC`,
    [orderId]
  );

  const items = itemRows.map(it => ({
    ...it,
    name: it.order_item_name || it.external_product_name || it.product_name || "Item",
    extras: typeof it.extras === "string"
      ? (() => { try { return JSON.parse(it.extras); } catch { return []; } })()
      : (it.extras || []),
    total: (parseFloat(it.price) || 0) * (it.quantity || 1),
  }));

  const header = orderRows[0];
  return {
    id: header.id,
    order: {
      id: header.id,
      status: header.status,
      table_number: header.table_number,
      order_type: header.order_type,
      total: header.total,
      created_at: header.created_at,
      customer_name: header.customer_name ?? null,
      customer_phone: header.customer_phone ?? null,
      customer_address: header.customer_address ?? null,
      payment_method: header.payment_method ?? null,
      takeaway_notes: header.takeaway_notes ?? null,
      receipt_id: header.receipt_id ?? null,
      external_id: header.external_id ?? null,
      external_source: header.external_source ?? null,
      external_expedition_type: header.external_expedition_type ?? null,
      items,
    },
  };
}



// GET /orders
// Supports: ?status=open_phone to return ONLY non-closed phone/packet orders
router.get("/", async (req, res) => {
  try {
    const orderSelect = await getOrderListSelectSql();
    const restaurantId = await requireRestaurantId(req, res);
    if (!restaurantId) return;
    const { status, table_number, type } = req.query;

    // Fire-and-forget, throttled to avoid opening extra DB connections on every poll.
    scheduleCloseStaleReservations(restaurantId);

    // 🔐 Special mode: always and only open phone/packet
    if (String(status).toLowerCase() === "open_phone") {
      const { rows } = await pool.query(
        `SELECT ${orderSelect.plain}
           FROM orders
          WHERE restaurant_id = $1
            AND order_type IN ('phone','packet')
            AND status <> 'closed'
          ORDER BY id DESC`,
        [restaurantId]
      );
      return res.json(rows);
    }

    // 🔎 default behavior
    let sql = `SELECT ${orderSelect.plain} FROM orders WHERE restaurant_id = $1`;
    const params = [restaurantId];
    let idx = 2;

    if (status) {
      sql += ` AND status = $${idx++}`;
      params.push(status);
    }
    if (table_number) {
      sql += ` AND table_number = $${idx++}`;
      params.push(table_number);
    }
    if (type) {
      sql += ` AND order_type = $${idx++}`;
      params.push(type);
    }
    sql += " ORDER BY id DESC";

    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    if (isConnectionTimeoutError(err)) {
      console.warn(
        "⚠️ Orders fetch timeout. Returning empty list to keep client responsive.",
        err?.message || err
      );
      return res.json([]);
    }
    console.error("❌ Orders fetch failed:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /orders/open/with-items
// Batched open-order payload used by TableOverview kitchen/packet views.
router.get("/open/with-items", async (req, res) => {
  try {
    const orderSelect = await getOrderListSelectSql();
    const modeRaw = String(req.query.mode || "both").trim().toLowerCase();
    const mode = OPEN_ORDER_MODES[modeRaw] ? modeRaw : "both";
    const allowedTypes = OPEN_ORDER_MODES[mode];

    const restaurantIdFromQuery = Number.parseInt(
      String(req.query.restaurant_id ?? req.query.restaurantId ?? ""),
      10
    );
    if (!Number.isFinite(restaurantIdFromQuery)) {
      return res.status(400).json({ error: "restaurant_id is required" });
    }

    const resolvedRestaurantId = await resolveRestaurantId(req);
    const restaurantId = restaurantIdFromQuery;

    if (
      Number.isFinite(Number(resolvedRestaurantId)) &&
      Number(resolvedRestaurantId) !== restaurantId
    ) {
      return res.status(403).json({ error: "Forbidden restaurant_id" });
    }

    if (
      Number.isFinite(Number(req.user?.restaurant_id)) &&
      Number(req.user.restaurant_id) !== restaurantId
    ) {
      return res.status(403).json({ error: "Forbidden restaurant_id" });
    }

    let sinceClause = "";
    const params = [restaurantId, allowedTypes];
    const sinceRaw = String(req.query.since || "").trim();
    if (sinceRaw) {
      const sinceDate = /^\d+$/.test(sinceRaw)
        ? new Date(Number(sinceRaw))
        : new Date(sinceRaw);
      if (Number.isFinite(sinceDate.getTime())) {
        params.push(sinceDate.toISOString());
        sinceClause = `AND COALESCE(o.updated_at, o.created_at) >= $${params.length}`;
      }
    }

    const cancellationColumns = await getOrderItemsCancellationColumns();
    const itemCancelFilter = cancellationColumns.hasCancelledAt
      ? "AND oi.cancelled_at IS NULL"
      : "AND COALESCE(oi.kitchen_status, '') <> 'cancelled'";

    const { rows } = await pool.query(
      `
      SELECT
        ${orderSelect.aliased},
        COALESCE(oi.items, '[]'::json) AS items,
        COALESCE(rm.receipt_methods, '[]'::json) AS receipt_methods
      FROM orders o
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id', oi.id,
            'product_id', oi.product_id,
            'external_product_id', oi.external_product_id,
            'quantity', oi.quantity,
            'qty', oi.quantity,
            'price', oi.price,
            'ingredients', oi.ingredients,
            'extras', oi.extras,
            'unique_id', oi.unique_id,
            'paid_at', oi.paid_at,
            'confirmed', oi.confirmed,
            'payment_method', oi.payment_method,
            'receipt_id', oi.receipt_id,
            'note', oi.note,
            'notes', oi.note,
            'kitchen_status', oi.kitchen_status,
            'discount_type', oi.discount_type,
            'discount_value', oi.discount_value,
            'name', COALESCE(oi.name, oi.external_product_name, p.name),
            'order_item_name', oi.name,
            'external_product_name', oi.external_product_name,
            'product_name', p.name,
            'category', p.category
          )
          ORDER BY oi.id ASC
        ) AS items
        FROM order_items oi
        LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = o.id
          ${itemCancelFilter}
      ) oi ON TRUE
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'payment_method', rm.payment_method,
            'amount', rm.amount
          )
          ORDER BY rm.id ASC
        ) AS receipt_methods
        FROM receipt_methods rm
        WHERE rm.receipt_id = o.receipt_id
      ) rm ON TRUE
      WHERE o.restaurant_id = $1
        AND LOWER(COALESCE(o.status, '')) NOT IN ('closed', 'cancelled', 'canceled')
        AND LOWER(COALESCE(o.order_type, '')) = ANY($2::text[])
        ${sinceClause}
      ORDER BY o.id DESC
      `,
      params
    );

    res.json({ orders: rows });
  } catch (err) {
    console.error("❌ Error fetching open orders with items:", err);
    res.status(500).json({ error: "Failed to fetch open orders with items" });
  }
});

// GET /orders/receipt-methods/bulk?ids=1,2,3
router.get("/receipt-methods/bulk", async (req, res) => {
  try {
    const restaurantId = await requireRestaurantId(req, res);
    if (!restaurantId) return;

    const ids = String(req.query.ids || "")
      .split(",")
      .map((value) => Number.parseInt(String(value || "").trim(), 10))
      .filter((value) => Number.isFinite(value));

    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length === 0) return res.json({});

    const cappedIds = uniqueIds.slice(0, 1000);
    const { rows } = await pool.query(
      `
      SELECT
        o.id AS order_id,
        rm.payment_method,
        rm.amount
      FROM orders o
      LEFT JOIN receipt_methods rm ON rm.receipt_id = o.receipt_id
      WHERE o.restaurant_id = $1
        AND o.id = ANY($2::int[])
      ORDER BY o.id ASC, rm.id ASC
      `,
      [restaurantId, cappedIds]
    );

    const byOrderId = {};
    cappedIds.forEach((id) => {
      byOrderId[String(id)] = [];
    });

    rows.forEach((row) => {
      const key = String(row.order_id);
      if (!Array.isArray(byOrderId[key])) byOrderId[key] = [];
      if (!row.payment_method && row.amount == null) return;
      byOrderId[key].push({
        payment_method: row.payment_method,
        amount: row.amount,
      });
    });

    res.json(byOrderId);
  } catch (err) {
    console.error("❌ Error fetching bulk receipt methods:", err);
    res.status(500).json({ error: "Failed to fetch bulk receipt methods" });
  }
});




// POST /orders - Create new order (table or phone)
router.post("/", async (req, res) => {
  console.log("💬 /orders payload:", req.body);

  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;
  const { rows: registerStateRows } = await pool.query(
    `
      SELECT type
      FROM cash_register_logs
      WHERE restaurant_id = $1
        AND type IN ('open', 'close')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [restaurantId]
  );
  const lastRegisterEventType = String(registerStateRows[0]?.type || "").toLowerCase();
  if (lastRegisterEventType !== "open") {
    return res.status(403).json({ error: "Register is closed. Cannot place order." });
  }

  const client = await pool.connect();
  try {
    const {
      table_number,
      total,
      items = [],
      order_type,          // 'table' | 'phone' | 'packet' ...
      customer_name,
      customer_phone,
      customer_email,
      customer_address,
      payment_method,
      reservation_clients,
    } = req.body;
    const normalizedCustomerEmail = normalizeCustomerEmail(customer_email);
    const hasReservationClientsInPayload =
      Object.prototype.hasOwnProperty.call(req.body || {}, "reservation_clients") ||
      Object.prototype.hasOwnProperty.call(req.body || {}, "reservationClients");
    const reservationClientsRaw =
      reservation_clients ?? req.body?.reservationClients ?? null;
    let reservationClientsValue = null;
    if (hasReservationClientsInPayload) {
      if (reservationClientsRaw === null || reservationClientsRaw === "") {
        reservationClientsValue = null;
      } else {
        const parsedReservationClients = Number(reservationClientsRaw);
        if (
          !Number.isFinite(parsedReservationClients) ||
          parsedReservationClients < 0 ||
          parsedReservationClients > 500
        ) {
          return res.status(400).json({ error: "Invalid reservation_clients" });
        }
        reservationClientsValue = Math.trunc(parsedReservationClients);
      }
    }

    // When coming from a QR table token, lock the table_number to the token
    let effectiveTableNumber = table_number || null;
    if (req.qrTable && order_type === "table") {
      const tokenTable = Number(req.qrTable.table_number);
      if (!Number.isFinite(tokenTable) || tokenTable <= 0) {
        return res.status(403).json({ error: "Invalid table in QR token" });
      }
      if (
        effectiveTableNumber !== null &&
        Number(effectiveTableNumber) !== tokenTable
      ) {
        return res
          .status(403)
          .json({ error: "QR token does not match requested table" });
      }
      effectiveTableNumber = tokenTable;
      const allowed = await enforceTableGeo(req, res, restaurantId);
      if (!allowed) return;
    }

    // Normalize pickup_time to a full timestamp string if only HH:MM is provided
    function normalizePickupTime(v) {
      if (!v) return null;
      const s = String(v).trim();
      try {
        // If only HH:MM or HH:MM:SS is provided, attach today's date
        if (/^\d{1,2}:\d{2}$/.test(s) || /^\d{1,2}:\d{2}:\d{2}$/.test(s)) {
          const now = new Date();
          const parts = s.split(":").map((x) => parseInt(x, 10));
          const hh = parts[0] || 0;
          const mm = parts[1] || 0;
          const ss = parts[2] || 0;
          const dt = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            hh,
            mm,
            ss,
            0
          );
          // Format as "YYYY-MM-DD HH:MM:SS" which Postgres TIMESTAMP accepts
          const pad = (n) => String(n).padStart(2, "0");
          const ts = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
          return ts;
        }
        // If it's a date/time-like string, try to keep it as-is
        if (/\d{4}-\d{2}-\d{2}.*\d{2}:\d{2}/.test(s)) return s;
        // Last resort: try Date parsing
        const d = new Date(s);
        if (!isNaN(d)) {
          const pad = (n) => String(n).padStart(2, "0");
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        }
      } catch (_) {
        // ignore and fall through
      }
      return s;
    }

    const pickupTimeRaw = req.body.pickup_time ?? req.body.pickupTime ?? null;
    const pickupTime = normalizePickupTime(pickupTimeRaw);
    const takeawayNotes =
      req.body.takeaway_notes ??
      req.body.notes ??
      req.body.takeawayNotes ??
      null;

    console.log("ORDER TYPE from payload:", order_type);
    const includeTakeawayFields = ordersHasTakeawayFields === true;
    const hasCreatedByColumn = await hasOrdersCreatedByColumn();
    await client.query("BEGIN");

    const hasItems = Array.isArray(items) && items.length > 0;
    // Default to confirmed so tables remain actionable even before items are added
    const initialStatus = "confirmed";
    const orderOrigin = resolveQrOrderOrigin(req, order_type);

    let createdBy = null;
    if (hasCreatedByColumn && req.user?.id) {
      const staffCreator = await pool.query(
        `SELECT id FROM staff WHERE restaurant_id = $1 AND id = $2 LIMIT 1`,
        [restaurantId, req.user.id]
      );
      if (staffCreator.rowCount) {
        createdBy = req.user.id;
      }
    }

    // 📍 Geocode customer delivery address if provided
    let deliveryLat = null;
    let deliveryLng = null;
    if (customer_address && (order_type === 'packet' || order_type === 'phone')) {
      try {
        console.log(`🌍 Attempting to geocode delivery address: "${customer_address}"`);
        
        const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
        if (GOOGLE_API_KEY) {
          const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
            customer_address + ', Turkey'
          )}&key=${GOOGLE_API_KEY}`;
          
          console.log(`📡 Google Maps geocoding request for: ${customer_address}`);
          const geocodeResponse = await fetch(geocodeUrl);
          const geocodeData = await geocodeResponse.json();
          
          console.log(`📊 Google Maps response status: ${geocodeData.status}`);
          
          if (geocodeData.status === 'OK' && geocodeData.results[0]) {
            deliveryLat = geocodeData.results[0].geometry.location.lat;
            deliveryLng = geocodeData.results[0].geometry.location.lng;
            console.log(`✅ Geocoded via Google Maps: ${customer_address} → (${deliveryLat}, ${deliveryLng})`);
          } else {
            console.warn(`⚠️ Google Maps geocoding failed (${geocodeData.status}). Trying Nominatim fallback...`);
            // Try Nominatim with full address
            const result = await geocodeWithNominatim(customer_address);
            if (result) {
              deliveryLat = result.lat;
              deliveryLng = result.lng;
              console.log(`✅ Geocoded via Nominatim: ${customer_address} → (${deliveryLat}, ${deliveryLng})`);
            }
          }
        } else {
          console.warn('⚠️ GOOGLE_MAPS_API_KEY not set. Trying Nominatim...');
          // Use Nominatim as default
          const result = await geocodeWithNominatim(customer_address);
          if (result) {
            deliveryLat = result.lat;
            deliveryLng = result.lng;
            console.log(`✅ Geocoded via Nominatim: ${customer_address} → (${deliveryLat}, ${deliveryLng})`);
          } else {
            console.warn(`⚠️ Nominatim failed for: ${customer_address}`);
          }
        }
      } catch (err) {
        console.error('❌ Geocoding error:', err.message);
      }
    }
    
    // Helper function for Nominatim geocoding with retry
    async function geocodeWithNominatim(address) {
      try {
        // Try 0: Google Maps API (if available)
        if (process.env.GOOGLE_API_KEY) {
          console.log(`  📍 Attempt 0: Google Maps API`);
          try {
            const googleUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
              address
            )}&region=tr&key=${process.env.GOOGLE_API_KEY}`;
            
            const response = await fetch(googleUrl);
            const data = await response.json();
            
            if (data.results && data.results.length > 0) {
              const result = data.results[0].geometry.location;
              const lat = parseFloat(result.lat);
              const lng = parseFloat(result.lng);
              
              // Validate result is in Tire area
              if (lat >= 38.0 && lat <= 38.3 && lng >= 27.6 && lng <= 27.9) {
                console.log(`    ✅ Geocoded via Google Maps: ${address} → (${lat}, ${lng})`);
                return { lat, lng };
              } else {
                console.log(`    ⚠️ Google Maps result outside Tire area (${lat}, ${lng}), trying fallback`);
              }
            } else {
              console.log(`    ⚠️ Google Maps returned no results`);
            }
          } catch (googleErr) {
            console.error(`    ❌ Google Maps error:`, googleErr.message);
          }
        }

        // Try 1: Full address with Tire bias
        console.log(`  📍 Attempt 1: Full address with Tire bias`);
        let url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
          address
        )}&format=json&limit=1&countrycodes=tr`;
        
        let response = await fetch(url, {
          headers: { 'User-Agent': 'HurryPOS-Backend' }
        });
        let data = await response.json();
        
        if (data && data.length > 0) {
          // Check if result is in Tire area (not just any city match)
          const lat = parseFloat(data[0].lat);
          const lng = parseFloat(data[0].lon);
          
          // Tire area bounds: lat 38.0-38.3, lng 27.6-27.9
          if (lat >= 38.0 && lat <= 38.3 && lng >= 27.6 && lng <= 27.9) {
            console.log(`    ✅ Found in Tire area`);
            return { lat, lng };
          } else {
            console.log(`    ⚠️ Found but outside Tire area (${lat}, ${lng}), trying next attempt`);
          }
        }
        
        // Try 2: Extract street name and number only
        console.log(`  📍 Attempt 2: Street-level search`);
        // Extract pattern: "Street Name No:XX"
        const streetMatch = address.match(/(.+?)\s+[Nn]o[.:]?\s*(\d+)/);
        if (streetMatch) {
          const streetName = streetMatch[1].trim();
          const streetNum = streetMatch[2];
          const searchAddr = `${streetName} ${streetNum}, Tire, İzmir`;
          
          console.log(`    Searching for: "${searchAddr}"`);
          url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
            searchAddr
          )}&format=json&limit=1&countrycodes=tr`;
          
          response = await fetch(url, {
            headers: { 'User-Agent': 'HurryPOS-Backend' }
          });
          data = await response.json();
          
          if (data && data.length > 0) {
            const lat = parseFloat(data[0].lat);
            const lng = parseFloat(data[0].lon);
            if (lat >= 38.0 && lat <= 38.3 && lng >= 27.6 && lng <= 27.9) {
              console.log(`    ✅ Found street location`);
              return { lat, lng };
            }
          }
        }
        
        // Try 3: Just neighborhood + Tire
        console.log(`  📍 Attempt 3: Neighborhood-level search`);
        const neighborhoodMatch = address.match(/([A-Za-zıöüşğçİÖÜŞĞÇ\s]+),\s*([A-Za-zıöüşğçİÖÜŞĞÇ\s]+)\s*[,\s]/);
        if (neighborhoodMatch) {
          const neighborhood = neighborhoodMatch[1].trim();
          const searchAddr = `${neighborhood}, Tire, İzmir`;
          
          console.log(`    Searching for: "${searchAddr}"`);
          url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
            searchAddr
          )}&format=json&limit=1&countrycodes=tr`;
          
          response = await fetch(url, {
            headers: { 'User-Agent': 'HurryPOS-Backend' }
          });
          data = await response.json();
          
          if (data && data.length > 0) {
            const lat = parseFloat(data[0].lat);
            const lng = parseFloat(data[0].lon);
            if (lat >= 38.0 && lat <= 38.3 && lng >= 27.6 && lng <= 27.9) {
              console.log(`    ✅ Found neighborhood location`);
              return { lat, lng };
            }
          }
        }
        
        // Try 4: City-level fallback
        console.log(`  📍 Attempt 4: City-level fallback`);
        url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
          'Tire, İzmir, Turkey'
        )}&format=json&limit=1&countrycodes=tr`;
        
        response = await fetch(url, {
          headers: { 'User-Agent': 'HurryPOS-Backend' }
        });
        data = await response.json();
        
        if (data && data.length > 0) {
          console.log(`    ✅ Using city-level fallback`);
          return {
            lat: parseFloat(data[0].lat),
            lng: parseFloat(data[0].lon)
          };
        }
        
        console.warn(`    ⚠️ All Nominatim attempts failed`);
        return null;
      } catch (err) {
        console.error(`    ❌ Nominatim fetch error:`, err.message);
        return null;
      }
    }
    
    console.log(`📍 FINAL DELIVERY COORDS FOR ORDER: lat=${deliveryLat}, lng=${deliveryLng}`);
    
    // 📍 Get restaurant pickup coordinates
    let pickupLat = null;
    let pickupLng = null;
    try {
      const restaurantCoords = await pool.query(
        'SELECT pos_location_lat, pos_location_lng FROM restaurants WHERE id = $1',
        [restaurantId]
      );
      if (restaurantCoords.rows[0]) {
        pickupLat = restaurantCoords.rows[0].pos_location_lat;
        pickupLng = restaurantCoords.rows[0].pos_location_lng;
      }
    } catch (err) {
      console.warn('⚠️ Failed to fetch restaurant coordinates:', err.message);
    }

    const insertColumns = [
      "restaurant_id",
      "table_number",
      "status",
      "total",
      "order_type",
      "order_origin",
      "customer_name",
      "customer_phone",
      "customer_address",
      "payment_method",
      "pickup_lat",
      "pickup_lng",
      "delivery_lat",
      "delivery_lng",
      "reservation_clients",
    ];
    const insertValues = [
      restaurantId,
      effectiveTableNumber || null,
      initialStatus,
      total,
      order_type || null,
      orderOrigin,
      customer_name || null,
      customer_phone || null,
      customer_address || null,
      payment_method || null,
      pickupLat,
      pickupLng,
      deliveryLat,
      deliveryLng,
      reservationClientsValue,
    ];

    if (includeTakeawayFields) {
      insertColumns.push("pickup_time", "takeaway_notes");
      insertValues.push(pickupTime, takeawayNotes);
    }

    if (hasCreatedByColumn) {
      insertColumns.push("created_by");
      insertValues.push(createdBy);
    }

    const placeholders = insertColumns.map((_, idx) => `$${idx + 1}`).join(", ");
    const orderInsertQuery = `
      INSERT INTO orders (${insertColumns.join(", ")})
      VALUES (${placeholders})
      RETURNING *
    `;

const orderResult = await client.query(orderInsertQuery, insertValues);

const order = orderResult.rows[0];

// Keep table guests in sync for QR/table orders that send reservation_clients.
if (
  String(order_type || "").toLowerCase() === "table" &&
  Number.isFinite(Number(order?.table_number)) &&
  hasReservationClientsInPayload
) {
  const tableNumber = Number(order.table_number);
  try {
    const updateGuestsRes = await client.query(
      `UPDATE tables
          SET guests = $1
        WHERE restaurant_id = $2 AND number = $3`,
      [reservationClientsValue, restaurantId, tableNumber]
    );

    if (updateGuestsRes.rowCount === 0 && reservationClientsValue !== null) {
      await client.query(
        `INSERT INTO tables (restaurant_id, number, guests)
         SELECT $1, $2, $3
         WHERE NOT EXISTS (
           SELECT 1 FROM tables WHERE restaurant_id = $1 AND number = $2
         )`,
        [restaurantId, tableNumber, reservationClientsValue]
      );
    }
  } catch (tableGuestsErr) {
    console.warn("⚠️ Failed syncing table guests from order create:", tableGuestsErr.message);
  }
}

// ✅ Persist customer contact details from QR checkout (name/phone/email/address).
if (customer_phone) {
  const safeCustomerPhone = String(customer_phone || "").trim();
  const safeCustomerName = String(customer_name || "").trim() || "Customer";
  const upsertCustomer = await client.query(
    `
    INSERT INTO customers (restaurant_id, name, phone, email)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (restaurant_id, phone)
    DO UPDATE SET
      name = COALESCE(NULLIF(EXCLUDED.name, ''), customers.name),
      email = COALESCE(NULLIF(EXCLUDED.email, ''), customers.email)
    RETURNING id
    `,
    [restaurantId, safeCustomerName, safeCustomerPhone, normalizedCustomerEmail || null]
  );

  const customerId = upsertCustomer.rows?.[0]?.id;
  if (customerId && customer_address) {
    await client.query(
      `
      INSERT INTO customer_addresses (customer_id, address, is_default, restaurant_id)
      VALUES ($1, $2, true, $3)
      ON CONFLICT (customer_id, address)
      DO UPDATE SET is_default = EXCLUDED.is_default
      `,
      [customerId, customer_address, restaurantId]
    );
  }
}

    // DEBUG
    dlog("POST /orders created", {
      id: order.id,
      order_type,
      table_number: effectiveTableNumber,
      total,
    });
    touch(order.id, "POST /orders create");

    if (hasItems) {
      await saveOrderItems(order.id, items);
      await updateStockForOrder(items, restaurantId, io);
      dlog("POST /orders saved items", { id: order.id, count: items.length });
    }

   await client.query("COMMIT");
touch(order.id, "POST /orders create+commit");

// ✅ Immediately notify this restaurant that a new order exists (so frontend refreshes instantly)
io.to(`restaurant_${restaurantId}`).emit("orders_updated");

if (typeof emitOrderUpdate === "function") emitOrderUpdate(io, restaurantId);

    // 📧 QR Menu customer confirmation email trigger (only once per confirmed order).
    if (isQrMenuRequest(req)) {
      const normalizedOrderType = String(order?.order_type || order_type || "").toLowerCase();
      const confirmationType =
        normalizedOrderType === "takeaway"
          ? CONFIRMATION_TYPES.PICKUP_ORDER
          : ["packet", "delivery", "online"].includes(normalizedOrderType)
            ? CONFIRMATION_TYPES.DELIVERY_ORDER
            : null;

      if (confirmationType) {
        await sendOrderCustomerConfirmationEmail({
          pool,
          restaurantId,
          orderId: Number(order.id),
          confirmationType,
          explicitCustomerEmail: normalizedCustomerEmail,
          triggeredFrom: "orders.create.qr_confirmed",
          req,
        });
      }
    }

    if (orderOrigin === QR_ORDER_ORIGIN_DELIVERY) {
      await sendDeliveryOwnerOrderNotificationEmail({
        pool,
        restaurantId,
        orderId: Number(order.id),
        explicitCustomerEmail: normalizedCustomerEmail,
        triggeredFrom: "orders.create.qr_delivery_owner",
        req,
      });
    }

    // 🔥 If the order was created WITH items, emit a full payload for auto-print
    if (hasItems) {
      try {
        const { rows: orderRows } = await pool.query(
          `SELECT id, status, table_number, order_type, total, created_at
           FROM orders
           WHERE restaurant_id = $1 AND id = $2`,
          [restaurantId, order.id]
        );

        if (orderRows.length) {
          const { rows: itemRows } = await pool.query(
            `SELECT
               oi.product_id,
               oi.unique_id,
               oi.name AS order_item_name,
               p.name  AS product_name,
               oi.quantity,
               oi.price,
               oi.extras,
               oi.note,
               oi.kitchen_status,
               oi.paid_at
             FROM order_items oi
             LEFT JOIN products p ON oi.product_id = p.id
             WHERE oi.order_id = $1
             ORDER BY oi.id ASC`,
            [order.id]
          );

          const payloadItems = itemRows.map((it) => ({
            ...it,
            name: it.order_item_name || it.product_name || "Item",
            extras:
              typeof it.extras === "string"
                ? (() => {
                    try { return JSON.parse(it.extras); } catch { return []; }
                  })()
                : (it.extras || []),
            total: (parseFloat(it.price) || 0) * (it.quantity || 1),
          }));

          const header = orderRows[0];
          const payload = {
            id: header.id,
            order_number: header.order_number ?? undefined,
            number: header.order_number ?? undefined,
            order: {
              id: header.id,
              status: header.status,
              table_number: header.table_number,
              order_type: header.order_type,
              total: header.total,
              created_at: header.created_at,
              items: payloadItems,
            },
          };

          // ✅ tenant-safe emit to correct restaurant room
          io.to(`restaurant_${restaurantId}`).emit("order_confirmed", payload);
          console.log(`🖨️ [orders] order_confirmed emitted for restaurant_${restaurantId}:`, header.id);
        }
      } catch (e) {
        console.error("❌ Failed to emit order_confirmed from POST /orders:", e);
      }
    }

    return res.json(order);
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
  const { payment_method, total, amount, item_ids } = req.body;
  const orderId = parseInt(id, 10);
  const restaurantId = req.user.restaurant_id;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const hasCreatedByColumn = await hasOrdersCreatedByColumn();

    const { rows: orderRows } = await client.query(
      `SELECT
         total,
         is_paid,
         customer_name,
         customer_phone,
         COALESCE(debt_recorded_total, 0) AS debt_recorded_total,
         table_number
       FROM orders
      WHERE restaurant_id = $1 AND id = $2
      FOR UPDATE`,
      [restaurantId, orderId]
    );
    if (!orderRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }
    const existingOrder = orderRows[0];

    const finalOrderTotal =
      total !== undefined && total !== null ? total : existingOrder.total;
    const paymentValue =
      amount !== undefined && amount !== null ? amount : finalOrderTotal;
    const amountPaid = toMoney(paymentValue);
    const recorded = toMoney(existingOrder.debt_recorded_total);
    const debtReduction =
      recorded > 0 && amountPaid > 0 ? Math.min(recorded, amountPaid) : 0;
    const nextRecordedTotal = Math.max(recorded - debtReduction, 0);
    const paidOff =
      nextRecordedTotal === 0 &&
      (recorded > 0
        ? amountPaid >= recorded
        : amountPaid >= toMoney(finalOrderTotal));

    const markDebtPaid = debtReduction > 0;

    // 1️⃣ Insert payment
    const paymentResult = await client.query(
      `INSERT INTO payments (order_id, amount, payment_method)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [orderId, amountPaid, payment_method]
    );

    // 2️⃣ Update order
    const orderResult = await client.query(
      `UPDATE orders
          SET payment_method = $1,
              total = $2,
              is_paid = $6,
              debt_recorded_total = $5,
              debt_paid_at = CASE WHEN $7 THEN NOW() ELSE debt_paid_at END
        WHERE restaurant_id = $3 AND id = $4
        RETURNING *`,
      [
        payment_method,
        finalOrderTotal,
        restaurantId,
        orderId,
        nextRecordedTotal,
        paidOff,
        markDebtPaid && nextRecordedTotal === 0,
      ]
    );

    // 3️⃣ Mark selected items as paid (or all unpaid if item_ids not provided)
    if (Array.isArray(item_ids) && item_ids.length > 0) {
      // Partial payment: mark only selected items
      const itemIds = item_ids.map(id => parseInt(id, 10)).filter(id => Number.isFinite(id));
      if (itemIds.length > 0) {
        await client.query(
          `UPDATE order_items
           SET paid_at = NOW(),
               confirmed = true
           WHERE order_id = $1 AND id = ANY($2)`,
          [orderId, itemIds]
        );
      }
    } else {
      // Full payment: mark all unpaid items
      await client.query(
        `UPDATE order_items
         SET paid_at = NOW(),
             confirmed = true
         WHERE order_id = $1 AND paid_at IS NULL`,
        [orderId]
      );
    }

    if (debtReduction > 0 && existingOrder.customer_phone) {
      await decreaseCustomerDebt(
        client,
        restaurantId,
        { phone: existingOrder.customer_phone },
        debtReduction
      );
    }

    const kitchenCheck = await client.query(
      `SELECT id, product_id, kitchen_status, paid_at
       FROM order_items
       WHERE order_id = $1`,
      [orderId]
    );

    console.log("🔍 Kitchen status after PAY:", kitchenCheck.rows);

    const orderTotalWithExtras = await computeOrderTotalWithExtras(client, orderId);
    await client.query("COMMIT");

    if (typeof emitOrderUpdate === "function") emitOrderUpdate(io, restaurantId);
    else io.to(`restaurant_${restaurantId}`).emit("orders_updated");

    emitPaymentMade(io, restaurantId, orderId, {
      payment_method,
      total: finalOrderTotal,
      amount: amountPaid,
      table_number: existingOrder.table_number ?? null,
      order_total_with_extras: orderTotalWithExtras,
    });

    console.log(`💸 [orders] payment_made emitted for restaurant_${restaurantId}, order ${orderId}`);

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



router.put("/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status, total, payment_method, payment_status, reservation_clients } = req.body; // ✅ added payment_status
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;

  // Safety check: ensure id is a valid integer
  const parsedId = Number(id);
  if (!Number.isFinite(parsedId) || parsedId <= 0) {
    return res.status(400).json({ error: "Invalid order ID" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows: existingRows } = await client.query(
      `SELECT
         total,
         is_paid,
         status,
         order_type,
         reservation_date,
         reservation_time,
         reservation_clients,
         reservation_notes,
         customer_phone,
         table_number,
         traffic_logged_at,
         payment_method AS current_payment_method,
         COALESCE(debt_recorded_total, 0) AS debt_recorded_total
       FROM orders
      WHERE id = $1 AND restaurant_id = $2
      FOR UPDATE`,
      [parsedId, restaurantId]
    );
    if (!existingRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }
    const existingOrder = existingRows[0];

    // In table QR mode, only allow status changes for the matching table
    if (req.qrTable) {
      const tokenTable = Number(req.qrTable.table_number);
      const orderTable = Number(existingOrder.table_number || 0);
      if (
        !Number.isFinite(tokenTable) ||
        !Number.isFinite(orderTable) ||
        tokenTable !== orderTable
      ) {
        await client.query("ROLLBACK");
        return res
          .status(403)
          .json({ error: "QR token does not match this table" });
      }
    }

    const normalizedStatus =
      typeof status === "string" && status.trim() !== "" ? status.trim().toLowerCase() : null;
    const normalizedPaymentStatus =
      typeof payment_status === "string" && payment_status.trim() !== ""
        ? payment_status.trim().toLowerCase()
        : null;
    const normalizedCustomerEmailFromPayload = normalizeCustomerEmail(req.body?.customer_email);
    const hasReservationClientsInPayload =
      Object.prototype.hasOwnProperty.call(req.body || {}, "reservation_clients") ||
      Object.prototype.hasOwnProperty.call(req.body || {}, "reservationClients");
    const reservationClientsRaw =
      reservation_clients ?? req.body?.reservationClients ?? null;
    let reservationClientsValue = null;
    if (hasReservationClientsInPayload) {
      if (reservationClientsRaw === null || reservationClientsRaw === "") {
        reservationClientsValue = null;
      } else {
        const parsedReservationClients = Number(reservationClientsRaw);
        if (
          !Number.isFinite(parsedReservationClients) ||
          parsedReservationClients < 0 ||
          parsedReservationClients > 500
        ) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Invalid reservation_clients" });
        }
        reservationClientsValue = Math.trunc(parsedReservationClients);
      }
    }
    const paidRequested = normalizedStatus === "paid" || normalizedPaymentStatus === "paid";
    const closedRequested = normalizedStatus === "closed";
    const existingStatus = String(existingOrder?.status || "").toLowerCase();
    const statusTransitionedToConfirmed =
      normalizedStatus === "confirmed" && existingStatus !== "confirmed";
    const statusTransitionedFromReservedToConfirmed =
      normalizedStatus === "confirmed" && existingStatus === "reserved";
    const hasReservationSignalOnOrder = Boolean(
      existingOrder?.reservation_date ||
        existingOrder?.reservation_time ||
        Number(existingOrder?.reservation_clients || 0) > 0 ||
        String(existingOrder?.reservation_notes || "").trim() ||
        String(existingOrder?.order_type || "").toLowerCase() === "reservation"
    );
    const shouldPreserveCheckedInStatusOnPaid =
      paidRequested &&
      normalizedStatus === "paid" &&
      existingStatus === "checked_in" &&
      hasReservationSignalOnOrder;
    const nextStatusForUpdate = shouldPreserveCheckedInStatusOnPaid
      ? "checked_in"
      : normalizedStatus;

    // Always persist the full order total when completing payment/closing.
    // This prevents partial-payment flows from overwriting `orders.total` and breaking reports.
    let computedTotal = null;
    if (paidRequested || closedRequested) {
      const { rows: totalRows } = await client.query(
        `
          SELECT COALESCE(SUM(COALESCE(price, 0) * COALESCE(quantity, 1)), 0) AS total
          FROM order_items
          WHERE order_id = $1
        `,
        [parsedId]
      );
      computedTotal = Number(totalRows?.[0]?.total || 0);
    }

    const nextTotal = paidRequested || closedRequested ? computedTotal : total;

    const result = await client.query(
      `UPDATE orders
       SET
         status = COALESCE($1, status),
         total = COALESCE($2, total),
         payment_method = COALESCE($3, payment_method),
         payment_status = COALESCE($4, payment_status),       -- ✅ added this
         reservation_clients = CASE
           WHEN $5::boolean THEN $6::integer
           ELSE reservation_clients
         END,
         kitchen_delivered_at = CASE
           WHEN ($1 = 'paid' OR $4 = 'paid' OR $1 = 'closed')
             THEN COALESCE(kitchen_delivered_at, NOW())
           ELSE kitchen_delivered_at
         END,
         is_paid = CASE
                     WHEN $1 = 'paid' OR $4 = 'paid' THEN true  -- ✅ support both status or payment_status
                     WHEN $1 IN ('confirmed') THEN false
                     ELSE is_paid
                   END
       WHERE id = $7 AND restaurant_id = $8
       RETURNING *`,
      [
        nextStatusForUpdate,
        nextTotal,
        payment_method,
        normalizedPaymentStatus,
        hasReservationClientsInPayload,
        reservationClientsValue,
        parsedId,
        restaurantId,
      ]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    const updatedOrder = result.rows[0];

    if (
      hasReservationClientsInPayload &&
      Number.isFinite(Number(updatedOrder?.table_number)) &&
      String(updatedOrder?.order_type || "").toLowerCase() === "table"
    ) {
      const tableNumber = Number(updatedOrder.table_number);
      try {
        const updateGuestsRes = await client.query(
          `UPDATE tables
              SET guests = $1
            WHERE restaurant_id = $2 AND number = $3`,
          [reservationClientsValue, restaurantId, tableNumber]
        );

        if (updateGuestsRes.rowCount === 0 && reservationClientsValue !== null) {
          await client.query(
            `INSERT INTO tables (restaurant_id, number, guests)
             SELECT $1, $2, $3
             WHERE NOT EXISTS (
               SELECT 1 FROM tables WHERE restaurant_id = $1 AND number = $2
             )`,
            [restaurantId, tableNumber, reservationClientsValue]
          );
        }
      } catch (tableGuestsErr) {
        console.warn("⚠️ Failed syncing table guests from order status:", tableGuestsErr.message);
      }
    }
    const becamePaid = updatedOrder.is_paid && !existingOrder.is_paid;
    const shouldLogTraffic =
      !existingOrder.traffic_logged_at &&
      (normalizedStatus === "confirmed" ||
        normalizedStatus === "paid" ||
        normalizedStatus === "closed");

    if (shouldLogTraffic && Number.isFinite(Number(existingOrder.table_number))) {
      const guests = await fetchTableGuests(client, restaurantId, existingOrder.table_number);
      if (Number.isFinite(guests) && guests > 0) {
        await logCustomerTraffic(client, {
          restaurantId,
          orderId: parsedId,
          tableNumber: existingOrder.table_number,
          delta: guests,
          source: "order_status_confirmed",
          meta: { status: normalizedStatus || null },
        });
      }
    }

    // ✅ If payment_method changed, insert a record tracking the change
    if (payment_method && payment_method !== existingOrder.current_payment_method) {
      console.log(`💾 Payment changed from "${existingOrder.current_payment_method}" to "${payment_method}"`);
      try {
        await client.query(
          `INSERT INTO payments (order_id, payment_method, previous_payment_method, amount, created_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT DO NOTHING`,
          [parsedId, payment_method, existingOrder.current_payment_method, 0]
        );
      } catch (paymentErr) {
        console.warn("⚠️  Could not insert payment change record:", paymentErr.message);
        // Don't fail the whole transaction if this fails
      }
    }

    if (becamePaid) {
      // ✅ Also mark all existing order_items as paid for this order
      try {
        await client.query(
          `UPDATE order_items
             SET paid_at = NOW(),
                 confirmed = TRUE
           WHERE order_id = $1 AND paid_at IS NULL`,
          [parsedId]
        );
      } catch (markErr) {
        console.warn("⚠️ Failed to mark order_items paid in /orders/:id/status:", markErr);
      }

      const recorded = toMoney(existingOrder.debt_recorded_total);
      const amountReference = toMoney(
        paidRequested || closedRequested
          ? computedTotal
          : total !== undefined && total !== null
            ? total
            : existingOrder.total
      );
      let reduction =
        recorded > 0
          ? amountReference > 0
            ? Math.min(recorded, amountReference)
            : recorded
          : 0;
      let nextRecorded = Math.max(recorded - reduction, 0);
      if (nextRecorded > 0 && recorded > 0) {
        reduction = recorded;
        nextRecorded = 0;
      }

      if (recorded > 0) {
        await client.query(
          `UPDATE orders
              SET debt_recorded_total = $1
            WHERE id = $2 AND restaurant_id = $3`,
          [nextRecorded, parsedId, restaurantId]
        );
      }

      if (reduction > 0 && existingOrder.customer_phone) {
        await decreaseCustomerDebt(
          client,
          restaurantId,
          { phone: existingOrder.customer_phone },
          reduction
        );
      }

      if (reduction > 0) {
        await client.query(
          `UPDATE orders
              SET debt_paid_at = NOW()
            WHERE id = $1 AND restaurant_id = $2`,
          [parsedId, restaurantId]
        );
      }
    }

    await client.query("COMMIT");

    const normalizedOrderType = String(updatedOrder?.order_type || "").toLowerCase();
    const hasReservationSchedule = Boolean(updatedOrder?.reservation_date || updatedOrder?.reservation_time);

    // 📧 Reservation confirmation is sent only when staff confirms reservation (reserved -> confirmed),
    // typically from TableOverview.
    if (
      statusTransitionedFromReservedToConfirmed &&
      (normalizedOrderType === "table" || normalizedOrderType === "reservation") &&
      hasReservationSchedule
    ) {
      await sendOrderCustomerConfirmationEmail({
        pool,
        restaurantId,
        orderId: Number(parsedId),
        confirmationType: CONFIRMATION_TYPES.TABLE_RESERVATION,
        explicitCustomerEmail: normalizedCustomerEmailFromPayload,
        triggeredFrom: "orders.status.tableoverview_confirmed",
        req,
      });
    }

    // Keep QR menu confirmation emails working both for immediate QR requests
    // and for later staff confirmations of persisted QR delivery orders.
    if ((isQrMenuRequest(req) || isQrDeliveryOrder(updatedOrder)) && statusTransitionedToConfirmed) {
      const confirmationType =
        normalizedOrderType === "takeaway"
          ? CONFIRMATION_TYPES.PICKUP_ORDER
          : ["packet", "delivery", "online"].includes(normalizedOrderType)
            ? CONFIRMATION_TYPES.DELIVERY_ORDER
            : null;

      if (confirmationType) {
        await sendOrderCustomerConfirmationEmail({
          pool,
          restaurantId,
          orderId: Number(parsedId),
          confirmationType,
          explicitCustomerEmail: normalizedCustomerEmailFromPayload,
          triggeredFrom: "orders.status.qr_confirmed",
          req,
        });
      }
    }

    io.to(`restaurant_${restaurantId}`).emit("orders_updated");
    res.json(updatedOrder);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to update order status:", err);
    res.status(500).json({ error: "Failed to update order status" });
  } finally {
    client.release();
  }
});


// POST /api/orders/:id/print - Send print request to Electron app
// Phone → Backend → Electron (Restaurant) → Printer
router.post("/:id/print", async (req, res) => {
  console.log(`🖨️  [PRINT] Incoming request for order ${req.params.id}`);
  const { id } = req.params;
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) {
    console.log(`🖨️  [PRINT] Failed to get restaurantId`);
    return;
  }

  try {
    // Fetch complete order from database with all details
    const { rows: orderRows } = await pool.query(
      `SELECT 
        o.id, 
        o.table_number, 
        o.total, 
        o.status,
        o.tax_value,
        o.discount_value,
        o.payment_method,
        o.created_at,
        o.customer_name,
        o.customer_phone,
        o.customer_address,
        o.takeaway_notes
      FROM orders o
       WHERE o.id = $1 AND o.restaurant_id = $2`,
      [id, restaurantId]
    );

    if (!orderRows.length) {
      console.log(`🖨️  [PRINT] Order ${id} not found for restaurant ${restaurantId}`);
      return res.status(404).json({ error: "Order not found" });
    }

    const order = orderRows[0];

    // Fetch all order items with their details
    const { rows: itemRows } = await pool.query(
      `SELECT 
        oi.id,
        oi.product_id,
        oi.quantity,
        oi.price,
        oi.price * oi.quantity as line_total,
        p.name as product_name,
        oi.name as item_name,
        oi.external_product_name,
        oi.extras,
        oi.note
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1
       ORDER BY oi.updated_at DESC`,
      [id]
    );

    // Format items for receipt printer
    const items = itemRows.map(item => {
      let extras = [];
      try {
        if (item.extras) {
          extras = typeof item.extras === 'string' ? JSON.parse(item.extras) : item.extras;
        }
      } catch (e) {
        console.warn(`Failed to parse extras for item ${item.id}:`, e);
      }

      return {
        id: item.id,
        product_id: item.product_id,
        name:
          item.item_name ||
          item.external_product_name ||
          item.product_name ||
          "Unknown Item",
        quantity: item.quantity,
        unit_price: item.price,
        price: item.price,
        line_total: parseFloat(item.line_total),
        total: parseFloat(item.line_total),
        extras: extras,
        note: item.note,
      };
    });

    console.log(`🖨️  [PRINT] Fetched ${items.length} items for order ${id}`);

    // Prepare print data for Electron app
    const printData = {
      orderId: order.id,
      id: order.id, // For compatibility
      tableNumber: order.table_number,
      table_number: order.table_number,
      total: order.total,
      tax_value: order.tax_value,
      discount_value: order.discount_value,
      payment_method: order.payment_method,
      status: order.status,
      created_at: order.created_at,
      customer_name: order.customer_name,
      customer_phone: order.customer_phone,
      customer_address: order.customer_address,
      takeaway_notes: order.takeaway_notes,
      items: items,
      timestamp: new Date().toISOString(),
    };

    // 🔔 Emit to Electron app for this restaurant
    // The Electron app will listen for 'print_request' on its restaurant socket
    io.to(`restaurant_${restaurantId}`).emit("print_request", {
      ...printData,
      restaurantId,
    });

    console.log(`🖨️  [PRINT] Print request sent for order ${id} at restaurant ${restaurantId}`);

    res.json({
      success: true,
      message: "Print request sent to restaurant printer",
      orderId: id,
    });
  } catch (err) {
    console.error("❌ [PRINT] Failed to send print request:", err);
    res.status(500).json({ error: "Failed to send print request" });
  }
});


// GET /api/driver-report?driver_id=1&date=YYYY-MM-DD
router.get("/driver-report", async (req, res) => {
  const { driver_id, date } = req.query;
  if (!driver_id || !date) {
    return res.status(400).json({ error: "driver_id and date are required" });
  }

  try {
    const restaurantId = await requireRestaurantId(req, res);
    if (!restaurantId) return;
    const ordersRes = await pool.query(
      `
        SELECT
          o.id,
          o.payment_method,
          o.status,
          o.driver_status,
          o.created_at,
          o.picked_up_at,
          o.delivered_at,
          o.kitchen_delivered_at,
          o.customer_name,
          o.customer_address,
          COALESCE(
            SUM(
              COALESCE(oi.price::numeric, 0) * COALESCE(oi.quantity::numeric, 0)
            ),
            0
          ) AS total,
          CASE
            WHEN o.picked_up_at IS NOT NULL AND o.delivered_at IS NOT NULL
              THEN EXTRACT(EPOCH FROM (o.delivered_at - o.picked_up_at))
            ELSE NULL
          END AS delivery_time_seconds,
          CASE
            WHEN o.kitchen_delivered_at IS NOT NULL AND o.delivered_at IS NOT NULL
              THEN EXTRACT(EPOCH FROM (o.delivered_at - o.kitchen_delivered_at))
            ELSE NULL
          END AS kitchen_to_delivery_seconds
        FROM orders o
        LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE o.restaurant_id = $1
          AND o.driver_id = $2
          AND o.delivered_at::date = $3::date
          AND o.driver_status = 'delivered'
          AND o.status = 'closed'
        GROUP BY o.id
        ORDER BY o.delivered_at ASC
      `,
      [restaurantId, driver_id, date]
    );
    const orders = ordersRes.rows.map((row) => ({
      ...row,
      total: Number(row.total || 0),
      delivery_time_seconds:
        row.delivery_time_seconds == null ? null : Number(row.delivery_time_seconds),
      kitchen_to_delivery_seconds:
        row.kitchen_to_delivery_seconds == null ? null : Number(row.kitchen_to_delivery_seconds),
    }));

    let total_sales = 0;
    const sales_by_method = {};
    const order_details = [];
    for (const order of orders) {
      const orderTotal = Number(order.total || 0);
      total_sales += orderTotal;
      order_details.push(order);
      if (order.payment_method) {
        sales_by_method[order.payment_method] =
          (sales_by_method[order.payment_method] || 0) + orderTotal;
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

router.get("/debt/find", async (req, res) => {
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;
  const phone = (req.query.phone || req.query.customer_phone || "").trim();
  if (!phone) {
    return res.status(400).json({ error: "customer_phone is required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT
          id,
          table_number,
          status,
          total,
          order_type,
          created_at,
          updated_at,
          customer_name,
          customer_phone,
          COALESCE(debt_recorded_total, 0) AS debt_recorded_total
         FROM orders
        WHERE restaurant_id = $1
          AND customer_phone = $2
          AND status = 'closed'
          AND COALESCE(is_paid, false) = false
          AND COALESCE(debt_recorded_total, 0) > 0
        ORDER BY updated_at DESC NULLS LAST, id DESC`,
      [restaurantId, phone]
    );
    if (!rows.length) return res.json({ orders: [], total_debt: 0 });
    const normalized = rows.map((row) => ({
      ...row,
      debt_recorded_total: Number(row.debt_recorded_total || 0),
    }));
    const totalDebt = normalized.reduce(
      (sum, order) => sum + (order.debt_recorded_total || 0),
      0
    );
    res.json({ orders: normalized, total_debt: totalDebt });
  } catch (err) {
    console.error("❌ Failed to find debt order:", err);
    res.status(500).json({ error: "Failed to find debt order" });
  }
});


// POST order items (with upsert for existing items)
router.post("/order-items", async (req, res) => {
  const { order_id, items, receipt_id } = req.body;
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;

  // If this request comes from a table QR token, make sure the order
  // really belongs to that table in this restaurant.
  if (req.qrTable) {
    try {
      const { rows } = await pool.query(
        `SELECT table_number, order_type
         FROM orders
         WHERE id = $1 AND restaurant_id = $2`,
        [order_id, restaurantId]
      );
      const dbTable = rows.length
        ? Number(rows[0].table_number || 0)
        : null;
      const orderType = rows.length ? String(rows[0].order_type || "") : "";
      const tokenTable = Number(req.qrTable.table_number);
      if (!rows.length || !Number.isFinite(dbTable)) {
        return res.status(404).json({ error: "Order not found" });
      }
      if (!Number.isFinite(tokenTable) || dbTable !== tokenTable) {
        return res
          .status(403)
          .json({ error: "QR token does not match this table" });
      }
      if (orderType.toLowerCase() === "table") {
        const allowed = await enforceTableGeo(req, res, restaurantId);
        if (!allowed) return;
      }
    } catch (err) {
      console.error(
        "❌ Failed to verify table ownership for /orders/order-items:",
        err
      );
      return res
        .status(500)
        .json({ error: "Failed to verify table ownership" });
    }
  }

  const preparedItems = items.map((item, idx) => {

    return {
      ...item,
      receipt_id: item.receipt_id || receipt_id || null,
      kitchen_status: item.confirmed && !item.paid_at ? 'new' : item.kitchen_status || null // ✅ only if confirmed and not yet paid
    };
  });

  try {
    await saveOrderItems(order_id, preparedItems);
    await updateStockForOrder(preparedItems, restaurantId, io);
    // Ensure `orders.total` stays in sync (reports rely on it).
    // Many flows create orders with total=0 and only add items later.
    await pool.query(
      `
        UPDATE orders
           SET total = (
             SELECT COALESCE(SUM(COALESCE(price, 0) * COALESCE(quantity, 1)), 0)
             FROM order_items
             WHERE order_id = $2
           )
         WHERE restaurant_id = $1 AND id = $2
      `,
      [restaurantId, order_id]
    );
     // --- ADD THIS BLOCK:
    const orderRes = await pool.query(
      "SELECT status, is_paid FROM orders WHERE restaurant_id = $1 AND id = $2",
      [restaurantId, order_id]
    );
    const currentStatus = String(orderRes.rows[0]?.status || "").toLowerCase();
    const hasNewUnpaidItems = preparedItems.some(
      (it) => !(it && it.paid_at) && !(it && it.receipt_id)
    );

    // If adding new unpaid items to an order that was fully paid before, reopen it.
    // This happens when a QR pre-order customer taps "order another" and appends items.
    if (currentStatus === "paid" && hasNewUnpaidItems) {
      await pool.query(
        "UPDATE orders SET status = 'confirmed', is_paid = false WHERE restaurant_id = $1 AND id = $2",
        [restaurantId, order_id]
      );
    } else if (["closed", "pending", "open"].includes(currentStatus)) {
      await pool.query(
        "UPDATE orders SET status = 'confirmed' WHERE restaurant_id = $1 AND id = $2",
        [restaurantId, order_id]
      );
    }

// ✅ Emit update immediately after writes complete for faster UI status/color refresh.
io.to(`restaurant_${restaurantId}`).emit("orders_updated");

// ✅ Build payload after writes — full and fresh
try {
  const payload = await buildFullOrderPayload(order_id, restaurantId);

  // Emit detailed payload (table/order metadata) for instant local patching on clients.
  io.to(`restaurant_${restaurantId}`).emit("order_confirmed", payload);

  console.log(
    `🖨️ [orders] order_confirmed emitted after saveOrderItems for restaurant_${restaurantId}, order ${order_id}`
  );
} catch (e) {
  console.error("❌ Failed to emit order_confirmed after /order-items:", e);
}

res.json({ message: "Order items saved successfully" });



  } catch (err) {
    console.error("❌ Error saving order items:", err);
    res.status(500).json({ error: "Failed to save order items" });
  }
});

router.get("/:id/payments", async (req, res) => {
  const { id } = req.params;
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;
  try {
    const { rows } = await pool.query(
      `SELECT
          p.id,
          p.amount,
          p.payment_method,
          p.previous_payment_method,
          p.created_at
       FROM payments p
       JOIN orders o ON o.id = p.order_id
      WHERE p.order_id = $1
        AND o.restaurant_id = $2
      ORDER BY p.created_at ASC`,
      [id, restaurantId]
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ Failed to fetch order payments:", err);
    res.status(500).json({ error: "Failed to fetch order payments" });
  }
});


async function saveOrderItems(orderId, items) {
  for (const item of items) {
    const extrasString = JSON.stringify(item.extras || []);
    const unique_id = item.unique_id || uuidv4();

    // ensure inserts finish before continuing
    const existing = await pool.query(
      "SELECT id FROM order_items WHERE unique_id = $1 AND order_id = $2",
      [unique_id, orderId]
    );

    if (existing.rowCount > 0) {
      await pool.query(
        "UPDATE order_items SET discount_type=$1, discount_value=$2, price=$3, quantity=$4 WHERE id=$5",
        [
          item.discountType || null,
          item.discountValue || 0,
          parseFloat(item.price) || 0,
          item.quantity || 1,
          existing.rows[0].id,
        ]
      );
      continue;
    }

    // ✅ Await each insert fully
    await pool.query(
      `INSERT INTO order_items (
        order_id, product_id, quantity, price,
        ingredients, extras, unique_id,
        confirmed, kitchen_status, payment_method, receipt_id, note,
        discount_type, discount_value,
        external_product_id, external_product_name, name
      )
      VALUES (
        $1,$2,$3,$4,
        $5::jsonb,$6::jsonb,$7,
        $8,$9,$10,$11,$12,
        $13,$14,
        $15,$16,$17
      )`,
      [
        orderId,
        Number(item.product_id) || null,
        item.quantity || 1,
        parseFloat(item.price) || 0,
        JSON.stringify(item.ingredients || []),
        extrasString,
        unique_id,
        true,
        item.kitchen_status || "new",
        item.payment_method || null,
        item.receipt_id || null,
        item.note || null,
        item.discountType || null,
        item.discountValue || 0,
        item.product_id || null,
        item.name || null,
        item.name || null,
      ]
    );
  }

  // No artificial delay: caller emits updates immediately after writes complete.
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


router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { total, payment_method, driver_id, receipt_id, changed_by } = req.body;

  let _payment_method = payment_method;

  // --- Normalize payment_method safely ---
  if (_payment_method && Array.isArray(_payment_method)) {
    _payment_method =
      _payment_method[0]?.payment_method ||
      _payment_method[0] ||
      null;
  } else if (
    _payment_method &&
    typeof _payment_method === "object" &&
    _payment_method !== null
  ) {
    _payment_method = _payment_method.payment_method || null;
  }

  // Always cast to string if defined
  if (_payment_method !== null && _payment_method !== undefined) {
    _payment_method = String(_payment_method).trim();
  }

  try {
    // 1️⃣ Get current payment_method for change log
    let old_method;
    let old_driver_id;
    if (payment_method !== undefined || driver_id !== undefined) {
      const oldOrder = await pool.query(
        "SELECT payment_method, driver_id FROM orders WHERE restaurant_id = $1 AND id = $2",
        [req.user.restaurant_id, id]
      );
      old_method = oldOrder.rows[0]?.payment_method;
      old_driver_id = oldOrder.rows[0]?.driver_id;
    }

    // 2️⃣ Build SET clause dynamically
    let setClauses = [];
    let params = [];
    let idx = 1;

    if (total !== undefined) {
      setClauses.push(`total = $${idx++}`);
      params.push(total);
    }

    if (_payment_method) {
      setClauses.push(`payment_method = $${idx++}::text`);
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

    // 3️⃣ Add restaurant_id + id at end
   // 3️⃣ Add restaurant_id and id at the END, not start
params.push(req.user.restaurant_id); // now this will always be the last -1 param
params.push(id);                     // and this will be the last param index

// Calculate actual indexes properly
const restaurantIdx = params.length - 1;
const idIdx = params.length;

const result = await pool.query(
  `UPDATE orders
   SET ${setClauses.join(", ")}
   WHERE restaurant_id = $${restaurantIdx} AND id = $${idIdx}
   RETURNING *`,
  params
);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    const updatedOrder = result.rows[0];

    // 5️⃣ Log payment change (optional)
    if (
      _payment_method !== undefined &&
      old_method !== undefined &&
      _payment_method !== old_method
    ) {
      await pool.query(
        `INSERT INTO payment_method_changes (order_id, old_method, new_method, changed_by, changed_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [id, old_method, _payment_method, changed_by || req.user?.username || "system"]
      );
    }

    // 6️⃣ Emit update to frontend
    setTimeout(() => emitOrderUpdate(req.app.get("io")), 250);

    if (
      driver_id !== undefined &&
      Number(old_driver_id || 0) !== Number(updatedOrder.driver_id || 0) &&
      updatedOrder.driver_id
    ) {
      let driverName = null;
      try {
        const driverRes = await pool.query(
          "SELECT name FROM staff WHERE id = $1",
          [updatedOrder.driver_id]
        );
        const row = driverRes.rows[0];
        driverName = row?.name || null;
      } catch (err) {
        console.warn("⚠️ Failed to fetch driver name for notification:", err);
      }

      const ioRef = req.app.get("io");
      if (ioRef) {
        const payload = {
          driverId: updatedOrder.driver_id,
          driverName,
        };
        emitDriverAssigned(ioRef, req.user.restaurant_id, updatedOrder.id, payload);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Failed to update order:", err);
    res.status(500).json({ error: "Update failed" });
  }
});




// POST /orders/:id/close
router.post("/:id/close", async (req, res) => {
  const { id } = req.params;
  const restaurantId = req.user.restaurant_id;
  const preserveReservationCheckoutBadge =
    req.body?.preserve_reservation_checkout_badge === true ||
    String(req.query?.preserve_reservation_checkout_badge || "").trim() === "1";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT
         id,
         status,
         order_type,
         total,
         is_paid,
         table_number,
         customer_name,
         customer_phone,
         kitchen_delivered_at,
         external_source,
         payment_method,
         reservation_date,
         reservation_time,
         reservation_clients,
         reservation_notes,
         COALESCE(debt_recorded_total, 0) AS debt_recorded_total
       FROM orders
      WHERE restaurant_id = $1 AND id = $2
      FOR UPDATE`,
      [restaurantId, id]
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    const existing = rows[0];
    if (existing.status === "closed") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Order already closed" });
    }

    // Check if kitchen has delivered the order. If the order-level flag isn't set,
    // fall back to item-level kitchen_status (some setups mark items but not order flag).
    let kitchenDelivered = Boolean(existing.kitchen_delivered_at);
    console.log(`🔍 [Order ${id}] Order-level kitchen_delivered_at: ${existing.kitchen_delivered_at} (delivered=${kitchenDelivered})`);
    
    if (!kitchenDelivered) {
      try {
        const safeParseArray = (value) => {
          if (!value) return [];
          if (Array.isArray(value)) return value;
          if (typeof value === "string") {
            try {
              const parsed = JSON.parse(value);
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          }
          return [];
        };

        const { rows: settingsRows } = await client.query(
          `SELECT excluded_categories, excluded_items
             FROM kitchen_compile_settings
            WHERE restaurant_id = $1
            ORDER BY id
            LIMIT 1`,
          [restaurantId]
        );

        const excludedCategoriesRaw = safeParseArray(settingsRows[0]?.excluded_categories);
        const excludedItemsRaw = safeParseArray(settingsRows[0]?.excluded_items);
        const excludedCategories = new Set(
          excludedCategoriesRaw.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
        );
        const excludedItems = new Set(
          excludedItemsRaw
            .map((value) => {
              if (value === null || value === undefined || value === "") return null;
              const num = Number(value);
              if (Number.isFinite(num)) return String(num);
              return String(value).trim();
            })
            .filter(Boolean)
        );

        const itemsRes = await client.query(
          `SELECT
             oi.id,
             oi.kitchen_status,
             oi.product_id,
             p.category AS product_category
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN products p ON p.id = oi.product_id
           WHERE o.restaurant_id = $1 AND oi.order_id = $2`,
          [restaurantId, id]
        );
        const items = (itemsRes.rows || []).filter((row) => {
          const category = String(row.product_category || "").trim().toLowerCase();
          const productId = row.product_id === null || row.product_id === undefined ? "" : String(row.product_id).trim();
          if (category && excludedCategories.has(category)) return false;
          if (productId && excludedItems.has(productId)) return false;
          return true;
        });
        console.log(
          `🍽️ [Order ${id}] Found ${items.length} relevant items:`,
          items.map((it) => ({ id: it.id, kitchen_status: it.kitchen_status }))
        );
        
        // If there are NO items, allow close (empty order or items not tracked)
        if (items.length === 0) {
          console.log(`✅ [Order ${id}] No items found - allowing close`);
          kitchenDelivered = true;
        } else if (items.length > 0) {
          const allReady = items.every((it) => {
            const s = (it.kitchen_status || "").toString().toLowerCase();
            const ready = s === "delivered" || s === "ready" || s === "packet_delivered";
            console.log(`   - Item ${it.id}: status="${it.kitchen_status}" → normalized="${s}" → ready=${ready}`);
            return ready;
          });
          console.log(`✅ [Order ${id}] All items ready? ${allReady}`);
          if (allReady) kitchenDelivered = true;
        }
      } catch (err) {
        // If item-level check fails, fall back to strict order flag behavior
        console.error("⚠️ Failed to read order items while checking kitchen delivery:", err);
      }
    }

    if (!kitchenDelivered) {
      await client.query("ROLLBACK");
      console.log(`❌ [Order ${id}] Kitchen NOT delivered. Rejecting close.`);
      return res.status(409).json({ error: "Order still preparing. Kitchen must deliver first!" });
    }
    console.log(`✅ [Order ${id}] Kitchen delivered. Proceeding with close.`);

    // Keep totals consistent for reports even when some items never hit the kitchen UI.
    const { rows: totalRows } = await client.query(
      `
        SELECT COALESCE(SUM(COALESCE(price, 0) * COALESCE(quantity, 1)), 0) AS total
        FROM order_items
        WHERE order_id = $1
      `,
      [id]
    );
    const totalNow = toMoney(totalRows?.[0]?.total || 0);
    const recorded = toMoney(existing.debt_recorded_total);
    const delta = existing.is_paid ? 0 : toMoney(totalNow - recorded);
    const needsDebtAdjustment = delta !== 0 && !existing.is_paid;
    
    // External orders (migros/yemeksepeti/etc) are prepaid, skip phone validation
    const isExternalOrder = Boolean(existing.external_source);

    if (needsDebtAdjustment && !isExternalOrder) {
      const phoneOk = (existing.customer_phone || "").trim();
      if (!phoneOk) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Customer phone is required before closing an unpaid order.",
        });
      }
      if (delta > 0) {
        const nameOk = (existing.customer_name || "").trim();
        if (!nameOk) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Customer name is required before adding unpaid debt.",
          });
        }
      }
    }

    const updated = await client.query(
      `UPDATE orders
          SET status = 'closed',
              total = $3,
              kitchen_delivered_at = COALESCE(kitchen_delivered_at, NOW()),
              cancellation_reason = NULL,
              debt_recorded_total = $4
        WHERE restaurant_id = $1 AND id = $2
        RETURNING *`,
      [restaurantId, id, totalNow, existing.is_paid ? recorded : totalNow]
    );

    const order = updated.rows[0];
    let reservationClearedOrder = null;
    let reservationCheckedOutPayload = null;
    const hadReservationContext = Boolean(
      existing?.reservation_date ||
        existing?.reservation_time ||
        existing?.reservation_clients ||
        existing?.reservation_notes ||
        String(existing?.order_type || "").toLowerCase() === "reservation" ||
        ["reserved", "checked_in"].includes(String(existing?.status || "").toLowerCase())
    );
    const shouldClearReservationOnClose =
      hadReservationContext &&
      (
        String(existing?.status || "").toLowerCase() === "checked_in" ||
        preserveReservationCheckoutBadge
      );

    if (shouldClearReservationOnClose) {
      const clearedReservationResult = await client.query(
        `UPDATE orders
            SET reservation_date = NULL,
                reservation_time = NULL,
                reservation_clients = NULL,
                reservation_notes = NULL,
                order_type = CASE
                  WHEN LOWER(COALESCE(order_type, '')) = 'reservation' THEN 'table'
                  ELSE order_type
                END,
                updated_at = NOW()
          WHERE restaurant_id = $1 AND id = $2
          RETURNING id, table_number, status, order_type, cancellation_reason`,
        [restaurantId, id]
      );
      reservationClearedOrder = clearedReservationResult.rows[0] || null;
      if (preserveReservationCheckoutBadge) {
        reservationCheckedOutPayload = {
          reservation_id: Number(existing.id),
          order_id: Number(existing.id),
          table_number: existing.table_number,
          status: "checked_out",
          order_type: "reservation",
          reservation_date: existing.reservation_date,
          reservation_time: existing.reservation_time,
          reservation_clients: existing.reservation_clients,
          reservation_notes: existing.reservation_notes,
          customer_name: existing.customer_name || null,
          customer_phone: existing.customer_phone || null,
          checked_out_at: new Date().toISOString(),
        };
      }
    }

    await cancelLinkedConcertBookings(client, restaurantId, id, {
      cancellationReason: "linked_order_closed",
    });

    if (needsDebtAdjustment) {
      if (delta > 0) {
        await increaseCustomerDebt(
          client,
          restaurantId,
          { name: existing.customer_name, phone: existing.customer_phone },
          delta
        );
      } else if (delta < 0) {
        await decreaseCustomerDebt(
          client,
          restaurantId,
          { phone: existing.customer_phone },
          Math.abs(delta)
        );
      }
    }

    await client.query("COMMIT");

    io.to(`restaurant_${restaurantId}`).emit("order_closed", { orderId: Number(order.id) });
    if (reservationClearedOrder) {
      const reservationPayload = {
        reservation_id: reservationClearedOrder.id,
        order_id: reservationClearedOrder.id,
        table_number: reservationClearedOrder.table_number,
        status: reservationClearedOrder.status,
        order_type: reservationClearedOrder.order_type,
        cancellation_reason: reservationClearedOrder.cancellation_reason || null,
      };
      io.to(`restaurant_${restaurantId}`).emit("reservation_cancelled", reservationPayload);
      io.to(`restaurant_${restaurantId}`).emit("reservation_deleted", reservationPayload);
      if (reservationCheckedOutPayload) {
        io.to(`restaurant_${restaurantId}`).emit(
          "reservation_checked_out",
          reservationCheckedOutPayload
        );
      }
    }
    res.json({
      message: needsDebtAdjustment
        ? delta > 0
          ? "✅ Order closed and debt recorded"
          : "✅ Order closed and debt adjusted"
        : "✅ Order closed",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Error in closing order:", err);
    res.status(500).json({ error: "Failed to close order" });
  } finally {
    client.release();
  }
});

router.patch("/:id/cancel", async (req, res) => {
  const { id } = req.params;
  const orderId = Number(id);
  if (!Number.isFinite(orderId)) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  const restaurantId = await requireRestaurantId(req);
  if (!restaurantId) return;

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  const requestedItemsMap = new Map(); // unique_id -> requestedQty (null => full row)

  for (const entry of rawItems) {
    if (!entry) continue;
    if (typeof entry === "string") {
      const key = entry.trim();
      if (!key) continue;
      if (!requestedItemsMap.has(key)) requestedItemsMap.set(key, null);
      continue;
    }
    if (typeof entry === "object") {
      const uniqueId = String(entry.unique_id || entry.uniqueId || "").trim();
      if (!uniqueId) continue;
      const qtyRaw = entry.quantity ?? entry.qty ?? null;
      const qty = qtyRaw === null || qtyRaw === undefined ? null : Number(qtyRaw);
      const normalizedQty = Number.isFinite(qty) ? Math.max(1, Math.floor(qty)) : null;

      const prev = requestedItemsMap.get(uniqueId);
      if (prev === null) continue; // already requested "full row"
      if (normalizedQty === null) {
        requestedItemsMap.set(uniqueId, null);
      } else {
        requestedItemsMap.set(uniqueId, (prev || 0) + normalizedQty);
      }
    }
  }

  const requestedItems = Array.from(requestedItemsMap.entries()).map(([unique_id, quantity]) => ({
    unique_id,
    quantity, // null => full row
  }));

  if (requestedItems.length > 0) {
    const cancellationColumns = await getOrderItemsCancellationColumns();
    const cancelPredicate = cancellationColumns.hasCancelledAt
      ? "cancelled_at IS NULL"
      : "COALESCE(kitchen_status, '') <> 'cancelled'";

    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");

      const { rows: orderRows } = await client.query(
        `SELECT id, total, status, order_type, order_origin
         FROM orders
         WHERE restaurant_id = $1 AND id = $2
         FOR UPDATE`,
        [restaurantId, orderId]
      );

      if (!orderRows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Order not found" });
      }

      if (orderRows[0].status === "cancelled") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Order already cancelled" });
      }

      const requestedUniqueIds = requestedItems.map((i) => i.unique_id);
      const { rows: itemsRows } = await client.query(
        `SELECT
           id,
           unique_id,
           order_id,
           product_id,
           quantity,
           price,
           ingredients,
           extras,
           confirmed,
           payment_method,
           receipt_id,
           note,
           discount_type,
           discount_value,
           external_product_id,
           external_product_name,
           name,
           kitchen_status,
           paid_at
         FROM order_items
         WHERE order_id = $1
           AND unique_id = ANY($2::text[])
           AND ${cancelPredicate}
         FOR UPDATE`,
        [orderId, requestedUniqueIds]
      );

      if (!itemsRows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "No matching items found" });
      }

      const requestedQtyByUniqueId = new Map(requestedItems.map((it) => [it.unique_id, it.quantity]));

      let totalReduction = 0;
      const cancelledItemIds = [];

      for (const row of itemsRows) {
        const rowQty = Number(row.quantity) || 0;
        if (rowQty <= 0) continue;

        const requestedQty = requestedQtyByUniqueId.get(row.unique_id);
        const cancelQty = requestedQty === null || requestedQty === undefined
          ? rowQty
          : Math.min(rowQty, Math.max(1, Number(requestedQty) || 1));

        totalReduction += toMoney(parseFloat(row.price) || 0) * cancelQty;

        if (cancelQty >= rowQty) {
          cancelledItemIds.push(row.id);
          continue;
        }

        // Partial cancel: split the line item.
        const remainingQty = rowQty - cancelQty;
        await client.query(
          `UPDATE order_items
              SET quantity = $1
            WHERE id = $2`,
          [remainingQty, row.id]
        );

        const newUniqueId = uuidv4();
        const cancelledAt = cancellationColumns.hasCancelledAt ? "NOW()" : "NULL";
        const cancellationReasonValue = cancellationColumns.hasCancellationReason ? "NULLIF($18, '')" : "NULL";

        const insertCols = [
          "order_id",
          "product_id",
          "quantity",
          "price",
          "ingredients",
          "extras",
          "unique_id",
          "confirmed",
          "kitchen_status",
          "payment_method",
          "receipt_id",
          "note",
          "discount_type",
          "discount_value",
          "external_product_id",
          "external_product_name",
          "name",
          "paid_at",
        ];

        if (cancellationColumns.hasCancelledAt) insertCols.push("cancelled_at");
        if (cancellationColumns.hasCancellationReason) insertCols.push("cancellation_reason");

        const baseValuesSql = [
          "$1", "$2", "$3", "$4",
          "$5::jsonb", "$6::jsonb", "$7",
          "$8", "$9", "$10", "$11", "$12",
          "$13", "$14", "$15", "$16", "$17", "$18",
        ];

        const insertValuesSql = [...baseValuesSql];
        const params = [
          row.order_id,
          row.product_id,
          cancelQty,
          parseFloat(row.price) || 0,
          typeof row.ingredients === "string"
            ? row.ingredients
            : JSON.stringify(row.ingredients || []),
          typeof row.extras === "string" ? row.extras : JSON.stringify(row.extras || []),
          newUniqueId,
          row.confirmed ?? true,
          "cancelled",
          row.payment_method || null,
          row.receipt_id || null,
          row.note || null,
          row.discount_type || null,
          row.discount_value || 0,
          row.external_product_id || null,
          row.external_product_name || null,
          row.name || null,
          row.paid_at || null,
        ];

        if (cancellationColumns.hasCancelledAt) insertValuesSql.push(cancelledAt);
        if (cancellationColumns.hasCancellationReason) {
          insertValuesSql.push("NULLIF($19, '')");
          params.push(reason);
        }

        const { rows: inserted } = await client.query(
          `INSERT INTO order_items (${insertCols.join(", ")})
           VALUES (${insertValuesSql.join(", ")})
           RETURNING id`,
          params
        );
        const insertedId = inserted?.[0]?.id;
        if (insertedId) cancelledItemIds.push(insertedId);
      }

      const updatedTotal = Math.max(
        0,
        toMoney(orderRows[0].total || 0) - toMoney(totalReduction)
      );

      if (cancelledItemIds.length > 0) {
        const updateColumns = ["kitchen_status = 'cancelled'"];
        const updateParams = [];
        let paramIdx = 1;

        if (cancellationColumns.hasCancelledAt) {
          updateColumns.push("cancelled_at = NOW()");
        }
        if (cancellationColumns.hasCancellationReason) {
          updateColumns.push(`cancellation_reason = NULLIF($${paramIdx++}, '')`);
          updateParams.push(reason);
        }

        const itemIdsParam = `$${paramIdx++}`;
        updateParams.push(cancelledItemIds);

        await client.query(
          `UPDATE order_items
             SET ${updateColumns.join(", ")}
           WHERE id = ANY(${itemIdsParam}::int[])`,
          updateParams
        );
      }

      await client.query(
        `UPDATE orders
           SET total = $1
         WHERE restaurant_id = $2 AND id = $3`,
        [updatedTotal, restaurantId, orderId]
      );

      const { rows: remainingRows } = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM order_items
         WHERE order_id = $1
           AND ${cancellationColumns.hasCancelledAt ? "cancelled_at IS NULL" : "COALESCE(kitchen_status, '') <> 'cancelled'"}`,
        [orderId]
      );
      const remainingCount = Number(remainingRows[0]?.count ?? 0);
      let orderNowCancelled = false;
      let orderTableNumber = null;

      const { rows: tableRows } = await client.query(
        "SELECT table_number FROM orders WHERE restaurant_id = $1 AND id = $2",
        [restaurantId, orderId]
      );
      orderTableNumber = tableRows?.[0]?.table_number ?? null;

      if (remainingCount === 0) {
        await client.query(
          `UPDATE orders
             SET status = 'cancelled',
                 cancellation_reason = NULLIF($1, cancellation_reason),
                 cancelled_at = NOW()
           WHERE restaurant_id = $2 AND id = $3`,
          [reason, restaurantId, orderId]
        );
        orderNowCancelled = true;
      }

      await client.query("COMMIT");

      const ioRef = req.app.get("io");
      ioRef && ioRef.to(`restaurant_${restaurantId}`).emit("orders_updated");
      if (orderNowCancelled) {
        ioRef &&
          emitOrderCancelled(ioRef, restaurantId, orderId, {
            table_number: orderTableNumber,
            reason,
          });
      }

      const externalSync = orderNowCancelled
        ? await sendExternalOrderRejection({ orderId, reason })
        : { skipped: true, reason: "order_not_cancelled" };

      if (
        orderNowCancelled &&
        isQrDeliveryOrder(orderRows[0]) &&
        ["packet", "delivery", "online"].includes(String(orderRows[0]?.order_type || "").toLowerCase())
      ) {
        await sendOrderCustomerCancellationEmail({
          pool,
          restaurantId,
          orderId,
          confirmationType: CONFIRMATION_TYPES.DELIVERY_ORDER_CANCELLED,
          triggeredFrom: "orders.cancel.partial.qr_delivery",
          req,
        });
      }

      return res.json({
        ok: true,
        partial: true,
        orderCancelled: orderNowCancelled,
        itemsCancelled: cancelledItemIds.length,
        remainingCount,
        newTotal: updatedTotal,
        externalSync,
      });
    } catch (err) {
      if (client) await client.query("ROLLBACK");
      console.error("❌ Failed to cancel selected items:", err);
      return res.status(500).json({ error: "Failed to cancel selected items" });
    } finally {
      if (client) client.release();
    }
  }

  try {
    const { rows } = await pool.query(
      `UPDATE orders
       SET status = 'cancelled',
             cancellation_reason = NULLIF($1, ''),
             cancelled_at = NOW()
       WHERE restaurant_id = $2 AND id = $3 AND status <> 'cancelled'
       RETURNING id, table_number, order_type, order_origin`,
      [reason, restaurantId, orderId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Order not found or already cancelled" });
    }

    const ioRef = req.app.get("io");
    if (ioRef) {
      emitOrderCancelled(ioRef, restaurantId, orderId, {
        table_number: rows[0]?.table_number ?? null,
        reason,
      });
    }

    const externalSync = await sendExternalOrderRejection({ orderId, reason });
    if (
      isQrDeliveryOrder(rows[0]) &&
      ["packet", "delivery", "online"].includes(String(rows[0]?.order_type || "").toLowerCase())
    ) {
      await sendOrderCustomerCancellationEmail({
        pool,
        restaurantId,
        orderId,
        confirmationType: CONFIRMATION_TYPES.DELIVERY_ORDER_CANCELLED,
        triggeredFrom: "orders.cancel.full.qr_delivery",
        req,
      });
    }
    return res.json({
      ok: true,
      orderId,
      orderCancelled: true,
      partial: false,
      externalSync,
    });
  } catch (err) {
    console.error("❌ Failed to cancel order:", err);
    res.status(500).json({ error: "Failed to cancel order" });
  }
});

router.post("/:id/add-debt", async (req, res) => {
  const { id } = req.params;
  const restaurantId = req.user.restaurant_id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const payload = req.body || {};
    const inputName = (payload.customer_name || "").trim();
    const inputPhone = (payload.customer_phone || "").trim();

    const { rows } = await client.query(
      `SELECT
         id,
         total,
         status,
         is_paid,
         table_number,
         customer_name,
         customer_phone,
         COALESCE(debt_recorded_total, 0) AS debt_recorded_total
       FROM orders
      WHERE restaurant_id = $1 AND id = $2
      FOR UPDATE`,
      [restaurantId, id]
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    const existing = rows[0];
    if (existing.is_paid) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Paid orders cannot be added to debt" });
    }

    let customerName = (existing.customer_name || "").trim();
    let customerPhone = (existing.customer_phone || "").trim();

    if (!customerName && inputName) customerName = inputName;
    if (!customerPhone && inputPhone) customerPhone = inputPhone;

    if (!customerPhone) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Customer phone is required to track debt" });
    }
    if (!customerName) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Customer name is required to track debt" });
    }

    const currentTotal = toMoney(existing.total);
    const recorded = toMoney(existing.debt_recorded_total);
    const requestedAmount = toMoney(payload.amount);
    let delta = currentTotal - recorded;
    if (requestedAmount > 0) {
      delta = requestedAmount;
    }

    if (delta <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No remaining balance to add to debt" });
    }

    await increaseCustomerDebt(
      client,
      restaurantId,
      { name: customerName, phone: customerPhone },
      delta
    );

    const newRecordedTotal = recorded + delta;
    const orderItemsQuery = `
      SELECT oi.kitchen_status,
             oi.product_id,
             COALESCE(p.category, '') AS product_category
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id AND o.restaurant_id = $1
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $2`;

    const kitchenSettingsQuery = `
      SELECT excluded_items, excluded_categories
      FROM kitchen_compile_settings
      WHERE restaurant_id = $1
      ORDER BY id DESC
      LIMIT 1`;

    const safeParseArray = (value) => {
      if (!value) return [];
      if (Array.isArray(value)) return value;
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return [];
        }
      }
      return [];
    };

    const [itemsResult, settingsResult] = await Promise.all([
      client.query(orderItemsQuery, [restaurantId, id]),
      client.query(kitchenSettingsQuery, [restaurantId]),
    ]);

    const excludedCategoriesRaw = safeParseArray(settingsResult.rows[0]?.excluded_categories);
    const excludedItemsRaw = safeParseArray(settingsResult.rows[0]?.excluded_items);

    const excludedCategories = new Set(
      excludedCategoriesRaw
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const excludedItems = new Set(
      excludedItemsRaw
        .map((value) => {
          if (value === null || value === undefined || value === "") return null;
          const normalized = Number.isFinite(Number(value))
            ? String(Number(value))
            : String(value).trim();
          return normalized;
        })
        .filter(Boolean)
    );

    const relevantItems = (itemsResult.rows || []).filter((row) => {
      const category = String(row.product_category || "").trim().toLowerCase();
      const productId =
        row.product_id === null || row.product_id === undefined
          ? ""
          : String(row.product_id).trim();
      if (category && excludedCategories.has(category)) return false;
      if (productId && excludedItems.has(productId)) return false;
      return true;
    });

    const hasUndelivered = relevantItems.some((row) => {
      const status = String(row.kitchen_status || "").trim().toLowerCase();
      if (!status) return false;
      return status !== "delivered" && status !== "packet_delivered";
    });

    if (hasUndelivered) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Kitchen still has undelivered items",
        message:
          "Order cannot be closed because there are still kitchen items being prepared",
      });
    }

    const nextOrderTotal = Math.max(currentTotal, newRecordedTotal);
    const updateResult = await client.query(
      `UPDATE orders
          SET status = 'closed',
              is_paid = false,
              debt_recorded_total = $3,
              total = $4,
              customer_name = $5,
              customer_phone = $6,
              debt_paid_at = NULL
        WHERE restaurant_id = $1 AND id = $2
        RETURNING *`,
      [restaurantId, id, newRecordedTotal, nextOrderTotal, customerName, customerPhone]
    );

    const order = updateResult.rows[0];
    await cancelLinkedConcertBookings(client, restaurantId, id, {
      cancellationReason: "linked_order_closed",
    });

    await client.query("COMMIT");

    io.to(`restaurant_${restaurantId}`).emit("order_closed", { orderId: Number(order.id) });

    res.json({
      message: "✅ Order amount added to customer debt",
      debt_added: delta,
      order,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to add order debt:", err);
    res.status(500).json({ error: "Failed to add order debt" });
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





 // ✅ Public route for QR Menu order view
// ✅ Safe for both authenticated POS users AND public QR menu views
router.get("/:id", async (req, res, next) => {
  const { id } = req.params;
  const identifier = req.query.identifier;
  let restaurant_id = req.user?.restaurant_id || null;

  try {
    // Avoid swallowing other explicit routes like /reservations, /reports, etc.
    // This route is only for numeric order IDs.
    if (!/^\d+$/.test(String(id || ""))) return next();

    // Allow public QR menu with ?identifier=
    if (!restaurant_id && identifier) {
      restaurant_id = await lookupRestaurantIdByIdentifier(identifier);
    }

    if (!restaurant_id) {
      return res.status(400).json({ error: "Missing restaurant ID" });
    }

    let canJoinConcertBooking = false;
    try {
      await ensureConcertTables(pool);
      canJoinConcertBooking = true;
    } catch (concertErr) {
      console.warn("⚠️ Failed to ensure concert tables in /orders/:id:", concertErr?.message || concertErr);
    }

    const orderSqlWithConcert = `
      SELECT
        o.*,
        r.name AS restaurant_name,
        r.slug AS restaurant_slug,
        r.logo_url AS restaurant_logo_url,
        r.pos_location AS restaurant_pos_location,
        r.pos_location_lat AS restaurant_pos_location_lat,
        r.pos_location_lng AS restaurant_pos_location_lng,
        cb.id AS concert_booking_id,
        cb.payment_status AS concert_booking_payment_status,
        cb.booking_status AS concert_booking_status,
        cb.updated_at AS concert_booking_updated_at,
        cb.booking_type AS concert_booking_type,
        cb.reserved_table_number AS concert_reserved_table_number,
        cb.event_id AS concert_event_id,
        ce.artist_name AS concert_artist_name,
        ce.event_title AS concert_event_title,
        ce.event_date AS concert_event_date,
        ce.event_time AS concert_event_time
      FROM orders o
      LEFT JOIN restaurants r ON r.id = o.restaurant_id
      LEFT JOIN LATERAL (
        SELECT *
        FROM concert_bookings
        WHERE restaurant_id = o.restaurant_id
          AND reservation_order_id = o.id
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
        LIMIT 1
      ) cb ON TRUE
      LEFT JOIN concert_events ce
        ON ce.id = cb.event_id
       AND ce.restaurant_id = o.restaurant_id
      WHERE o.id = $1 AND o.restaurant_id = $2
      LIMIT 1
    `;
    const orderSqlPlain = `
      SELECT
        o.*,
        r.name AS restaurant_name,
        r.slug AS restaurant_slug,
        r.logo_url AS restaurant_logo_url,
        r.pos_location AS restaurant_pos_location,
        r.pos_location_lat AS restaurant_pos_location_lat,
        r.pos_location_lng AS restaurant_pos_location_lng
      FROM orders o
      LEFT JOIN restaurants r ON r.id = o.restaurant_id
      WHERE o.id = $1 AND o.restaurant_id = $2
      LIMIT 1
    `;

    const orderRes = await pool.query(
      canJoinConcertBooking ? orderSqlWithConcert : orderSqlPlain,
      [id, restaurant_id]
    );

    if (orderRes.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    const record = orderRes.rows[0];
    const payment_method =
      record.payment_method ||
      record.payment_type ||
      record.pay_method ||
      record.method ||
      null;

    const response = {
      ...record,
      payment_method,
      pos_location: record.restaurant_pos_location || null,
      pos_location_lat: record.restaurant_pos_location_lat || null,
      pos_location_lng: record.restaurant_pos_location_lng || null,
    };

    if (!response.restaurant && (record.restaurant_name || record.restaurant_slug || record.restaurant_logo_url)) {
      response.restaurant = {
        name: record.restaurant_name || null,
        slug: record.restaurant_slug || null,
        logo_url: record.restaurant_logo_url || null,
        pos_location: record.restaurant_pos_location || null,
        pos_location_lat: record.restaurant_pos_location_lat || null,
        pos_location_lng: record.restaurant_pos_location_lng || null,
      };
    }

    res.json(response);
  } catch (err) {
    console.error("❌ Error fetching order by id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


// GET order items by order ID
router.get("/:id/items", async (req, res) => {
  const { id } = req.params;
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;
  try {
    const includeCancelled =
      String(req.query?.include_cancelled || req.query?.includeCancelled || "")
        .trim()
        .toLowerCase() === "true" ||
      String(req.query?.include_cancelled || req.query?.includeCancelled || "")
        .trim()
        .toLowerCase() === "1";

    const cancellationColumns = await getOrderItemsCancellationColumns();
    const cancelFilter = includeCancelled
      ? ""
      : cancellationColumns.hasCancelledAt
        ? "AND oi.cancelled_at IS NULL"
        : "AND COALESCE(oi.kitchen_status, '') <> 'cancelled'";
    const cancellationSelect = [
      cancellationColumns.hasCancelledAt
        ? "oi.cancelled_at"
        : "NULL::timestamp AS cancelled_at",
      cancellationColumns.hasCancellationReason
        ? "oi.cancellation_reason"
        : "NULL::text AS cancellation_reason",
    ].join(",\n     ");
    const result = await pool.query(
  `SELECT
     oi.id,
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
     ${cancellationSelect},
     oi.discount_type,
     oi.discount_value,
     oi.name AS order_item_name,
     oi.external_product_name,
     p.name AS product_name,
     p.category AS category
   FROM order_items oi
   LEFT JOIN products p ON oi.product_id = p.id
   JOIN orders o ON o.id = oi.order_id
   WHERE oi.order_id = $1 AND o.restaurant_id = $2 ${cancelFilter}`,
  [id, restaurantId]
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
    await client.query("BEGIN");
    const itemsRes = await client.query("SELECT COUNT(*) FROM order_items WHERE order_id = $1", [id]);
    const itemCount = parseInt(itemsRes.rows[0].count, 10);

if (itemCount === 0) {
  const typeRes = await client.query("SELECT order_type FROM orders WHERE id = $1", [id]);
  const type = typeRes.rows[0]?.order_type;

  if (type !== 'quick') {
    await client.query(
      `UPDATE orders
          SET status = 'closed',
              ${getReservationFinalizeResetSql("'closed'")}
        WHERE restaurant_id = $1 AND id = $2`,
      [req.user.restaurant_id, id]
    );
    await cancelLinkedConcertBookings(client, req.user.restaurant_id, id, {
      cancellationReason: "empty_order_auto_closed",
    });
    await client.query("COMMIT");
    io.to(`restaurant_${req.user.restaurant_id}`).emit("order_closed", { orderId: parseInt(id, 10) });
    return res.json({ message: "Order status reset to closed" });
  }

  await client.query("COMMIT");
  return res.json({ message: "Quick order skipped from auto-close" });
}

    await client.query("COMMIT");
    res.json({ message: "Order has items, not resetting" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error resetting order:", error);
    res.status(500).json({ error: "Failed to reset order" });
  } finally {
    client.release();
  }
});



// POST /sub-orders
// POST /sub-orders  (supports paid & unpaid flows via mark_paid)
router.post("/sub-orders", async (req, res) => {
  const {
    order_id,
    total = 0,
    payment_method,
    items = [],
    receipt_id,
    mark_paid = true, // default to paid unless explicitly set
  } = req.body;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO sub_orders (order_id, total, payment_method, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id AS sub_order_id`,
      [order_id, total, payment_method || null]
    );
    const subOrderId = rows[0].sub_order_id;

    const shouldMarkPaid = !!mark_paid && !!receipt_id;

    const itemsWithReceipt = items.map((item) => ({
      ...item,
      receipt_id: receipt_id || null,
      payment_method: item.payment_method || payment_method || null,
      product_id: item.product_id ?? item.id ?? null,
      // kitchen_status intentionally not forced here
    }));

    // ❌ Prevent double deduction if these items were already confirmed before payment
const unconfirmedItems = itemsWithReceipt.filter(it => !it.confirmed && !it.paid_at);
if (unconfirmedItems.length > 0) {
  await updateStockForOrder(unconfirmedItems, req.user.restaurant_id, io);
}



    const requestedByUniqueId = new Map(
      itemsWithReceipt
        .filter((it) => it && typeof it === "object" && it.unique_id)
        .map((it) => [
          String(it.unique_id),
          Math.max(1, Math.trunc(Number(it.quantity) || 1)),
        ])
    );
    const uniqueIds = Array.from(requestedByUniqueId.keys());

    if (uniqueIds.length > 0) {
      const { rows: locked } = await client.query(
        `SELECT *
           FROM order_items
          WHERE order_id = $1
            AND unique_id = ANY($2::text[])
          FOR UPDATE`,
        [order_id, uniqueIds]
      );

      let updatedPaid = 0;
      let insertedPaid = 0;
      let updatedUnpaid = 0;

      for (const row of locked) {
        const key = String(row.unique_id);
        const requestedQty = requestedByUniqueId.get(key);
        if (!requestedQty) continue;

        const safeJson = (val) => {
          if (val === null || val === undefined) return JSON.stringify([]);
          if (typeof val === "string") return val;
          try {
            return JSON.stringify(val);
          } catch {
            return JSON.stringify([]);
          }
        };

        const existingQty = Math.max(1, Math.trunc(Number(row.quantity) || 1));
        const payQty = Math.min(Math.max(1, requestedQty), existingQty);

        if (shouldMarkPaid) {
          if (row.paid_at) {
            // Skip already-paid rows (prevents double-stamping); frontend should not send these.
            continue;
          }

          if (payQty < existingQty) {
            const remainingQty = existingQty - payQty;

            // Keep the original row as the remaining UNPAID quantity.
            await client.query(
              `UPDATE order_items
                  SET quantity = $2,
                      confirmed = true,
                      sub_order_id = NULL,
                      paid_at = NULL,
                      receipt_id = NULL,
                      payment_method = NULL
                WHERE id = $1`,
              [row.id, remainingQty]
            );
            updatedUnpaid += 1;

            // Insert a new PAID row for the paid portion.
            const newUniqueId = `${key}::p:${uuidv4()}`;

            const safeJson = (val) => {
              if (val === null || val === undefined) return JSON.stringify([]);
              if (typeof val === "string") return val;
              try {
                return JSON.stringify(val);
              } catch {
                return JSON.stringify([]);
              }
            };

            await client.query(
              `INSERT INTO order_items (
                 order_id, product_id, quantity, price,
                 ingredients, extras, unique_id,
                 confirmed, kitchen_status, payment_method, receipt_id, note,
                 discount_type, discount_value,
                 external_product_id, external_product_name, name,
                 sub_order_id, paid_at
               )
               VALUES (
                 $1,$2,$3,$4,
                 $5::jsonb,$6::jsonb,$7,
                 TRUE,$8,$9,$10,$11,
                 $12,$13,
                 $14,$15,$16,
                 $17, NOW()
               )`,
              [
                row.order_id,
                row.product_id,
                payQty,
                row.price,
                safeJson(row.ingredients),
                safeJson(row.extras),
                newUniqueId,
                row.kitchen_status || "new",
                payment_method || "Split",
                receipt_id,
                row.note || null,
                row.discount_type || null,
                Number(row.discount_value) || 0,
                row.external_product_id || null,
                row.external_product_name || null,
                row.name || null,
                subOrderId,
              ]
            );
            insertedPaid += 1;
          } else {
            const updateRes = await client.query(
              `UPDATE order_items
                  SET sub_order_id = $1,
                      paid_at = NOW(),
                      confirmed = true,
                      receipt_id = $3,
                      payment_method = $4
                WHERE id = $2`,
              [subOrderId, row.id, receipt_id, payment_method || "Split"]
            );
            updatedPaid += updateRes.rowCount || 0;
          }
        } else {
          // Unpaid sub-order: just link and confirm (no paid_at).
          const updateRes = await client.query(
            `UPDATE order_items
                SET sub_order_id = $1,
                    confirmed = true
              WHERE id = $2`,
            [subOrderId, row.id]
          );
          updatedPaid += updateRes.rowCount || 0;
        }
      }

      if (shouldMarkPaid) {
        console.log(
          `✅ Sub-order ${subOrderId} paid items updated=${updatedPaid}, inserted=${insertedPaid}, remainingUpdated=${updatedUnpaid}`
        );
      } else {
        console.log(`🟡 Sub-order ${subOrderId} items linked=${updatedPaid}`);
      }
    }

    // Keep order total in sync with the sub-order's total
    await client.query(
              `UPDATE orders
	SET total = total + $1
	WHERE restaurant_id = $2 AND id = $3`,
      [total, req.user.restaurant_id, order_id]
    );

    await client.query("COMMIT");
    // 🔒 Tenant-safe emit only for this restaurant
    if (typeof emitOrderUpdate === "function") emitOrderUpdate(io, req.user.restaurant_id);

    // 🔥 Emit payment event only when marked paid AND receipt present
    if (shouldMarkPaid) {
      const restaurantId = req.user.restaurant_id;
      const tableResult = await client.query(
        "SELECT table_number FROM orders WHERE id = $1 AND restaurant_id = $2",
        [order_id, restaurantId]
      );
      const tableNumber = tableResult.rows?.[0]?.table_number ?? null;
      const orderTotalWithExtras = await computeOrderTotalWithExtras(client, order_id);
      emitPaymentMade(io, restaurantId, order_id, {
        payment_method,
        total,
        amount: total,
        table_number: tableNumber,
        order_total_with_extras: orderTotalWithExtras,
      });

      console.log(
        `💸 [orders] payment_made emitted from sub-order for restaurant_${restaurantId}, order ${order_id}`
      );
    }

    res.json({ sub_order_id: subOrderId, mark_paid: !!mark_paid });
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
        COALESCE(
          json_agg(
            json_build_object(
              'product_id', oi.product_id,
              'name', COALESCE(oi.name, p.name, oi.external_product_name, 'Item'),
              'quantity', oi.quantity,
              'price', oi.price,
              'ingredients', oi.ingredients,
              'extras', oi.extras,
              'unique_id', oi.unique_id,
              'payment_method', oi.payment_method,
              'paid_at', oi.paid_at,
              'receipt_id', oi.receipt_id
            )
          ) FILTER (WHERE oi.id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM sub_orders so
      LEFT JOIN order_items oi ON so.id = oi.sub_order_id
      LEFT JOIN products p ON oi.product_id = p.id
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





// ✅ PATCH /orders/:id/reopen
// ✅ PATCH /orders/:id/reopen — restores paid order properly
router.patch("/:id/reopen", async (req, res) => {
  const { id } = req.params;
  const restaurantId = req.user.restaurant_id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1️⃣ Get the last order details
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, id]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    const order = rows[0];

    // 2️⃣ If it's already closed or paid, reopen it visually only
    const updated = await client.query(
      `UPDATE orders
       SET status = 'confirmed',
           is_paid = false
       WHERE restaurant_id = $1 AND id = $2
       RETURNING *`,
      [restaurantId, id]
    );

    await client.query("COMMIT");

    // 4️⃣ Return the order with its items
    const { rows: itemRows } = await client.query(
      `SELECT *
       FROM order_items
       WHERE order_id = $1
       ORDER BY id ASC`,
      [id]
    );

    res.json({
      ...updated.rows[0],
      items: itemRows,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to reopen order:", err);
    res.status(500).json({ error: "Failed to reopen order" });
  } finally {
    client.release();
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
        "UPDATE orders SET receipt_id = gen_random_uuid() WHERE restaurant_id = $1 AND id = $2 RETURNING receipt_id",
        [req.user.restaurant_id, order_id]
      );
      receipt_id = rows[0].receipt_id;
    }

    // Always set receipt_id on order (even if already present)
    if (order_id && receipt_id) {
      await pool.query(
        "UPDATE orders SET receipt_id = $1 WHERE restaurant_id = $2 AND id = $3",
        [receipt_id, req.user.restaurant_id, order_id]
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
	
	    const restaurantId = req.user.restaurant_id;
	    const changedBy = req.user?.username || req.user?.name || req.user?.email || "system";
	    // Update payment_method string on order for clarity.
	    // IMPORTANT: An order can have multiple receipts over time (e.g. QRMenu "order another"),
	    // so we MERGE new method(s) with existing ones instead of overwriting.
	    const methodKeys = Object.keys(methods || {})
	      .filter((k) => parseFloat(methods[k]) > 0)
	      .map((k) => String(k || "").trim())
	      .filter(Boolean);
	    const thisPaymentMethodStr = methodKeys.join("+");

	    let orderId =
	      order_id === null || order_id === undefined ? null : Number(order_id);
	    if (!Number.isFinite(orderId) && receipt_id) {
	      const { rows } = await pool.query(
	        "SELECT id FROM orders WHERE receipt_id = $1 AND restaurant_id = $2 LIMIT 1",
	        [receipt_id, restaurantId]
	      );
	      orderId = rows[0]?.id ? Number(rows[0].id) : null;
	    }
	    if (!Number.isFinite(orderId)) {
	      return res.status(400).json({ error: "Invalid payload: missing order_id" });
	    }

	    const { rows: beforeRows } = await pool.query(
	      "SELECT payment_method FROM orders WHERE restaurant_id = $1 AND id = $2",
	      [restaurantId, orderId]
	    );
	    const prevMethodRaw = beforeRows[0]?.payment_method ?? null;

	    const parseMethodTokens = (value) =>
	      String(value || "")
	        .split("+")
	        .map((t) => t.trim())
	        .filter(Boolean);

	    // Preserve existing casing when a new token matches case-insensitively.
	    const mergedTokens = [];
	    const seen = new Map(); // lower -> display token

	    for (const tok of parseMethodTokens(prevMethodRaw)) {
	      const lower = tok.toLowerCase();
	      if (!seen.has(lower)) {
	        seen.set(lower, tok);
	        mergedTokens.push(tok);
	      }
	    }
	    for (const tok of methodKeys) {
	      const lower = tok.toLowerCase();
	      if (seen.has(lower)) continue;
	      seen.set(lower, tok);
	      mergedTokens.push(tok);
	    }

	    const mergedPaymentMethodStr = mergedTokens.join("+");

	    await pool.query(
	      `UPDATE orders
	          SET payment_method = $1
	        WHERE restaurant_id = $2 AND id = $3`,
	      [mergedPaymentMethodStr, restaurantId, orderId]
	    );
	
	    // 🔥 Emit payment_made after split receipt saved
	    // Record payment method changes (timeline in history)
	    const prev = prevMethodRaw;
	    if (prev !== mergedPaymentMethodStr) {
	      await pool.query(
	        `INSERT INTO payment_method_changes (order_id, old_method, new_method, changed_by, changed_at)
	         VALUES ($1, $2, $3, $4, NOW())`,
	        [orderId, prev, mergedPaymentMethodStr, changedBy]
	      );
	    }
	
	    if (orderId) {
	      const tableResult = await pool.query(
	        "SELECT table_number FROM orders WHERE id = $1 AND restaurant_id = $2",
	        [orderId, restaurantId]
	      );
	      const tableNumber = tableResult.rows?.[0]?.table_number ?? null;
	      const orderTotalWithExtras = await computeOrderTotalWithExtras(pool, orderId);
	      emitPaymentMade(io, restaurantId, orderId, {
	        payment_method: thisPaymentMethodStr || mergedPaymentMethodStr || "Split",
	        total: null,
	        table_number: tableNumber,
	        order_total_with_extras: orderTotalWithExtras,
	      });
	
	      console.log(
	        `💸 [orders] payment_made emitted after receipt_methods for restaurant_${restaurantId}, order ${orderId}`
	      );
	    }

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

    // 1. Update kitchen_status for all items (tenant-safe, no reliance on order_items.restaurant_id)
    await client.query(
      `UPDATE order_items AS oi
       SET kitchen_status = $1
       FROM orders o
       WHERE oi.order_id = o.id
         AND o.restaurant_id = $2
         AND oi.id = ANY($3::int[])`,
      [status, req.user.restaurant_id, ids]
    );


    // 2. Find affected order IDs
    const { rows: itemOrders } = await client.query(
      `SELECT DISTINCT oi.order_id
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       WHERE o.restaurant_id = $1
         AND oi.id = ANY($2::int[])`,
      [req.user.restaurant_id, ids]
    );

    const orderIds = itemOrders.map((r) => r.order_id);
    const orderTableMap = new Map();
      if (orderIds.length) {
        const { rows: orderRows } = await client.query(
          `SELECT id, table_number, external_source, external_id, customer_name, order_type
           FROM orders
           WHERE restaurant_id = $1 AND id = ANY($2::int[])`,
          [req.user.restaurant_id, orderIds]
        );
        orderRows.forEach((row) => {
          orderTableMap.set(row.id, {
            number: row.table_number ?? null,
            external_source: row.external_source ?? null,
            external_id: row.external_id ?? null,
            customer_name: row.customer_name ?? null,
            order_type: row.order_type ?? null,
          });
        });
      }

    // Load kitchen exclusions (so excluded items don't block order-level delivered).
    const safeParseArray = (value) => {
      try {
        if (!value) return [];
        return typeof value === "string" ? JSON.parse(value) : value;
      } catch {
        return [];
      }
    };
    const { rows: settingsRows } = await client.query(
      `SELECT excluded_categories, excluded_items
         FROM kitchen_compile_settings
         WHERE restaurant_id = $1
         ORDER BY id
         LIMIT 1`,
      [req.user.restaurant_id]
    );
    const excludedCategoriesRaw = safeParseArray(settingsRows[0]?.excluded_categories);
    const excludedItemsRaw = safeParseArray(settingsRows[0]?.excluded_items);
    const excludedCategories = new Set(
      excludedCategoriesRaw
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const excludedItems = new Set(
      excludedItemsRaw
        .map((value) => {
          if (value === null || value === undefined || value === "") return null;
          const num = Number(value);
          if (Number.isFinite(num)) return String(num);
          return String(value).trim();
        })
        .filter(Boolean)
    );

    // 3. For each order, set prep_started_at / estimated_ready_at / kitchen_delivered_at
    const deliveredOrders = [];
    const penaltyPerBatch = (orderIds.length - 1) * 2 * 60; // +2min per extra order in the batch

    for (const orderId of orderIds) {
      // Fetch all items for this order
      const { rows: allItems } = await client.query(
        `SELECT
           oi.kitchen_status,
           oi.product_id,
           p.category AS product_category
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         LEFT JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = $1 AND o.restaurant_id = $2`,
        [orderId, req.user.restaurant_id]
      );
      const relevantItems = (allItems || []).filter((row) => {
        const category = String(row.product_category || "").trim().toLowerCase();
        const productId =
          row.product_id === null || row.product_id === undefined
            ? ""
            : String(row.product_id).trim();
        if (category && excludedCategories.has(category)) return false;
        if (productId && excludedItems.has(productId)) return false;
        return true;
      });
      const statuses = relevantItems.map((i) => i.kitchen_status);

      // --- PENALTY LOGIC ---
      if (statuses.includes("preparing")) {
        // Calculate max prep time among all products in this order,
        // including per-item (quantity) penalty!
        const { rows: itemsWithPrep } = await client.query(
          `SELECT oi.quantity, p.preparation_time
           FROM order_items oi
           JOIN orders o ON oi.order_id = o.id
           JOIN products p ON oi.product_id = p.id
          WHERE oi.order_id = $1 AND o.restaurant_id = $2`,
          [orderId, req.user.restaurant_id]
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
   WHERE restaurant_id = $2 AND id = $3`,
  [estReadyAt, req.user.restaurant_id, orderId]
);

      } else {
        await client.query(
  `UPDATE orders SET estimated_ready_at = NULL WHERE restaurant_id = $1 AND id = $2`,
  [req.user.restaurant_id, orderId]
);

      }

      // a) PREP STARTED (prep_started_at always set above)
      // b) ALL DELIVERED (ignoring kitchen-excluded items)
      // If there are no relevant items (everything excluded), treat as delivered.
      const allDelivered =
        statuses.length === 0 ||
        statuses.every((s) => (s || "").toString().toLowerCase() === "delivered");

      if (allDelivered) {
        const tableInfo = orderTableMap.get(orderId);

        await client.query(
          `UPDATE orders SET kitchen_delivered_at = NOW() WHERE restaurant_id = $1 AND id = $2`,
          [req.user.restaurant_id, orderId]
        );

        deliveredOrders.push({
          orderId,
          table_number: tableInfo?.number ?? null,
          table_label: null,
          customer_name: tableInfo?.customer_name ?? null,
          order_type: tableInfo?.order_type ?? null,
          external_source: tableInfo?.external_source ?? null,
          external_id: tableInfo?.external_id ?? null,
        });
      }
    }

    await client.query("COMMIT");

    // 4️⃣ Tenant-safe socket emits
    const io = getIO();
    io.to(`restaurant_${req.user.restaurant_id}`).emit("orders_updated");

    if (status === "preparing" && orderIds.length) {
      orderIds.forEach((orderId) => {
        const tableInfo = orderTableMap.get(orderId);
        emitOrderPreparing(io, req.user.restaurant_id, orderId, {
          table_number: tableInfo?.number ?? null,
            table_label: null,
          customer_name: tableInfo?.customer_name ?? null,
          order_type: tableInfo?.order_type ?? null,
          external_source: tableInfo?.external_source ?? null,
          external_id: tableInfo?.external_id ?? null,
          order_id: orderId,
        });
        if (String(tableInfo?.external_source || "").toLowerCase() === "yemeksepeti") {
          emitYsOrderStatus(req.user.restaurant_id, orderId, "preparing", {});
        }
      });
    }

    if (status === "ready" && orderIds.length) {
      io.to(`restaurant_${req.user.restaurant_id}`).emit("order_ready", { orderIds });
      await Promise.allSettled(
        orderIds.map((orderId) => sendExternalPreparationCompleted({ orderId }))
      );
    }

    if (status === "delivered" && deliveredOrders.length) {
      deliveredOrders.forEach(({ 
        orderId, 
        table_number, 
        customer_name,
        order_type,
        external_source,
        external_id 
      }) =>
        emitOrderDelivered(io, req.user.restaurant_id, orderId, {
          table_number,
          table_label: null,
          customer_name,
          order_type,
          external_source,
          external_id,
          order_id: orderId,
        })
      );
      deliveredOrders.forEach(({ orderId }) => {
        const meta = orderTableMap.get(orderId);
        if (String(meta?.external_source || "").toLowerCase() === "yemeksepeti") {
          emitYsOrderStatus(req.user.restaurant_id, orderId, "delivered", {});
        }
      });
      // Some kitchen flows skip `ready` and move straight to `delivered`.
      await Promise.allSettled(
        deliveredOrders.map(({ orderId }) => sendExternalPreparationCompleted({ orderId }))
      );
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

    const driverCheck = await client.query(
      `SELECT
         driver_id,
         customer_name,
         table_number,
         external_source,
         external_id,
         external_expedition_type,
         customer_address,
         order_type,
         order_origin
       FROM orders WHERE restaurant_id = $1 AND id = $2`,
      [req.user.restaurant_id, id]
    );

    const order = driverCheck.rows[0];
    const isYsOrder = String(order?.external_source || "").toLowerCase() === "yemeksepeti";
    const isYemeksepetiPickup =
      order &&
      (order.external_source === "yemeksepeti" || order.external_id) &&
      (String(order.external_expedition_type || "").toLowerCase() === "pickup" ||
        String(order.customer_address || "").toLowerCase() === "pickup order");

    // 🛑 Block driver status change if driver_id is not assigned, except YS pickup orders (no driver needed)
    if (!order || (!order.driver_id && !isYemeksepetiPickup)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Cannot change driver status: no driver assigned!" });
    }

    // 1. Always update driver_status
   await client.query(
  `UPDATE orders
   SET driver_status = $1
   WHERE restaurant_id = $2 AND id = $3`,
  [driver_status, req.user.restaurant_id, id]
);


    // 2. If delivered, set delivered_at
    if (driver_status === "delivered") {
      await client.query(
  `UPDATE orders
   SET delivered_at = NOW()
   WHERE restaurant_id = $1 AND id = $2 AND delivered_at IS NULL`,
  [req.user.restaurant_id, id]
);

    }

    await client.query("COMMIT");

// 🔒 Tenant-safe emit only to this restaurant
    const io = getIO();
    io.to(`restaurant_${req.user.restaurant_id}`).emit("orders_updated");
    io
      .to(`restaurant_${req.user.restaurant_id}`)
      .emit("driver_status_updated", { orderId: Number(id), driver_status });
    if (["on_road", "picked_up"].includes(String(driver_status || "").toLowerCase())) {
      await sendExternalOrderPickedUp({ orderId: Number(id) });
      if (driver_status === "picked_up" && isYsOrder) {
        emitYsOrderStatus(req.user.restaurant_id, Number(id), "picked_up", {});
      }
      if (process.env.YS_PARTNER_FULFILLMENT_ENABLED === "true") {
        try {
          const partnerRes = await sendYsPartnerFulfillment({ orderId: Number(id), status: "DISPATCHED" });
          if (partnerRes?.skipped) {
            dlog("ℹ️ [ys-partner] DISPATCHED skipped:", partnerRes.reason);
          }
        } catch (err) {
          console.warn(
            "⚠️ YS partner fulfillment (DISPATCHED) failed:",
            err?.message || err
          );
        }
      }
    }
    if (driver_status === "delivered") {
      // Do not attempt to sync "delivered" to Yemeksepeti via middleware callbacks.
      // Middleware supports: order_accepted / order_rejected / order_picked_up (+ preparation-completed).
      // A "delivered" signal should come from platform logistics (when supported).
      dlog(`✅ Driver marked order as DELIVERED - no external sync performed`);
      if (
        isQrDeliveryOrder(order) &&
        ["packet", "delivery", "online"].includes(String(order?.order_type || "").toLowerCase())
      ) {
        await sendOrderCustomerDeliveredEmail({
          pool,
          restaurantId: req.user.restaurant_id,
          orderId: Number(id),
          triggeredFrom: "orders.driver_status.delivered.qr_delivery",
          req,
        });
      }
      if (isYsOrder) {
        emitYsOrderStatus(req.user.restaurant_id, Number(id), "delivered", {});
      }
      emitOrderDelivered(io, req.user.restaurant_id, Number(id), {
        table_number: order?.table_number ?? null,
      });
      io.to(`restaurant_${req.user.restaurant_id}`).emit("driver_delivered", {
        orderId: Number(id),
        customer_name: order?.customer_name || null,
        driver_status,
      });
    }

    if (driver_status === "on_road") {
      emitDriverOnRoad(io, req.user.restaurant_id, Number(id), {
        customer_name: order?.customer_name || null,
      });
    }
res.json({ success: true });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Driver status update failed:", err);
    res.status(500).json({ error: "Failed to update driver status" });
  } finally {
    client.release();
  }
});
// ✅ PATCH /orders/:id/move-table
// ✅ PATCH /orders/:id/move-table
router.patch("/:id/move-table", async (req, res) => {
  const { id } = req.params;
  const { new_table_number } = req.body;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT * FROM orders WHERE restaurant_id = $1 AND id = $2`,
      [req.user.restaurant_id, id]
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    const order = rows[0];

    // 3️⃣ Move the order
    const updatedOrder = await client.query(
      `UPDATE orders
       SET table_number = $1,
           status = CASE
                      WHEN status = 'paid' THEN 'confirmed'
                      ELSE status
                    END
       WHERE restaurant_id = $2 AND id = $3
       RETURNING *`,
      [new_table_number, req.user.restaurant_id, id]
    );

    await client.query("COMMIT");

    // Emit socket update
    io.emit("table_moved", {
      order_id: id,
      from: order.table_number,
      to: new_table_number,
      order: updatedOrder.rows[0],
    });

    res.json({
      message: `✅ Table moved from ${order.table_number} to ${new_table_number}`,
      order: updatedOrder.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Move table failed:", err);
    res.status(500).json({ error: "Failed to move table" });
  } finally {
    client.release();
  }
});


// ✅ FINAL PATCH: Merge tables preserving all paid/unpaid states
router.patch("/:orderId/merge-table", async (req, res) => {
  const { orderId } = req.params;
  const { target_table_number } = req.body;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const restaurantId = req.user?.restaurant_id;
    if (!restaurantId) throw new Error("Missing restaurant context");

    // 1️⃣ Find destination order (open)
    const { rows: target } = await client.query(
      `SELECT id, restaurant_id, total, is_paid
         FROM orders
        WHERE restaurant_id = $2
          AND table_number = $1
          AND status <> 'closed'
          AND status <> 'cancelled'
          AND status <> 'canceled'
        LIMIT 1`,
      [target_table_number, restaurantId]
    );
    if (!target.length) throw new Error("Target order not found or closed");
    const targetOrder = target[0];

    // 2️⃣ Find source
    const { rows: source } = await client.query(
      `SELECT id, restaurant_id, total
         FROM orders
        WHERE restaurant_id = $2
          AND id = $1
        LIMIT 1`,
      [orderId, restaurantId]
    );
    if (!source.length) throw new Error("Source order not found");
    const sourceOrder = source[0];

    if (targetOrder.restaurant_id !== sourceOrder.restaurant_id)
      throw new Error("Cross-restaurant merge is not allowed");

    // 3️⃣ Move all order_items (preserve all payment info!)
    await client.query(
      `UPDATE order_items
       SET order_id = $1
       WHERE order_id = $2`,
      [targetOrder.id, sourceOrder.id]
    );

    // 4️⃣ Move sub_orders
    await client.query(
      `UPDATE sub_orders
       SET order_id = $1
       WHERE order_id = $2`,
      [targetOrder.id, sourceOrder.id]
    );

    // 5️⃣ Roll totals and detect if target should now be marked paid
    const { rows: paidCheck } = await client.query(
      `SELECT COUNT(*) FILTER (WHERE paid_at IS NULL) AS unpaid_count
         FROM order_items
        WHERE order_id = $1`,
      [targetOrder.id]
    );

    const unpaidCount = parseInt(paidCheck[0].unpaid_count, 10) || 0;
    const newStatus = unpaidCount === 0 ? "paid" : "confirmed";

    await client.query(
      `UPDATE orders
         SET total = COALESCE(total,0) + $2,
             status = $3,
             is_paid = $4
       WHERE id = $1`,
      [
        targetOrder.id,
        sourceOrder.total || 0,
        newStatus,
        unpaidCount === 0, // true if all paid
      ]
    );

    // 6️⃣ Close and zero the source
    await client.query(
      `UPDATE orders
          SET status = 'closed',
              ${getReservationFinalizeResetSql("'closed'")},
              total = 0
        WHERE id = $1`,
      [sourceOrder.id]
    );
    await cancelLinkedConcertBookings(client, restaurantId, sourceOrder.id, {
      cancellationReason: "merged_into_other_order",
    });

    await client.query("COMMIT");

// 7️⃣ Emit (tenant-safe)
if (typeof emitOrderUpdate === "function") emitOrderUpdate(io, restaurantId);

io.to(`restaurant_${restaurantId}`).emit("order_merged", {
  order: { id: targetOrder.id, table_number: Number(target_table_number) },
});

    res.json({
      ok: true,
      target_id: targetOrder.id,
      merged_status: newStatus,
      message: unpaidCount === 0
        ? "Merged successfully (all paid)"
        : "Merged successfully (some unpaid items remain)",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ merge-table failed:", err);
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
const orderRes = await client.query(`
  SELECT o.*,
         c.name AS customer_name,
         c.phone AS customer_phone,
         ca.address AS customer_address
  FROM orders o
  LEFT JOIN customers c ON o.customer_phone = c.phone
  LEFT JOIN customer_addresses ca ON ca.customer_id = c.id AND ca.is_default = true
  WHERE o.restaurant_id = $1 AND o.id = $2
`, [req.user.restaurant_id, req.params.id]);

    const order = orderRes.rows[0];
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
  `UPDATE orders
   SET status = 'confirmed'
   WHERE restaurant_id = $1 AND id = $2
   RETURNING *`,
  [req.user.restaurant_id, id]
);

    await client.query("COMMIT");

const ioRef = req.app.get("io");
const restaurantId = req.user.restaurant_id;

if (order.external_source === "yemeksepeti") {
  try {
    const { rows: orderItems } = await pool.query(
      `SELECT id, product_id, quantity, ingredients, extras,
              COALESCE(stock_deducted, FALSE) AS stock_deducted
       FROM order_items
       WHERE order_id = $1`,
      [id]
    );
    const matchedItems = orderItems.filter(
      (it) => Boolean(it.product_id) && !it.stock_deducted
    );
    const skippedCount = orderItems.length - matchedItems.length;
    if (matchedItems.length) {
      await updateStockForOrder(matchedItems, restaurantId, io);
      await pool.query(
        `UPDATE order_items
         SET stock_deducted = TRUE
         WHERE id = ANY($1::int[])`,
        [matchedItems.map((row) => row.id)]
      );
    }
    console.log("📦 [orders] Yemeksepeti stock deducted on accept:", {
      orderId: id,
      items: matchedItems.length,
      skipped_unmatched: skippedCount,
    });
  } catch (e) {
    console.error("❌ Failed to deduct stock on Yemeksepeti accept:", e);
  }
}

try {
  const payload = await buildFullOrderPayload(id, restaurantId);
  ioRef.to(`restaurant_${restaurantId}`).emit("order_confirmed", payload);
  console.log(`🖨️ [orders] order_confirmed emitted for restaurant_${restaurantId}:`, id);
} catch (e) {
  console.error("❌ Failed to build full order payload for order_confirmed:", e);
}

// 🔒 tenant-safe update emit
if (typeof emitOrderUpdate === "function") emitOrderUpdate(ioRef, restaurantId);
else ioRef.to(`restaurant_${restaurantId}`).emit("orders_updated");

  if (isQrDeliveryOrder(order)) {
    await sendOrderCustomerConfirmationEmail({
      pool,
      restaurantId,
      orderId: Number(id),
      confirmationType: CONFIRMATION_TYPES.DELIVERY_ORDER,
      triggeredFrom: "orders.confirm_online.qr_delivery",
      req,
    });
  }

  if (String(order.external_source || "").toLowerCase() === "yemeksepeti") {
    emitYsOrderStatus(restaurantId, Number(id), "accepted", {});
  }

    const externalSync = await sendExternalOrderAccepted({ orderId: Number(id) });
    res.json({ message: "Order confirmed", order: updateRes.rows[0], externalSync });
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
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;
  try {
    const result = await pool.query(
      `SELECT old_method, new_method, changed_by, changed_at
         FROM payment_method_changes pmc
         JOIN orders o ON o.id = pmc.order_id
         WHERE pmc.order_id = $1
           AND o.restaurant_id = $2
         ORDER BY changed_at ASC`,
      [id, restaurantId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching payment method changes:', err);
    res.status(500).json({ error: 'Failed to fetch payment method changes' });
  }
});

// ✅ Merge all open orders with the same customer_name into one
router.patch("/merge-by-customer", async (req, res) => {
  const { customer_name } = req.body;
  const restaurantId = req.user.restaurant_id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1️⃣ Find all open orders for this customer
    const { rows: openOrders } = await client.query(
      `SELECT id, total FROM orders
       WHERE restaurant_id = $1 AND status <> 'closed' AND LOWER(customer_name) = LOWER($2)
       ORDER BY id ASC`,
      [restaurantId, customer_name]
    );

    if (openOrders.length < 2) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No multiple open orders found for this name." });
    }

    const target = openOrders[0];
    const others = openOrders.slice(1);

    // 2️⃣ Merge all others into target
    for (const order of others) {
      await client.query(`UPDATE order_items SET order_id = $1 WHERE order_id = $2`, [target.id, order.id]);
      await client.query(`UPDATE sub_orders SET order_id = $1 WHERE order_id = $2`, [target.id, order.id]);
      await client.query(
        `UPDATE orders
            SET status = 'closed',
                ${getReservationFinalizeResetSql("'closed'")},
                total = 0
          WHERE id = $1`,
        [order.id]
      );
      await cancelLinkedConcertBookings(client, restaurantId, order.id, {
        cancellationReason: "merged_into_other_order",
      });
      await client.query(`UPDATE orders SET total = total + $2 WHERE id=$1`, [target.id, order.total || 0]);
    }

    await client.query("COMMIT");

    // Emit update to frontend
    io.to(`restaurant_${restaurantId}`).emit("orders_updated");

    res.json({ message: `Merged ${others.length} orders for ${customer_name}`, target_id: target.id });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ merge-by-customer failed:", err);
    res.status(500).json({ error: "Failed to merge by customer" });
  } finally {
    client.release();
  }
});

// ✅ POST /reservations - Create a new reservation
// Creates or updates a reservation with date, time, client count, and notes
router.post("/reservations", async (req, res) => {
  const {
    reservation_date,
    reservation_time,
    reservation_clients,
    reservation_men,
    reservation_women,
    reservation_notes,
    order_id,
    table_number,
    customer_name,
    customer_phone,
    customer_email,
  } = req.body;
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;
  const normalizedCustomerEmail = normalizeCustomerEmail(customer_email);

  try {
    await ensureReservationGuestCompositionFields();

    // Validate required fields
    if (!reservation_date || !reservation_time) {
      return res.status(400).json({ error: "Reservation date and time are required" });
    }

    const clientCount = parseInt(reservation_clients) || 0;
    const notes = (reservation_notes || "").trim();
    const qrCustomization = await getQrMenuCustomization(restaurantId);
    const guestCompositionValidation = validateReservationGuestComposition({
      config: qrCustomization,
      guestCount: clientCount,
      reservationMen: reservation_men,
      reservationWomen: reservation_women,
    });
    if (guestCompositionValidation?.error) {
      return res.status(400).json({ error: guestCompositionValidation.error });
    }

    const createStandaloneReservationForTable = async ({
      resolvedTableNumber,
      fallbackCustomerName = null,
      fallbackCustomerPhone = null,
    }) => {
      const newOrderResult = await pool.query(
        `INSERT INTO orders (
          restaurant_id,
          table_number,
          status,
          total,
          order_type,
          customer_name,
          customer_phone,
          reservation_date,
          reservation_time,
          reservation_clients,
          reservation_men,
          reservation_women,
          reservation_notes,
          created_at
        )
        VALUES ($1, $2, 'reserved', 0, 'reservation', $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        RETURNING *`,
        [
          restaurantId,
          resolvedTableNumber,
          fallbackCustomerName,
          fallbackCustomerPhone,
          reservation_date,
          reservation_time,
          clientCount,
          reservation_men == null ? null : Number(reservation_men) || 0,
          reservation_women == null ? null : Number(reservation_women) || 0,
          notes,
        ]
      );

      const reservation = newOrderResult.rows[0];

      if (fallbackCustomerPhone) {
        await pool.query(
          `
          INSERT INTO customers (restaurant_id, name, phone, email)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (restaurant_id, phone)
          DO UPDATE SET
            name = COALESCE(NULLIF(EXCLUDED.name, ''), customers.name),
            email = COALESCE(NULLIF(EXCLUDED.email, ''), customers.email)
          `,
          [
            restaurantId,
            fallbackCustomerName || "Customer",
            fallbackCustomerPhone,
            normalizedCustomerEmail || null,
          ]
        );
      }

      emitReservationCreated(restaurantId, reservation);
      console.log("[owner-reservation-email] route.trigger.start", {
        source: "orders.reservations.create.table",
        reservationType: "table",
        reservationId: Number(reservation.id),
        restaurantId,
      });
      const ownerNotificationResult = await sendTableReservationOwnerNotificationEmail({
        pool,
        restaurantId,
        reservationId: Number(reservation.id),
        explicitCustomerEmail: normalizedCustomerEmail,
        triggeredFrom: "orders.reservations.create.table",
        req,
      });
      console.log("[owner-reservation-email] route.trigger.result", {
        source: "orders.reservations.create.table",
        reservationType: "table",
        reservationId: Number(reservation.id),
        restaurantId,
        result: ownerNotificationResult,
      });

      return res.json({
        success: true,
        message: "✅ Reservation created for table",
        reservation,
      });
    };

    // If order_id provided, attach to an existing reservation row or create a standalone
    // reservation row for normal service orders. Do not mutate live table service orders.
    if (order_id) {
      const sourceOrderId = Number(order_id);
      if (!Number.isFinite(sourceOrderId) || sourceOrderId <= 0) {
        return res.status(400).json({ error: "Invalid order_id" });
      }
      const safeTableNumber = Number.isFinite(Number(table_number))
        ? Number(table_number)
        : null;
      const safeCustomerName = (customer_name || "").trim() || null;
      const safeCustomerPhone = (customer_phone || "").trim() || null;
      const sourceOrderResult = await pool.query(
        `SELECT
           id,
           table_number,
           status,
           order_type,
           total,
           customer_name,
           customer_phone,
           reservation_date,
           reservation_time,
           reservation_clients,
           reservation_notes
         FROM orders
         WHERE restaurant_id = $1 AND id = $2
         LIMIT 1`,
        [restaurantId, sourceOrderId]
      );
      if (sourceOrderResult.rowCount === 0) {
        return res.status(404).json({ error: "Order not found" });
      }

      const sourceOrder = sourceOrderResult.rows[0];
      const sourceOrderType = String(sourceOrder?.order_type || "").trim().toLowerCase();
      const sourceOrderStatus = String(sourceOrder?.status || "").trim().toLowerCase();
      const sourceTableNumber = Number(sourceOrder?.table_number);
      const sourceTotal = Number(sourceOrder?.total || 0);
      const sourceItemsResult = await pool.query(
        `SELECT COUNT(*)::int AS item_count
           FROM order_items
          WHERE order_id = $1`,
        [sourceOrderId]
      );
      const sourceItemCount = Number(sourceItemsResult.rows?.[0]?.item_count || 0);
      const isReservationOnlySource =
        sourceOrderType === "reservation" ||
        ((sourceOrderStatus === "reserved" || sourceOrderStatus === "confirmed") &&
          sourceItemCount === 0 &&
          sourceTotal <= 0);

      if (!isReservationOnlySource) {
        const resolvedTableNumber = Number.isFinite(safeTableNumber)
          ? safeTableNumber
          : Number.isFinite(sourceTableNumber)
            ? sourceTableNumber
            : null;
        if (!Number.isFinite(resolvedTableNumber)) {
          return res.status(400).json({ error: "Table number is required for reservation" });
        }

        return await createStandaloneReservationForTable({
          resolvedTableNumber,
          fallbackCustomerName: safeCustomerName ?? sourceOrder?.customer_name ?? null,
          fallbackCustomerPhone: safeCustomerPhone ?? sourceOrder?.customer_phone ?? null,
        });
      }

      const result = await pool.query(
        `UPDATE orders
         SET reservation_date = $1,
             reservation_time = $2,
             reservation_clients = $3,
             reservation_men = $4,
             reservation_women = $5,
             reservation_notes = $6,
             table_number = COALESCE($7::int, table_number),
             customer_name = COALESCE($8::text, customer_name),
             customer_phone = COALESCE($9::text, customer_phone),
             order_type = CASE
               WHEN LOWER(COALESCE(order_type,'')) = 'reservation' THEN 'table'
               ELSE COALESCE(order_type, 'table')
             END,
             status = CASE 
               WHEN LOWER(COALESCE(status,'')) IN ('closed', 'cancelled', 'canceled') THEN 'reserved'
               WHEN status = 'confirmed' THEN 'reserved'
               ELSE COALESCE(status, 'reserved')
             END,
             updated_at = NOW()
         WHERE restaurant_id = $10 AND id = $11
         RETURNING *`,
        [
          reservation_date,
          reservation_time,
          clientCount,
          reservation_men == null ? null : Number(reservation_men) || 0,
          reservation_women == null ? null : Number(reservation_women) || 0,
          notes,
          safeTableNumber,
          safeCustomerName,
          safeCustomerPhone,
          restaurantId,
          sourceOrderId,
        ]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Order not found" });
      }

      if (safeCustomerPhone) {
        await pool.query(
          `
          INSERT INTO customers (restaurant_id, name, phone, email)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (restaurant_id, phone)
          DO UPDATE SET
            name = COALESCE(NULLIF(EXCLUDED.name, ''), customers.name),
            email = COALESCE(NULLIF(EXCLUDED.email, ''), customers.email)
          `,
          [restaurantId, safeCustomerName || "Customer", safeCustomerPhone, normalizedCustomerEmail || null]
        );
      }

      emitReservationCreated(restaurantId, result.rows[0], {
        order_id: sourceOrderId,
      });
      console.log("[owner-reservation-email] route.trigger.start", {
        source: "orders.reservations.create.order",
        reservationType: "table",
        reservationId: Number(result.rows[0].id),
        restaurantId,
      });
      const ownerNotificationResult = await sendTableReservationOwnerNotificationEmail({
        pool,
        restaurantId,
        reservationId: Number(result.rows[0].id),
        explicitCustomerEmail: normalizedCustomerEmail,
        triggeredFrom: "orders.reservations.create.order",
        req,
      });
      console.log("[owner-reservation-email] route.trigger.result", {
        source: "orders.reservations.create.order",
        reservationType: "table",
        reservationId: Number(result.rows[0].id),
        restaurantId,
        result: ownerNotificationResult,
      });

      return res.json({
        success: true,
        message: "✅ Reservation created and order updated",
        reservation: result.rows[0],
      });
    }

    // If table_number provided, create a standalone reservation (new order)
    if (table_number) {
      const safeCustomerName = (customer_name || "").trim() || null;
      const safeCustomerPhone = (customer_phone || "").trim() || null;
      return await createStandaloneReservationForTable({
        resolvedTableNumber: Number(table_number),
        fallbackCustomerName: safeCustomerName,
        fallbackCustomerPhone: safeCustomerPhone,
      });
    }

    return res.status(400).json({ error: "Either order_id or table_number is required" });
  } catch (err) {
    console.error("❌ Error creating reservation:", err);
    res.status(500).json({ error: "Failed to create reservation" });
  }
});

// ✅ GET /reservations - List all reservations for a restaurant
// Supports filtering by date range: ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
router.get("/reservations", async (req, res) => {
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;

  const { start_date, end_date, table_number } = req.query;

  try {
    await ensureReservationGuestCompositionFields();

    // Fire-and-forget, throttled to avoid opening extra DB connections on every poll.
    scheduleCloseStaleReservations(restaurantId);

    let query = `
      SELECT
        id,
        table_number,
        reservation_date,
        reservation_time,
        reservation_clients,
        reservation_men,
        reservation_women,
        reservation_notes,
        status,
        order_type,
        total,
        customer_name,
        customer_phone,
        created_at,
        updated_at
      FROM orders
      WHERE restaurant_id = $1
        AND (
          (LOWER(COALESCE(status,'')) = 'reserved' AND LOWER(COALESCE(status,'')) NOT IN ('closed', 'cancelled', 'canceled'))
          OR (reservation_date IS NOT NULL AND LOWER(COALESCE(status,'')) NOT IN ('closed', 'cancelled', 'canceled'))
        )
    `;
    const params = [restaurantId];
    let paramIdx = 2;

    // Filter by date range if provided
    if (start_date) {
      query += ` AND reservation_date::date >= $${paramIdx++}::date`;
      params.push(start_date);
    }

    if (end_date) {
      query += ` AND reservation_date::date <= $${paramIdx++}::date`;
      params.push(end_date);
    }

    // Filter by table number if provided
    if (table_number) {
      query += ` AND table_number = $${paramIdx++}`;
      params.push(parseInt(table_number));
    }

    query += ` ORDER BY
      reservation_date ASC,
      reservation_time ASC,
      CASE
        WHEN LOWER(COALESCE(status, '')) = 'checked_in' THEN 0
        WHEN LOWER(COALESCE(status, '')) = 'confirmed' THEN 1
        WHEN LOWER(COALESCE(status, '')) = 'reserved' THEN 2
        ELSE 3
      END ASC,
      updated_at DESC,
      id DESC`;

    const result = await pool.query(query, params);
    
    console.log(`📋 [GET /reservations] Query found ${result.rowCount} reservations for restaurant ${restaurantId}, date range: ${start_date} to ${end_date}`);

    res.json({
      success: true,
      count: result.rowCount,
      reservations: result.rows,
    });
  } catch (err) {
    if (isConnectionTimeoutError(err)) {
      console.warn(
        "⚠️ Reservations fetch timeout. Returning empty list to keep client responsive.",
        err?.message || err
      );
      return res.json({
        success: true,
        count: 0,
        reservations: [],
      });
    }
    console.error("❌ Error fetching reservations:", err);
    res.status(500).json({ error: "Failed to fetch reservations" });
  }
});

// ✅ PUT /reservations/:id - Update an existing reservation
router.put("/reservations/:id", async (req, res) => {
  const { id } = req.params;
  const {
    reservation_date,
    reservation_time,
    reservation_clients,
    reservation_men,
    reservation_women,
    reservation_notes,
  } = req.body;
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;

  try {
    await ensureReservationGuestCompositionFields();

    // Build dynamic UPDATE query
    const updates = [];
    const params = [];
    let paramIdx = 1;

    if (reservation_date) {
      updates.push(`reservation_date = $${paramIdx++}::date`);
      params.push(reservation_date);
    }

    if (reservation_time) {
      updates.push(`reservation_time = $${paramIdx++}::time`);
      params.push(reservation_time);
    }

    if (reservation_clients !== undefined) {
      updates.push(`reservation_clients = $${paramIdx++}::integer`);
      params.push(parseInt(reservation_clients) || 0);
    }

    if (reservation_men !== undefined) {
      updates.push(`reservation_men = $${paramIdx++}::integer`);
      params.push(reservation_men === null || reservation_men === "" ? null : parseInt(reservation_men) || 0);
    }

    if (reservation_women !== undefined) {
      updates.push(`reservation_women = $${paramIdx++}::integer`);
      params.push(
        reservation_women === null || reservation_women === "" ? null : parseInt(reservation_women) || 0
      );
    }

    if (reservation_notes !== undefined) {
      updates.push(`reservation_notes = $${paramIdx++}::text`);
      params.push((reservation_notes || "").trim());
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    // Add WHERE clause with properly tracked parameter indices
    updates.push(`updated_at = NOW()`);
    params.push(restaurantId);
    params.push(id);

    const query = `
      UPDATE orders
      SET ${updates.join(", ")}
      WHERE restaurant_id = $${paramIdx++}::integer AND id = $${paramIdx++}::integer
      RETURNING *
    `;

    const result = await pool.query(query, params);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    emitReservationStateUpdate(restaurantId, result.rows[0], {
      changes: req.body,
    });

    res.json({
      success: true,
      message: "✅ Reservation updated",
      reservation: result.rows[0],
    });
  } catch (err) {
    console.error("❌ Error updating reservation:", err);
    res.status(500).json({ error: "Failed to update reservation" });
  }
});

// ✅ GET /reservations/:id - Get single reservation details
router.get("/reservations/:id", async (req, res) => {
  const { id } = req.params;
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;

  try {
    await ensureReservationGuestCompositionFields();

    const result = await pool.query(
      `SELECT
        id,
        table_number,
        reservation_date,
        reservation_time,
        reservation_clients,
        reservation_men,
        reservation_women,
        reservation_notes,
        status,
        order_type,
        total,
        customer_name,
        customer_phone,
        created_at,
        updated_at
      FROM orders
      WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    res.json({
      success: true,
      reservation: result.rows[0],
    });
  } catch (err) {
    console.error("❌ Error fetching reservation:", err);
    res.status(500).json({ error: "Failed to fetch reservation" });
  }
});

const emitReservationStateUpdate = (restaurantId, reservationOrder, extraPayload = {}) => {
  if (!reservationOrder || !restaurantId) return;
  const payload = {
    reservation_id: reservationOrder.id,
    order_id: reservationOrder.id,
    table_number: reservationOrder.table_number,
    status: reservationOrder.status,
    order_type: reservationOrder.order_type,
    reservation_date: reservationOrder.reservation_date,
    reservation_time: reservationOrder.reservation_time,
    reservation_clients: reservationOrder.reservation_clients,
    reservation_men: reservationOrder.reservation_men ?? null,
    reservation_women: reservationOrder.reservation_women ?? null,
    reservation_notes: reservationOrder.reservation_notes,
    customer_name: reservationOrder.customer_name || null,
    customer_phone: reservationOrder.customer_phone || null,
    ...extraPayload,
  };

  io.to(`restaurant_${restaurantId}`).emit("orders_updated");
  io.to(`restaurant_${restaurantId}`).emit("reservation_updated", payload);
  return payload;
};

const emitReservationCreated = (restaurantId, reservationOrder, extraPayload = {}) => {
  if (!reservationOrder || !restaurantId) return;
  const payload = {
    reservation_id: reservationOrder.id,
    order_id: reservationOrder.id,
    table_number: reservationOrder.table_number,
    status: reservationOrder.status,
    order_type: reservationOrder.order_type,
    reservation_date: reservationOrder.reservation_date,
    reservation_time: reservationOrder.reservation_time,
    reservation_clients: reservationOrder.reservation_clients,
    reservation_men: reservationOrder.reservation_men ?? null,
    reservation_women: reservationOrder.reservation_women ?? null,
    reservation_notes: reservationOrder.reservation_notes,
    customer_name: reservationOrder.customer_name || null,
    customer_phone: reservationOrder.customer_phone || null,
    ...extraPayload,
  };

  io.to(`restaurant_${restaurantId}`).emit("orders_updated");
  io.to(`restaurant_${restaurantId}`).emit("reservation_created", payload);
  return payload;
};

const checkInReservationOrder = async ({ restaurantId, orderId }) => {
  try {
    await ensureConcertTables(pool);
    const concertBookingResult = await pool.query(
      `SELECT
         id,
         booking_type,
         payment_status,
         booking_status
       FROM concert_bookings
       WHERE restaurant_id = $1
         AND reservation_order_id = $2
         AND LOWER(COALESCE(booking_type, '')) IN ('table', 'ticket')
       ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
       LIMIT 1`,
      [restaurantId, orderId]
    );
    const linkedConcertBooking = concertBookingResult.rows?.[0] || null;
    if (linkedConcertBooking) {
      const paymentStatus = String(linkedConcertBooking.payment_status || "").toLowerCase();
      const bookingStatus = String(linkedConcertBooking.booking_status || "").toLowerCase();
      if (paymentStatus !== "confirmed") {
        const err = new Error(
          paymentStatus === "cancelled"
            ? "Concert booking is cancelled. Check-in is blocked."
            : "Concert booking is not confirmed yet. Please confirm booking before check-in."
        );
        err.status = 409;
        err.code = "concert_booking_unconfirmed";
        err.paymentStatus = paymentStatus || null;
        err.bookingStatus = bookingStatus || null;
        throw err;
      }
    }
  } catch (err) {
    if (err?.code === "concert_booking_unconfirmed") {
      throw err;
    }
    console.warn(
      "⚠️ Failed to validate concert booking confirmation before check-in:",
      err?.message || err
    );
  }

  const result = await pool.query(
    `UPDATE orders o
        SET status = 'checked_in',
            order_type = CASE
              WHEN LOWER(COALESCE(o.order_type, '')) = 'reservation' THEN 'table'
              ELSE COALESCE(o.order_type, 'table')
            END,
            updated_at = NOW()
      WHERE o.restaurant_id = $1
        AND o.id = $2
        AND LOWER(COALESCE(o.status, '')) NOT IN ('closed', 'completed', 'cancelled', 'canceled')
        AND (
          LOWER(COALESCE(o.status, '')) IN ('reserved', 'checked_in')
          OR LOWER(COALESCE(o.order_type, '')) = 'reservation'
          OR o.reservation_date IS NOT NULL
          OR o.reservation_time IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM concert_bookings cb
            WHERE cb.restaurant_id = o.restaurant_id
              AND cb.reservation_order_id = o.id
              AND LOWER(COALESCE(cb.booking_type, '')) = 'ticket'
              AND LOWER(COALESCE(cb.payment_status, '')) = 'confirmed'
              AND LOWER(COALESCE(cb.booking_status, '')) <> 'cancelled'
          )
        )
      RETURNING o.*`,
    [restaurantId, orderId]
  );

  return result.rows[0] || null;
};

// ✅ POST /reservations/:id/checkin - Mark a reservation guest as checked in
router.post("/reservations/:id/checkin", async (req, res) => {
  const { id } = req.params;
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;

  const reservationId = Number(id);
  if (!Number.isFinite(reservationId)) {
    return res.status(400).json({ error: "Invalid reservation id" });
  }

  try {
    const updatedReservation = await checkInReservationOrder({
      restaurantId,
      orderId: reservationId,
    });

    if (!updatedReservation) {
      return res.status(404).json({ error: "Reservation not found or cannot be checked in" });
    }

    const payload = emitReservationStateUpdate(restaurantId, updatedReservation, {
      event: "checked_in",
    });
    io.to(`restaurant_${restaurantId}`).emit("reservation_checked_in", payload);

    return res.json({
      success: true,
      message: "✅ Guest checked in",
      reservation: updatedReservation,
    });
  } catch (err) {
    if (Number(err?.status) === 409 && err?.code === "concert_booking_unconfirmed") {
      return res.status(409).json({
        error: err.message,
        code: err.code,
        payment_status: err.paymentStatus || null,
        booking_status: err.bookingStatus || null,
      });
    }
    console.error("❌ Error checking in reservation:", err);
    return res.status(500).json({ error: "Failed to check in reservation" });
  }
});

// ✅ DELETE /reservations/:id - Cancel a reservation
router.delete("/reservations/:id", async (req, res) => {
  const { id } = req.params;
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;
  const deleteReason = String(
    req.body?.delete_reason ?? req.body?.cancellation_reason ?? req.body?.reason ?? ""
  ).trim();

  try {
    const snapshotResult = await pool.query(
      `
      SELECT
        id,
        order_number,
        customer_name,
        customer_phone,
        reservation_date,
        reservation_time,
        reservation_clients,
        reservation_notes,
        table_number,
        cancellation_reason,
        cancelled_at,
        updated_at
      FROM orders
      WHERE restaurant_id = $1
        AND id = $2
      LIMIT 1
      `,
      [restaurantId, Number(id)]
    );
    const reservationSnapshot = snapshotResult.rows?.[0] || null;
    const result = await pool.query(
      `UPDATE orders o
       SET reservation_date = NULL,
           reservation_time = NULL,
           reservation_clients = NULL,
           reservation_notes = NULL,
           status = CASE
             WHEN COALESCE(o.total, 0) <= 0
               AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id LIMIT 1)
             THEN 'closed'
             WHEN LOWER(COALESCE(o.status, '')) = 'reserved' THEN 'confirmed'
             ELSE o.status
           END,
           cancellation_reason = CASE
             WHEN COALESCE(o.total, 0) <= 0
               AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id LIMIT 1)
             THEN NULLIF($3, '')
             ELSE o.cancellation_reason
           END,
           order_type = CASE
             WHEN LOWER(COALESCE(o.order_type, '')) = 'reservation' THEN 'table'
             ELSE o.order_type
           END,
           updated_at = NOW()
       WHERE o.restaurant_id = $1
         AND o.id = $2
         AND (
           LOWER(COALESCE(o.status, '')) = 'reserved'
           OR LOWER(COALESCE(o.order_type, '')) = 'reservation'
         )
       RETURNING o.id, o.table_number, o.status, o.order_type, o.cancellation_reason`,
      [restaurantId, id, deleteReason]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Reservation not found or cannot be cancelled" });
    }

    await cancelLinkedConcertBookings(pool, restaurantId, id, {
      cancellationReason: "reservation_deleted",
    });

    // Emit cancellation to frontend
    io.to(`restaurant_${restaurantId}`).emit("orders_updated");
    const cancelledReservation = result.rows[0];
    const payload = {
      reservation_id: cancelledReservation.id,
      table_number: cancelledReservation.table_number,
      status: cancelledReservation.status,
      order_type: cancelledReservation.order_type,
      cancellation_reason: cancelledReservation.cancellation_reason || null,
    };
    io.to(`restaurant_${restaurantId}`).emit("reservation_cancelled", payload);
    io.to(`restaurant_${restaurantId}`).emit("reservation_deleted", payload);

    await sendOrderCustomerCancellationEmail({
      pool,
      restaurantId,
      orderId: Number(cancelledReservation.id),
      triggeredFrom: "orders.reservations.cancelled",
      req,
      orderSnapshot: {
        ...(reservationSnapshot || {}),
        cancellation_reason: deleteReason || reservationSnapshot?.cancellation_reason || null,
        cancelled_at: new Date(),
      },
    });

    res.json({
      success: true,
      message: "✅ Reservation removed",
      reservation: cancelledReservation,
    });
  } catch (err) {
    console.error("❌ Error cancelling reservation:", err);
    res.status(500).json({ error: "Failed to cancel reservation" });
  }
});

// ✅ POST /orders/:id/reservations - Mobile app route to create reservation for an order
router.post("/:id/reservations", async (req, res) => {
  const { id } = req.params;
  const {
    reservation_date,
    reservation_time,
    reservation_clients,
    reservation_men,
    reservation_women,
    reservation_notes,
  } = req.body;
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;

  try {
    await ensureReservationGuestCompositionFields();

    if (!reservation_date || !reservation_time) {
      return res.status(400).json({ error: "Reservation date and time are required" });
    }

    const clientCount = parseInt(reservation_clients) || 0;
    const notes = (reservation_notes || "").trim();
    const dateStr = String(reservation_date).trim();
    const timeStr = String(reservation_time).trim();

    const result = await pool.query(
      `UPDATE orders 
       SET reservation_date = $1, 
           reservation_time = $2, 
           reservation_clients = $3, 
           reservation_men = $4,
           reservation_women = $5,
           reservation_notes = $6,
           updated_at = NOW()
       WHERE id = $7 AND restaurant_id = $8
       RETURNING id, reservation_date, reservation_time, reservation_clients, reservation_men, reservation_women, reservation_notes`,
      [
        dateStr,
        timeStr,
        clientCount,
        reservation_men === null || reservation_men === "" ? null : parseInt(reservation_men) || 0,
        reservation_women === null || reservation_women === "" ? null : parseInt(reservation_women) || 0,
        notes,
        id,
        restaurantId,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json({
      message: "✅ Reservation created",
      reservation: result.rows[0],
    });
  } catch (err) {
    console.error("❌ Error creating reservation:", err);
    res.status(500).json({ error: "Failed to create reservation" });
  }
});

// ✅ PUT /orders/:id/reservations - Mobile app route to update reservation for an order
router.put("/:id/reservations", async (req, res) => {
  const { id } = req.params;
  const {
    reservation_date,
    reservation_time,
    reservation_clients,
    reservation_men,
    reservation_women,
    reservation_notes,
  } = req.body;
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;

  try {
    await ensureReservationGuestCompositionFields();

    if (!reservation_date || !reservation_time) {
      return res.status(400).json({ error: "Reservation date and time are required" });
    }

    const clientCount = parseInt(reservation_clients) || 0;
    const notes = (reservation_notes || "").trim();
    const dateStr = String(reservation_date).trim();
    const timeStr = String(reservation_time).trim();

    const result = await pool.query(
      `UPDATE orders 
       SET reservation_date = $1, 
           reservation_time = $2, 
           reservation_clients = $3, 
           reservation_men = $4,
           reservation_women = $5,
           reservation_notes = $6,
           updated_at = NOW()
       WHERE id = $7 AND restaurant_id = $8
       RETURNING id, reservation_date, reservation_time, reservation_clients, reservation_men, reservation_women, reservation_notes`,
      [
        dateStr,
        timeStr,
        clientCount,
        reservation_men === null || reservation_men === "" ? null : parseInt(reservation_men) || 0,
        reservation_women === null || reservation_women === "" ? null : parseInt(reservation_women) || 0,
        notes,
        id,
        restaurantId,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json({
      message: "✅ Reservation updated",
      reservation: result.rows[0],
    });
  } catch (err) {
    console.error("❌ Error updating reservation:", err);
    res.status(500).json({ error: "Failed to update reservation" });
  }
});

// ✅ DELETE /orders/:id/reservations - Remove reservation from an order/table
router.delete("/:id/reservations", async (req, res) => {
  const { id } = req.params;
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;
  const deleteReason = String(
    req.body?.delete_reason ?? req.body?.cancellation_reason ?? req.body?.reason ?? ""
  ).trim();

  const orderId = Number(id);
  if (!Number.isFinite(orderId)) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  try {
    const snapshotResult = await pool.query(
      `
      SELECT
        id,
        order_number,
        customer_name,
        customer_phone,
        reservation_date,
        reservation_time,
        reservation_clients,
        reservation_notes,
        table_number,
        cancellation_reason,
        cancelled_at,
        updated_at
      FROM orders
      WHERE restaurant_id = $1
        AND id = $2
      LIMIT 1
      `,
      [restaurantId, orderId]
    );
    const reservationSnapshot = snapshotResult.rows?.[0] || null;
    const { rows } = await pool.query(
      `SELECT id, status, order_type, total
         FROM orders
        WHERE restaurant_id = $1 AND id = $2
        LIMIT 1`,
      [restaurantId, orderId]
    );
    if (!rows.length) return res.status(404).json({ error: "Order not found" });

    const order = rows[0];
    const total = Number(order.total || 0);

    const { rowCount: hasItems } = await pool.query(
      `SELECT 1 FROM order_items WHERE order_id = $1 LIMIT 1`,
      [orderId]
    );

    // If it's an empty reservation-only order, close it so the table becomes free.
    const shouldClose = (!hasItems || hasItems === 0) && total <= 0;

    const updated = await pool.query(
      `UPDATE orders
          SET reservation_date = NULL,
              reservation_time = NULL,
              reservation_clients = NULL,
              reservation_notes = NULL,
              status = CASE
                WHEN $3 THEN 'closed'
                WHEN LOWER(COALESCE(status,'')) = 'reserved' THEN 'confirmed'
                ELSE status
              END,
              cancellation_reason = CASE
                WHEN $3 THEN NULLIF($4, '')
                ELSE cancellation_reason
              END,
              order_type = CASE
                WHEN LOWER(COALESCE(order_type,'')) = 'reservation' THEN 'table'
                ELSE order_type
              END,
              updated_at = NOW()
        WHERE restaurant_id = $1 AND id = $2
        RETURNING *`,
      [restaurantId, orderId, shouldClose, deleteReason]
    );

    const updatedOrder = updated.rows[0];
    await cancelLinkedConcertBookings(pool, restaurantId, orderId, {
      cancellationReason: "reservation_deleted",
    });
    io.to(`restaurant_${restaurantId}`).emit("orders_updated");
    if (updatedOrder) {
      const reservationPayload = {
        reservation_id: updatedOrder.id,
        table_number: updatedOrder.table_number,
        status: updatedOrder.status,
        order_type: updatedOrder.order_type,
        cancellation_reason: updatedOrder.cancellation_reason || null,
      };
      io.to(`restaurant_${restaurantId}`).emit("reservation_cancelled", reservationPayload);
      io.to(`restaurant_${restaurantId}`).emit("reservation_deleted", reservationPayload);
    }

    await sendOrderCustomerCancellationEmail({
      pool,
      restaurantId,
      orderId,
      triggeredFrom: "orders.order_reservations.cancelled",
      req,
      orderSnapshot: {
        ...(reservationSnapshot || {}),
        cancellation_reason: shouldClose ? deleteReason || reservationSnapshot?.cancellation_reason || null : reservationSnapshot?.cancellation_reason || null,
        cancelled_at: new Date(),
      },
    });

    return res.json({
      success: true,
      message: "✅ Reservation removed",
      order: updatedOrder,
    });
  } catch (err) {
    console.error("❌ Error deleting reservation for order:", err);
    return res.status(500).json({ error: "Failed to delete reservation" });
  }
});

// ✅ POST /orders/:id/reservations/checkin - Mark reservation guest as checked in
router.post("/:id/reservations/checkin", async (req, res) => {
  const { id } = req.params;
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;

  const orderId = Number(id);
  if (!Number.isFinite(orderId)) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  try {
    const updatedOrder = await checkInReservationOrder({
      restaurantId,
      orderId,
    });

    if (!updatedOrder) {
      return res.status(404).json({ error: "Reservation not found or cannot be checked in" });
    }

    const payload = emitReservationStateUpdate(restaurantId, updatedOrder, {
      event: "checked_in",
    });
    io.to(`restaurant_${restaurantId}`).emit("reservation_checked_in", payload);

    return res.json({
      success: true,
      message: "✅ Guest checked in",
      order: updatedOrder,
      reservation: updatedOrder,
    });
  } catch (err) {
    if (Number(err?.status) === 409 && err?.code === "concert_booking_unconfirmed") {
      return res.status(409).json({
        error: err.message,
        code: err.code,
        payment_status: err.paymentStatus || null,
        booking_status: err.bookingStatus || null,
      });
    }
    console.error("❌ Error checking in reservation for order:", err);
    return res.status(500).json({ error: "Failed to check in reservation" });
  }
});

// 🧪 TEST ENDPOINT: Manually trigger Yemeksepeti status sync for debugging
router.post("/:id/test-yemeksepeti-sync", async (req, res) => {
  try {
    const { id } = req.params;
    dlog(`🧪 TEST: Manually triggering Yemeksepeti sync for order ${id}`);

    // Simulate what happens when driver presses "delivered"
    const result = await sendExternalOrderPickedUp({ orderId: Number(id) });

    res.json({
      success: true,
      message: "✅ Yemeksepeti sync test completed - check backend logs",
      syncResult: result,
      expectedBehavior: result?.skipped 
        ? `Sync skipped (reason: ${result.reason})`
        : result?.ok
        ? "✅ Order status sent to Yemeksepeti (order_picked_up)"
        : "❌ Sync failed - check error details above",
    });
  } catch (err) {
    console.error("❌ Yemeksepeti sync test failed:", err);
    res.status(500).json({ 
      error: "Test failed", 
      details: err.message,
      logs: "Check backend console for details"
    });
  }
});

return router;
};
