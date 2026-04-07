const { pool } = require("../db");
const { encryptJson, decryptJson } = require("../utils/piiCrypto");

const GRAPH_BASE_URL = String(
  process.env.WHATSAPP_GRAPH_API_BASE_URL || "https://graph.facebook.com"
).replace(/\/+$/, "");
const GRAPH_API_VERSION = String(process.env.WHATSAPP_GRAPH_API_VERSION || "v23.0").trim();

let ensureWhatsAppColumnsPromise = null;

function createServiceError(message, { code = "WHATSAPP_INTEGRATION_ERROR", statusCode = 500, details } = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  if (details !== undefined) {
    err.details = details;
  }
  return err;
}

function toPositiveRestaurantId(restaurantId) {
  const parsed = Number.parseInt(String(restaurantId), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw createServiceError("Invalid restaurant ID", {
      code: "INVALID_RESTAURANT_ID",
      statusCode: 400,
    });
  }
  return parsed;
}

function normalizeRequiredField(value, key) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw createServiceError(`Missing required field: ${key}`, {
      code: "VALIDATION_ERROR",
      statusCode: 400,
      details: { field: key },
    });
  }
  return normalized;
}

function normalizeTokenType(value) {
  const normalized = String(value || "").trim();
  return normalized || "Bearer";
}

function normalizeDestinationPhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function buildPublicConfig(row) {
  return {
    connected: row?.whatsapp_connected === true,
    displayPhoneNumber: row?.whatsapp_display_phone_number || null,
    verifiedName: row?.whatsapp_verified_name || null,
    phoneNumberId: row?.whatsapp_phone_number_id || null,
    businessAccountId: row?.whatsapp_business_account_id || null,
    connectedAt: row?.whatsapp_connected_at || null,
    lastSyncAt: row?.whatsapp_last_sync_at || null,
  };
}

function maskPhoneForLog(value) {
  const digits = normalizeDestinationPhone(value);
  if (!digits) return "(empty)";
  if (digits.length <= 4) return `***${digits}`;
  return `***${digits.slice(-4)}`;
}

function encryptAccessTokenForStorage(token) {
  const normalized = String(token || "").trim();
  if (!normalized) return null;
  const encryptedPayload = encryptJson({ token: normalized });
  return JSON.stringify(encryptedPayload);
}

function decryptAccessTokenFromStorage(storedValue) {
  const raw = String(storedValue || "").trim();
  if (!raw) return null;

  // Backward compatibility for legacy plain-text storage.
  if (!raw.startsWith("{")) {
    return raw;
  }

  try {
    const parsed = JSON.parse(raw);
    const decrypted = decryptJson(parsed);
    const token = String(decrypted?.token || "").trim();
    if (!token) {
      throw createServiceError("Stored WhatsApp token is invalid", {
        code: "WHATSAPP_TOKEN_INVALID",
        statusCode: 500,
      });
    }
    return token;
  } catch (err) {
    if (err?.code && err?.statusCode) throw err;
    throw createServiceError("Failed to decrypt WhatsApp token", {
      code: "WHATSAPP_TOKEN_DECRYPT_FAILED",
      statusCode: 500,
    });
  }
}

async function ensureWhatsAppColumns() {
  if (!ensureWhatsAppColumnsPromise) {
    ensureWhatsAppColumnsPromise = (async () => {
      await pool.query(`
        ALTER TABLE restaurants
          ADD COLUMN IF NOT EXISTS whatsapp_connected BOOLEAN DEFAULT false,
          ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id TEXT,
          ADD COLUMN IF NOT EXISTS whatsapp_business_account_id TEXT,
          ADD COLUMN IF NOT EXISTS whatsapp_display_phone_number TEXT,
          ADD COLUMN IF NOT EXISTS whatsapp_verified_name TEXT,
          ADD COLUMN IF NOT EXISTS whatsapp_access_token TEXT,
          ADD COLUMN IF NOT EXISTS whatsapp_token_type TEXT,
          ADD COLUMN IF NOT EXISTS whatsapp_connected_at TIMESTAMP NULL,
          ADD COLUMN IF NOT EXISTS whatsapp_last_sync_at TIMESTAMP NULL
      `);
    })().catch((err) => {
      ensureWhatsAppColumnsPromise = null;
      throw err;
    });
  }
  return ensureWhatsAppColumnsPromise;
}

