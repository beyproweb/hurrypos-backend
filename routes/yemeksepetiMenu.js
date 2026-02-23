// routes/yemeksepetiMenu.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const axios = require("axios");
const extApiAuth = require("../middleware/externalApiAuth");
const authMiddleware = require("../middleware/authMiddleware");
const {
  getMiddlewareBearerForCallbackUrl,
  clearMiddlewareBearerForCallbackUrl,
} = require("../utils/dhMiddlewareToken");

const YS_MENU_TRIGGER_RESPONSE_URL = process.env.YS_MENU_TRIGGER_RESPONSE_URL;
const YS_MENU_STATUS_CALLBACK_URL = process.env.YS_MENU_STATUS_CALLBACK_URL;
const YS_PLATFORM = "yemeksepeti";

const resolveMiddlewareBaseUrl = () => {
  const explicit =
    process.env.DH_MW_BASE_URL ||
    process.env.DELIVERYHERO_MW_BASE_URL ||
    process.env.MIDDLEWARE_BASE_URL ||
    "";
  const fromEnv = explicit || YS_MENU_TRIGGER_RESPONSE_URL || YS_MENU_STATUS_CALLBACK_URL || "";
  if (!fromEnv) return null;
  try {
    return new URL(fromEnv).origin;
  } catch {
    return null;
  }
};

const resolveCallbackUrl = (req) => {
  const explicit =
    process.env.PUBLIC_API_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.API_BASE_URL ||
    "";
  let origin = "";
  if (explicit) {
    try {
      origin = new URL(explicit).origin;
    } catch {
      origin = "";
    }
  }

  if (!origin && req) {
    const host = req.get("host");
    if (host) {
      const proto =
        req.get("x-forwarded-proto") || req.protocol || "http";
      origin = `${proto}://${host}`;
    }
  }

  if (!origin) return null;
  return `${origin.replace(/\/+$/, "")}/api/integrations/yemeksepeti/menuimport/callback`;
};

const getYsSettings = async (restaurantId) => {
  const settingsRes = await pool.query(
    "SELECT integrations FROM settings WHERE restaurant_id = $1 AND key = 'global'",
    [restaurantId]
  );
  const integrations = settingsRes.rows?.[0]?.integrations || {};
  const ys = integrations.yemeksepeti || {};
  return typeof ys === "object" && ys ? ys : {};
};

const resolvePosVendorId = (ysSettings) => {
  const remoteId = String(ysSettings.remoteId || "").trim();
  if (remoteId) return remoteId;
  const vendorId = String(ysSettings.vendorId || "").trim();
  return vendorId || "";
};

const summarizeCatalog = (catalog) => ({
  categories: catalog?.categories?.length || 0,
  products: catalog?.products?.length || 0,
  options: catalog?.options?.length || 0,
  modifiers: catalog?.modifiers?.length || 0,
});

async function persistPlatformMappings({ restaurantId, products, extras }) {
  if (!restaurantId) return;

  if (products.length) {
    const values = [];
    const placeholders = products.map((p, idx) => {
      const base = idx * 5;
      values.push(
        restaurantId,
        YS_PLATFORM,
        `PROD_${p.id}`,
        p.id,
        p.remoteCode || null
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, NOW(), NOW())`;
    });

    await pool.query(
      `INSERT INTO platform_product_map (
         restaurant_id,
         platform,
         platform_product_id,
         beypro_product_id,
         remote_code_used,
         created_at,
         updated_at
       ) VALUES ${placeholders.join(", ")}
       ON CONFLICT (restaurant_id, platform, platform_product_id)
       DO UPDATE SET
         beypro_product_id = EXCLUDED.beypro_product_id,
         remote_code_used = EXCLUDED.remote_code_used,
         updated_at = NOW()`,
      values
    );
  }

  if (extras.length) {
    const values = [];
    const placeholders = extras.map((i, idx) => {
      const base = idx * 5;
      values.push(
        restaurantId,
        YS_PLATFORM,
        `MOD_${i.id}`,
        i.id,
        i.remoteCode || null
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, NOW(), NOW())`;
    });

    await pool.query(
      `INSERT INTO platform_extra_map (
         restaurant_id,
         platform,
         platform_extra_id,
         beypro_extra_id,
         remote_code_used,
         created_at,
         updated_at
       ) VALUES ${placeholders.join(", ")}
       ON CONFLICT (restaurant_id, platform, platform_extra_id)
       DO UPDATE SET
         beypro_extra_id = EXCLUDED.beypro_extra_id,
         remote_code_used = EXCLUDED.remote_code_used,
         updated_at = NOW()`,
      values
    );
  }
}


