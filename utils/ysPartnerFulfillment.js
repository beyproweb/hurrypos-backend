const { pool } = require("../db");

let cachedAuthHeader = null;
let cachedAuthExpiresAt = 0;

const nowMs = () => Date.now();

const normalizeBearer = (token) => {
  if (!token) return null;
  const raw = String(token).trim();
  if (!raw) return null;
  return raw.toLowerCase().startsWith("bearer ") ? raw : `Bearer ${raw}`;
};

const resolvePartnerBaseUrl = () => {
  return (
    process.env.YS_PARTNER_API_BASE_URL ||
    process.env.YEMEKSEPETI_PARTNER_API_BASE_URL ||
    "https://yemeksepeti.partner.deliveryhero.io"
  ).replace(/\/+$/, "");
};

async function loginPartner() {
  const baseUrl = resolvePartnerBaseUrl();

  // 1) Prefer explicit bearer (recommended)
  const bearer = normalizeBearer(process.env.YS_PARTNER_API_TOKEN);
  if (bearer) {
    cachedAuthHeader = bearer;
    cachedAuthExpiresAt = nowMs() + 10 * 60 * 1000;
    return bearer;
  }

  // 2) Optional: try client_credentials login (same style as middlewareExternalApi)
  const username = process.env.YS_PARTNER_USERNAME || process.env.DH_MW_USERNAME;
  const password = process.env.YS_PARTNER_PASSWORD || process.env.DH_MW_PASSWORD;
  if (!username || !password) return null;

  const url = `${baseUrl}/v2/login`;
  const body = new URLSearchParams({
    username,
    password,
    grant_type: "client_credentials",
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Partner login failed (${response.status}): ${text}`);
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const token = json?.access_token || json?.token || null;
  const expiresIn = Number(json?.expires_in || 0);
  const header = normalizeBearer(token);
  if (!header) return null;

  cachedAuthHeader = header;
  cachedAuthExpiresAt = nowMs() + (Number.isFinite(expiresIn) && expiresIn > 30 ? expiresIn * 1000 : 10 * 60 * 1000);
  return header;
}

async function getPartnerAuthHeader() {
  if (cachedAuthHeader && cachedAuthExpiresAt - nowMs() > 30_000) return cachedAuthHeader;
  return await loginPartner();
}

const isYemeksepetiOrderRow = (row) => {
  return Boolean(
    row &&
      (row.external_source === "yemeksepeti" ||
        row.external_id ||
        row.external_order_token ||
        row.external_callback_urls)
  );
};

const extractOrderUuidFromToken = (token) => {
  if (!token) return null;
  const raw = String(token);
  // Tokens often include `oma_<uuid>` (seen in logs)
  const match = raw.match(/oma_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : null;
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

const toNumber = (value) => {
  if (value === null || value === undefined) return 0;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

async function sendYsPartnerFulfillment({ orderId, status }) {
  if (!orderId) return { skipped: true, reason: "missing_order_id" };

  const baseUrl = resolvePartnerBaseUrl();
  const authHeader = await getPartnerAuthHeader();
  if (!authHeader) {
    return { skipped: true, reason: "missing_partner_auth" };
  }

  const { rows: orderRows } = await pool.query(
    `SELECT
       id,
       restaurant_id,
       external_source,
       external_id,
       external_order_token,
       external_expedition_type,
       customer_address
     FROM orders
     WHERE id = $1
     LIMIT 1`,
    [orderId]
  );
  if (!orderRows.length) return { skipped: true, reason: "order_not_found" };
  const order = orderRows[0];
  if (!isYemeksepetiOrderRow(order)) return { skipped: true, reason: "not_yemeksepeti" };

  const ys = await getYsSettings(order.restaurant_id);
  const chainCode = String(ys.chainCode || "").trim();
  if (!chainCode) return { skipped: true, reason: "missing_chain_code" };

  const orderUuid = extractOrderUuidFromToken(order.external_order_token);
  if (!orderUuid) return { skipped: true, reason: "missing_order_uuid" };

  const expedition = String(order.external_expedition_type || "").toLowerCase().trim();
  const derivedExpedition =
    expedition ||
    (String(order.customer_address || "").toLowerCase().trim() === "pickup order"
      ? "pickup"
      : "delivery");

  const desiredStatus =
    status ||
    (derivedExpedition === "pickup" ? "READY_FOR_PICKUP" : "DISPATCHED");

  const { rows: itemRows } = await pool.query(
    `SELECT
       oi.product_id,
       oi.external_product_id,
       oi.quantity,
       oi.price,
       p.external_code AS pos_sku
     FROM order_items oi
     LEFT JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1
     ORDER BY oi.id ASC`,
    [orderId]
  );

  const items = (itemRows || [])
    .map((it) => {
      // Partner Picking API expects `sku`. For mapped products, `products.external_code` matches the remoteCode in the dispatch payload.
      // Fallback to `order_items.external_product_id` for legacy/unmapped cases.
      const sku = it.pos_sku
        ? String(it.pos_sku).trim()
        : it.external_product_id
          ? String(it.external_product_id).trim()
          : "";
      if (!sku) return null;
      const quantity = Math.max(1, Math.floor(toNumber(it.quantity) || 1));
      const totalPrice = toNumber(it.price);
      const unitPrice = quantity > 0 ? totalPrice / quantity : totalPrice;
      return {
        sku,
        pricing: {
          pricing_type: "UNIT",
          unit_price: unitPrice,
          quantity,
        },
        status: "IN_CART",
      };
    })
    .filter(Boolean);

  const url = `${baseUrl}/v2/chains/${encodeURIComponent(chainCode)}/orders/${encodeURIComponent(orderUuid)}`;
  const payload = {
    order_id: orderUuid,
    items,
    status: desiredStatus,
  };

  console.log(new Date().toISOString(), "[ys-partner] 📤 PUT fulfill:", {
    orderId,
    chainCode,
    orderUuid,
    status: desiredStatus,
    url,
    items: items.length,
  });

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify(payload),
  });
  const responseBody = await response.text();

  console.log(new Date().toISOString(), "[ys-partner] 📥 PUT fulfill response:", {
    orderId,
    status: response.status,
    body: responseBody,
  });

  return { ok: response.ok, status: response.status, body: responseBody };
}

module.exports = {
  sendYsPartnerFulfillment,
  extractOrderUuidFromToken,
  resolvePartnerBaseUrl,
};