async function getRestaurantRow(restaurantId) {
  await ensureWhatsAppColumns();
  const query = `
    SELECT
      id,
      whatsapp_connected,
      whatsapp_phone_number_id,
      whatsapp_business_account_id,
      whatsapp_display_phone_number,
      whatsapp_verified_name,
      whatsapp_access_token,
      whatsapp_token_type,
      whatsapp_connected_at,
      whatsapp_last_sync_at
    FROM restaurants
    WHERE id = $1
    LIMIT 1
  `;
  const { rows } = await pool.query(query, [restaurantId]);
  if (!rows.length) {
    throw createServiceError("Restaurant not found", {
      code: "RESTAURANT_NOT_FOUND",
      statusCode: 404,
    });
  }
  return rows[0];
}

async function getRestaurantWhatsAppConfig(restaurantId) {
  const safeRestaurantId = toPositiveRestaurantId(restaurantId);
  const row = await getRestaurantRow(safeRestaurantId);
  return buildPublicConfig(row);
}

async function saveRestaurantWhatsAppConfig(restaurantId, data) {
  const safeRestaurantId = toPositiveRestaurantId(restaurantId);
  const payload = data && typeof data === "object" ? data : {};

  const phoneNumberId = normalizeRequiredField(payload.phoneNumberId, "phoneNumberId");
  const businessAccountId = normalizeRequiredField(payload.businessAccountId, "businessAccountId");
  const displayPhoneNumber = normalizeRequiredField(payload.displayPhoneNumber, "displayPhoneNumber");
  const verifiedName = normalizeRequiredField(payload.verifiedName, "verifiedName");
  const accessToken = normalizeRequiredField(payload.accessToken, "accessToken");
  const tokenType = normalizeTokenType(payload.tokenType);

  const encryptedToken = encryptAccessTokenForStorage(accessToken);

  const { rows } = await pool.query(
    `
      UPDATE restaurants
      SET
        whatsapp_connected = true,
        whatsapp_phone_number_id = $2,
        whatsapp_business_account_id = $3,
        whatsapp_display_phone_number = $4,
        whatsapp_verified_name = $5,
        whatsapp_access_token = $6,
        whatsapp_token_type = $7,
        whatsapp_connected_at = NOW(),
        whatsapp_last_sync_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        whatsapp_connected,
        whatsapp_phone_number_id,
        whatsapp_business_account_id,
        whatsapp_display_phone_number,
        whatsapp_verified_name,
        whatsapp_connected_at,
        whatsapp_last_sync_at
    `,
    [
      safeRestaurantId,
      phoneNumberId,
      businessAccountId,
      displayPhoneNumber,
      verifiedName,
      encryptedToken,
      tokenType,
    ]
  );

  if (!rows.length) {
    throw createServiceError("Restaurant not found", {
      code: "RESTAURANT_NOT_FOUND",
      statusCode: 404,
    });
  }

  console.log(
    "✅ Saved restaurant WhatsApp Business config",
    JSON.stringify({
      restaurantId: safeRestaurantId,
      phoneNumberId,
      businessAccountId,
      tokenType,
    })
  );

  return buildPublicConfig(rows[0]);
}

async function disconnectRestaurantWhatsApp(restaurantId) {
  const safeRestaurantId = toPositiveRestaurantId(restaurantId);

  const { rows } = await pool.query(
    `
      UPDATE restaurants
      SET
        whatsapp_connected = false,
        whatsapp_phone_number_id = NULL,
        whatsapp_business_account_id = NULL,
        whatsapp_display_phone_number = NULL,
        whatsapp_verified_name = NULL,
        whatsapp_access_token = NULL,
        whatsapp_token_type = NULL,
        whatsapp_connected_at = NULL,
        whatsapp_last_sync_at = NULL
      WHERE id = $1
      RETURNING
        id,
        whatsapp_connected,
        whatsapp_phone_number_id,
        whatsapp_business_account_id,
        whatsapp_display_phone_number,
        whatsapp_verified_name,
        whatsapp_connected_at,
        whatsapp_last_sync_at
    `,
    [safeRestaurantId]
  );

  if (!rows.length) {
    throw createServiceError("Restaurant not found", {
      code: "RESTAURANT_NOT_FOUND",
      statusCode: 404,
    });
  }

  console.log(`✅ Disconnected WhatsApp Business for restaurant ${safeRestaurantId}`);
  return buildPublicConfig(rows[0]);
}

