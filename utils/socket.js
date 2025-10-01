const { Server } = require("socket.io");
let io = null;

function initSocket(server) {
  if (io) {
    console.log("!!! WARNING: Socket.IO already initialized");
    return io;
  }

  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST", "PATCH", "PUT"],
    },
  });

  io.on("connection", (socket) => {
    console.log("✅ Socket connected:", socket.id);

    // Client tells us which restaurant they belong to
    socket.on("join_restaurant", (restaurantId) => {
      if (!restaurantId) return;
      socket.join(`restaurant_${restaurantId}`);
      console.log(`👥 Socket ${socket.id} joined restaurant_${restaurantId}`);
    });

    socket.on("leave_restaurant", (restaurantId) => {
      if (!restaurantId) return;
      socket.leave(`restaurant_${restaurantId}`);
      console.log(`👋 Socket ${socket.id} left restaurant_${restaurantId}`);
    });

    socket.on("disconnect", () => {
      console.log("❌ Socket disconnected:", socket.id);
    });
  });

  global.io = io; // optional global ref for debugging

  return io;
}

function getIO() {
  if (!io) {
    throw new Error("❌ Socket.io not initialized yet!");
  }
  return io;
}

module.exports = { initSocket, getIO };
