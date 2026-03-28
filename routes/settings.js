const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const sharp = require("sharp");
const authMiddleware = require("../middleware/authMiddleware");
const { attachAllowedModules } = require("../middleware/moduleGuard");
const { ensureCashLogColumns } = require("../utils/registerLogColumns");
const {
  generateUniqueRestaurantSlug,
  isMissingRestaurantSlug,
  normalizeCustomDomain,
  parseCustomDomain,
} = require("../utils/restaurantSlug");

// ✅ protect all setting
// ✅ protect all settings routes with tenant-safe auth
router.use(authMiddleware);
const standaloneQrAllowed = new Set([
  "/qr-link",
  "/qr-token",
  "/qr-menu-disabled",
  "/qr-menu-customization",
  "/qr-menu-delivery",
  "/qr-menu-branding-assets",
]);
const standaloneStaffAllowed = new Set([
  "/users",
]);
router.use(async (req, res, next) => {
  const allowed = await attachAllowedModules(req);
  if (Array.isArray(allowed) && !allowed.includes("pos_core")) {
    const isStaffAllowed =
      allowed.includes("staff") &&
      (standaloneStaffAllowed.has(req.path) || req.path.startsWith("/roles"));
    if (!standaloneQrAllowed.has(req.path) && !isStaffAllowed) {
      return res.status(403).json({ error: "MODULE_NOT_ALLOWED" });
    }
  }
  return next();
});
// Allowed setting sections
const allowedSections = [
  "notifications",
  "appearance",
  "payments",
  "register",
  "users",
  "subscription",
  "integrations",
  "log_files",
  "localization",
  "transactions",
  "tables",
];
const DEFAULT_TRANSACTIONS = {
  autoCloseTableAfterPay: false,
  autoClosePacketAfterPay: false,
  presetNotes: ["No ketchup", "Extra spicy", "Sauce on side", "Well done"],
  disableAutoPrintTable: false,
  disableAutoPrintPacket: false,
};

const BRANDING_UPLOAD_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/svg+xml",
]);

const brandingUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 6 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const mime = String(file?.mimetype || "").toLowerCase();
    const ext = String(path.extname(file?.originalname || "") || "").toLowerCase();
    const extensionAllowed = [".png", ".jpg", ".jpeg", ".svg"].includes(ext);
    if (BRANDING_UPLOAD_MIME_TYPES.has(mime) || extensionAllowed) {
      return cb(null, true);
    }
    return cb(null, false);
  },
});

async function ensureTransactionsColumn() {
  await pool.query(
    "ALTER TABLE settings ADD COLUMN IF NOT EXISTS transactions jsonb DEFAULT '{}'::jsonb"
  );
}

async function ensureTablesColumn() {
  await pool.query(
    "ALTER TABLE settings ADD COLUMN IF NOT EXISTS tables jsonb DEFAULT '{}'::jsonb"
  );
}

let ensureRestaurantCustomDomainColumnPromise = null;

async function ensureRestaurantCustomDomainColumn() {
  if (!ensureRestaurantCustomDomainColumnPromise) {
    ensureRestaurantCustomDomainColumnPromise = (async () => {
      await pool.query("ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS custom_domain TEXT");
      await pool.query(
        "CREATE UNIQUE INDEX IF NOT EXISTS restaurants_custom_domain_unique_idx ON restaurants (lower(custom_domain)) WHERE custom_domain IS NOT NULL AND btrim(custom_domain) <> ''"
      );
    })().catch((err) => {
      ensureRestaurantCustomDomainColumnPromise = null;
      throw err;
    });
  }

  return ensureRestaurantCustomDomainColumnPromise;
}


// inside settings.js
const jwt = require("jsonwebtoken");

// POST /api/settings/qr-token
router.post("/qr-token", async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const restaurantSlug = req.body.slug || "default";

    const token = jwt.sign(
      {
        token_type: "qr",
        role: "qr",
        restaurant_id: restaurantId,
        slug: restaurantSlug,
        allowed_modules: ["qr_kitchen"],
      },
      process.env.JWT_SECRET,
      { expiresIn: "180d" } // valid for 6 months
    );

    await pool.query(
      "UPDATE restaurants SET qr_token = $1 WHERE id = $2",
      [token, restaurantId]
    );

    res.json({ success: true, token });
  } catch (err) {
    console.error("❌ Failed to generate QR token:", err);
    res.status(500).json({ error: "Failed to generate QR token" });
  }
});

