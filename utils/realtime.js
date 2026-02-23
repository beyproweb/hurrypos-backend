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
const emitOrderPreparing = (
  io,
  restaurantId,
  orderId,
  { 
    table_number = null, 
    table_label = null,
    customer_name = null,
    order_type = null,
    external_source = null,
    external_id = null,
    order_id = null
  } = {}
) => {
  const payload = {
    orderId,
    table_number,
    table_label,
    customer_name,
    order_type,
    external_source,
    external_id,
    order_id,
  };
  io.to(`restaurant_${restaurantId}`).emit("order_preparing", payload);
  
  // Save notification for bell/history
  saveNotification({
    restaurantId,
    message: `Kitchen preparing order`,
    type: "order",
    stockId: null,
    extra: { event: "order_preparing", order: payload },
  });
};

// Emits when an order becomes ready
const emitOrderReady = (io, restaurantId, orderId) => {
  console.log(`📡 Emitting order_ready for order ${orderId}, restaurant: ${restaurantId}`);
  io.to(`restaurant_${restaurantId}`).emit("order_ready", { orderId });
};

const emitDriverAssigned = (io, restaurantId, orderId, driverInfo = {}) => {
  console.log(`📡 Emitting driver_assigned for order ${orderId}, restaurant: ${restaurantId}`);
  const driverName = driverInfo.driverName ?? driverInfo.driver_name ?? null;
  io.to(`restaurant_${restaurantId}`).emit("driver_assigned", {
    orderId,
    driverId: driverInfo.driverId ?? driverInfo.driver_id ?? null,
    driverName,
  });

  // Persist for bell/history (no alert_event side effects)
  saveNotification({
    restaurantId,
    message: `${driverName || "Driver"} assigned to order #${orderId}`,
    type: "driver",
    stockId: null,
    extra: {
      orderId,
      driverId: driverInfo.driverId ?? driverInfo.driver_id ?? null,
      driverName,
    },
  });
};

// Emits when a driver is on the road
const emitDriverOnRoad = (io, restaurantId, orderId, { customer_name = null, driverName = null } = {}) => {
  console.log(`📡 Emitting driver_on_road for order ${orderId}, restaurant: ${restaurantId}`);
  io.to(`restaurant_${restaurantId}`).emit("driver_on_road", {
    orderId,
    customer_name,
    driverName,
  });

  // Persist for bell/history
  saveNotification({
    restaurantId,
    message: `On the way`,
    type: "driver",
    stockId: null,
    extra: {
      event: "driver_on_road",
      orderId,
      customer_name,
      driverName,
    },
  });
};

// Emits when an order is delivered
const emitOrderDelivered = (
  io,
  restaurantId,
  orderId,
  { 
    table_number = null, 
    table_label = null,
    customer_name = null,
    order_type = null,
    external_source = null,
    external_id = null,
    order_id = null
  } = {}
) => {
  const payload = {
    orderId,
    table_number,
    table_label,
    customer_name,
    order_type,
    external_source,
    external_id,
    order_id,
  };
  io.to(`restaurant_${restaurantId}`).emit("order_delivered", payload);
  
  // Save notification for bell/history
  saveNotification({
    restaurantId,
    message: `Kitchen delivered order`,
    type: "order",
    stockId: null,
    extra: { event: "order_delivered", order: payload },
  });
};

const emitOrderCancelled = (
  io,
  restaurantId,
  orderId,
  { table_number = null, table_label = null, reason = null } = {}
) => {
  console.log(`📡 Emitting order_cancelled for order ${orderId}, restaurant: ${restaurantId}`);
  const payload = {
    orderId,
    table_number,
    table_label,
    reason,
  };
  io.to(`restaurant_${restaurantId}`).emit("order_cancelled", payload);
  saveNotification({
    restaurantId,
    message: `Order cancelled`,
    type: "order",
    stockId: null,
    extra: { event: "order_cancelled", ...payload },
  });
};

// Emits when a payment is made (deduplicated to avoid double toast)
// Emits when a payment is made (deduplicated across all routes)
const _paymentEmitLock = new Map();

const emitPaymentMade = (
  io,
  restaurantId,
  orderId,
  {
    payment_method = null,
    total = null,
    amount = null,
    table_number = null,
    table_label = null,
    order_total_with_extras = null,
  } = {}
) => {
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
  const payload = {
    orderId,
    payment_method,
    total,
    amount,
    table_number,
    table_label,
    order_total_with_extras,
    orderTotalWithExtras: order_total_with_extras,
    timestamp: now,
  };
  io.to(`restaurant_${restaurantId}`).emit("payment_made", payload);

  // Persist for bell/history (deduped by emit lock)
  saveNotification({
    restaurantId,
    message: `💸 Payment made`,
    type: "payment",
    stockId: null,
    extra: payload,
  });

  // Optional cleanup after 60s to keep memory small
  setTimeout(() => _paymentEmitLock.delete(key), 60000);
};

// Emits when reports-related data changes (expenses, payroll, supplier payments, etc.)
const emitReportsRefresh = (io, restaurantId, extra = {}) => {
  try {
    if (!io || !restaurantId) return;
    const payload = { ...extra, timestamp: Date.now() };
    io.to(`restaurant_${restaurantId}`).emit("reports_refresh", payload);
  } catch (e) {
    console.warn("⚠️ emitReportsRefresh failed:", e?.message || e);
  }
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
  emitDriverOnRoad,
  emitOrderDelivered,
  emitOrderCancelled,
  emitPaymentMade,
  emitReportsRefresh,
  emitStockCritical,
  emitCustomerCall,
  emitAlert,
  saveNotification,
};
