const express = require("express");
require("dotenv").config();
const app = express();
const pool = require("./db");
const cors = require("cors");
const path = require("path");
const http = require("http").createServer(app);
const { initSocket } = require("./utils/socket");
const io = initSocket(http);
app.set("io", io);

// --- Middleware
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

app.options("*", cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- Static Assets
app.use("/uploads", express.static(path.join(__dirname, "public/uploads")));
app.use(
  "/bridge",
  express.static(path.join(__dirname, "public/bridge"), {
    cacheControl: false,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-cache");
    },
  })
);

// --- Public Routes (no auth)
app.use("/api/upload", require("./routes/upload"));
app.use("/api", require("./routes/tasks"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/production", require("./routes/production"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/user-settings", require("./routes/userSettings"));
app.use("/api/printer-settings", require("./routes/printer"));
app.use("/api/drinks", require("./routes/drinks"));
app.use("/api/integrations/yemeksepeti", require("./routes/yemeksepeti"));
app.use("/api/category-images", require("./routes/categoryImages"));
app.use("/api/campaigns", require("./routes/campaigns"));
app.use("/api/customers", require("./routes/customers"));
app.use("/api/customerAddresses", require("./routes/customerAddresses"));
app.use("/api", require("./routes/expenses"));

// Optional Iyzico routes
if (process.env.IYZI_API_KEY && process.env.IYZI_SECRET) {
  app.use("/api", require("./routes/iyzico"));
} else {
  console.log("⚠️ Iyzico not configured – skipping /api/iyzico routes");
}

// --- Auth middleware (after public routes)
const auth = require("./middleware/auth");
app.use(auth);

// --- Tenant-safe + real-time routes
app.use("/api/stock", require("./routes/stock")(io));
app.use("/api/orders", require("./routes/orders")(io));
app.use("/api/drivers", require("./routes/drivers")(io));
app.use("/api/suppliers", require("./routes/suppliers")(io));
app.use("/api/ingredient-prices", require("./routes/ingredient-prices")(io));
app.use("/api", require("./routes/Autosuppliersorder")(io));
app.use("/api", require("./routes/kitchen"));
app.use("/api", require("./routes/phoneorders"));
app.use("/api/settings", require("./routes/settings"));
app.use("/api/products", require("./routes/products"));
app.use("/api/extras-groups", require("./routes/extras-groups"));
app.use("/api/staff", require("./routes/staff"));
app.use("/api", require("./routes/subscription"));

// --- Global error handler
app.use((err, req, res, next) => {
  console.error("🔥 Express error:", err);
  res.status(500).json({ status: "error", message: "Internal server error" });
});

// --- Start server
const PORT = process.env.PORT || 5000;
http.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Beypro backend running on port ${PORT}`);
});

module.exports = { app, pool };