// ✅ GET /api/settings/qr-link — generate full public QR link for this restaurant
// ✅ GET /api/settings/qr-link — short permanent QR link
router.get("/qr-link", async (req, res) => {
  try {
    await ensureRestaurantCustomDomainColumn();
    const restaurantId = req.user.restaurant_id;
    const { rows } = await pool.query(
      "SELECT id, name, slug, custom_domain, qr_token, qr_code_id FROM restaurants WHERE id = $1",
      [restaurantId]
    );
    if (!rows.length) return res.status(404).json({ error: "Restaurant not found" });

    let { id, name, slug, custom_domain, qr_token, qr_code_id } = rows[0];
    const jwt = require("jsonwebtoken");

    // ⚙️ Ensure slug exists (fixes legacy rows where slug is NULL → /qr-menu/null/...)
    if (isMissingRestaurantSlug(slug)) {
      const nextSlug = await generateUniqueRestaurantSlug(pool, name || `restaurant-${id}`);
      await pool.query("UPDATE restaurants SET slug = $1 WHERE id = $2", [nextSlug, restaurantId]);
      slug = nextSlug;
    }

    // ⚙️ Generate token if missing
    if (!qr_token) {
      const token = jwt.sign(
        {
          token_type: "qr",
          role: "qr",
          restaurant_id: restaurantId,
          slug,
          allowed_modules: ["qr_kitchen"],
        },
        process.env.JWT_SECRET,
        { expiresIn: "180d" }
      );
      await pool.query("UPDATE restaurants SET qr_token = $1 WHERE id = $2", [token, restaurantId]);
      qr_token = token;
    }

    // ⚙️ Generate short QR code id if missing
    if (!qr_code_id) {
      const shortid = Math.random().toString(36).substring(2, 8); // e.g. "beyp12"
      await pool.query("UPDATE restaurants SET qr_code_id = $1 WHERE id = $2", [shortid, restaurantId]);
      qr_code_id = shortid;
      console.log(`✅ Generated new short QR id: ${shortid}`);
    }

    // ✅ Final short link (easy to share/print)
    const link = `https://pos.beypro.com/${slug}`;

    res.json({
      success: true,
      link,
      name: name || "",
      slug,
      custom_domain: normalizeCustomDomain(custom_domain) || "",
    });
  } catch (err) {
    console.error("❌ Failed to build QR link:", err);
    res.status(500).json({ error: "Failed to build QR link" });
  }
});



const {
  JSON_COLUMN_TYPES,
  DEFAULT_LOCALIZATION,
  getSettingsSchemaInfo,
  parseMaybeJson,
  normalizeCurrency,
  buildLocalizationResponse,
} = require("../utils/localization");

// POST /settings/shop-hours
router.post("/shop-hours/all", async (req, res) => {
  const { hours } = req.body;
  const restaurantId = Number(req.user?.restaurant_id);

  if (!hours || typeof hours !== "object") {
    return res.status(400).json({ error: "Invalid payload" });
  }
  if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
    return res.status(400).json({ error: "Missing restaurant context" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const [day, { open, close }] of Object.entries(hours)) {
      const openValue = typeof open === "string" ? open.trim() : "";
      const closeValue = typeof close === "string" ? close.trim() : "";
      const isDisabledDay = !openValue || !closeValue;

      // Keep exactly one row per (restaurant, day) without relying on legacy conflict keys.
      await client.query(
        `
        DELETE FROM shop_hours
        WHERE restaurant_id = $1 AND day = $2
        `,
        [restaurantId, day]
      );
      if (isDisabledDay) {
        continue;
      }
      await client.query(
        `
        INSERT INTO shop_hours (restaurant_id, day, open_time, close_time)
        VALUES ($1, $2, $3, $4)
        `,
        [restaurantId, day, openValue, closeValue]
      );
    }

    await client.query("COMMIT");

    try {
      const io = req.app?.get?.("io");
      if (io && Number.isFinite(restaurantId) && restaurantId > 0) {
        const payload = {
          restaurant_id: restaurantId,
          updated_at: new Date().toISOString(),
        };
        // Tenant-scoped event for authenticated clients in the same restaurant room.
        io.to(`restaurant_${restaurantId}`).emit("shop_hours_updated", payload);
        // Public QR pages may not be joined to a tenant room yet; this keeps them in sync instantly.
        io.emit("shop_hours_updated_public", payload);
      }
    } catch (socketErr) {
      console.warn("⚠️ shop_hours_updated socket emit skipped:", socketErr?.message || socketErr);
    }

    res.json({ message: "Shop hours updated" });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to save shop hours:", err);
    res.status(500).json({ error: "Failed to save shop hours" });
  } finally {
    client.release();
  }
});

// ✅ LOG ROUTES (under /api/settings/logs)

