// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const pool = require("./db");

const app = express();
const PORT = process.env.PORT || 5000;

// ===== MIDDLEWARE =====
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan("dev"));

// ===== STATIC FILES =====
app.use("/public", express.static(path.join(__dirname, "public")));

// ===== ROUTES (Public before Auth) =====
const authRoutes = require("./routes/auth");
const subscriptionRoutes = require("./routes/subscription");

app.use("/api", authRoutes); // ✅ /api/login, /api/register
app.use("/api/subscription", subscriptionRoutes);

// ===== HEALTH CHECK =====
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Beypro backend running ✅" });
});

// ===== AUTH MIDDLEWARE (Protect below) =====
const auth = require("./middleware/auth");
app.use(auth); // ⛔ Everything below requires token

// ===== SECURE ROUTES =====
app.use("/api/products", require("./routes/products"));
app.use("/api/stock", require("./routes/stock"));
app.use("/api/settings", require("./routes/settings"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/logs", require("./routes/logs"));
app.use("/api/suppliers", require("./routes/suppliers"));
app.use("/api/payments", require("./routes/payments"));
app.use("/api/user-settings", require("./routes/userSettings"));
app.use("/api/staff", require("./routes/staff"));
app.use("/api/tasks", require("./routes/tasks"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/appearance", require("./routes/appearance"));
app.use("/api/production", require("./routes/production"));
app.use("/api/driver", require("./routes/driver"));
app.use("/api/ingredient-prices", require("./routes/ingredientPrices"));
app.use("/api/logs", require("./routes/logs"));
app.use("/api/tenant", require("./routes/tenant"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/cash-register", require("./routes/cashRegister"));
app.use("/api/kitchen-orders", require("./routes/kitchenOrders"));
app.use("/api/order-items", require("./routes/orderItems"));
app.use("/api/printer-settings", require("./routes/printerSettings"));

// ===== SOCKET.IO SETUP =====
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// 🔌 SOCKET EVENTS
io.on("connection", (socket) => {
  console.log(`[SOCKET] Connected: ${socket.id}`);

  socket.on("disconnect", () => {
    console.log(`[SOCKET] Disconnected: ${socket.id}`);
  });

  // Example real-time event for new orders
  socket.on("new_order", (data) => {
    io.emit("order_update", data);
  });

  // Example: stock update
  socket.on("stock_updated", (data) => {
    io.emit("stock_refresh", data);
  });
});

// Make socket globally available (optional)
app.set("io", io);

// ===== ERROR HANDLING =====
app.use((req, res) => {
  res.status(404).json({ status: "error", message: "Not Found" });
});

app.use((err, req, res, next) => {
  console.error("🔥 Server error:", err);
  res
    .status(err.status || 500)
    .json({ status: "error", message: err.message || "Internal Server Error" });
});

// ===== START SERVER =====
server.listen(PORT, () => {
  console.log(`🚀 Beypro backend running on port ${PORT}`);
});
