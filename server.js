// server.js
require("dotenv").config();
console.log("🔐 JWT_SECRET loaded =", process.env.JWT_SECRET ? "✅ OK" : "❌ MISSING");

const express = require("express");
const app = express();
const pool = require("./db");
const cors = require("cors");

const allowedOrigins = [
  "http://localhost:5173",
  "https://pos.beypro.com",
  "https://www.pos.beypro.com",
  "https://hurrypos-frontend.onrender.com",
];

const allowedOriginsNormalized = allowedOrigins.map((o) => o.toLowerCase());

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // allow REST clients / curl
      const normalized = origin.toLowerCase();
      if (
        allowedOrigins.some((o) => normalized === o.toLowerCase()) ||
        /\.vercel\.app$/.test(normalized)
      ) {
        return callback(null, true);
      }
      console.warn("❌ Blocked by CORS:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    credentials: true,
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
      "x-client-lang",
      "X-Client-Lang",
    ],
  })
);


// ✅ Preflight
app.options("*", cors());

const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const Tesseract = require("tesseract.js");
const path = require("path");
const fs = require("fs");

const http = require("http").createServer(app);
const { initSocket } = require("./utils/socket");
const io = initSocket(http);
app.set("io", io);

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const { sendEmail } = require("./utils/notifications");

app.use("/uploads", express.static(path.join(__dirname, "public", "uploads")));

// ✅ Serve notification sound files
app.use(
  "/sounds",
  express.static(path.join(__dirname, "public", "sounds"), {
    etag: false,
    cacheControl: false,
  })
);
const whatsappWebhook = require("./routes/whatsappWebhook");
// Beypro Bridge binaries (no-cache)
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

// 🚫 Mute all Redis errors globally (temporary dev patch)
process.env.REDIS_URL = ""; // ensure no adapter uses it

try {
  const Redis = require("ioredis");

  // Override the constructor to prevent real connections
  const Original = Redis.prototype.connect;
  Redis.prototype.connect = function (...args) {
    console.warn("⚠️ Redis disabled — skipping connection silently");
    this.status = "ready";
    return Promise.resolve(this);
  };

  // Suppress global error events so they don't log
  Redis.prototype.emit = function (event, ...rest) {
    if (event === "error") return false; // swallow error events
    return require("events").EventEmitter.prototype.emit.call(this, event, ...rest);
  };
} catch (err) {
  console.log("ℹ️ ioredis not used or already muted");
}

// Legacy installer redirects
app.get("/installers/windows/*", (req, res) =>
  res.redirect(302, "/bridge/beypro-bridge-win-x64.zip")
);
app.get("/installers/macos/*", (req, res) =>
  res.redirect(302, "/bridge/beypro-bridge-mac-x64.tar.gz")
);
app.get("/installers/linux/*", (req, res) =>
  res.redirect(302, "/bridge/beypro-bridge-linux-x64.tar.gz")
);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ========== ROUTES (Public / mixed) ==========
app.use("/api", require("./routes/tasks"));

const staffRoutes = require("./routes/staff");
app.use("/api/staff", staffRoutes);

const uploadRouter = require("./routes/upload.js");
app.use("/api/upload", uploadRouter);

const { startKitchenTimersJob } = require("./routes/timerScheduler");
startKitchenTimersJob();

// Reports, Production, Notifications, Expenses (public mounts; internal auth inside each if needed)
app.use("/api/reports", require("./routes/reports"));
app.use("/api/production", require("./routes/production"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api", require("./routes/expenses"));
app.use("/api/maintenance", require("./routes/maintenance"));
// Iyzico (conditionally)
if (process.env.IYZI_API_KEY && process.env.IYZI_SECRET) {
  app.use("/api", require("./routes/iyzico"));
} else {
  console.log("⚠️ Iyzico not configured – skipping /api/iyzico routes");
}

// ========== AUTH ==========
const authRoutes = require("./routes/auth");
app.use("/api/auth", authRoutes); // public login/register

const authMiddleware = require("./middleware/authMiddleware");

// Settings, Printers
app.use("/api/user-settings", require("./routes/userSettings"));
app.use("/api/printer-settings", require("./routes/printer"));

// Subscription (register/login)
app.use("/api", require("./routes/subscription"));

// ========== ORDER & KITCHEN ORDER MATTERS ==========
const kitchenRoutes = require("./routes/kitchen");

// ✅ Mount ORDERS (tenant-aware) FIRST — includes PUT /api/orders/order-items/kitchen-status
app.use("/api/orders", require("./routes/orders")(io));

// Other feature routes (public or internal-auth)
app.use("/api/drinks", authMiddleware, require("./routes/drinks")(io));
app.use("/api/integrations/yemeksepeti", require("./routes/yemeksepeti"));
app.use("/api/category-images", require("./routes/categoryImages"));
app.use("/api/settings", require("./routes/settings"));
app.use("/api/extras-groups", require("./routes/extras-groups"));
app.use("/api", require("./routes/Autosuppliersorder")(io));
app.use("/api/phoneorders", require("./routes/phoneorders"));
app.use("/api/customerAddresses", require("./routes/customerAddresses"));
app.use("/api/customers", require("./routes/customers"));
app.use("/api/campaigns", require("./routes/campaigns"));
app.use("/webhook", whatsappWebhook);
// ✅ Mount KITCHEN router AFTER orders, with auth
app.use("/api", kitchenRoutes);

// ========== PROTECTED ROUTES ==========
app.use("/api/products", require("./routes/products"));
app.use("/api/stock", authMiddleware, require("./routes/stock")(io));
// ❌ REMOVE the duplicate orders mount that was here
app.use("/api/drivers", authMiddleware, require("./routes/drivers")(io));
app.use("/api/suppliers", authMiddleware, require("./routes/suppliers")(io));
app.use(
  "/api/ingredient-prices",
  authMiddleware,
  require("./routes/ingredient-prices")(io)
);

// ========== UTIL ==========
app.use((req, res, next) => {
  console.log(`➡️ ${req.method} request to ${req.url}`);
  next();
});

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

// Slug redirect → public QR link
const RESERVED_SLUGS = new Set([
  "api",
  "uploads",
  "sounds",
  "bridge",
  "favicon.ico",
]);

app.get("/:slug", async (req, res, next) => {
  const { slug } = req.params;
  if (!slug || RESERVED_SLUGS.has(slug) || slug.includes(".")) {
    return next();
  }

  try {
    const { rows } = await pool.query("SELECT id FROM restaurants WHERE slug = $1", [slug]);
    if (rows.length) {
      return res.redirect(302, `https://pos.beypro.com/qr-menu/${slug}`);
    }
    return res.status(404).send("Restaurant not found");
  } catch (err) {
    console.error("❌ Slug redirect failed:", err);
    return next(err);
  }
});

// Error catcher
app.use((err, req, res, next) => {
  console.error("🔥 Express error handler:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Start server
const PORT = process.env.PORT || 5000;
http.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend is running on port ${PORT} and accessible from LAN`);
});

module.exports = { app, pool };
