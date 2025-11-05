const { pool } = require("../db");

/* ---------------------------------------------
   🔊 Real-time socket helpers for tenant rooms
--------------------------------------------- */

// Emits generic order update
const emitOrderUpdate = (io, restaurantId) => {
  io.to(`restaurant_${restaurantId}`).emit("orders_updated");
};

// Emits when stock is updated
const emitStockUpdate = (io, restaurantId, stockId) => {
  console.log(`📡 Emitting stock-updated for stock ${stockId}, restaurant: ${restaurantId}`);
  io.to(`restaurant_${restaurantId}`).emit("stock-updated", { stockId });
};

// Emits when an order is confirmed
const emitOrderConfirmed = (io, restaurantId, orderId) => {
  console.log(`📡 Emitting order_confirmed for order ${orderId}, restaurant: ${restaurantId}`);
  io.to(`restaurant_${restaurantId}`).emit("order_confirmed", { orderId });
};

// Emits when an order moves to preparing
const emitOrderPreparing = (io, restaurantId, orderId) => {
  console.log(`📡 Emitting order_preparing for order ${orderId}, restaurant: ${restaurantId}`);
  io.to(`restaurant_${restaurantId}`).emit("order_preparing", { orderId });
};

// Emits when an order becomes ready
const emitOrderReady = (io, restaurantId, orderId) => {
  console.log(`📡 Emitting order_ready for order ${orderId}, restaurant: ${restaurantId}`);
  io.to(`restaurant_${restaurantId}`).emit("order_ready", { orderId });
};

const emitDriverAssigned = (io, restaurantId, orderId, driverInfo = {}) => {
  console.log(`📡 Emitting driver_assigned for order ${orderId}, restaurant: ${restaurantId}`);
  io.to(`restaurant_${restaurantId}`).emit("driver_assigned", {
    orderId,
    driverId: driverInfo.driverId ?? driverInfo.driver_id ?? null,
    driverName: driverInfo.driverName ?? driverInfo.driver_name ?? null,
  });
};

// Emits when an order is delivered
const emitOrderDelivered = (io, restaurantId, orderId) => {
  console.log(`📡 Emitting order_delivered for order ${orderId}, restaurant: ${restaurantId}`);
  io.to(`restaurant_${restaurantId}`).emit("order_delivered", { orderId });
};

// Emits when a payment is made (deduplicated to avoid double toast)
// Emits when a payment is made (deduplicated across all routes)
const _paymentEmitLock = new Map();

const emitPaymentMade = (io, restaurantId, orderId, payment_method, total = null) => {
  const key = `${restaurantId}_${orderId}`;
  const now = Date.now();
  const lastEmit = _paymentEmitLock.get(key) || 0;

  // 🔒 Lock out any new emits for this order for 5 seconds
  if (now - lastEmit < 5000) {
    console.log(`⏸️ Skipping duplicate payment_made for order ${orderId} (locked 5s)`);
    return;
  }

  _paymentEmitLock.set(key, now);

  console.log(`📡 [emitPaymentMade] Sending payment_made for order ${orderId}, restaurant: ${restaurantId}`);
  io.to(`restaurant_${restaurantId}`).emit("payment_made", {
    orderId,
    payment_method,
    total,
    timestamp: now,
  });

  // Optional cleanup after 60s to keep memory small
  setTimeout(() => _paymentEmitLock.delete(key), 60000);
};



// Emits when stock becomes critical
const emitStockCritical = (io, restaurantId, stockId) => {
  console.log(`📡 Emitting stock_critical for stock ${stockId}, restaurant: ${restaurantId}`);
  io.to(`restaurant_${restaurantId}`).emit("stock_critical", { stockId });
};

/* ---------------------------------------------
   💾 DB persistence for notifications
--------------------------------------------- */
async function saveNotification({ message, type, stockId, restaurantId, extra }) {
  try {
    const safeStockId = isNaN(parseInt(stockId)) ? null : parseInt(stockId);
    await pool.query(
      `INSERT INTO notifications (message, type, stock_id, restaurant_id, extra)
       VALUES ($1, $2, $3, $4, $5)`,
      [message, type, safeStockId, restaurantId, extra ? JSON.stringify(extra) : null]
    );
  } catch (e) {
    console.error("❌ Failed to save notification:", e);
  }
}

/* ---------------------------------------------
   ⚡ Unified alert emitter
--------------------------------------------- */
async function emitAlert(io, restaurantId, message, stockId = null, type = "other", extra = {}) {
  const payload = { message, time: Date.now(), type, stockId, ...extra };
  io.to(`restaurant_${restaurantId}`).emit("alert_event", payload);
  console.log("📢 Alert Emitted:", payload);
  await saveNotification({ message, type, stockId, restaurantId, extra });
}

/* ---------------------------------------------
   🧠 Customer call event
--------------------------------------------- */
function emitCustomerCall(io, restaurantId, data) {
  io.to(`restaurant_${restaurantId}`).emit("customer_call", data);
}

/* ---------------------------------------------
   ✅ Export
--------------------------------------------- */
module.exports = {
  emitOrderUpdate,
  emitStockUpdate,
  emitOrderConfirmed,
  emitOrderPreparing,
  emitOrderReady,
  emitDriverAssigned,
  emitOrderDelivered,
  emitPaymentMade,
  emitStockCritical,
  emitCustomerCall,
  emitAlert,
};
