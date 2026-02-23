const authMiddleware = require("./authMiddleware");
const { pool } = require("../db");

const MODULES_CACHE_TTL_MS = 60 * 1000;
const modulesCache = new Map();

function normalizeModules(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    return raw.map((m) => String(m).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed)
        ? parsed.map((m) => String(m).trim()).filter(Boolean)
        : [];
    } catch {
      return trimmed
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
    }
  }
  return [];
}

async function fetchAllowedModules(restaurantId) {
  if (!restaurantId) return null;
  const now = Date.now();
  const cached = modulesCache.get(restaurantId);
  if (cached && cached.expiresAt > now) {
    return cached.allowed;
  }

  const { rows } = await pool.query(
    "SELECT allowed_modules, plan FROM restaurants WHERE id = $1 LIMIT 1",
    [restaurantId]
  );
  if (!rows.length) return null;
  const allowed = normalizeModules(rows[0].allowed_modules);
  if (Array.isArray(allowed) && allowed.length) {
    modulesCache.set(restaurantId, {
      allowed,
      expiresAt: now + MODULES_CACHE_TTL_MS,
      staleAt: now,
    });
    return allowed;
  }
  const plan = String(rows[0].plan || "").trim().toLowerCase();
  if (plan === "qr_kitchen") {
    const fallback = ["qr_kitchen"];
    modulesCache.set(restaurantId, {
      allowed: fallback,
      expiresAt: now + MODULES_CACHE_TTL_MS,
      staleAt: now,
    });
    return fallback;
  }
  if (plan === "staff") {
    const fallback = ["staff"];
    modulesCache.set(restaurantId, {
      allowed: fallback,
      expiresAt: now + MODULES_CACHE_TTL_MS,
      staleAt: now,
    });
    return fallback;
  }
  modulesCache.set(restaurantId, {
    allowed,
    expiresAt: now + MODULES_CACHE_TTL_MS,
    staleAt: now,
  });
  return allowed;
}

async function attachAllowedModules(req) {
  if (!req?.user?.restaurant_id) return null;
  if (Array.isArray(req.user.allowed_modules)) {
    return req.user.allowed_modules;
  }
  try {
    const allowed = await fetchAllowedModules(req.user.restaurant_id);
    if (Array.isArray(allowed)) {
      req.user.allowed_modules = allowed;
      req.allowed_modules = allowed;
    }
    if (!Array.isArray(allowed) || allowed.length === 0) {
      const { rows } = await pool.query(
        "SELECT subscription_plan FROM users WHERE id = $1 LIMIT 1",
        [req.user.id]
      );
      const plan = String(rows[0]?.subscription_plan || "").trim().toLowerCase();
      if (plan === "qr_kitchen") {
        req.user.allowed_modules = ["qr_kitchen"];
        req.allowed_modules = ["qr_kitchen"];
        return req.allowed_modules;
      }
    }
    return allowed;
  } catch (err) {
    const cached = modulesCache.get(req.user.restaurant_id);
    if (cached && Array.isArray(cached.allowed)) {
      req.user.allowed_modules = cached.allowed;
      req.allowed_modules = cached.allowed;
      return cached.allowed;
    }
    console.warn("⚠️ Failed to load allowed_modules:", err?.message || err);
    return null;
  }
}

function requireModule(moduleKey) {
  return async (req, res, next) => {
    return authMiddleware(req, res, async () => {
      let allowed = await attachAllowedModules(req);

      // Fallback: standalone namespace should never leak POS access, so if the
      // request is under /api/standalone/* and we have an authenticated user
      // with a restaurant, allow the required module by default.
      if (
        (!Array.isArray(allowed) || !allowed.length) &&
        typeof req.originalUrl === "string" &&
        req.originalUrl.startsWith("/api/standalone/") &&
        req.user?.restaurant_id
      ) {
        allowed = [moduleKey];
        req.user.allowed_modules = allowed;
        req.allowed_modules = allowed;
      }

      if (Array.isArray(allowed) && allowed.includes(moduleKey)) {
        return next();
      }
      return res.status(403).json({ error: "MODULE_NOT_ALLOWED" });
    });
  };
}

// Allow if user has ANY of the provided modules
function requireAnyModule(moduleKeys = []) {
  const keys = Array.isArray(moduleKeys)
    ? moduleKeys.filter(Boolean).map((k) => String(k).trim())
    : [String(moduleKeys || "").trim()].filter(Boolean);

  const primaryKey = keys[0];

  return async (req, res, next) => {
    return authMiddleware(req, res, async () => {
      let allowed = await attachAllowedModules(req);

      if (
        (!Array.isArray(allowed) || !allowed.length) &&
        typeof req.originalUrl === "string" &&
        req.originalUrl.startsWith("/api/standalone/") &&
        req.user?.restaurant_id &&
        primaryKey
      ) {
        allowed = [primaryKey];
        req.user.allowed_modules = allowed;
        req.allowed_modules = allowed;
      }

      if (Array.isArray(allowed) && keys.some((k) => allowed.includes(k))) {
        return next();
      }
      return res.status(403).json({ error: "MODULE_NOT_ALLOWED" });
    });
  };
}

function requireNotStandaloneOrHasModule(moduleKey) {
  return async (req, res, next) => {
    return authMiddleware(req, res, async () => {
      const role = String(req.user?.role || "").toLowerCase();
      if (role === "admin") {
        return next();
      }
      // Allow standalone staff app to reach /api/staff even if plan metadata is incomplete
      if (
        moduleKey === "staff" &&
        typeof req.originalUrl === "string" &&
        req.originalUrl.startsWith("/api/staff") &&
        req.user?.restaurant_id
      ) {
        return next();
      }
      const allowed = await attachAllowedModules(req);
      if (Array.isArray(allowed) && !allowed.includes(moduleKey)) {
        return res.status(403).json({ error: "MODULE_NOT_ALLOWED" });
      }
      return next();
    });
  };
}

module.exports = {
  normalizeModules,
  fetchAllowedModules,
  attachAllowedModules,
  requireModule,
  requireAnyModule,
  requireNotStandaloneOrHasModule,
};