//
// 1️⃣ MENU IMPORT TRIGGER (GET)
//    GET /api/integrations/yemeksepeti/menuimport/:remoteId
//
router.get("/menuimport/:remoteId", extApiAuth, async (req, res) => {
  const remoteId = req.params.remoteId;
  const vendorCode = req.query.vendorCode;
  const menuImportId = req.query.menuImportId;

  // Map remoteId → restaurant_id
  const r = await pool.query(
    "SELECT id FROM restaurants WHERE external_remote_id = $1 LIMIT 1",
    [remoteId]
  );

  if (!r.rows.length) return res.status(404).send();

  const restaurantId = r.rows[0].id;

  // MUST send 202 immediately
  res.status(202).send();

  setTimeout(async () => {
    try {
      const menuPayload = await buildMenu(restaurantId);

      await axios.post(YS_MENU_TRIGGER_RESPONSE_URL, {
        vendorCode,
        menuImportId,
        menu: menuPayload
      });

      await sendCatalogStatus(menuImportId, vendorCode, "done", "Menu imported");

    } catch (err) {
      console.error("❌ Failed menu import:", err);

      await sendCatalogStatus(menuImportId, vendorCode, "failed", err.message);
    }
  }, 50);
});


//
// 1️⃣5️⃣ MENU SYNC (manual push to middleware)
//    POST /api/integrations/yemeksepeti/menu-sync
//
router.post("/menu-sync", authMiddleware, async (req, res) => {
  const restaurantId = req.user?.restaurant_id;
  if (!restaurantId) {
    return res.status(401).json({ error: "Unauthorized: missing restaurant" });
  }

  try {
    const ys = await getYsSettings(restaurantId);
    const chainCode = String(ys.chainCode || "").trim();
    const posVendorId = resolvePosVendorId(ys);
    if (!chainCode || !posVendorId) {
      return res.status(400).json({
        error: "Missing Yemeksepeti chainCode or remoteId/vendorId",
      });
    }

    const catalog = await buildMenu(restaurantId);
    const callbackUrl = resolveCallbackUrl(req);
    const middlewareBaseUrl = resolveMiddlewareBaseUrl();
    if (!middlewareBaseUrl) {
      return res.status(500).json({
        error:
          "Missing middleware base URL. Set DH_MW_BASE_URL or YS_MENU_TRIGGER_RESPONSE_URL.",
      });
    }

    const url = `${middlewareBaseUrl}/v2/chains/${encodeURIComponent(
      chainCode
    )}/catalog`;
    const payload = {
      vendors: [posVendorId],
      catalog,
      ...(callbackUrl ? { callbackUrl } : {}),
    };

    console.log("📦 [menu-sync] Sending catalog import:", {
      restaurantId,
      chainCode,
      posVendorId,
      url,
      callbackUrl: callbackUrl || null,
      summary: summarizeCatalog(catalog),
    });

    let authHeader = await getMiddlewareBearerForCallbackUrl(
      `${middlewareBaseUrl}/v2/login`
    );
    let response;
    try {
      response = await axios.put(url, payload, {
        headers: {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
      });
    } catch (err) {
      if (err?.response?.status === 401 && authHeader) {
        clearMiddlewareBearerForCallbackUrl(`${middlewareBaseUrl}/v2/login`);
        authHeader = await getMiddlewareBearerForCallbackUrl(
          `${middlewareBaseUrl}/v2/login`
        );
        response = await axios.put(url, payload, {
          headers: {
            "Content-Type": "application/json",
            ...(authHeader ? { Authorization: authHeader } : {}),
          },
        });
      } else {
        throw err;
      }
    }

    console.log("📥 [menu-sync] Middleware response:", {
      status: response.status,
      data: response.data,
    });

    return res.json({
      ok: true,
      status: response.status,
      catalogImportId: response.data?.catalogImportId || null,
      response: response.data,
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data || null;
    console.error("❌ [menu-sync] Failed to push menu:", err?.message || err);
    if (data) {
      console.error("❌ [menu-sync] Middleware error:", data);
    }
    return res.status(status).json({
      error: "Failed to sync menu to Yemeksepeti",
      status,
      details: data || err?.message || "Unknown error",
    });
  }
});


//
// 2️⃣ CATALOG IMPORT STATUS RECEIVER
//    POST /api/integrations/yemeksepeti/menuimport/callback
//
router.post("/menuimport/callback", extApiAuth, async (req, res) => {
  console.log("📥 Catalog import callback:", req.body);

  return res.status(200).send();
});

//
// 3️⃣ GET MENU IMPORT LOGS
//    GET /api/integrations/yemeksepeti/menu-sync/logs
//
router.get("/menu-sync/logs", authMiddleware, async (req, res) => {
  const restaurantId = req.user?.restaurant_id;
  if (!restaurantId) {
    return res.status(401).json({ error: "Unauthorized: missing restaurant" });
  }

  try {
    const ys = await getYsSettings(restaurantId);
    const chainCode = String(ys.chainCode || "").trim();
    const posVendorId = resolvePosVendorId(ys);
    if (!chainCode || !posVendorId) {
      return res.status(400).json({
        error: "Missing Yemeksepeti chainCode or remoteId/vendorId",
      });
    }

    const middlewareBaseUrl = resolveMiddlewareBaseUrl();
    if (!middlewareBaseUrl) {
      return res.status(500).json({
        error:
          "Missing middleware base URL. Set DH_MW_BASE_URL or YS_MENU_TRIGGER_RESPONSE_URL.",
      });
    }

    const url = `${middlewareBaseUrl}/v2/chains/${encodeURIComponent(
      chainCode
    )}/vendors/${encodeURIComponent(posVendorId)}/menu-import-logs`;
    const params = {};
    if (req.query.from) params.from = req.query.from;
    if (req.query.to) params.to = req.query.to;
    if (req.query.limit) params.limit = req.query.limit;

    let authHeader = await getMiddlewareBearerForCallbackUrl(
      `${middlewareBaseUrl}/v2/login`
    );
    let response;
    try {
      response = await axios.get(url, {
        headers: {
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        params,
      });
    } catch (err) {
      if (err?.response?.status === 401 && authHeader) {
        clearMiddlewareBearerForCallbackUrl(`${middlewareBaseUrl}/v2/login`);
        authHeader = await getMiddlewareBearerForCallbackUrl(
          `${middlewareBaseUrl}/v2/login`
        );
        response = await axios.get(url, {
          headers: {
            ...(authHeader ? { Authorization: authHeader } : {}),
          },
          params,
        });
      } else {
        throw err;
      }
    }

    console.log("📥 [menu-sync] Menu import logs:", {
      status: response.status,
    });

    return res.json({ ok: true, data: response.data });
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data || null;
    console.error("❌ [menu-sync] Failed to fetch logs:", err?.message || err);
    if (data) {
      console.error("❌ [menu-sync] Logs error:", data);
    }
    return res.status(status).json({
      error: "Failed to fetch menu sync logs",
      status,
      details: data || err?.message || "Unknown error",
    });
  }
});


//
// Menu Builder (tenant-safe)
//
async function buildMenu(restaurantId) {
  const { rows: categories } = await pool.query(
    `SELECT id, name
     FROM categories
     WHERE restaurant_id = $1
     ORDER BY sequence ASC, id ASC`,
    [restaurantId]
  );

  const { rows: products } = await pool.query(
    `SELECT
       id,
       name,
       price,
       category_id,
       COALESCE(NULLIF(sku,''), NULLIF(external_code,''), id::text) AS "remoteCode"
     FROM products
     WHERE restaurant_id = $1
       AND active IS NOT FALSE`,
    [restaurantId]
  );

  const { rows: groups } = await pool.query(
    `SELECT
       id,
       group_name AS name,
       required,
       max_selection
     FROM extras_groups
     WHERE restaurant_id = $1
     ORDER BY group_name ASC, id ASC`,
    [restaurantId]
  );

  const items = [];
  for (const group of groups) {
    const { rows: groupItems } = await pool.query(
      `SELECT
         id,
         group_id,
         ingredient_name AS name,
         price,
         COALESCE(NULLIF(sku,''), id::text) AS "remoteCode"
       FROM extras_group_items
       WHERE restaurant_id = $1 AND group_id = $2
       ORDER BY id ASC`,
      [restaurantId, group.id]
    );
    items.push(...groupItems);
  }

  await persistPlatformMappings({
    restaurantId,
    products,
    extras: items,
  });

  const emptyProductRemote = products.filter(
    (p) => !p.remoteCode || String(p.remoteCode).trim() === ""
  );
  const emptyExtraRemote = items.filter(
    (i) => !i.remoteCode || String(i.remoteCode).trim() === ""
  );

  console.log("📦 [menu-build] counts", {
    restaurantId,
    categories: categories.length,
    products: products.length,
    groups: groups.length,
    items: items.length,
  });
  if (emptyProductRemote.length) {
    console.warn("⚠️ [menu-build] products missing remoteCode:", emptyProductRemote);
  }
  if (emptyExtraRemote.length) {
    console.warn("⚠️ [menu-build] extras missing remoteCode:", emptyExtraRemote);
  }

  const categoryById = new Map(categories.map((c) => [c.id, c]));
  let uncategorizedCategory = null;
  const resolveCategoryId = (categoryId) => {
    if (categoryId && categoryById.has(categoryId)) {
      return `CAT_${categoryId}`;
    }
    if (!uncategorizedCategory) {
      uncategorizedCategory = { id: "UNCATEGORIZED", name: "Uncategorized" };
    }
    return `CAT_${uncategorizedCategory.id}`;
  };

  return {
    categories: [
      ...categories.map(c => ({
        id: `CAT_${c.id}`,
        name: c.name
      })),
      ...(uncategorizedCategory
        ? [{ id: `CAT_${uncategorizedCategory.id}`, name: uncategorizedCategory.name }]
        : []),
    ],

    products: products.map(p => ({
      id: `PROD_${p.id}`,
      name: p.name,
      categoryId: resolveCategoryId(p.category_id),
      price: Number(p.price),
      remoteCode: p.remoteCode,
      images: [],
      variations: []
    })),

    options: groups.map(g => ({
      id: `OPT_${g.id}`,
      name: g.name,
      type: "multiple",
      minChoices: g.required ? 1 : 0,
      maxChoices: Number.isFinite(Number(g.max_selection)) ? Number(g.max_selection) : 20,
      items: items
        .filter(i => i.group_id === g.id)
        .map((i, idx) => ({
          id: `MOD_${i.id}`,
          sequence: idx + 1
        }))
    })),

    modifiers: items.map(i => ({
      id: `MOD_${i.id}`,
      name: i.name,
      price: Number(i.price),
      remoteCode: i.remoteCode
    })),

    availability: Object.fromEntries(
      products.map(p => [`PROD_${p.id}`, { available: true }])
    )
  };
}


//
// Send catalog import status
//
async function sendCatalogStatus(catalogId, vendorCode, status, message) {
  await axios.post(YS_MENU_STATUS_CALLBACK_URL, {
    catalogImportId: catalogId,
    status,
    message,
    details: [
      {
        vendorCode,
        status,
        message
      }
    ]
  });
}

module.exports = router;
