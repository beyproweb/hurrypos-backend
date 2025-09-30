// server.js
const express = require("express");
require("dotenv").config();
const app = express();
const pool = require("./db");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const http = require("http").createServer(app);
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const Tesseract = require("tesseract.js");
const dayjs = require("dayjs");

// --- SOCKET.IO INITIALIZATION ---
const { initSocket } = require("./utils/socket");
const io = initSocket(http);
app.set("io", io);

// --- MIDDLEWARE CONFIG ---
app.use(
  cors({
    origin: [
      "https://www.beypro.com",
      "https://pos.beypro.com",
      "http://localhost:5173",
      process.env.FRONTEND_BASE,
    ].filter(Boolean),
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
      "X-Restaurant-Id",
    ],
  })
);

// Preflight handler
app.options("*", cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- STATIC SERVING (Uploads / Bridge Installers) ---
app.use("/uploads", express.static(path.join(__dirname, "public", "uploads")));
app.use(
  "/bridge",
  express.static(path.join(__dirname, "public/bridge"), {
    etag: true,
    lastModified: true,
    cacheControl: false,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    },
  })
);

// Legacy redirects for older installers
app.get("/installers/windows/*", (_, res) =>
  res.redirect(302, "/bridge/beypro-bridge-win-x64.zip")
);
app.get("/installers/macos/*", (_, res) =>
  res.redirect(302, "/bridge/beypro-bridge-mac-x64.tar.gz")
);
app.get("/installers/linux/*", (_, res) =>
  res.redirect(302, "/bridge/beypro-bridge-linux-x64.tar.gz")
);

// --- UTILITIES ---
const { sendEmail } = require("./utils/notifications");
const {
  emitOrderUpdate,
  emitStockUpdate,
  emitOrderConfirmed,
  emitOrderDelivered,
  emitAlert,
} = require("./utils/realtime");

// --- ROUTES ---
// (1) Routes that don’t require auth first
const taskRoutes = require("./routes/tasks");
app.use("/api", taskRoutes);

const uploadRouter = require("./routes/upload");
app.use("/api/upload", uploadRouter);

// Background jobs
const { startKitchenTimersJob } = require("./routes/timerScheduler");
startKitchenTimersJob();

// (2) Tenant-safe and real-time routes
app.use("/api/stock", require("./routes/stock")(io));
app.use("/api/staff", require("./routes/staff"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/production", require("./routes/production"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api", require("./routes/expenses"));

// Optional Iyzico payment routes
if (process.env.IYZI_API_KEY && process.env.IYZI_SECRET) {
  app.use("/api", require("./routes/iyzico"));
} else {
  console.log("⚠️ Iyzico not configured – skipping /api/iyzico routes");
}

app.use("/api/user-settings", require("./routes/userSettings"));
app.use("/api/printer-settings", require("./routes/printer"));
app.use("/api", require("./routes/subscription"));
app.use("/api/drinks", require("./routes/drinks"));
app.use("/api/integrations/yemeksepeti", require("./routes/yemeksepeti"));
app.use("/api/category-images", require("./routes/categoryImages"));

// --- AUTH MIDDLEWARE (Protects everything below this point) ---
const auth = require("./middleware/auth");
app.use(auth);

// Log all authenticated requests
app.use((req, res, next) => {
  console.log(`➡️ ${req.method} ${req.url} | Tenant: ${req.headers["x-restaurant-id"]}`);
  next();
});

// (3) Protected tenant routes
app.use("/api/settings", require("./routes/settings"));
app.use("/api/products", require("./routes/products"));
app.use("/api/extras-groups", require("./routes/extras-groups"));
app.use("/api", require("./routes/Autosuppliersorder")(io));
app.use("/api", require("./routes/kitchen"));
app.use("/api", require("./routes/phoneorders"));
app.use("/api/customerAddresses", require("./routes/customerAddresses"));
app.use("/api/customers", require("./routes/customers"));
app.use("/api/campaigns", require("./routes/campaigns"));
app.use("/api/orders", require("./routes/orders")(io));
app.use("/api/drivers", require("./routes/drivers")(io));
app.use("/api/suppliers", require("./routes/suppliers")(io));
app.use("/api/ingredient-prices", require("./routes/ingredient-prices")(io));

// --- ERROR HANDLER ---
app.use((err, req, res, next) => {
  console.error("🔥 Express error:", err);
  res.status(500).json({ status: "error", message: "Internal server error" });
});

// --- START SERVER ---
const PORT = process.env.PORT || 5000;
http.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Beypro backend running on port ${PORT}`);
});

module.exports = { app, pool };
