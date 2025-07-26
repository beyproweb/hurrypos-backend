const { pool } = require("../db");

// Emits a generic orders update event
const emitOrderUpdate = (io) => {
  io.emit('orders_updated');
};

// Emits when stock is updated
const emitStockUpdate = (io, stockId) => {
  console.log("📡 Emitting stock-updated via socket for stock ID:", stockId);
  io.emit('stock-updated', { stockId });
};

// Emits when an order is confirmed
const emitOrderConfirmed = (io, orderId) => {
  console.log("📡 Emitting order_confirmed for order:", orderId);
  io.emit('order_confirmed', { orderId });
};

// Helper to save notification to DB
async function saveNotification({ message, type, stockId, extra }) {
  try {
    await pool.query(
      `INSERT INTO notifications (message, type, stock_id, extra)
       VALUES ($1, $2, $3, $4)`,
      [message, type, stockId, extra ? JSON.stringify(extra) : null]
    );
  } catch (e) {
    console.error("Failed to save notification:", e);
  }
}

// Unified emitAlert (emits and saves)
async function emitAlert(io, message, stockId = null, type = "other", extra = {}) {
  const payload = {
    message,
    time: Date.now(),
    type,
    stockId,
    ...extra,
  };
  io.emit("alert_event", payload);
  console.log("📢 Alert Emitted:", payload);

  await saveNotification({ message, type, stockId, extra });
}

// Emits when an order is delivered
const emitOrderDelivered = (io, orderId) => {
  console.log("📡 Emitting order_delivered for order:", orderId);
  io.emit('order_delivered', { orderId });
};

function emitCustomerCall(io, data) {
  io.emit('customer_call', data);
}

module.exports = {
  emitOrderUpdate,
  emitStockUpdate,
  emitOrderConfirmed,
  emitOrderDelivered,
  emitCustomerCall,
  emitAlert,
};
