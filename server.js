// server.js
const express = require("express");
require("dotenv").config();
const app = express();
const pool = require("./db");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const http = require("http").createServer(app);
const { initSocket } = require("./utils/socket");
const io = initSocket(http);
const { sendEmail } = require("./utils/notifications");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const Tesseract = require("tesseract.js");
const dayjs = require("dayjs");
const bcrypt = require("bcrypt");

// ------------------  CORS CONFIG  ------------------
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
    ],
  })
);
app.options("*", cors());

// ------------------  STATIC FILES  ------------------
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

// Redirect old installer paths
app.get("/installers/windows/*", (req, res) =>
  res.redirect(302, "/bridge/beypro-bridge-win-x64.zip")
);
app.get("/installers/macos/*", (req, res) =>
  res.redirect(302, "/bridge/beypro-bridge-mac-x64.tar.gz")
);
app.get("/installers/linux/*", (req, res) =>
  res.redirect(302, "/bridge/beypro-bridge-linux-x64.tar.gz")
);

// ------------------  CORE MIDDLEWARE  ------------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Log requests
app.use((req, res, next) => {
  console.log(`➡️ ${req.method} ${req.url}`);
  next();
});

// ------------------  CRON & JOBS  ------------------
const { startKitchenTimersJob } = require("./routes/timerScheduler");
startKitchenTimersJob();

// ------------------  NORMAL ROUTES  ------------------
app.use("/api/upload", require("./routes/upload"));
app.use("/api/tasks", require("./routes/tasks"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/production", require("./routes/production"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/expenses", require("./routes/expenses"));
app.use("/api/user-settings", require("./routes/userSettings"));
app.use("/api/printer-settings", require("./routes/printer"));
app.use("/api/category-images", require("./routes/categoryImages"));
app.use("/api/campaigns", require("./routes/campaigns"));
app.use("/api/customers", require("./routes/customers"));
app.use("/api/customer-addresses", require("./routes/customerAddresses"));
app.use("/api/phoneorders", require("./routes/phoneorders"));
app.use("/api/drinks", require("./routes/drinks"));
app.use("/api/staff", require("./routes/staff"));
app.use("/api/settings", require("./routes/settings"));
app.use("/api/subscription", require("./routes/subscription"));

// Optional Iyzico Integration
if (process.env.IYZI_API_KEY && process.env.IYZI_SECRET) {
  app.use("/api", require("./routes/iyzico"));
} else {
  console.log("⚠️ Iyzico not configured – skipping /api/iyzico routes");
}
app.use("/api/integrations/yemeksepeti", require("./routes/yemeksepeti"));

// ------------------  AUTH MIDDLEWARE  ------------------
const auth = require("./middleware/auth");
app.use(auth); // Protect routes below this line

// ------------------  SOCKET-AWARE ROUTES  ------------------
app.use("/api/orders", require("./routes/orders")(io));
app.use("/api/kitchen", require("./routes/kitchen")(io));
app.use("/api/suppliers", require("./routes/suppliers")(io));
app.use("/api/ingredient-prices", require("./routes/ingredient-prices")(io));
app.use("/api/stock", require("./routes/stock")(io));
app.use("/api/drivers", require("./routes/drivers")(io));
app.use("/api", require("./routes/Autosuppliersorder")(io));

// ------------------  GENERAL ROUTES  ------------------
app.use("/api/products", require("./routes/products"));
app.use("/api/extras-groups", require("./routes/extras-groups"));

// ------------------  HELPERS  ------------------
const safeParseExtras = (extras) => {
  try {
    if (Array.isArray(extras)) return extras;
    if (typeof extras === "string") return JSON.parse(extras);
    return [];
  } catch (err) {
    console.error("❌ Error parsing extras:", err);
    return [];
  }
};

// ------------------  GLOBAL ERROR HANDLER  ------------------
app.use((err, req, res, next) => {
  console.error("🔥 Express error handler:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ------------------  SERVER STARTUP  ------------------
const PORT = process.env.PORT || 5000;
http.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Beypro backend running on port ${PORT}`);
});

module.exports = { app, pool };
