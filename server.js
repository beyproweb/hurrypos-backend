// server.js
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// ✅ Global log silencer for production (MUST be early, before other modules load)
const { setupLogSilencer } = require("./utils/logSilencer");
setupLogSilencer();

// ✅ Environment detection
const NODE_ENV = process.env.NODE_ENV || "development";
const isDev = NODE_ENV !== "production";

console.log(`\n🚀 Starting backend in ${isDev ? "DEVELOPMENT" : "PRODUCTION"} mode`);
console.log("🔐 JWT_SECRET loaded =", process.env.JWT_SECRET ? "✅ OK" : "❌ MISSING");
console.log("🟣 YS_SECRET loaded =", process.env.YS_SECRET ? "✅ OK" : "❌ MISSING");
console.log(
  "🧩 INTERNAL_JWT_SECRET loaded =",
  process.env.INTERNAL_JWT_SECRET ? "✅ OK" : "❌ MISSING (breaks /api/internal/*)"
);
console.log(
  "🧾 PII_ENCRYPTION_KEY loaded =",
  process.env.PII_ENCRYPTION_KEY || process.env.PII_ENCRYPTION_SECRET || process.env.ENCRYPTION_KEY
    ? "✅ OK"
    : "❌ MISSING (breaks /api/public/* in production)"
);

// Runtime PATH logging to help debug missing binaries (Tesseract, clamscan, etc.)
console.log("Runtime PATH:", process.env.PATH);

const express = require("express");
const app = express();
app.set("trust proxy", true);
const { pool } = require('./db');
const cors = require("cors");
const { ensureMinimalSchema } = require("./utils/ensureSchema");
const { normalizeTrPhoneForApi } = require("./utils/phone");

