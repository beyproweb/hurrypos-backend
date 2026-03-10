// routes/publicQR.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { getIO } = require("../utils/socket");
const { saveNotification } = require("../utils/realtime");

const CALL_WAITER_COOLDOWN_MS = 15000;
const callWaiterRateLimit = new Map();

const QR_BRANDING_DEFAULTS = {
  app_icon: "",
  app_icon_192: "",
  app_icon_512: "",
  apple_touch_icon: "",
  splash_logo: "",
  app_display_name: "",
  pwa_primary_color: "#4F46E5",
  pwa_background_color: "#FFFFFF",
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

function normalizeHexColor(value, fallback = "#4F46E5") {
  const raw = String(value || "").trim();
  const match = raw.match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!match) return fallback;
  if (match[1].length === 6) return `#${match[1].toUpperCase()}`;
  const expanded = match[1]
    .split("")
    .map((ch) => `${ch}${ch}`)
    .join("")
    .toUpperCase();
  return `#${expanded}`;
}

function normalizeAssetPath(value, fallback = "") {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return raw;
  return `/${raw.replace(/^\/+/, "")}`;
}

function detectImageMimeType(src) {
  const lower = String(src || "").toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withoutSlash = raw.replace(/\/+$/, "");
  return withoutSlash.replace(/\/api$/i, "");
}

