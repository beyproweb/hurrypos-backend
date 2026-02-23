// utils/migrosOrderSync.js
/**
 * Migros Order Status Synchronization
 * Sends order status updates to Migros using v2 endpoints with encryption
 */

const { pool } = require("../db");
const {
  postToMigros,
  mapBeyprosStatusToMigros,
  getMigrosApiKeyForRestaurant,
  recordMigrosApiError,
} = require("./migrosClient");

const dlog = (...args) =>
  console.log(new Date().toISOString(), "[migros-order-sync]", ...args);

// =========================================================
// STATUS UPDATE FUNCTIONS
// =========================================================

/**
 * Send order status update to Migros (v2 endpoint)
 * @param {number} orderId - Beypro order ID
 * @param {string} newStatus - New Beypro status (confirmed, prepared, dispatched, etc.)
 * @returns {Promise<{ok: boolean, status: number, data?: any, error?: string}>}
 */
async function sendMigrosOrderStatusUpdate(orderId, newStatus) {
  if (!orderId) {
    return { ok: false, error: "Missing orderId" };
  }

  try {
    // Fetch order details
    const { rows } = await pool.query(
      `SELECT restaurant_id, external_id, external_source FROM orders WHERE id = $1 LIMIT 1`,
      [orderId]
    );

    if (!rows.length) {
      dlog(`⚠️  Order ${orderId} not found`);
      return { ok: false, error: "Order not found" };
    }

    const order = rows[0];
    if (order.external_source !== "migros") {
      dlog(`ℹ️  Order ${orderId} is not a Migros order`);
      return { ok: false, error: "Not a Migros order" };
    }

    // Get Migros API key for this restaurant
    const keyInfo = await getMigrosApiKeyForRestaurant(order.restaurant_id);
    if (!keyInfo) {
      dlog(`❌ No Migros API key found for restaurant ${order.restaurant_id}`);
      await recordMigrosApiError(
        "Order/v2/UpdateOrderStatus",
        400,
        "No API key for restaurant"
      );
      return { ok: false, error: "No API key configured" };
    }

    // Map Beypro status to Migros orderStatus
    const migrosStatus = mapBeyprosStatusToMigros(newStatus);

    // Build request body
    const requestBody = {
      orderId: order.external_id, // Migros order ID
      storeId: keyInfo.store_id,
      orderStatus: migrosStatus,
    };

    dlog(`📤 Updating Migros order ${order.external_id} to status: ${migrosStatus}`);

    // Send to Migros
    const result = await postToMigros(
      "Order/v2/UpdateOrderStatus",
      keyInfo.api_key,
      requestBody,
      process.env.MIGROS_SECRET_KEY,
      { retries: 2 }
    );

    if (!result.ok) {
      dlog(`❌ Failed to update Migros order status: ${result.error}`);
      await recordMigrosApiError(
        "Order/v2/UpdateOrderStatus",
        result.status,
        result.error
      );
      return {
        ok: false,
        status: result.status,
        error: result.error,
      };
    }

    dlog(`✅ Migros order ${order.external_id} status updated to ${migrosStatus}`);
    return {
      ok: true,
      status: 200,
      data: result.data,
    };
  } catch (err) {
    dlog(`❌ Error updating order status: ${err.message}`);
    await recordMigrosApiError("Order/v2/UpdateOrderStatus", 500, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Send order cancellation to Migros (v2 endpoint)
 * @param {number} orderId - Beypro order ID
 * @param {string} cancelReason - Reason for cancellation
 * @param {number} cancelReasonId - Migros cancel reason ID
 * @returns {Promise<{ok: boolean, status: number, data?: any, error?: string}>}
 */
async function sendMigrosOrderCancel(orderId, cancelReason, cancelReasonId) {
  if (!orderId) {
    return { ok: false, error: "Missing orderId" };
  }

  try {
    // Fetch order details
    const { rows } = await pool.query(
      `SELECT restaurant_id, external_id, external_source FROM orders WHERE id = $1 LIMIT 1`,
      [orderId]
    );

    if (!rows.length) {
      dlog(`⚠️  Order ${orderId} not found`);
      return { ok: false, error: "Order not found" };
    }

    const order = rows[0];
    if (order.external_source !== "migros") {
      dlog(`ℹ️  Order ${orderId} is not a Migros order`);
      return { ok: false, error: "Not a Migros order" };
    }

    // Get Migros API key
    const keyInfo = await getMigrosApiKeyForRestaurant(order.restaurant_id);
    if (!keyInfo) {
      dlog(`❌ No Migros API key found for restaurant ${order.restaurant_id}`);
      await recordMigrosApiError(
        "Order/v2/CancelOrder",
        400,
        "No API key for restaurant"
      );
      return { ok: false, error: "No API key configured" };
    }

    // Build cancel request
    const requestBody = {
      orderId: order.external_id, // Migros order ID
      storeId: keyInfo.store_id,
      notifyUser: true,
      cancelReasonId: cancelReasonId || 1, // Default cancel reason ID
      userId: 0, // POS system user
    };

    dlog(
      `🚫 Cancelling Migros order ${order.external_id}, reason: ${cancelReason}`
    );

    // Send to Migros
    const result = await postToMigros(
      "Order/v2/CancelOrder",
      keyInfo.api_key,
      requestBody,
      process.env.MIGROS_SECRET_KEY,
      { retries: 2 }
    );

    if (!result.ok) {
      dlog(`❌ Failed to cancel Migros order: ${result.error}`);
      await recordMigrosApiError(
        "Order/v2/CancelOrder",
        result.status,
        result.error
      );
      return {
        ok: false,
        status: result.status,
        error: result.error,
      };
    }

    dlog(`✅ Migros order ${order.external_id} cancelled`);
    return {
      ok: true,
      status: 200,
      data: result.data,
    };
  } catch (err) {
    dlog(`❌ Error cancelling order: ${err.message}`);
    await recordMigrosApiError("Order/v2/CancelOrder", 500, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Trigger all relevant status updates based on order status change
 * Maps internal status to Migros flow: Approved -> Prepared -> Delivery -> Completed
 * @param {number} orderId - Beypro order ID
 * @param {string} newStatus - New order status
 * @returns {Promise<void>}
 */
async function syncMigrosOrderStatusAsync(orderId, newStatus) {
  try {
    const result = await sendMigrosOrderStatusUpdate(orderId, newStatus);
    if (!result.ok) {
      dlog(`⚠️  Async sync failed for order ${orderId}: ${result.error}`);
    }
  } catch (err) {
    dlog(`❌ Async sync error for order ${orderId}:`, err.message);
  }
}

module.exports = {
  sendMigrosOrderStatusUpdate,
  sendMigrosOrderCancel,
  syncMigrosOrderStatusAsync,
};
