const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { internalDevLogin, requireInternalDevJwt } = require("../middleware/internalDevAuth");

// Public: dev login (issues INTERNAL dev JWT)
router.post("/auth/login", internalDevLogin);

// Everything else under /api/internal/* requires dev JWT
router.use(requireInternalDevJwt);

// Applications review (drivers/restaurants)
router.use("/applications", require("./internalApplications"));

let internalSettingsReady = null;
async function ensureInternalSettingsTable() {
  if (!internalSettingsReady) {
    internalSettingsReady = (async () => {
      await pool.query(
        `
        CREATE TABLE IF NOT EXISTS internal_settings (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        `
      );
      await pool.query(
        `
        CREATE INDEX IF NOT EXISTS internal_settings_updated_at_idx
          ON internal_settings (updated_at DESC)
        `
      );
    })().catch((err) => {
      internalSettingsReady = null;
      throw err;
    });
  }
  return internalSettingsReady;
}

router.get("/restaurants", async (req, res) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const params = [];

    let where = "";
    if (search) {
      params.push(`%${search}%`);
      where = `WHERE r.name ILIKE $1 OR r.slug ILIKE $1 OR r.id::text ILIKE $1`;
    }

    const { rows } = await pool.query(
      `
      SELECT
        r.id,
        r.name,
        r.slug,
        r.plan,
        r.billing_cycle,
        u.email AS owner_email
      FROM restaurants r
      LEFT JOIN users u ON u.id = r.owner_id
      ${where}
      ORDER BY r.updated_at DESC NULLS LAST, r.created_at DESC NULLS LAST
      LIMIT 200
      `,
      params
    );

    return res.json(Array.isArray(rows) ? rows : []);
  } catch (err) {
    console.error("❌ GET /api/internal/restaurants failed:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

router.get("/restaurants/:restaurantId", async (req, res) => {
  try {
    const restaurantId = String(req.params.restaurantId || "").trim();
    if (!restaurantId) {
      return res.status(400).json({ status: "error", message: "restaurantId is required" });
    }

    const { rows } = await pool.query(
      `
      SELECT
        r.id,
        r.name,
        r.slug,
        r.plan,
        r.billing_cycle,
        u.id AS owner_id,
        u.email AS owner_email,
        u.trial_expires_at
      FROM restaurants r
      LEFT JOIN users u ON u.id = r.owner_id
      WHERE r.id::text = $1 OR r.slug = $1
      LIMIT 1
      `,
      [restaurantId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ status: "error", message: "Restaurant not found" });
    }

    const row = rows[0];
    return res.json({
      id: row.id,
      name: row.name ?? null,
      slug: row.slug ?? null,
      plan: row.plan ?? null,
      billing_cycle: row.billing_cycle ?? null,
      owner_email: row.owner_email ?? null,
      owner: row.owner_id
        ? {
            id: row.owner_id,
            email: row.owner_email ?? null,
            trial_expires_at: row.trial_expires_at ?? null
          }
        : null
    });
  } catch (err) {
    console.error("❌ GET /api/internal/restaurants/:restaurantId failed:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

let userColumnsCache = null;
async function getUserColumns() {
  if (userColumnsCache) return userColumnsCache;
  const { rows } = await pool.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
    `
  );
  userColumnsCache = new Set((rows || []).map((r) => String(r.column_name)));
  return userColumnsCache;
}

function hasCol(cols, name) {
  return cols && cols.has(name);
}

async function listAdmins(req, res) {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const cols = await getUserColumns();

    const selectBase = [
      "u.id",
      hasCol(cols, "full_name") ? "u.full_name" : "NULL::text AS full_name",
      "u.email",
      hasCol(cols, "role") ? "u.role" : "NULL::text AS role",
      hasCol(cols, "restaurant_id") ? "u.restaurant_id" : "NULL::int AS restaurant_id",
      "r.name AS restaurant_name",
      "r.slug AS restaurant_slug",
      "r.plan AS restaurant_plan",
      hasCol(cols, "trial_expires_at") ? "u.trial_expires_at" : "NULL::timestamptz AS trial_expires_at",
      hasCol(cols, "created_at") ? "u.created_at" : "NULL::timestamptz AS created_at",
      hasCol(cols, "status") ? "u.status" : "NULL::text AS status"
    ];

    const params = [];
    let where = "";
    if (search) {
      params.push(`%${search}%`);
      where = `
        WHERE (u.email ILIKE $1)
           OR (${hasCol(cols, "full_name") ? "u.full_name ILIKE $1" : "FALSE"})
           OR (r.name ILIKE $1)
           OR (r.slug ILIKE $1)
           OR (${hasCol(cols, "restaurant_id") ? "u.restaurant_id::text ILIKE $1" : "FALSE"})
      `;
    }

    const queryWithSubscriptions = `
      SELECT ${[...selectBase, "COALESCE(s.billing_cycle, r.billing_cycle, 'monthly') AS restaurant_billing_cycle"].join(", ")}
      FROM users u
      LEFT JOIN restaurants r ON r.id = u.restaurant_id
      LEFT JOIN subscriptions s ON s.restaurant_id = r.id
      ${where}
      ORDER BY u.id DESC
      LIMIT 300
    `;

    const queryWithoutSubscriptions = `
      SELECT ${[...selectBase, "COALESCE(r.billing_cycle, 'monthly') AS restaurant_billing_cycle"].join(", ")}
      FROM users u
      LEFT JOIN restaurants r ON r.id = u.restaurant_id
      ${where}
      ORDER BY u.id DESC
      LIMIT 300
    `;

    let rows;
    try {
      ({ rows } = await pool.query(queryWithSubscriptions, params));
    } catch (err) {
      if (err && err.code === "42P01") {
        ({ rows } = await pool.query(queryWithoutSubscriptions, params));
      } else {
        throw err;
      }
    }

    return res.json(Array.isArray(rows) ? rows : []);
  } catch (err) {
    console.error("❌ GET /api/internal/admins failed:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
}

router.get("/admins", listAdmins);

router.get("/users", async (req, res) => {
  // Alias to keep frontend service flexible
  return listAdmins(req, res);
});

function normalizePlan(plan) {
  const p = String(plan || "").trim().toLowerCase();
  return p === "basic" || p === "pro" || p === "enterprise" ? p : null;
}

function isValidModuleKey(key) {
  // dot notation: page.settings.users, snake_case segments allowed
  return typeof key === "string" && /^[a-z0-9]+(?:[._][a-z0-9_]+)*$/.test(key);
}

function sanitizeEnabledKeys(input, allowedKeys) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const k of input) {
    const key = typeof k === "string" ? k.trim() : "";
    if (!key) continue;
    if (key.length > 80) continue;
    if (!isValidModuleKey(key)) continue;
    if (allowedKeys && !allowedKeys.has(key)) continue;
    out.push(key);
  }
  return Array.from(new Set(out));
}

async function getInternalSetting(key) {
  await ensureInternalSettingsTable();
  const { rows } = await pool.query(
    "SELECT value FROM internal_settings WHERE key = $1 LIMIT 1",
    [key]
  );
  return rows && rows[0] ? rows[0].value : null;
}

async function upsertInternalSetting(key, value) {
  await ensureInternalSettingsTable();
  await pool.query(
    `
    INSERT INTO internal_settings (key, value, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [key, JSON.stringify(value)]
  );
}

const DEFAULT_MODULE_CATALOG = {
  modules: [
    { key: "page.login", label: "Login", group: "system", routes: ["/login"] },
    {
      key: "page.qr_menu_public",
      label: "QR Menu (Public)",
      group: "public",
      routes: ["/qr-menu/:slug/:id", "/qr", "/menu"]
    },
    { key: "page.dashboard", label: "Dashboard", group: "core", routes: ["/dashboard"] },
    { key: "page.tables", label: "Tables", group: "pos", routes: ["/tables", "/tableoverview?tab=tables"] },
    { key: "page.packet_orders", label: "Packet Orders", group: "pos", routes: ["/tableoverview?tab=packet"] },
    { key: "page.phone_orders", label: "Phone Orders", group: "pos", routes: ["/tableoverview?tab=phone"] },
    { key: "page.history", label: "History", group: "pos", routes: ["/tableoverview?tab=history"] },
    { key: "page.register", label: "Register", group: "pos", routes: ["/tableoverview?tab=register"] },
    { key: "page.orders", label: "Orders", group: "pos", routes: ["/orders"] },
    {
      key: "page.payments",
      label: "Payments / Transactions",
      group: "pos",
      routes: ["/payments", "/transaction/:tableId", "/transaction/phone/:orderId"]
    },
    { key: "page.kitchen", label: "Kitchen", group: "pos", routes: ["/kitchen", "/tableoverview?tab=kitchen"] },
    { key: "page.takeaway_overview", label: "Takeaway", group: "pos", routes: ["/takeaway", "/tableoverview?tab=takeaway"] },
    { key: "page.products", label: "Products", group: "catalog", routes: ["/products"] },
    { key: "page.suppliers", label: "Suppliers", group: "inventory", routes: ["/suppliers"] },
    { key: "page.stock", label: "Stock", group: "inventory", routes: ["/stock"] },
    { key: "page.production", label: "Production", group: "operations", routes: ["/production"] },
    { key: "page.task", label: "Task", group: "operations", routes: ["/task"] },
    { key: "page.staff", label: "Staff", group: "staff", routes: ["/staff", "/staff?tab=payroll"] },
    { key: "page.reports", label: "Reports", group: "reports", routes: ["/reports"] },
    { key: "page.expenses", label: "Expenses", group: "finance", routes: ["/expenses"] },
    { key: "page.ingredient_prices", label: "Ingredient Prices", group: "inventory", routes: ["/ingredient-prices"] },
    {
      key: "page.cash_register_history",
      label: "Cash Register History",
      group: "finance",
      routes: ["/cash-register-history", "/cash-register"]
    },
    { key: "page.delivery", label: "Delivery / Live Route", group: "delivery", routes: ["/live-route"] },
    { key: "page.integrations", label: "Integrations", group: "integrations", routes: ["/integrations"] },
    { key: "page.customer_insights", label: "Customer Insights", group: "marketing", routes: ["/customer-insights"] },
    { key: "page.marketing_campaigns", label: "Marketing Campaigns", group: "marketing", routes: ["/marketing-campaigns"] },
    { key: "page.maintenance", label: "Maintenance", group: "operations", routes: ["/maintenance"] },
    { key: "page.qr_menu_settings", label: "QR Menu Settings", group: "settings", routes: ["/qr-menu-settings"] },
    { key: "page.settings.users", label: "Settings: Users & Roles", group: "settings", routes: ["/settings/users", "/user-management"] },
    { key: "page.settings.printers", label: "Settings: Printers", group: "settings", routes: ["/settings/printers", "/printers"] },
    { key: "page.settings.cameras", label: "Settings: Cameras", group: "settings", routes: ["/settings/cameras", "/cameras"] },
    { key: "page.settings.integrations", label: "Settings: Integrations", group: "settings", routes: ["/settings/integrations"] },
    { key: "page.settings.subscription", label: "Settings: Subscription / Billing", group: "billing", routes: ["/settings/subscription", "/subscription"] },
    {
      key: "page.settings",
      label: "Settings",
      group: "settings",
      routes: [
        "/settings",
        "/settings/notifications",
        "/settings/localization",
        "/settings/shop_hours",
        "/settings/payments",
        "/settings/register",
        "/settings/appearance",
        "/settings/inventory",
        "/settings/tables",
        "/settings/transactions"
      ]
    },
    { key: "page.unauthorized", label: "Unauthorized", group: "system", routes: ["/unauthorized"] }
  ]
};

function normalizeCatalog(value) {
  if (!value || typeof value !== "object") return null;
  const modules = value.modules;
  if (!Array.isArray(modules)) return null;

  const seen = new Set();
  const out = [];

  for (const raw of modules) {
    if (!raw || typeof raw !== "object") continue;
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    const group = typeof raw.group === "string" ? raw.group.trim() : "";
    const routesRaw = Array.isArray(raw.routes) ? raw.routes : [];

    if (!key || !label) continue;
    if (!isValidModuleKey(key)) continue;
    if (key.length > 80 || label.length > 80 || group.length > 40) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    const routes = [];
    for (const r of routesRaw) {
      if (typeof r !== "string") continue;
      const route = r.trim();
      if (!route) continue;
      if (route.length > 160) continue;
      routes.push(route);
    }

    out.push({
      key,
      label,
      group: group || "other",
      routes
    });
  }

  return { modules: out };
}

async function getModuleCatalog() {
  const stored = await getInternalSetting("module_catalog");
  const normalized = normalizeCatalog(stored);
  return normalized || DEFAULT_MODULE_CATALOG;
}

router.get("/plans/catalog", async (req, res) => {
  try {
    const catalog = await getModuleCatalog();
    return res.json(catalog);
  } catch (err) {
    if (err && err.code === "INTERNAL_SETTINGS_MISSING") {
      return res.status(500).json({ status: "error", message: err.message });
    }
    console.error("❌ GET /api/internal/plans/catalog failed:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

router.post("/plans/catalog", async (req, res) => {
  try {
    const incoming = normalizeCatalog({ modules: req.body?.modules });
    if (!incoming || incoming.modules.length === 0) {
      return res.status(400).json({ status: "error", message: "Invalid module catalog" });
    }

    if (incoming.modules.length > 300) {
      return res.status(400).json({ status: "error", message: "Catalog too large" });
    }

    await upsertInternalSetting("module_catalog", incoming);
    return res.json({ status: "ok", count: incoming.modules.length });
  } catch (err) {
    if (err && err.code === "INTERNAL_SETTINGS_MISSING") {
      return res.status(500).json({ status: "error", message: err.message });
    }
    console.error("❌ POST /api/internal/plans/catalog failed:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

router.get("/plans/modules", async (req, res) => {
  try {
    const plan = normalizePlan(req.query.plan);
    if (!plan) {
      return res.status(400).json({ status: "error", message: "Invalid plan" });
    }

    const catalog = await getModuleCatalog();
    const allowedKeys = new Set(catalog.modules.map((m) => m.key));

    const stored = (await getInternalSetting("plan_modules")) || {};
    const enabledKeysRaw = Array.isArray(stored?.[plan]) ? stored[plan] : [];
    const enabledKeys = sanitizeEnabledKeys(enabledKeysRaw, allowedKeys);
    const enabled = new Set(enabledKeys);

    const modules = catalog.modules.map((m) => ({
      key: m.key,
      label: m.label,
      group: m.group,
      routes: m.routes,
      enabled: enabled.has(m.key)
    }));

    return res.json({ plan, enabledKeys, modules });
  } catch (err) {
    if (err && err.code === "INTERNAL_SETTINGS_MISSING") {
      return res.status(500).json({ status: "error", message: err.message });
    }
    console.error("❌ GET /api/internal/plans/modules failed:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

router.post("/plans/modules", async (req, res) => {
  try {
    const plan = normalizePlan(req.query.plan);
    if (!plan) {
      return res.status(400).json({ status: "error", message: "Invalid plan" });
    }

    const catalog = await getModuleCatalog();
    const allowedKeys = new Set(catalog.modules.map((m) => m.key));

    const enabledKeys = sanitizeEnabledKeys(req.body?.enabledKeys, allowedKeys);
    const current = (await getInternalSetting("plan_modules")) || {};
    const next = { ...(current && typeof current === "object" ? current : {}) };
    next[plan] = enabledKeys;

    await upsertInternalSetting("plan_modules", next);

    return res.json({ status: "ok", plan, enabledKeys });
  } catch (err) {
    if (err && err.code === "INTERNAL_SETTINGS_MISSING") {
      return res.status(500).json({ status: "error", message: err.message });
    }
    console.error("❌ POST /api/internal/plans/modules failed:", err);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

module.exports = router;