// Supplier cart logs
router.get("/logs/suppliers", async (req, res) => {
  const { from, to } = req.query;

  try {
    const result = await pool.query(
      `
      SELECT
        to_char(sc.scheduled_at, 'YYYY-MM-DD') AS date,
        'Supplier Order to ID ' || sc.supplier_id || ' (' || COUNT(sci.id) || ' items)' AS action,
        'System' AS user
      FROM supplier_carts sc
      LEFT JOIN supplier_cart_items sci ON sci.cart_id = sc.id
      WHERE sc.archived = true
        AND sc.scheduled_at BETWEEN $1 AND $2
      GROUP BY sc.id
      ORDER BY sc.scheduled_at DESC
      `,
      [from || "2000-01-01", to || "2100-01-01"]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching supplier cart logs:", err);
    res.status(500).json({ error: "Failed to fetch supplier cart logs." });
  }
});

// Payment logs
router.get("/logs/payments", async (req, res) => {
  const { from, to } = req.query;
  try {
    const result = await pool.query(
      `
      SELECT to_char(delivery_date, 'YYYY-MM-DD') AS date,
             'Paid ' || amount_paid || ' ' || COALESCE(
               (SELECT split_part(l.localization->>'currency', ' ', 1)
                FROM settings s
                CROSS JOIN LATERAL COALESCE(
                  s.localization,
                  (s.value::jsonb -> 'localization')
                ) AS l(localization)
                WHERE s.key = 'global'
                LIMIT 1),
               '₺'
             ) || ' via ' || payment_method AS action,
             'System' AS user
      FROM transactions
      WHERE ingredient = 'Payment'
        AND delivery_date BETWEEN $1 AND $2
      ORDER BY delivery_date DESC
      `,
      [from || "2000-01-01", to || "2100-01-01"]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Payment logs failed:", err);
    res.status(500).json({ error: "Payment log error" });
  }
});

// Register logs
router.get("/logs/:type", async (req, res) => {
  const { type } = req.params;
  const { from, to } = req.query;
  const fromDate = from || "2000-01-01";
  const toDate = to || "2100-01-01";

  try {
    let result;

    if (type === "register") {
      await ensureCashLogColumns();
      result = await pool.query(
        `
          SELECT
            date::text AS date,
            type,
            amount,
            note,
            COALESCE(staff_name, 'System') AS staff,
            COALESCE(staff_id::text, '') AS staff_id,
            created_at
          FROM cash_register_logs
          WHERE date BETWEEN $1 AND $2
          ORDER BY created_at DESC
        `,
        [fromDate, toDate]
      );
    } else if (type === "login") {
      // Example for login logs; adapt this for your actual table/fields!
      result = await pool.query(
        `
          SELECT
            to_char(login_time, 'YYYY-MM-DD') AS date,
            'User Login: ' || username AS action,
            username AS user
          FROM user_login_logs
          WHERE login_time BETWEEN $1 AND $2
          ORDER BY login_time DESC
        `,
        [fromDate, toDate]
      );
    } else {
      // Add more else-if blocks for new log types as needed.
      return res.status(400).json({ error: `Log type "${type}" not supported.` });
    }

    res.json(result.rows);
  } catch (err) {
    console.error(`❌ Error fetching ${type} logs:`, err);
    res.status(500).json({ error: `Log fetch failed for ${type}` });
  }
});


router.get("/shop-hours/all", async (req, res) => {
  try {
    const restaurantId = Number(req.user?.restaurant_id);
    if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
      return res.status(400).json({ error: "Missing restaurant context" });
    }

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");

    const result = await pool.query(
      `
      SELECT day, open_time, close_time
      FROM shop_hours
      WHERE restaurant_id = $1
      ORDER BY id
      `,
      [restaurantId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Failed to load shop hours:", err);
    res.status(500).json({ error: "Failed to load shop hours" });
  }
});

router.get("/localization", async (req, res) => {
  try {
    const schema = await getSettingsSchemaInfo();

    if (schema.hasLocalization && schema.hasRestaurantId) {
      const restaurantId = req.user.restaurant_id;
      const result = await pool.query(
        `
          SELECT localization, value
          FROM settings
          WHERE restaurant_id = $1 AND key = 'global'
          LIMIT 1
        `,
        [restaurantId]
      );

      const row = result.rows?.[0] || {};
      let localization = row.localization;

      if (!localization || typeof localization !== "object") {
        const parsedLocalization = parseMaybeJson(localization);
        if (parsedLocalization && typeof parsedLocalization === "object") {
          localization = parsedLocalization;
        } else {
          const parsed = parseMaybeJson(row.value);
          if (parsed && typeof parsed === "object" && parsed.localization) {
            localization = parsed.localization;
          } else {
            localization = {};
          }
        }
      }

      return res.json(buildLocalizationResponse(localization));
    }

    const restaurantId = schema.hasRestaurantId ? req.user.restaurant_id : null;
    const params = [];
    let query = `
      SELECT key, value
      FROM settings
      WHERE key IN ('language', 'currency')
    `;

    if (schema.hasRestaurantId) {
      query += " AND restaurant_id = $1";
      params.push(restaurantId);
    }

    const fallbackResult = await pool.query(query, params);

    const settingsMap = fallbackResult.rows.reduce((acc, row) => {
      const parsed = parseMaybeJson(row.value);
      acc[row.key] = parsed?.value ?? parsed ?? row.value;
      return acc;
    }, {});

    res.json(
      buildLocalizationResponse({
        language: settingsMap.language,
        currency: settingsMap.currency,
      })
    );
  } catch (err) {
    console.error("❌ Error fetching localization:", err);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});



router.post("/localization", async (req, res) => {
  const { language, currency } = req.body;

  try {
    const schema = await getSettingsSchemaInfo();
    const normalizedCurrency = normalizeCurrency(currency);
    const localizationPayload = JSON.stringify({
      language,
      currency: normalizedCurrency,
    });

    if (schema.hasLocalization && schema.hasRestaurantId) {
      const restaurantId = req.user.restaurant_id;
      const isJsonColumn = JSON_COLUMN_TYPES.has(
        (schema.localizationType || "").toLowerCase()
      );

      const query = `
        INSERT INTO settings (restaurant_id, key, localization)
        VALUES ($1, 'global', ${isJsonColumn ? "$2::" + schema.localizationType : "$2"})
        ON CONFLICT (restaurant_id, key)
        DO UPDATE SET localization = EXCLUDED.localization
      `;

      await pool.query(query, [restaurantId, localizationPayload]);

      return res.json({
        success: true,
        localization: { language, currency: normalizedCurrency },
      });
    }

    const hasRestaurant = schema.hasRestaurantId;
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const insertSql = hasRestaurant
        ? `
            INSERT INTO settings (restaurant_id, key, value)
            VALUES ($1, $2, $3)
            ON CONFLICT (restaurant_id, key) DO UPDATE SET value = EXCLUDED.value
          `
        : `
            INSERT INTO settings (key, value)
            VALUES ($1, $2)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
          `;

      const langParams = hasRestaurant
        ? [req.user.restaurant_id, "language", language]
        : ["language", language];

      const currencyParams = hasRestaurant
        ? [req.user.restaurant_id, "currency", normalizedCurrency]
        : ["currency", normalizedCurrency];

      await client.query(insertSql, langParams);
      await client.query(insertSql, currencyParams);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({
      success: true,
      localization: { language, currency: normalizedCurrency },
    });
  } catch (err) {
    console.error("❌ Error saving localization settings:", err);
    res.status(500).json({ error: "Failed to save localization settings" });
  }
});


// GET /api/settings/qr-menu-disabled
router.get("/qr-menu-disabled", async (req, res) => {
  try {
    const restaurantId = req.user?.restaurant_id;
    if (!restaurantId) {
      return res.status(400).json({ error: "restaurant_id is required" });
    }

    const result = await pool.query(
      "SELECT value FROM settings WHERE restaurant_id = $1 AND key = 'qr-menu-disabled' LIMIT 1",
      [restaurantId]
    );
    // Try to parse value as JSON array, fallback to empty
    let disabled = [];
    if (result.rows.length) {
      try {
        disabled = JSON.parse(result.rows[0].value);
        if (!Array.isArray(disabled)) disabled = [];
      } catch {
        disabled = [];
      }
    }
    res.json({ disabled });
  } catch (err) {
    console.error("❌ Failed to fetch qr-menu-disabled:", err);
    res.status(500).json({ error: "Failed to fetch qr-menu-disabled" });
  }
});

// POST /api/settings/qr-menu-disabled
router.post("/qr-menu-disabled", async (req, res) => {
  const { disabled } = req.body; // expects an array of IDs
  try {
    const restaurantId = req.user.restaurant_id;
await pool.query(
  `INSERT INTO settings (restaurant_id, key, value)
   VALUES ($1, 'qr-menu-disabled', $2)
   ON CONFLICT (restaurant_id, key) DO UPDATE SET value = EXCLUDED.value`,
  [restaurantId, JSON.stringify(Array.isArray(disabled) ? disabled : [])]
);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to update qr-menu-disabled:", err);
    res.status(500).json({ error: "Failed to update qr-menu-disabled" });
  }
});

// ✅ Correct: save role permissions into settings.key='users' (not 'global')
router.post("/roles", async (req, res) => {
  const { role, permissions } = req.body;
  const restaurantId = req.user.restaurant_id;

  if (!role || !Array.isArray(permissions)) {
    return res.status(400).json({ error: "Role and permissions required" });
  }

  try {
    // 1️⃣ Fetch current user config (key='users')
    const result = await pool.query(
      `SELECT value FROM settings WHERE restaurant_id = $1 AND key = 'users' LIMIT 1`,
      [restaurantId]
    );

    let config = result.rows[0]?.value || { roles: {} };
    if (typeof config === "string") config = JSON.parse(config);

    // 2️⃣ Update that role
    const roleKey = role.toLowerCase();
    config.roles = config.roles || {};
    config.roles[roleKey] = permissions.map((p) => p.toLowerCase());

    // 3️⃣ Save back into key='users'
    await pool.query(
      `
      INSERT INTO settings (restaurant_id, key, value)
      VALUES ($1, 'users', $2::jsonb)
      ON CONFLICT (restaurant_id, key)
      DO UPDATE SET value = EXCLUDED.value;
      `,
      [restaurantId, JSON.stringify(config)]
    );

    res.json({ success: true, roles: config.roles });
  } catch (err) {
    console.error("❌ Failed to update role permissions:", err);
    res.status(500).json({ error: "Failed to update role permissions" });
  }
});



// ✅ Delete role
// ✅ Delete role from key='users'
router.delete("/roles/:role", async (req, res) => {
  const role = req.params.role?.toLowerCase();
  const restaurantId = req.user.restaurant_id;

  if (!role) return res.status(400).json({ error: "Role is required" });

  try {
    const result = await pool.query(
      `SELECT value FROM settings WHERE restaurant_id = $1 AND key = 'users' LIMIT 1`,
      [restaurantId]
    );

    let config = result.rows[0]?.value || { roles: {} };
    if (typeof config === "string") config = JSON.parse(config);

    if (!config.roles || !config.roles[role]) {
      return res.status(404).json({ error: `Role '${role}' not found` });
    }

    delete config.roles[role];

    await pool.query(
      `
      INSERT INTO settings (restaurant_id, key, value)
      VALUES ($1, 'users', $2::jsonb)
      ON CONFLICT (restaurant_id, key)
      DO UPDATE SET value = EXCLUDED.value;
      `,
      [restaurantId, JSON.stringify(config)]
    );

    res.json({ success: true, roles: config.roles });
  } catch (err) {
    console.error("❌ Failed to delete role:", err);
    res.status(500).json({ error: "Failed to delete role" });
  }
});



// ✅ GET /api/settings/:section
/* ===========================================================
   QR MENU WEBSITE BUILDER
   Save + Fetch Customization (titles, story, hero slides, etc.)
   =========================================================== */

const BRANDING_DEFAULTS = {
  app_icon: "",
  app_icon_192: "",
  app_icon_512: "",
  apple_touch_icon: "",
  splash_logo: "",
  app_display_name: "",
  pwa_primary_color: "#4F46E5",
  pwa_background_color: "#FFFFFF",
  qrmenu_font_family: "gotham",
  concert_reservation_button_color: "#111827",
};

function parseCustomizationPayload(row) {
  if (!row) return {};
  if (row.qr_menu_customization && typeof row.qr_menu_customization === "object") {
    return row.qr_menu_customization;
  }
  if (row.value && typeof row.value === "object") {
    return row.value;
  }
  if (typeof row.value === "string") {
    try {
      const parsed = JSON.parse(row.value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function sanitizeSlugForPath(value, fallback = "restaurant") {
  const raw = String(value || "").trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9-_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalized || fallback;
}

async function ensureRestaurantSlugForBranding(restaurantId, fallbackName = "restaurant") {
  await ensureRestaurantCustomDomainColumn();
  const { rows } = await pool.query(
    "SELECT slug, name, custom_domain FROM restaurants WHERE id = $1 LIMIT 1",
    [restaurantId]
  );

  if (!rows.length) {
    return { slug: null, name: "", custom_domain: "" };
  }

  let slug = rows[0].slug;
  const name = rows[0].name || fallbackName;
  const custom_domain = normalizeCustomDomain(rows[0].custom_domain) || "";
  if (isMissingRestaurantSlug(slug)) {
    const nextSlug = await generateUniqueRestaurantSlug(pool, name || `restaurant-${restaurantId}`);
    await pool.query("UPDATE restaurants SET slug = $1 WHERE id = $2", [nextSlug, restaurantId]);
    slug = nextSlug;
  }

  return { slug, name, custom_domain };
}

async function findRestaurantSlugConflict(db, slug, restaurantId) {
  const { rows } = await db.query(
    "SELECT id FROM restaurants WHERE lower(slug) = lower($1) AND id <> $2 LIMIT 1",
    [slug, restaurantId]
  );
  return rows[0] || null;
}

async function findRestaurantCustomDomainConflict(db, customDomain, restaurantId) {
  const { rows } = await db.query(
    "SELECT id FROM restaurants WHERE lower(custom_domain) = lower($1) AND id <> $2 LIMIT 1",
    [customDomain, restaurantId]
  );
  return rows[0] || null;
}

function colorHexToRgba(input, fallback = { r: 255, g: 255, b: 255, alpha: 1 }) {
  const value = String(input || "").trim();
  const match = value.match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!match) return fallback;
  const hex = match[1].length === 3
    ? match[1].split("").map((ch) => ch + ch).join("")
    : match[1];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    alpha: 1,
  };
}

async function readQrMenuCustomization(restaurantId, db = pool) {
  const result = await db.query(
    `
      SELECT qr_menu_customization, value
      FROM settings
      WHERE restaurant_id = $1 AND key = 'qr-menu-customization'
      LIMIT 1
    `,
    [restaurantId]
  );

  if (!result.rows.length) return {};
  return parseCustomizationPayload(result.rows[0]);
}

async function saveQrMenuCustomization(restaurantId, payload) {
  await pool.query(
    `
      INSERT INTO settings (restaurant_id, key, qr_menu_customization)
      VALUES ($1, 'qr-menu-customization', $2::jsonb)
      ON CONFLICT (restaurant_id, key)
      DO UPDATE SET qr_menu_customization = EXCLUDED.qr_menu_customization
    `,
    [restaurantId, JSON.stringify(payload)]
  );
}

// Place these BEFORE the generic /:section handlers so they are not shadowed
router.get("/qr-menu-customization", async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const {
      name: restaurantName,
      slug: restaurantSlug,
      custom_domain: restaurantCustomDomain,
    } = await ensureRestaurantSlugForBranding(restaurantId);

    const result = await pool.query(
      `
      SELECT qr_menu_customization, value
      FROM settings
      WHERE restaurant_id = $1 AND key = 'qr-menu-customization'
      LIMIT 1
      `,
      [restaurantId]
    );

    let data = {};

    if (result.rows.length) {
      // Prefer jsonb column
      if (result.rows[0].qr_menu_customization) {
        data = result.rows[0].qr_menu_customization;
      }
      // Fallback to value column
      else if (result.rows[0].value) {
        data = JSON.parse(result.rows[0].value);
      }
    }

    // Default values if new restaurant
    const defaults = {
      main_title: "Welcome to Our Restaurant",
      subtitle: "Fresh • Local • Crafted",
      tagline: "",
      phone: "",
      primary_color: "#4F46E5",

      hero_slides: [],

      story_title: "",
      story_text: "",
      story_image: "",

      reviews: [],

      social_instagram: "",
      social_tiktok: "",
      social_website: "",

      gallery_images: [],

      show_open_status: true,
      delivery_time: "25–35 min",
      pickup_time: "10 min",
      call_button_enabled: true,

      // === New customization fields ===
      enable_popular: true,
      // qr theme: auto | light | dark
      qr_theme: "auto",

      // Loyalty program
      loyalty_enabled: false,
      loyalty_goal: 10,
      loyalty_reward_text: "Free Menu Item",
      loyalty_color: "#F59E0B",
      delivery_enabled: true,
      table_order_enabled: true,
      reservation_pickup_enabled: true,
      reservation_guest_composition_enabled: false,
      reservation_guest_composition_field_mode: "optional",
      reservation_guest_composition_restriction_rule: "no_restriction",
      reservation_guest_composition_validation_message: "",
      disable_all_products: false,
      table_geo_enabled: false,
      table_geo_radius_meters: 150,
      ...BRANDING_DEFAULTS,
      app_display_name: restaurantName || "Restaurant",
    };

    res.json({
      success: true,
      customization: {
        ...defaults,
        ...data,
      },
      restaurant: {
        slug: restaurantSlug || "",
        custom_domain: restaurantCustomDomain || "",
      },
    });
  } catch (err) {
    console.error("❌ Failed to load QR menu customization:", err);
    res.status(500).json({ error: "Failed to load QR menu customization" });
  }
});

router.post("/qr-menu-customization", async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureRestaurantCustomDomainColumn();
    const restaurantId = Number(req.user.restaurant_id);
    const newData = req.body;

    if (!newData || typeof newData !== "object" || Array.isArray(newData)) {
      return res.status(400).json({ error: "Invalid customization payload" });
    }

    await client.query("BEGIN");

    const restaurantResult = await client.query(
      `
      SELECT id, name, slug, custom_domain
      FROM restaurants
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [restaurantId]
    );

    if (!restaurantResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const restaurant = restaurantResult.rows[0];
    const restaurantName = String(restaurant.name || "").trim() || `restaurant-${restaurantId}`;
    let nextSlug = restaurant.slug;
    let nextCustomDomain = normalizeCustomDomain(restaurant.custom_domain) || "";

    if (isMissingRestaurantSlug(nextSlug)) {
      nextSlug = await generateUniqueRestaurantSlug(client, restaurantName);
      await client.query("UPDATE restaurants SET slug = $1 WHERE id = $2", [nextSlug, restaurantId]);
    }

    if (Object.prototype.hasOwnProperty.call(newData, "custom_domain")) {
      const rawCustomDomain = String(newData.custom_domain || "").trim();

      if (!rawCustomDomain) {
        nextCustomDomain = "";
        await client.query("UPDATE restaurants SET custom_domain = NULL WHERE id = $1", [restaurantId]);
      } else {
        const parsedDomain = parseCustomDomain(rawCustomDomain);
        if (!parsedDomain.normalizedDomain || !parsedDomain.slug) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Invalid custom domain format",
            field: "custom_domain",
          });
        }

        const customDomainConflict = await findRestaurantCustomDomainConflict(
          client,
          parsedDomain.normalizedDomain,
          restaurantId
        );
        if (customDomainConflict) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "This custom domain is already in use",
            field: "custom_domain",
          });
        }

        const slugConflict = await findRestaurantSlugConflict(client, parsedDomain.slug, restaurantId);
        if (slugConflict) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "Another restaurant already uses the generated slug for this domain",
            field: "custom_domain",
            slug: parsedDomain.slug,
          });
        }

        nextCustomDomain = parsedDomain.normalizedDomain;
        nextSlug = parsedDomain.slug;
        await client.query(
          "UPDATE restaurants SET custom_domain = $1, slug = $2 WHERE id = $3",
          [nextCustomDomain, nextSlug, restaurantId]
        );
      }
    }

    const existingData = await readQrMenuCustomization(restaurantId, client);
    const sanitizedNewData = { ...newData };
    delete sanitizedNewData.custom_domain;
    delete sanitizedNewData.slug;
    delete sanitizedNewData.generated_slug;
    delete sanitizedNewData.restaurant_slug;

    const mergedData = {
      ...existingData,
      ...sanitizedNewData,
    };

    await client.query(
      `
      INSERT INTO settings (restaurant_id, key, qr_menu_customization)
      VALUES ($1, 'qr-menu-customization', $2::jsonb)
      ON CONFLICT (restaurant_id, key)
      DO UPDATE SET qr_menu_customization = EXCLUDED.qr_menu_customization
      `,
      [restaurantId, JSON.stringify(mergedData)]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      customization: mergedData,
      restaurant: {
        slug: nextSlug || "",
        custom_domain: nextCustomDomain || "",
      },
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures after early returns.
    }
    console.error("❌ Failed to save QR customization:", err);
    res.status(500).json({ error: "Failed to save qr-menu-customization" });
  } finally {
    client.release();
  }
});

router.post(
  "/qr-menu-branding-assets",
  brandingUpload.fields([
    { name: "app_icon", maxCount: 1 },
    { name: "splash_logo", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const restaurantId = req.user.restaurant_id;
      const files = req.files || {};
      const appIconFile = Array.isArray(files.app_icon) ? files.app_icon[0] : null;
      const splashLogoFile = Array.isArray(files.splash_logo) ? files.splash_logo[0] : null;

      if (!appIconFile && !splashLogoFile) {
        return res.status(400).json({ error: "No branding file uploaded." });
      }

      const existing = await readQrMenuCustomization(restaurantId);
      const next = { ...existing };
      const { slug, name: restaurantName } = await ensureRestaurantSlugForBranding(restaurantId);
      if (!slug) {
        return res.status(404).json({ error: "Restaurant not found" });
      }

      const safeSlug = sanitizeSlugForPath(slug, `restaurant-${restaurantId}`);
      const relativeDir = path.join("uploads", "restaurants", safeSlug);
      const absoluteDir = path.join(__dirname, "..", "public", relativeDir);
      await fs.promises.mkdir(absoluteDir, { recursive: true });

      if (appIconFile?.buffer) {
        const icon192RelPath = path.join(relativeDir, "icon-192.png");
        const icon512RelPath = path.join(relativeDir, "icon-512.png");
        const appleTouchRelPath = path.join(relativeDir, "apple-touch-icon.png");

        await sharp(appIconFile.buffer, { density: 300 })
          .resize(192, 192, {
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
            withoutEnlargement: false,
          })
          .png({ compressionLevel: 9, quality: 90 })
          .toFile(path.join(__dirname, "..", "public", icon192RelPath));

        await sharp(appIconFile.buffer, { density: 300 })
          .resize(512, 512, {
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
            withoutEnlargement: false,
          })
          .png({ compressionLevel: 9, quality: 90 })
          .toFile(path.join(__dirname, "..", "public", icon512RelPath));

        await sharp(appIconFile.buffer, { density: 300 })
          .resize(180, 180, {
            fit: "contain",
            background: { r: 255, g: 255, b: 255, alpha: 1 },
            withoutEnlargement: false,
          })
          .png({ compressionLevel: 9, quality: 90 })
          .toFile(path.join(__dirname, "..", "public", appleTouchRelPath));

        next.app_icon = `/${icon512RelPath.replace(/\\/g, "/")}`;
        next.app_icon_192 = `/${icon192RelPath.replace(/\\/g, "/")}`;
        next.app_icon_512 = `/${icon512RelPath.replace(/\\/g, "/")}`;
        next.apple_touch_icon = `/${appleTouchRelPath.replace(/\\/g, "/")}`;
      }

      if (splashLogoFile?.buffer) {
        const splashRelPath = path.join(relativeDir, "splash-logo.png");
        const splashBackground = colorHexToRgba(
          req.body?.pwa_background_color || existing?.pwa_background_color || "#FFFFFF",
          { r: 255, g: 255, b: 255, alpha: 1 }
        );

        await sharp(splashLogoFile.buffer, { density: 300 })
          .resize(1024, 1024, {
            fit: "contain",
            background: splashBackground,
            withoutEnlargement: true,
          })
          .png({ compressionLevel: 9, quality: 90 })
          .toFile(path.join(__dirname, "..", "public", splashRelPath));

        next.splash_logo = `/${splashRelPath.replace(/\\/g, "/")}`;
      }

      next.branding_updated_at = new Date().toISOString();
      if (!String(next.app_display_name || "").trim()) {
        next.app_display_name = restaurantName || next.main_title || "Restaurant";
      }

      await saveQrMenuCustomization(restaurantId, next);

      return res.json({
        success: true,
        customization: next,
      });
    } catch (err) {
      console.error("❌ Failed to upload QR branding assets:", err);
      return res.status(500).json({ error: "Failed to upload branding assets" });
    }
  }
);

router.post("/qr-menu-delivery", async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const { delivery_enabled } = req.body;

    if (typeof delivery_enabled !== "boolean") {
      return res.status(400).json({ error: "delivery_enabled must be boolean" });
    }

    const result = await pool.query(
      `
      SELECT qr_menu_customization, value
      FROM settings
      WHERE restaurant_id = $1 AND key = 'qr-menu-customization'
      LIMIT 1
      `,
      [restaurantId]
    );

    let data = {};
    if (result.rows.length) {
      const row = result.rows[0];
      if (row.qr_menu_customization) {
        data = { ...row.qr_menu_customization };
      } else if (row.value) {
        try {
          data = { ...JSON.parse(row.value) };
        } catch {
          data = {};
        }
      }
    }

    data.delivery_enabled = delivery_enabled;

    await pool.query(
      `
      INSERT INTO settings (restaurant_id, key, qr_menu_customization)
      VALUES ($1, 'qr-menu-customization', $2::jsonb)
      ON CONFLICT (restaurant_id, key)
      DO UPDATE SET qr_menu_customization = EXCLUDED.qr_menu_customization
      `,
      [restaurantId, JSON.stringify(data)]
    );

    res.json({ success: true, delivery_enabled });
  } catch (err) {
    console.error("❌ Failed to update delivery flag:", err);
    res.status(500).json({ error: "Failed to update delivery setting" });
  }
});

// Generic GET after specific routes
router.get("/:section", async (req, res) => {
  const { section } = req.params;
  const restaurantId = req.user.restaurant_id; // ✅ tenant-safe

  if (!allowedSections.includes(section)) {
    console.warn(`⚠️ Invalid GET section: ${section}`);
    return res.status(400).json({ error: "Invalid section" });
  }

  try {
    if (section === "transactions") {
      await ensureTransactionsColumn();
    }
    if (section === "tables") {
      await ensureTablesColumn();
    }

    const restaurantId = req.user.restaurant_id;
const result = await pool.query(
  `SELECT ${section} FROM settings WHERE restaurant_id = $1 AND key = 'global' LIMIT 1`,
  [restaurantId]
);


    const raw = result.rows?.[0]?.[section] || {};

    const defaults = {
      notifications: {
        enabled: true,
        defaultSound: "ding",
        enableCallWaiterAlerts: true,
        enableCallWaiterVibration: false,
        channels: { kitchen: "app", cashier: "app", manager: "app" },
        escalation: { enabled: true, delayMinutes: 3 },
        eventSounds: {
          new_order: "new_order.mp3",
          order_preparing: "pop",
        order_ready: "chime",
        order_delivered: "success",
        payment_made: "cash",
        stock_low: "warning",
        stock_restocked: "ding",
        driver_assigned: "horn",
        order_delayed: "alarm",
      driver_arrived: "horn",
      call_waiter: "none",
    },
  }
};

    const merged = section === "notifications"
      ? {
          ...defaults.notifications,
          ...raw,
          eventSounds: {
            ...defaults.notifications.eventSounds,
            ...(raw?.eventSounds || {}),
          },
        }
      : section === "transactions"
        ? {
            ...DEFAULT_TRANSACTIONS,
            ...raw,
            presetNotes: Array.isArray(raw?.presetNotes)
              ? raw.presetNotes
              : DEFAULT_TRANSACTIONS.presetNotes,
          }
        : raw;

    res.json(merged);
  } catch (err) {
    console.error(`❌ Failed to fetch ${section} settings:`, err);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

// ✅ POST /api/settings/:section
// ✅ POST /api/settings/:section
router.post("/:section", async (req, res) => {
  const { section } = req.params;
  let newData = req.body;

  if (!allowedSections.includes(section)) {
    console.warn(`⚠️ Invalid POST section: ${section}`);
    return res.status(400).json({ error: "Invalid section" });
  }

  if (section === "transactions") {
    newData = {
      ...DEFAULT_TRANSACTIONS,
      ...newData,
      presetNotes: Array.isArray(newData?.presetNotes)
        ? newData.presetNotes
        : DEFAULT_TRANSACTIONS.presetNotes,
    };
  }

  if (section === "tables") {
    newData = {
      tableLabelText: "",
      showAreas: true,
      ...newData,
    };
  }

  // 🔹 Merge defaults for notifications (keeps all expected fields)
  if (section === "notifications") {
    const defaults = {
      enabled: true,
      defaultSound: "ding.mp3",
      enableCallWaiterAlerts: true,
      enableCallWaiterVibration: false,
      channels: { kitchen: "app", cashier: "app", manager: "app" },
      escalation: { enabled: true, delayMinutes: 3 },
      stockAlert: { enabled: true, cooldownMinutes: 30 },
      eventSounds: {
        new_order: "new_order.mp3",
        order_preparing: "pop.mp3",
        order_ready: "chime.mp3",
        order_delivered: "success.mp3",
        payment_made: "cash.mp3",
        stock_low: "warning.mp3",
        stock_restocked: "ding.mp3",
        driver_assigned: "horn.mp3",
        order_delayed: "alarm.mp3",
        driver_arrived: "horn.mp3",
        call_waiter: "none",
      },
    };

    newData = {
      ...defaults,
      ...newData,
      eventSounds: {
        ...defaults.eventSounds,
        ...(newData?.eventSounds || {}),
      },
    };
  }

  try {
    const restaurantId = req.user.restaurant_id;
    if (section === "transactions") {
      await ensureTransactionsColumn();
    }

    // ✅ Upsert (INSERT or UPDATE) tenant-safe JSON section
    await pool.query(
      `
      INSERT INTO settings (restaurant_id, key, ${section})
      VALUES ($1, 'global', $2::jsonb)
      ON CONFLICT (restaurant_id, key)
      DO UPDATE SET ${section} = EXCLUDED.${section};
      `,
      [restaurantId, JSON.stringify(newData)]
    );

    // ✅ Keep restaurants.external_remote_id in sync with Yemeksepeti remoteId
    // Rule: integrations.yemeksepeti.remoteId -> restaurants.external_remote_id
    if (section === "integrations") {
      const remoteIdRaw =
        newData?.yemeksepeti?.remoteId ??
        newData?.integrations?.yemeksepeti?.remoteId;

      if (remoteIdRaw !== undefined) {
        const remoteIdNormalized = String(remoteIdRaw || "").trim() || null;
        await pool.query(
          "UPDATE restaurants SET external_remote_id = $1 WHERE id = $2",
          [remoteIdNormalized, restaurantId]
        );
      }
    }

    res.json({ success: true, [section]: newData });
  } catch (err) {
    console.error(`❌ Failed to save ${section} settings:`, err);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

// =========================================================
// RESTAURANT EXTERNAL IDS API
// =========================================================

/**
 * GET /api/settings/restaurants/:id/external-ids
 * Fetch external integration remote IDs for a restaurant
 */
router.get("/restaurants/:id/external-ids", async (req, res) => {
  try {
    const restaurantId = Number.parseInt(req.params.id, 10);
    const userRestaurantId = req.user?.restaurant_id;

    if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
      return res.status(400).json({ error: "Invalid restaurant ID" });
    }

    // Ensure user can only access their own restaurant
    if (userRestaurantId && userRestaurantId !== restaurantId) {
      return res.status(403).json({ error: "Access denied to this restaurant" });
    }

    const { rows } = await pool.query(
      `SELECT external_migros_remote_id, external_remote_id 
       FROM restaurants 
       WHERE id = $1 
       LIMIT 1`,
      [restaurantId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    res.json({
      migrosRemoteId: rows[0].external_migros_remote_id || "",
      yemeksepetiRemoteId: rows[0].external_remote_id || "",
    });
  } catch (err) {
    console.error("❌ Failed to fetch external IDs:", err);
    res.status(500).json({ error: "Failed to fetch external IDs" });
  }
});

/**
 * POST /api/settings/restaurants/:id/external-ids
 * Update external integration remote IDs for a restaurant
 */
router.post("/restaurants/:id/external-ids", async (req, res) => {
  try {
    const restaurantId = Number.parseInt(req.params.id, 10);
    const userRestaurantId = req.user?.restaurant_id;

    if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
      return res.status(400).json({ error: "Invalid restaurant ID" });
    }

    // Ensure user can only update their own restaurant
    if (userRestaurantId && userRestaurantId !== restaurantId) {
      return res.status(403).json({ error: "Access denied to this restaurant" });
    }

    const { migrosRemoteId } = req.body;

    if (migrosRemoteId !== undefined && typeof migrosRemoteId !== "string") {
      return res.status(400).json({ error: "migrosRemoteId must be a string" });
    }

    const normalizedMigrosRemoteId = (migrosRemoteId || "").trim() || null;

    // Check uniqueness if non-empty
    if (normalizedMigrosRemoteId) {
      const { rows: existing } = await pool.query(
        `SELECT id FROM restaurants 
         WHERE external_migros_remote_id = $1 
         AND id != $2 
         LIMIT 1`,
        [normalizedMigrosRemoteId, restaurantId]
      );

      if (existing.length > 0) {
        return res.status(409).json({
          error: "DUPLICATE_MIGROS_REMOTE_ID",
          message: "This Migros Remote ID is already used by another restaurant",
        });
      }
    }

    // Update the restaurant
    const { rows } = await pool.query(
      `UPDATE restaurants 
       SET external_migros_remote_id = $1 
       WHERE id = $2 
       RETURNING id, external_migros_remote_id`,
      [normalizedMigrosRemoteId, restaurantId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    console.log(`✅ Updated Migros Remote ID for restaurant ${restaurantId}: ${normalizedMigrosRemoteId || "(cleared)"}`);

    res.json({
      success: true,
      migrosRemoteId: rows[0].external_migros_remote_id || "",
    });
  } catch (err) {
    console.error("❌ Failed to update external IDs:", err);
    res.status(500).json({ error: "Failed to update external IDs" });
  }
});

module.exports = router;