function parseCommaListEnv(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function envBool(name, defaultValue = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

// ✅ Unified CORS setup — supports web, dev, and Electron
const localDevOrigins = [
  "http://localhost:5173", // Vite dev server
  "http://localhost:5174", // Vite alternate port
  "http://localhost:3000", // React dev server
  "http://localhost:3001", // Alternate React port
  "http://127.0.0.1:5173", // Localhost alt
  "http://127.0.0.1:5174",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
];

const alwaysAllowedDevAppOrigins = [
  // ✅ Always allow local Electron/Expo during testing
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "http://10.55.189.102:8081",
];

const productionOrigins = [
  "https://pos.beypro.com",
  "https://www.pos.beypro.com",
  "https://app.beypro.com",
  "https://www.app.beypro.com",
  "https://apollo.beypro.com",
  "https://dev.beypro.com",
  "https://hurrypos-frontend.onrender.com",
  "https://beypro.com",
  "https://www.beypro.com",
];

const extraOrigins = parseCommaListEnv(process.env.CORS_EXTRA_ORIGINS);
const allowLocalhostInProd = envBool("CORS_ALLOW_LOCALHOST", false);

const allowedOrigins = [
  ...(isDev || allowLocalhostInProd ? localDevOrigins : []),
  ...alwaysAllowedDevAppOrigins,
  ...productionOrigins,
  ...extraOrigins,
];

console.log(`📍 Allowed CORS origins (${isDev ? "DEV" : "PROD"}):`);
allowedOrigins.forEach(origin => console.log(`   - ${origin}`));

const corsOptions = {
  origin: function (origin, callback) {
    // Electron/mobile clients may omit Origin or use non-http schemes.
    if (!origin) return callback(null, true);

    const normalized = String(origin).toLowerCase();

    if (
      allowedOrigins.some((o) => normalized === o.toLowerCase()) ||
      /\.vercel\.app$/.test(normalized) ||
      normalized === "null" ||
      normalized.startsWith("file://") ||
      normalized.startsWith("app://") ||
      normalized.startsWith("capacitor://")
    ) {
      return callback(null, true);
    }

    console.warn("❌ Blocked by CORS:", origin);
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Turn CORS allowlist failures into a clearer status code (otherwise Express returns 500).
app.use((err, req, res, next) => {
  if (err?.message === "Not allowed by CORS") {
    return res.status(403).json({ success: false, error: "Not allowed by CORS" });
  }
  return next(err);
});





const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");

const http = require("http").createServer(app);
const { initSocket } = require("./utils/socket");
const io = initSocket(http);
app.get("/health", (req, res) => res.status(200).send("ok"));

const bodySizeLimit = process.env.BODY_SIZE_LIMIT || "5mb";
app.use(express.urlencoded({ extended: true, limit: bodySizeLimit }));
app.use(express.json({ limit: bodySizeLimit }));

function isPhoneLikeFieldName(key) {
  const normalized = String(key || "").trim().toLowerCase();
  return (
    normalized === "phone" ||
    normalized.endsWith("_phone") ||
    normalized.endsWith("phone")
  );
}

function normalizePhoneFieldsDeep(payload) {
  if (!payload || typeof payload !== "object") return;

  if (Array.isArray(payload)) {
    payload.forEach((entry) => normalizePhoneFieldsDeep(entry));
    return;
  }

  Object.entries(payload).forEach(([key, value]) => {
    if (typeof value === "string" && isPhoneLikeFieldName(key)) {
      const normalizedPhone = normalizeTrPhoneForApi(value);
      payload[key] = normalizedPhone || value.trim();
      return;
    }

    if (value && typeof value === "object") {
      normalizePhoneFieldsDeep(value);
    }
  });
}

app.use((req, _res, next) => {
  normalizePhoneFieldsDeep(req.body);
  next();
});
app.set("io", io);

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const { sendEmail } = require("./utils/notifications");

app.use("/uploads", express.static(path.join(__dirname, "public", "uploads")));
app.use(
  "/uploads/receipts",
  express.static(path.join(__dirname, "uploads", "receipts"))
);

// ✅ Serve notification sound files
app.use(
  "/sounds",
  express.static(path.join(__dirname, "public", "sounds"), {
    etag: false,
    cacheControl: false,
  })
);
const whatsappWebhook = require("./routes/whatsappWebhook");

app.use("/api/integrations/yemeksepeti", require("./routes/yemeksepeti"));
app.use("/api/integrations/migros", require("./routes/migros"));
app.use("/api/integrations/whatsapp", require("./routes/whatsappIntegration"));

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

// Optional dev-only Redis muting. Keep Redis enabled in production so
// driver locations and socket rooms work across multiple backend instances.
if (isDev && envBool("DISABLE_REDIS", false)) {
  process.env.REDIS_URL = "";
  process.env.REDIS_HOST = "";
  process.env.REDIS_PORT = "";
  process.env.REDIS_PASSWORD = "";
  process.env.REDIS_USERNAME = "";
  process.env.REDIS_TLS = "false";

  try {
    const Redis = require("ioredis");

    Redis.prototype.connect = function (...args) {
      console.warn("⚠️ Redis disabled via DISABLE_REDIS=true");
      this.status = "ready";
      return Promise.resolve(this);
    };

    Redis.prototype.emit = function (event, ...rest) {
      if (event === "error") return false;
      return require("events").EventEmitter.prototype.emit.call(this, event, ...rest);
    };
  } catch (err) {
    console.log("ℹ️ ioredis not used or already muted");
  }
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


const authMiddleware = require("./middleware/authMiddleware");
const { requireNotStandaloneOrHasModule } = require("./middleware/moduleGuard");
const requirePosCore = requireNotStandaloneOrHasModule("pos_core");

// ========== ROUTES (Public / mixed) ==========

// Internal dev panel API (separate auth from restaurant/admin JWTs)
app.use("/api/internal", require("./routes/internal"));

app.use(
  "/api/integrations/yemeksepeti",
  require("./routes/yemeksepetiMenu")
);

// ========== AUTH (public + standalone) ==========
const authRoutes = require("./routes/auth");
app.use("/api/auth", authRoutes); // public login/register
app.use("/api/standalone/auth", require("./routes/standaloneAuth"));
app.use("/api/standalone/qr", require("./routes/standaloneQr"));
app.use("/api/standalone/kitchen", require("./routes/standaloneKitchen"));
app.use("/api/standalone/tables", require("./routes/standaloneTables"));
const publicQRRoutes = require("./routes/publicQR");
app.use("/api/public", publicQRRoutes);
// Backward-compat aliases for stale frontend builds / caches.
app.use("/public", publicQRRoutes);
app.get("/api/restaurants/nearby", (req, res) => {
  const queryText = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return res.redirect(307, `/api/public/restaurants/nearby${queryText}`);
});
app.use("/api/public", require("./routes/publicCustomers"));
app.use("/public", require("./routes/publicCustomers"));
require("./scheduleMailer");
app.get("/manifest.json", (req, res) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(302, `/api/public/manifest.json${qs}`);
});
app.use("/api/public/concerts", require("./routes/publicConcerts"));
app.use("/api/public", require("./routes/publicRegistrations"));
app.use("/api", require("./routes/guestQrPublic"));

const { startKitchenTimersJob } = require("./routes/timerScheduler");
startKitchenTimersJob();

let subscriptionsTableReady = null;
function ensureSubscriptionsTable() {
  if (!subscriptionsTableReady) {
    subscriptionsTableReady = pool
      .query(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          restaurant_id INTEGER PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
          card_number TEXT,
          expiry TEXT,
          cvv TEXT,
          billing_cycle TEXT DEFAULT 'monthly',
          efatura BOOLEAN DEFAULT false,
          invoice_title TEXT,
          tax_office TEXT,
          invoice_type TEXT
        );
      `)
      .catch((err) => {
        console.warn("⚠️ Could not ensure subscriptions table exists:", err?.message || err);
        subscriptionsTableReady = null;
      });
  }
  return subscriptionsTableReady;
}

app.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const restaurantId = req.user.restaurant_id;
    const roleKey = String(req.user.role || "").toLowerCase();
    const shouldPreferStaff =
      req.user.auth_source === "staff" ||
      ["staff", "driver", "cashier", "waiter", "kitchen", "kurye"].includes(roleKey);
    await ensureSubscriptionsTable();

    if (shouldPreferStaff) {
      let staffResult;
      try {
        staffResult = await pool.query(
          `
          SELECT
            st.id,
            st.name AS full_name,
            st.email,
            st.phone,
            st.role,
            st.restaurant_id,
            r.name AS restaurant_name,
            r.pos_location,
            r.pos_location_lat,
            r.pos_location_lng,
            r.plan,
            r.allowed_modules,
            COALESCE(s.billing_cycle, r.billing_cycle, 'monthly') AS billing_cycle
          FROM staff st
          LEFT JOIN restaurants r ON r.id = st.restaurant_id
          LEFT JOIN subscriptions s ON s.restaurant_id = st.restaurant_id
          WHERE st.id = $1
            AND st.restaurant_id = $2
            AND st.status = 'active'
          LIMIT 1
          `,
          [userId, restaurantId]
        );
      } catch (err) {
        if (err && err.code === "42P01") {
          staffResult = await pool.query(
            `
            SELECT
              st.id,
              st.name AS full_name,
              st.email,
              st.phone,
              st.role,
              st.restaurant_id,
              r.name AS restaurant_name,
              r.pos_location,
              r.pos_location_lat,
              r.pos_location_lng,
              r.plan,
              r.allowed_modules,
              COALESCE(r.billing_cycle, 'monthly') AS billing_cycle
            FROM staff st
            LEFT JOIN restaurants r ON r.id = st.restaurant_id
            WHERE st.id = $1
              AND st.restaurant_id = $2
              AND st.status = 'active'
            LIMIT 1
            `,
            [userId, restaurantId]
          );
        } else {
          throw err;
        }
      }

      if (staffResult?.rows?.length) {
        const row = staffResult.rows[0];
        return res.json({
          id: row.id,
          full_name: row.full_name,
          email: row.email,
          phone: row.phone,
          role: row.role || req.user.role || "staff",
          auth_source: req.user.auth_source || "staff",
          restaurant_id: row.restaurant_id,
          restaurant_name: row.restaurant_name,
          pos_location: row.pos_location || "",
          pos_location_lat: row.pos_location_lat,
          pos_location_lng: row.pos_location_lng,
          plan: row.plan,
          allowed_modules: row.allowed_modules || null,
          billing_cycle: row.billing_cycle,
        });
      }

      console.warn("⚠️ /api/me staff-preferred lookup found no active staff row, falling back to users", {
        userId,
        restaurantId,
        role: req.user.role,
        auth_source: req.user.auth_source || null,
      });
    }

    let result;
    try {
      result = await pool.query(
        `
        SELECT
          u.id,
          u.full_name,
          u.email,
          u.phone,
          u.role,
          u.restaurant_id,
          r.name AS restaurant_name,
          r.pos_location,
          r.pos_location_lat,
          r.pos_location_lng,
          r.plan,
          r.allowed_modules,
          COALESCE(s.billing_cycle, r.billing_cycle, 'monthly') AS billing_cycle
        FROM users u
        LEFT JOIN restaurants r ON r.id = u.restaurant_id
        LEFT JOIN subscriptions s ON s.restaurant_id = u.restaurant_id
        WHERE u.id = $1
        `,
        [userId]
      );
    } catch (err) {
      // 42P01 = undefined_table (older DBs)
      if (err && err.code === "42P01") {
        result = await pool.query(
          `
          SELECT
            u.id,
            u.full_name,
            u.email,
            u.phone,
          u.role,
          u.restaurant_id,
          r.name AS restaurant_name,
          r.pos_location,
          r.pos_location_lat,
          r.pos_location_lng,
          r.plan,
          r.allowed_modules,
          COALESCE(r.billing_cycle, 'monthly') AS billing_cycle
          FROM users u
          LEFT JOIN restaurants r ON r.id = u.restaurant_id
          WHERE u.id = $1
          `,
          [userId]
        );
      } else {
        throw err;
      }
    }

    if (!result.rows.length) {
      return res.status(404).json({ error: "User not found" });
    }

    const row = result.rows[0];
    res.json({
      id: row.id,
      full_name: row.full_name,
      email: row.email,
      phone: row.phone,
      role: row.role,
      auth_source: req.user.auth_source || "users",
      restaurant_id: row.restaurant_id,
      restaurant_name: row.restaurant_name,
      pos_location: row.pos_location || "",
      pos_location_lat: row.pos_location_lat,
      pos_location_lng: row.pos_location_lng,
      plan: row.plan,
      allowed_modules: row.allowed_modules || null,
      billing_cycle: row.billing_cycle,
    });
  } catch (err) {
    console.error("❌ /api/me failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
// Plan-based feature gating for restaurant dashboard (restaurant JWT required)
// Settings, Printers
app.use("/api/user-settings", requirePosCore, require("./routes/userSettings"));
app.use("/api/printer-settings", requirePosCore, require("./routes/printer"));

// Subscription (register/login)
app.use("/api", require("./routes/subscription"));

// ========== ORDER & KITCHEN ORDER MATTERS ==========
const kitchenRoutes = require("./routes/kitchen");

// ✅ Mount ORDERS (tenant-aware) FIRST — includes PUT /api/orders/order-items/kitchen-status
app.use("/api/orders", require("./routes/orders")(io));
app.use("/api", require("./routes/voice"));

// Other feature routes (public or internal-auth)
app.use("/api/drinks", requirePosCore, require("./routes/drinks")(io));
app.use("/api/category-images", requirePosCore, require("./routes/categoryImages"));
app.use("/api/settings", require("./routes/settings"));
app.use("/api/concerts", require("./routes/concerts"));
app.use("/api/extras-groups", requirePosCore, require("./routes/extras-groups"));
app.use("/api/phoneorders", requirePosCore, require("./routes/phoneorders"));
app.use("/api/customerAddresses", requirePosCore, require("./routes/customerAddresses"));
app.use("/api/customers", requirePosCore, require("./routes/customers"));
app.use("/api/tables", require("./routes/tables"));
app.use("/api", require("./routes/songRequests")(io));
app.use("/api/campaigns", requirePosCore, require("./routes/campaigns"));
app.use("/webhook", whatsappWebhook);
// ✅ Mount KITCHEN router AFTER orders, with auth
app.use("/api", kitchenRoutes);



// ========== PROTECTED ROUTES ==========
app.use("/api/products", require("./routes/products"));
app.use("/api/stock", requirePosCore, require("./routes/stock")(io));
// ❌ REMOVE the duplicate orders mount that was here
app.use("/api/drivers", requirePosCore, require("./routes/drivers")(io));
app.use("/api/suppliers", requirePosCore, require("./routes/suppliers")(io));
app.use(
  "/api/ingredient-prices",
  requirePosCore,
  require("./routes/ingredient-prices")(io)
);

// ========== POS-ONLY ROUTES (mounted last to avoid blocking standalone) ==========
app.use("/api", requirePosCore, require("./routes/planModules"));
app.use("/api", requirePosCore, require("./routes/cashDrawer"));
app.use("/api", requirePosCore, require("./routes/Autosuppliersorder")(io));
app.use("/api", requirePosCore, require("./routes/expenses"));
app.use("/api", requirePosCore, require("./routes/tasks"));

const staffRoutes = require("./routes/staff");
// Allow POS core users and standalone tenants that explicitly have the staff module
app.use("/api/staff", requireNotStandaloneOrHasModule("staff"), staffRoutes);
// Standalone staff namespace (rewritten by frontend secureFetch /standalone/staff → /api/standalone/staff/*)
app.use("/api/standalone/staff", require("./routes/standaloneStaff"));

const uploadRouter = require("./routes/upload.js");
app.use("/api/upload", requirePosCore, uploadRouter);
const terminalZReportRouter = require("./routes/terminalZReport");
app.use("/api/terminal-zreport", requirePosCore, terminalZReportRouter);

// Reports, Production, Notifications, Expenses, Maintenance
app.use("/api/reports", requirePosCore, require("./routes/reports"));
app.use("/api/analytics", requirePosCore, require("./routes/analytics"));
app.use("/api/production", requirePosCore, require("./routes/production"));
app.use("/api/notifications", requirePosCore, require("./routes/notifications"));
app.use("/api/maintenance", requirePosCore, require("./routes/maintenance"));
// Iyzico (conditionally)
if (process.env.IYZI_API_KEY && process.env.IYZI_SECRET) {
  app.use("/api", requirePosCore, require("./routes/iyzico"));
} else {
  console.log("⚠️ Iyzico not configured – skipping /api/iyzico routes");
}

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
    const { rows } = await pool.query(
      "SELECT id, qr_token, qr_code_id FROM restaurants WHERE slug = $1",
      [slug]
    );
    if (rows.length) {
      const jwt = require("jsonwebtoken");
      let { id, qr_token, qr_code_id } = rows[0];

      // Ensure QR token exists for protected endpoints (orders, etc.)
      if (!qr_token) {
        const token = jwt.sign(
          { restaurant_id: id, slug },
          process.env.JWT_SECRET,
          { expiresIn: "180d" }
        );
        await pool.query("UPDATE restaurants SET qr_token = $1 WHERE id = $2", [token, id]);
        qr_token = token;
      }

      // Ensure a short QR code id exists (used by /qr-menu/:slug/:id)
      if (!qr_code_id) {
        const shortid = Math.random().toString(36).substring(2, 8);
        await pool.query("UPDATE restaurants SET qr_code_id = $1 WHERE id = $2", [shortid, id]);
        qr_code_id = shortid;
      }

      // Redirect to the public QR menu route without exposing JWT in the URL
      const target = `/qr-menu/${encodeURIComponent(slug)}/${encodeURIComponent(qr_code_id)}`;
      return res.redirect(302, target);

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
async function startServer() {
  const autoMigrate = isDev || envBool("AUTO_MIGRATE", false);
  if (autoMigrate) {
    try {
      console.log("🧩 Ensuring minimal DB schema...");
      await ensureMinimalSchema(pool);
      console.log("✅ Minimal DB schema ready");
    } catch (err) {
      console.warn("⚠️ Failed to ensure minimal DB schema:", err.message);
    }
  }

  // Pre-initialize PaddleOCR to warm up cache on backend startup
  // This prevents timeout on first invoice upload
  if (process.env.SKIP_OCR_INIT !== "true") {
    try {
      console.log("🔤 Warming up PaddleOCR cache (this may take 20-30 seconds on first run)...");
      const { execFile } = require("child_process");

      // Run a simple warm-up script to initialize PaddleOCR
      await new Promise((resolve, reject) => {
        const pythonScript = path.join(__dirname, "tools", "ocr_warmup.py");
        const venvPython = path.join(__dirname, ".venv", "bin", "python");
        const pythonExe = fs.existsSync(venvPython)
          ? venvPython
          : (process.env.OCR_PYTHON || "python3");
        const systemPathPrefix = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
        const runtimePath = process.env.PATH
          ? `${systemPathPrefix}:${process.env.PATH}`
          : systemPathPrefix;

        const safeEnv = {
          ...process.env,
          PATH: runtimePath,
        };

        execFile(
          pythonExe,
          [pythonScript],
          { timeout: 60000, maxBuffer: 10 * 1024 * 1024, env: safeEnv },
          (error, stdout, stderr) => {
            if (error && error.code !== 0) {
              console.warn("⚠️ OCR warmup failed (non-critical):", error.message);
            } else {
              console.log("✅ PaddleOCR cache initialized");
            }
            resolve(); // Always resolve, don't block server start
          }
        );
      });
    } catch (err) {
      console.warn("⚠️ OCR warmup error (non-critical):", err.message);
    }
  }

  http.listen(PORT, "0.0.0.0", () => {
    const url = isDev ? `http://localhost:${PORT}` : `https://pos.beypro.com`;
    console.log(`\n✅ Backend running on ${url}`);
    console.log(`   Environment: ${isDev ? "🔧 DEVELOPMENT" : "🚀 PRODUCTION"}`);
    console.log(`   Port: ${PORT}`);
    console.log(`   LAN accessible: http://0.0.0.0:${PORT}\n`);
  });
}

startServer();

module.exports = { app, pool };
