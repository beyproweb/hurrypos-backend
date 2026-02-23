// utils/socket.js
const { Server } = require("socket.io");
let io = null;

function initSocket(server) {
  if (io) {
    console.log("⚠️ Socket.IO already initialized");
    return io;
  }

  io = new Server(server, {
    cors: {
      // Allow web, onrender frontend, localhost dev, desktop apps, and mobile
     origin: (origin, callback) => {
  try {
    if (!origin) return callback(null, true);
    const normalized = String(origin).toLowerCase();
    const isDev = process.env.NODE_ENV !== "production";
    const isPrivateLanOrigin =
      /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(
        normalized
      );
    const allowList = new Set([
      "http://localhost:5173",
      "https://pos.beypro.com",
      "https://www.pos.beypro.com",
      "https://hurrypos-frontend.onrender.com",
      "https://hurrypos-backend.onrender.com:443", // ✅ Legacy Render
      "https://hurrypos-backend.onrender.com",
      "https://api.beypro.com:443",                // ✅ New AWS API
      "https://api.beypro.com",
      "http://localhost:8081",                     // ✅ Expo dev server (Android)
      "http://localhost:19000",                    // ✅ Expo dev server (legacy)
      "http://localhost:19006",                    // ✅ Expo web/devtools
    ]);

    const isExpoOrigin =
      normalized.startsWith("https://expo.dev") ||
      normalized.startsWith("https://u.expo.dev") ||
      normalized.startsWith("https://exp.host") ||
      normalized.startsWith("exp://") ||
      normalized.startsWith("exps://");

    if (
      allowList.has(normalized) ||
      (isDev && isPrivateLanOrigin) ||
      isExpoOrigin ||
      normalized.startsWith("file://") ||
      normalized.startsWith("app://") || // ✅ packaged Electron
      normalized.startsWith("capacitor://") || // ✅ Capacitor mobile
      normalized === "null" ||
      /\.vercel\.app$/.test(normalized) ||
      !origin // ✅ allow missing header (Electron)
    ) {
      return callback(null, true);
    }

    console.warn("❌ Socket CORS blocked:", origin);
    return callback(new Error("Not allowed by CORS"));
  } catch (e) {
    return callback(null, true);
  }
},

      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  /* ------------------------------------------------------------------
     🧠 Optional Redis adapter (auto-skipped in local dev if no REDIS_URL)
  ------------------------------------------------------------------ */
  if (process.env.REDIS_URL) {
    try {
      const { createAdapter } = require("@socket.io/redis-adapter");
      const { createClient } = require("redis");
      const pubClient = createClient({ url: process.env.REDIS_URL });
      const subClient = pubClient.duplicate();

      pubClient.on("error", (err) => console.error("❌ Redis pub error:", err));
      subClient.on("error", (err) => console.error("❌ Redis sub error:", err));

      pubClient.connect();
      subClient.connect();
      io.adapter(createAdapter(pubClient, subClient));

      console.log("✅ Redis adapter enabled for multi-instance scaling");
    } catch (err) {
      console.warn("⚠️ Redis adapter skipped:", err.message);
    }
  } else {
    console.log("⚠️ No REDIS_URL found — running without Redis adapter");
  }

  /* ------------------------------------------------------------------
     🔒 Tenant-safe socket connections
  ------------------------------------------------------------------ */
  io.on("connection", (socket) => {
    console.log(`✅ Socket connected: ${socket.id}`);

    // 1️⃣ Manual join from frontend
    socket.on("join_restaurant", (restaurantId) => {
      if (!restaurantId) return;
      socket.join(`restaurant_${restaurantId}`);
      socket.data.restaurantId = restaurantId;
      console.log(`👥 ${socket.id} joined restaurant_${restaurantId}`);
    });

    // 2️⃣ Auto join from auth handshake (if JWT decoded on frontend)
    const auth = socket.handshake?.auth;
    if (auth?.restaurantId) {
      socket.join(`restaurant_${auth.restaurantId}`);
      socket.data.restaurantId = auth.restaurantId;
      console.log(`🔐 Auto-joined from auth: restaurant_${auth.restaurantId}`);
    }

    // 3️⃣ Reconnect auto rejoin
    socket.on("reconnect_attempt", () => {
      if (socket.data.restaurantId) {
        socket.join(`restaurant_${socket.data.restaurantId}`);
        console.log(`♻️ Rejoined restaurant_${socket.data.restaurantId}`);
      }
    });

    // Leave when requested
    socket.on("leave_restaurant", (restaurantId) => {
      if (!restaurantId) return;
      socket.leave(`restaurant_${restaurantId}`);
      console.log(`👋 ${socket.id} left restaurant_${restaurantId}`);
    });

    socket.on("disconnect", (reason) => {
      console.log(`❌ Socket disconnected: ${socket.id} (${reason})`);
    });
  });

  global.io = io; // Debug access
  console.log("🚀 Socket.IO initialized (tenant-safe)");
  return io;
}

function getIO() {
  if (!io) throw new Error("❌ Socket.IO not initialized yet!");
  return io;
}

module.exports = { initSocket, getIO };