function resolveRequestOrigin(req) {
  const forwardedProto = String(req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const host = String(req.get("host") || "").trim();
  if (!host) return "";
  const isLocalHost =
    host.includes("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
  const protocol = forwardedProto || (isLocalHost ? "http" : "https");
  return `${protocol}://${host}`;
}

function resolvePublicWebBaseUrl(req) {
  const envBase = normalizePublicBaseUrl(
    process.env.PUBLIC_WEB_BASE_URL ||
      process.env.PUBLIC_POS_BASE_URL ||
      process.env.POS_APP_BASE_URL ||
      process.env.WEB_BASE_URL ||
      ""
  );
  if (envBase) return envBase;

  const host = String(req.get("host") || "").trim().toLowerCase();
  if (host.includes("api.beypro.com")) {
    return "https://pos.beypro.com";
  }
  if (host.includes("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]")) {
    return "http://localhost:5173";
  }
  return resolveRequestOrigin(req);
}

function resolvePublicApiBaseUrl(req) {
  const envBase = normalizePublicBaseUrl(
    process.env.PUBLIC_API_BASE_URL ||
      process.env.PUBLIC_API_BASE ||
      process.env.API_BASE_URL ||
      ""
  );
  if (envBase) return envBase;

  const host = String(req.get("host") || "").trim().toLowerCase();
  if (host.includes("pos.beypro.com")) {
    return "https://api.beypro.com";
  }
  return resolveRequestOrigin(req);
}

function toAbsolutePublicAssetUrl(src, req) {
  const value = String(src || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;

  const normalized = normalizeAssetPath(value, "");
  if (!normalized) return "";
  if (normalized.startsWith("/uploads/")) {
    return `${resolvePublicApiBaseUrl(req)}${normalized}`;
  }
  return `${resolvePublicWebBaseUrl(req)}${normalized}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toAbsoluteManifestAssetUrl(src, req) {
  const value = String(src || "").trim();
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) return value;
  // Keep non-upload app-root assets (e.g. /Beylogo.svg) on current origin.
  if (!value.startsWith("/uploads/")) return value;

  const publicBase = normalizePublicBaseUrl(
    process.env.PUBLIC_UPLOADS_BASE_URL ||
      process.env.PUBLIC_API_BASE_URL ||
      process.env.PUBLIC_API_BASE ||
      process.env.API_BASE_URL ||
      ""
  );
  if (publicBase) return `${publicBase}${value}`;

  const forwardedProto = String(req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const host = String(req.get("host") || "").trim();
  const isLocalHost =
    host.includes("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
  const protocol = forwardedProto || (isLocalHost ? "http" : "https");
  const origin = `${protocol}://${host}`;
  return `${origin}${value}`;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function resolveIdentifierFromReferer(refererValue) {
  const raw = String(refererValue || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const query = url.searchParams;
    const fromQuery =
      query.get("identifier") ||
      query.get("tenant_id") ||
      query.get("tenant") ||
      query.get("restaurant_id") ||
      query.get("restaurant") ||
      query.get("slug") ||
      query.get("id") ||
      "";
    if (String(fromQuery || "").trim()) {
      return safeDecodeURIComponent(String(fromQuery).trim());
    }

    const segments = String(url.pathname || "/")
      .split("/")
      .filter(Boolean);
    if (!segments.length) return "";

    const reservedRootRoutes = new Set([
      "login",
      "staff-login",
      "dashboard",
      "orders",
      "products",
      "kitchen",
      "suppliers",
      "stock",
      "production",
      "tables",
      "tableoverview",
      "reports",
      "staff",
      "task",
      "live-route",
      "takeaway-overview",
      "settings",
      "subscription",
      "expenses",
      "ingredient-prices",
      "cash-register-history",
      "integrations",
      "standalone",
      "standalone-register",
      "qr-menu-settings",
      "register",
      "qr",
      "menu",
      "api",
      "socket.io",
    ]);

    if (segments[0] === "qr-menu" && segments[1]) {
      return safeDecodeURIComponent(segments[1]);
    }
    if (segments.length === 1 && !reservedRootRoutes.has(segments[0])) {
      return safeDecodeURIComponent(segments[0]);
    }
    return "";
  } catch {
    return "";
  }
}

async function resolveRestaurantForPublic(identifier) {
  const key = String(identifier || "").trim();
  if (!key) return null;
  const { rows } = await pool.query(
    `
      SELECT id, name, slug, qr_code_id
      FROM restaurants
      WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1
      LIMIT 1
    `,
    [key]
  );
  return rows[0] || null;
}

async function readQrMenuCustomization(restaurantId) {
  const result = await pool.query(
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

router.get("/qr-resolve/:code", async (req, res) => {
  try {
    const { code } = req.params;
    const { rows } = await pool.query(
      "SELECT id, slug, qr_token FROM restaurants WHERE qr_code_id = $1 OR slug = $1 OR id::text = $1 LIMIT 1",
      [code]
    );
    if (!rows.length) return res.status(404).json({ error: "Invalid QR code" });
    res.json(rows[0]); // send { id, slug, qr_token }
  } catch (err) {
    console.error("❌ QR resolve failed:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Public Call Waiter endpoint (used by QR Menu)
router.post("/call-waiter/:identifier", async (req, res) => {
  try {
    const identifier = String(req.params.identifier || "").trim();
    const tableNumber = Number(req.body?.table_number ?? req.body?.tableNumber);
    const note = String(req.body?.note || "").trim();
    const requestedSource = String(req.body?.source || "").trim().toLowerCase();

    if (!identifier) {
      return res.status(400).json({ error: "Missing identifier" });
    }
    if (!Number.isFinite(tableNumber) || tableNumber <= 0) {
      return res.status(400).json({ error: "Missing or invalid table_number" });
    }

    const { rows: restaurantRows } = await pool.query(
      `
      SELECT id
      FROM restaurants
      WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1
      LIMIT 1
      `,
      [identifier]
    );
    if (!restaurantRows.length) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const restaurantId = Number(restaurantRows[0].id);
    const { rows: tableRows } = await pool.query(
      `
      SELECT number, label
      FROM tables
      WHERE restaurant_id = $1
        AND number = $2
      LIMIT 1
      `,
      [restaurantId, tableNumber]
    );
    if (!tableRows.length) {
      return res.status(404).json({ error: "Table not found" });
    }

    const rateKey = `${restaurantId}:${tableNumber}`;
    const now = Date.now();
    const lastHit = Number(callWaiterRateLimit.get(rateKey) || 0);
    if (now - lastHit < CALL_WAITER_COOLDOWN_MS) {
      const retryAfterMs = CALL_WAITER_COOLDOWN_MS - (now - lastHit);
      return res.status(429).json({
        error: "Too many call waiter requests",
        retry_after_ms: retryAfterMs,
      });
    }
    callWaiterRateLimit.set(rateKey, now);

    const payload = {
      event: "customer_call_requested",
      request_id: `cw_${restaurantId}_${tableNumber}_${now}`,
      restaurant_id: restaurantId,
      table_number: tableNumber,
      table_label: tableRows[0]?.label || null,
      note: note || null,
      requested_at: new Date(now).toISOString(),
      source: requestedSource === "qr_menu_order_status" ? "qr_menu_order_status" : "qr_menu",
    };

    try {
      const io = getIO();
      io.to(`restaurant_${restaurantId}`).emit("customer_call", payload);
    } catch (socketErr) {
      console.warn("⚠️ customer_call socket emit skipped:", socketErr?.message || socketErr);
    }

    await saveNotification({
      restaurantId,
      message: `Customer called waiter on Table ${tableNumber}`,
      type: "customer_call",
      stockId: null,
      extra: payload,
    });

    res.json({ success: true, payload });
  } catch (err) {
    console.error("❌ Public call waiter failed:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ New: GET /api/public/products/:slugOrCode
router.get("/products/:identifier", async (req, res) => {
  try {
    const identifier = (req.params.identifier || "").trim();
    if (!identifier) {
      return res.status(400).json({ error: "Missing identifier" });
    }

    // identifier may be slug, qr_code_id, or numeric id
    const { rows } = await pool.query(
      `
      SELECT id
      FROM restaurants
      WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1
      LIMIT 1
      `,
      [identifier]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Invalid restaurant" });
    }
    const restaurantId = rows[0].id;

    const { rows: products } = await pool.query(
      `
      SELECT
        id,
        name,
        price,
        category,
        description,
        image,
        ingredients,
        extras,
        selected_extras_group,
        COALESCE(visible, true) AS visible,
        COALESCE(show_add_to_cart_modal, true) AS show_add_to_cart_modal
      FROM products
      WHERE restaurant_id = $1
        AND COALESCE(visible, true) = true
      ORDER BY category, name, id
      `,
      [restaurantId]
    );

    res.json(products);
  } catch (err) {
    console.error("❌ Public products fetch failed:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ New: GET /api/public/restaurant-info?identifier=slugOrId
router.get("/restaurant-info", async (req, res) => {
  try {
    const { identifier } = req.query;
    if (!identifier) {
      return res.status(400).json({ error: "Missing identifier" });
    }

    const { rows } = await pool.query(
      `
      SELECT id, name, slug, description, banner_url, logo_url, tagline
      FROM restaurants
      WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1
      LIMIT 1
      `,
      [identifier]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("❌ Public restaurant-info failed:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Public shop-hours for QR menu (slug | qr_code_id | numeric id)
router.get("/shop-hours/:identifier", async (req, res) => {
  try {
    const identifier = String(req.params.identifier || "").trim();
    if (!identifier) {
      return res.status(400).json({ error: "Missing identifier" });
    }

    const { rows } = await pool.query(
      `
      SELECT id
      FROM restaurants
      WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1
      LIMIT 1
      `,
      [identifier]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Restaurant not found" });
    }
    const restaurantId = rows[0].id;

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");

    const { rows: hours } = await pool.query(
      `
      SELECT day, open_time, close_time
      FROM shop_hours
      WHERE restaurant_id = $1
      ORDER BY id
      `,
      [restaurantId]
    );

    res.json(hours);
  } catch (err) {
    console.error("❌ Public shop-hours failed:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Public QR link endpoint (no auth required)
router.get("/qr-link/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const { rows } = await pool.query(
      "SELECT slug, qr_code_id FROM restaurants WHERE slug = $1 LIMIT 1",
      [slug]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const { slug: s } = rows[0];
    const link = `https://pos.beypro.com/${s}`;

    res.json({ success: true, link });
  } catch (err) {
    console.error("❌ Public qr-link error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/share/:identifier", async (req, res) => {
  try {
    const identifier = String(req.params.identifier || "").trim();
    const webBase = resolvePublicWebBaseUrl(req);
    const fallbackMenuUrl = `${webBase}/`;

    if (!identifier) {
      return res.redirect(302, fallbackMenuUrl);
    }

    const restaurant = await resolveRestaurantForPublic(identifier);
    if (!restaurant) {
      return res.redirect(302, fallbackMenuUrl);
    }

    const customizationRaw = await readQrMenuCustomization(restaurant.id);
    const customization = {
      ...QR_BRANDING_DEFAULTS,
      ...customizationRaw,
    };

    const appName =
      String(
        customization.app_display_name ||
          customization.main_title ||
          customization.title ||
          restaurant.name ||
          "Restaurant"
      ).trim() || "Restaurant";

    const description =
      String(
        customization.subtitle ||
          customization.tagline ||
          customization.story_text ||
          `Explore ${appName} on Beypro QR Menu.`
      ).trim() || `Explore ${appName} on Beypro QR Menu.`;

    const imageCandidate =
      customization.app_icon_512 ||
      customization.app_icon_192 ||
      customization.splash_logo ||
      customization.app_icon ||
      "/Beylogo.svg";
    const imageUrl =
      toAbsolutePublicAssetUrl(imageCandidate, req) ||
      `${resolvePublicWebBaseUrl(req)}/Beylogo.svg`;

    const menuPath = restaurant.slug
      ? `/${encodeURIComponent(restaurant.slug)}`
      : `/restaurant/${encodeURIComponent(String(restaurant.id))}`;
    const menuUrl = `${webBase}${menuPath}`;
    const landingUrl = `${menuUrl}${menuUrl.includes("?") ? "&" : "?"}from_share=1`;

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(appName)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${escapeHtml(appName)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:image" content="${escapeHtml(imageUrl)}" />
    <meta property="og:url" content="${escapeHtml(menuUrl)}" />
    <meta property="og:site_name" content="${escapeHtml(appName)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(appName)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
    <meta http-equiv="refresh" content="0; url=${escapeHtml(landingUrl)}" />
    <link rel="canonical" href="${escapeHtml(menuUrl)}" />
  </head>
  <body>
    <p>Redirecting to ${escapeHtml(appName)}...</p>
    <script>
      window.location.replace(${JSON.stringify(landingUrl)});
    </script>
  </body>
</html>`;

    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    return res.status(200).send(html);
  } catch (err) {
    console.error("❌ Public share page generation failed:", err);
    return res.status(500).send("Server error");
  }
});

router.get("/manifest.json", async (req, res) => {
  try {
    const fallbackManifest = {
      id: "/beypro",
      name: "Beypro QR Menu",
      short_name: "Beypro Menu",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#FFFFFF",
      theme_color: "#4F46E5",
      icons: [
        {
          src: "/Beylogo.svg",
          sizes: "192x192",
          type: "image/svg+xml",
        },
        {
          src: "/Beylogo.svg",
          sizes: "512x512",
          type: "image/svg+xml",
          purpose: "any maskable",
        },
      ],
    };

    let identifier = String(req.query?.identifier || "").trim();
    if (!identifier) {
      identifier = resolveIdentifierFromReferer(req.get("referer"));
    }

    const restaurant = identifier ? await resolveRestaurantForPublic(identifier) : null;
    if (!restaurant) {
      res.set("Content-Type", "application/manifest+json");
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");
      return res.status(200).json(fallbackManifest);
    }

    const customizationRaw = await readQrMenuCustomization(restaurant.id);
    const customization = {
      ...QR_BRANDING_DEFAULTS,
      ...customizationRaw,
    };

    const appName = String(
      customization.app_display_name ||
        customization.main_title ||
        customization.title ||
        restaurant.name ||
        "Restaurant"
    ).trim() || "Restaurant";
    const shortName = appName.length > 18 ? `${appName.slice(0, 18).trim()}` : appName;
    const themeColor = normalizeHexColor(
      customization.pwa_primary_color || customization.primary_color,
      "#4F46E5"
    );
    const backgroundColor = normalizeHexColor(customization.pwa_background_color, "#FFFFFF");
    const fallbackIcon = "/Beylogo.svg";
    const icon192 = normalizeAssetPath(
      customization.app_icon_192 || customization.app_icon,
      fallbackIcon
    );
    const icon512 = normalizeAssetPath(
      customization.app_icon_512 || customization.app_icon,
      fallbackIcon
    );
    const manifestIcon192 = toAbsoluteManifestAssetUrl(icon192, req);
    const manifestIcon512 = toAbsoluteManifestAssetUrl(icon512, req);
    const basePath = restaurant.slug
      ? `/${encodeURIComponent(restaurant.slug)}`
      : `/qr-menu/${encodeURIComponent(String(restaurant.id))}/${encodeURIComponent(
          String(restaurant.qr_code_id || "scan")
        )}`;
    // Keep scope/page aligned even when user opens /slug without trailing slash.
    // This preserves per-restaurant install identity while keeping installability stable.
    const startUrl = `${basePath}?source=pwa`;
    const appScope = basePath;

    const manifest = {
      id: `/restaurant/${restaurant.id}`,
      name: appName,
      short_name: shortName || appName,
      start_url: startUrl,
      scope: appScope,
      display: "standalone",
      background_color: backgroundColor,
      theme_color: themeColor,
      icons: [
        {
          src: manifestIcon192,
          sizes: "192x192",
          type: detectImageMimeType(manifestIcon192),
        },
        {
          src: manifestIcon512,
          sizes: "512x512",
          type: detectImageMimeType(manifestIcon512),
          purpose: "any maskable",
        },
      ],
    };

    res.set("Content-Type", "application/manifest+json");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    return res.status(200).json(manifest);
  } catch (err) {
    console.error("❌ Public manifest generation failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
});


// 🔹 NEW: Public tables for QR menu
router.get("/tables/:identifier", async (req, res) => {
  try {
    const identifier = (req.params.identifier || "").trim();
    if (!identifier) return res.json([]);

    const { rows } = await pool.query(
      `
      SELECT id
      FROM restaurants
      WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1
      LIMIT 1
      `,
      [identifier]
    );

    if (!rows.length) return res.json([]);
    const restaurantId = rows[0].id;

    const { rows: tables } = await pool.query(
      `
      SELECT number,
             color,
             label,
             seats,
             area,
             COALESCE(active, TRUE) AS active
      FROM tables
      WHERE restaurant_id = $1
      ORDER BY number ASC
      `,
      [restaurantId]
    );

    res.json(tables);
  } catch (err) {
    console.error("❌ Public tables failed:", err);
    res.json([]);
  }
});

// 🔹 Public unavailable table numbers (occupied or reserved)
router.get("/unavailable-tables/:identifier", async (req, res) => {
  try {
    const identifier = (req.params.identifier || "").trim();
    if (!identifier) return res.json({ table_numbers: [], reserved_table_numbers: [] });

    const { rows } = await pool.query(
      `
      SELECT id
      FROM restaurants
      WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1
      LIMIT 1
      `,
      [identifier]
    );

    if (!rows.length) return res.json({ table_numbers: [], reserved_table_numbers: [] });
    const restaurantId = rows[0].id;

    const { rows: busyRows } = await pool.query(
      `
      SELECT DISTINCT
             table_number,
             status,
             order_type,
             reservation_date,
             reservation_time
      FROM orders
      WHERE restaurant_id = $1
        AND table_number IS NOT NULL
        AND LOWER(COALESCE(status, '')) NOT IN ('closed', 'completed', 'cancelled', 'canceled')
      ORDER BY table_number ASC
      `,
      [restaurantId]
    );

    const isReservationLikeRow = (row) => {
      const status = String(row?.status || "").toLowerCase();
      const orderType = String(row?.order_type || "").toLowerCase();
      return (
        status === "reserved" ||
        orderType === "reservation" ||
        row?.reservation_date != null ||
        row?.reservation_time != null
      );
    };

    const parseReservationMs = (dateValue, timeValue) => {
      if (!dateValue) return NaN;
      const dateRaw = String(dateValue).trim();
      if (!dateRaw) return NaN;
      const timeRaw = timeValue ? String(timeValue).trim() : "00:00:00";
      const parsed = new Date(`${dateRaw}T${timeRaw || "00:00:00"}`).getTime();
      return Number.isFinite(parsed) ? parsed : NaN;
    };

    const isReservationDueNow = (row) => {
      if (!isReservationLikeRow(row)) return false;
      if (!row?.reservation_date) return true;
      const scheduledMs = parseReservationMs(row.reservation_date, row.reservation_time);
      if (!Number.isFinite(scheduledMs)) return true;
      return Date.now() >= scheduledMs;
    };

    const unavailableSet = new Set();
    const reservedSet = new Set();

    busyRows.forEach((row) => {
      const tableNumber = Number(row?.table_number);
      if (!Number.isFinite(tableNumber) || tableNumber <= 0) return;
      const status = String(row?.status || "").toLowerCase();

      if (!isReservationLikeRow(row)) {
        unavailableSet.add(tableNumber);
        return;
      }

      if (!isReservationDueNow(row)) return;

      unavailableSet.add(tableNumber);
      if (status !== "checked_in") {
        reservedSet.add(tableNumber);
      }
    });

    const tableNumbers = Array.from(unavailableSet);
    const reservedTableNumbers = Array.from(reservedSet);

    return res.json({
      table_numbers: tableNumbers,
      reserved_table_numbers: reservedTableNumbers,
    });
  } catch (err) {
    console.error("❌ Public unavailable tables failed:", err);
    return res.json({ table_numbers: [], reserved_table_numbers: [] });
  }
});


// 🔹 NEW: Public extras-groups for QR menu
router.get("/extras-groups/:identifier", async (req, res) => {
  try {
    const identifier = (req.params.identifier || "").trim();
    if (!identifier) return res.json([]);

    const { rows } = await pool.query(
      `
      SELECT id
      FROM restaurants
      WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1
      LIMIT 1
      `,
      [identifier]
    );

    if (!rows.length) return res.json([]);
    const restaurantId = rows[0].id;

    const { rows: groups } = await pool.query(
      `
      SELECT id,
             group_name,
             items
      FROM extras_groups
      WHERE restaurant_id = $1
      ORDER BY id ASC
      `,
      [restaurantId]
    );

    res.json(groups);
  } catch (err) {
    console.error("❌ Public extras-groups failed:", err);
    res.json([]);
  }
});


// 🔹 NEW: Public category-images for QR menu
router.get("/category-images/:identifier", async (req, res) => {
  try {
    const identifier = (req.params.identifier || "").trim();
    if (!identifier) return res.json([]);

    const { rows } = await pool.query(
      `
      SELECT id
      FROM restaurants
      WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1
      LIMIT 1
      `,
      [identifier]
    );

    if (!rows.length) return res.json([]);
    const restaurantId = rows[0].id;

    const { rows: imgs } = await pool.query(
      `
      SELECT category,
             image
      FROM category_images
      WHERE restaurant_id = $1
      ORDER BY category
      `,
      [restaurantId]
    );

    res.json(imgs);
  } catch (err) {
    console.error("❌ Public category-images failed:", err);
    res.json([]);
  }
});

router.get("/qr-menu-customization/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const restaurant = await resolveRestaurantForPublic(slug);
    if (!restaurant) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const data = await readQrMenuCustomization(restaurant.id);

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
      enable_popular: true,
      qr_theme: "auto",
      loyalty_enabled: false,
      loyalty_goal: 10,
      loyalty_reward_text: "Free Menu Item",
      loyalty_color: "#F59E0B",
      delivery_enabled: true,
      table_geo_enabled: false,
      table_geo_radius_meters: 150,
      ...QR_BRANDING_DEFAULTS,
      app_display_name: restaurant.name || "Restaurant",
    };

    res.json({
      success: true,
      customization: {
        ...defaults,
        ...data,
      },
    });

  } catch (err) {
    console.error("❌ Public QR Menu Customization failed:", err);
    res.status(500).json({ error: "Public QR customization error" });
  }
});





// =========================
// Popular This Week
// =========================
router.get("/popular/:identifier", async (req, res) => {
  try {
    const identifier = (req.params.identifier || "").trim();
    if (!identifier) return res.status(400).json({ error: "Missing identifier" });

    // Resolve restaurant id (slug, qr_code_id, or id)
    const r = await pool.query(
      `SELECT id FROM restaurants WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1 LIMIT 1`,
      [identifier]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Restaurant not found" });
    const restaurantId = r.rows[0].id;

    const { rows } = await pool.query(
      `
      SELECT oi.product_id::int AS product_id, SUM(oi.quantity) AS cnt
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.restaurant_id = $1
        AND o.created_at >= NOW() - INTERVAL '7 days'
        AND COALESCE(o.status,'') <> 'cancelled'
      GROUP BY oi.product_id
      ORDER BY cnt DESC
      LIMIT 6
      `,
      [restaurantId]
    );

    return res.json({ product_ids: rows.map(r => r.product_id), items: rows });
  } catch (err) {
    console.error("❌ Public popular failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
});


// =========================
// QR Loyalty Card System
// =========================
async function ensureLoyaltyTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qr_loyalty (
      id SERIAL PRIMARY KEY,
      restaurant_id INT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      points INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (restaurant_id, fingerprint)
    );
  `);
}

async function resolveRestaurantId(identifier) {
  const row = await resolveRestaurantForPublic(identifier);
  return row?.id || null;
}

router.get("/loyalty/:identifier", async (req, res) => {
  try {
    const identifier = (req.params.identifier || "").trim();
    const fingerprint = (req.query.fp || "").trim();
    if (!identifier) return res.status(400).json({ error: "Missing identifier" });
    const restaurantId = await resolveRestaurantId(identifier);
    if (!restaurantId) return res.status(404).json({ error: "Restaurant not found" });

    // Load customization for loyalty config
    const r = await pool.query(
      `SELECT qr_menu_customization FROM settings WHERE restaurant_id = $1 AND key = 'qr-menu-customization' LIMIT 1`,
      [restaurantId]
    );
    const c = r.rows[0]?.qr_menu_customization || {};

    const enabled = !!c.loyalty_enabled;
    const goal = Number(c.loyalty_goal || 10);
    const reward_text = c.loyalty_reward_text || "Free Menu Item";
    const color = c.loyalty_color || "#F59E0B";

    let points = 0;
    if (fingerprint) {
      await ensureLoyaltyTable();
      const q = await pool.query(
        `SELECT points FROM qr_loyalty WHERE restaurant_id = $1 AND fingerprint = $2 LIMIT 1`,
        [restaurantId, fingerprint]
      );
      points = Number(q.rows[0]?.points || 0);
    }

    return res.json({ enabled, points, goal, reward_text, color });
  } catch (err) {
    console.error("❌ Public loyalty GET failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/loyalty/:identifier/add", async (req, res) => {
  try {
    const identifier = (req.params.identifier || "").trim();
    const { fingerprint, points: addPoints } = req.body || {};
    if (!identifier) return res.status(400).json({ error: "Missing identifier" });
    if (!fingerprint) return res.status(400).json({ error: "Missing fingerprint" });
    const delta = Number(addPoints || 1);

    const restaurantId = await resolveRestaurantId(identifier);
    if (!restaurantId) return res.status(404).json({ error: "Restaurant not found" });

    await ensureLoyaltyTable();

    const up = await pool.query(
      `
      INSERT INTO qr_loyalty (restaurant_id, fingerprint, points)
      VALUES ($1, $2, $3)
      ON CONFLICT (restaurant_id, fingerprint)
      DO UPDATE SET points = qr_loyalty.points + EXCLUDED.points, updated_at = NOW()
      RETURNING points
      `,
      [restaurantId, fingerprint, delta]
    );

    return res.json({ success: true, points: Number(up.rows[0]?.points || 0) });
  } catch (err) {
    console.error("❌ Public loyalty ADD failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
});



module.exports = router;
