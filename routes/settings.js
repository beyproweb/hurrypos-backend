const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
const { ensureCashLogColumns } = require("../utils/registerLogColumns");

// ✅ protect all setting
// ✅ protect all settings routes with tenant-safe auth
router.use(authMiddleware);
// Allowed setting sections
const allowedSections = [
  "notifications", "appearance", "payments", "register",
  "users", "subscription", "integrations", "log_files" ,"localization"
];


// inside settings.js
const jwt = require("jsonwebtoken");

// POST /api/settings/qr-token
router.post("/qr-token", async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const restaurantSlug = req.body.slug || "default";

    const token = jwt.sign(
      { restaurant_id: restaurantId, slug: restaurantSlug },
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
    const restaurantId = req.user.restaurant_id;
    const { rows } = await pool.query(
      "SELECT id, slug, qr_token, qr_code_id FROM restaurants WHERE id = $1",
      [restaurantId]
    );
    if (!rows.length) return res.status(404).json({ error: "Restaurant not found" });

    let { id, slug, qr_token, qr_code_id } = rows[0];
    const jwt = require("jsonwebtoken");

    // ⚙️ Generate token if missing
    if (!qr_token) {
      const token = jwt.sign(
        { restaurant_id: restaurantId, slug },
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

    // ✅ Final short link (no JWT exposed)
    const link = `https://pos.beypro.com/qr-menu/${slug}/${qr_code_id}`;

    res.json({ success: true, link });
  } catch (err) {
    console.error("❌ Failed to build QR link:", err);
    res.status(500).json({ error: "Failed to build QR link" });
  }
});



const JSON_COLUMN_TYPES = new Set(["json", "jsonb"]);
const DEFAULT_LOCALIZATION = { language: "en", currency: "₺ TRY" };

async function getSettingsSchemaInfo() {
  const { rows } = await pool.query(
    `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'settings'
    `
  );

  const find = (name) => rows.find((row) => row.column_name === name);

  return {
    hasLocalization: Boolean(find("localization")),
    localizationType: find("localization")?.data_type || null,
    hasRestaurantId: Boolean(find("restaurant_id")),
    hasValue: Boolean(find("value")),
  };
}

function parseMaybeJson(value) {
  if (value === null || typeof value === "undefined") return undefined;
  if (typeof value === "object") return value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return value;
      }
    }
  }

  return value;
}

function normalizeCurrency(currency) {
  if (!currency) return DEFAULT_LOCALIZATION.currency;

  const map = {
    "₺": "₺ TRY",
    "try": "₺ TRY",
    "₺ try": "₺ TRY",
    "try ₺": "₺ TRY",
  };

  const key = String(currency).trim().toLowerCase();
  return map[key] || currency;
}

function buildLocalizationResponse(rawLocalization = {}) {
  const merged = {
    ...DEFAULT_LOCALIZATION,
    ...rawLocalization,
  };

  merged.currency = normalizeCurrency(merged.currency);
  return merged;
}

// POST /settings/shop-hours
router.post("/shop-hours/all", async (req, res) => {
  const { hours } = req.body;

  if (!hours || typeof hours !== "object") {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const [day, { open, close }] of Object.entries(hours)) {
      await client.query(`
        INSERT INTO shop_hours (day, open_time, close_time)
        VALUES ($1, $2, $3)
        ON CONFLICT (day) DO UPDATE
        SET open_time = EXCLUDED.open_time,
            close_time = EXCLUDED.close_time
      `, [day, open, close]);
    }

    await client.query("COMMIT");
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
             'Paid ' || amount_paid || '₺ via ' || payment_method AS action,
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
    const result = await pool.query(`
      SELECT day, open_time, close_time
      FROM shop_hours
      ORDER BY id
    `);
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

// Place these BEFORE the generic /:section handlers so they are not shadowed
router.get("/qr-menu-customization", async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;

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
    };

    res.json({
      success: true,
      customization: {
        ...defaults,
        ...data,
      },
    });
  } catch (err) {
    console.error("❌ Failed to load QR menu customization:", err);
    res.status(500).json({ error: "Failed to load QR menu customization" });
  }
});

router.post("/qr-menu-customization", async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const newData = req.body;

    if (!newData || typeof newData !== "object") {
      return res.status(400).json({ error: "Invalid customization payload" });
    }

    // Upsert jsonb
    await pool.query(
      `
      INSERT INTO settings (restaurant_id, key, qr_menu_customization)
      VALUES ($1, 'qr-menu-customization', $2::jsonb)
      ON CONFLICT (restaurant_id, key)
      DO UPDATE SET qr_menu_customization = EXCLUDED.qr_menu_customization
      `,
      [restaurantId, JSON.stringify(newData)]
    );

    res.json({ success: true, customization: newData });
  } catch (err) {
    console.error("❌ Failed to save QR customization:", err);
    res.status(500).json({ error: "Failed to save qr-menu-customization" });
  }
});

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

  // 🔹 Merge defaults for notifications (keeps all expected fields)
  if (section === "notifications") {
    const defaults = {
      enabled: true,
      defaultSound: "ding.mp3",
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

    res.json({ success: true, [section]: newData });
  } catch (err) {
    console.error(`❌ Failed to save ${section} settings:`, err);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

module.exports = router;
