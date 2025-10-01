const { pool } = require("../db");

// Emits a generic orders update event
const emitOrderUpdate = (io, restaurantId) => {
  io.to(`restaurant_${restaurantId}`).emit("orders_updated");
};

// Emits when stock is updated
const emitStockUpdate = (io, restaurantId, stockId) => {
  console.log(
    `📡 Emitting stock-updated via socket for stock ID: ${stockId}, restaurant: ${restaurantId}`
  );
  io.to(`restaurant_${restaurantId}`).emit("stock-updated", { stockId });
};

// Emits when an order is confirmed
const emitOrderConfirmed = (io, restaurantId, orderId) => {
  console.log(`📡 Emitting order_confirmed for order: ${orderId}, restaurant: ${restaurantId}`);
  io.to(`restaurant_${restaurantId}`).emit("order_confirmed", { orderId });
};

// Helper to save notification to DB
async function saveNotification({ message, type, stockId, restaurantId, extra }) {
  try {
    await pool.query(
      `INSERT INTO notifications (message, type, stock_id, restaurant_id, extra)
       VALUES ($1, $2, $3, $4, $5)`,
      [message, type, stockId, restaurantId, extra ? JSON.stringify(extra) : null]
    );
  } catch (e) {
    console.error("Failed to save notification:", e);
  }
}

// Unified emitAlert (emits and saves)
async function emitAlert(io, restaurantId, message, stockId = null, type = "other", extra = {}) {
  const payload = {
    message,
    time: Date.now(),
    type,
    stockId,
    ...extra,
  };
  io.to(`restaurant_${restaurantId}`).emit("alert_event", payload);
  console.log("📢 Alert Emitted:", payload);

  await saveNotification({ message, type, stockId, restaurantId, extra });
}

// Emits when an order is delivered
const emitOrderDelivered = (io, restaurantId, orderId) => {
  console.log(
    `📡 Emitting order_delivered for order: ${orderId}, restaurant: ${restaurantId}`
  );
  io.to(`restaurant_${restaurantId}`).emit("order_delivered", { orderId });
};

function emitCustomerCall(io, restaurantId, data) {
  io.to(`restaurant_${restaurantId}`).emit("customer_call", data);
}

module.exports = {
  emitOrderUpdate,
  emitStockUpdate,
  emitOrderConfirmed,
  emitOrderDelivered,
  emitCustomerCall,
  emitAlert,
};
