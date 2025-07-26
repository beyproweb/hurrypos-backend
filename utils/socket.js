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
      methods: ["GET", "POST", "PATCH", "PUT"]
    },
  });

  io.on("connection", (socket) => {
    console.log("✅ Socket connected:", socket.id);
    socket.on("disconnect", () => {
      console.log("❌ Socket disconnected:", socket.id);
    });
  });

  global.io = io; // add this line for global debugging reference

  return io;
}

function getIO() {
  if (!io) {
    throw new Error("❌ Socket.io not initialized yet!");
  }
  return io;
}

module.exports = { initSocket, getIO };