async function sendWhatsAppTemplateMessage({
  restaurantId,
  to,
  templateName,
  templateLanguage,
  components,
}) {
  const safeRestaurantId = toPositiveRestaurantId(restaurantId);
  const normalizedTo = normalizeRequiredField(to, "to");
  const normalizedTemplateName = normalizeRequiredField(templateName, "templateName");
  const normalizedTemplateLanguage = normalizeRequiredField(
    templateLanguage,
    "templateLanguage"
  );
  const destination = normalizeDestinationPhone(normalizedTo);

  if (!destination || destination.length < 8) {
    throw createServiceError("Invalid recipient phone number", {
      code: "INVALID_PHONE_NUMBER",
      statusCode: 400,
      details: { to: normalizedTo },
    });
  }

  const row = await getRestaurantRow(safeRestaurantId);

  if (!row.whatsapp_connected) {
    throw createServiceError("WhatsApp Business is not connected for this restaurant", {
      code: "WHATSAPP_NOT_CONNECTED",
      statusCode: 400,
    });
  }

  const phoneNumberId = String(row.whatsapp_phone_number_id || "").trim();
  if (!phoneNumberId) {
    throw createServiceError("Connected restaurant is missing whatsapp_phone_number_id", {
      code: "WHATSAPP_PHONE_NUMBER_ID_MISSING",
      statusCode: 400,
    });
  }

  const accessToken = decryptAccessTokenFromStorage(row.whatsapp_access_token);
  if (!accessToken) {
    throw createServiceError("Connected restaurant is missing WhatsApp access token", {
      code: "WHATSAPP_ACCESS_TOKEN_MISSING",
      statusCode: 400,
    });
  }

  const tokenType = normalizeTokenType(row.whatsapp_token_type || "Bearer");
  const url = `${GRAPH_BASE_URL}/${GRAPH_API_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to: destination,
    type: "template",
    template: {
      name: normalizedTemplateName,
      language: {
        code: normalizedTemplateLanguage,
      },
    },
  };

  if (Array.isArray(components) && components.length) {
    body.template.components = components;
  }

  // TODO: Add template parameter support helper for variable substitution.
  // TODO: Add media message support (image/document/video payload builders).
  // TODO: Add per-restaurant template mapping/alias layer.
  // TODO: Add retry/backoff and idempotency key support for transient Graph API failures.
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `${tokenType} ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseJson = await response.json().catch(() => ({}));

  if (!response.ok) {
    const graphError = responseJson?.error || {};
    console.error(
      "❌ WhatsApp template send failed",
      JSON.stringify({
        restaurantId: safeRestaurantId,
        status: response.status,
        to: maskPhoneForLog(destination),
        templateName: normalizedTemplateName,
        graphCode: graphError?.code || null,
        graphSubcode: graphError?.error_subcode || null,
        graphMessage: graphError?.message || response.statusText,
      })
    );

    throw createServiceError("WhatsApp Graph API request failed", {
      code: "WHATSAPP_GRAPH_API_ERROR",
      statusCode: 502,
      details: {
        status: response.status,
        graphError: graphError?.message || response.statusText,
        graphCode: graphError?.code || null,
      },
    });
  }

  await pool.query("UPDATE restaurants SET whatsapp_last_sync_at = NOW() WHERE id = $1", [
    safeRestaurantId,
  ]);

  console.log(
    "✅ WhatsApp template sent",
    JSON.stringify({
      restaurantId: safeRestaurantId,
      to: maskPhoneForLog(destination),
      templateName: normalizedTemplateName,
      templateLanguage: normalizedTemplateLanguage,
      messageId: responseJson?.messages?.[0]?.id || null,
    })
  );

  return {
    sent: true,
    messageId: responseJson?.messages?.[0]?.id || null,
    to: destination,
    templateName: normalizedTemplateName,
    templateLanguage: normalizedTemplateLanguage,
    providerResponse: responseJson,
  };
}

// TODO: Implement Meta Embedded Signup callback flow to finalize account linking server-side.
// TODO: Implement token refresh / long-lived token lifecycle management.
// TODO: Add webhook verification endpoint for Cloud API callbacks.
// TODO: Add inbound message/status webhook handling and persistence.
module.exports = {
  createServiceError,
  getRestaurantWhatsAppConfig,
  saveRestaurantWhatsAppConfig,
  disconnectRestaurantWhatsApp,
  sendWhatsAppTemplateMessage,
};
