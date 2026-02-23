// utils/migrosClient.js
/**
 * Migros Yemek API Client
 * Handles encryption, request signing, retries, and timeouts per Migros API v1.2.0
 */

const crypto = require("crypto");
const { pool } = require("../db");

const MIGROS_API_BASE = process.env.MIGROS_API_BASE || "https://test.gourmet.migrosonline.com";
const MIGROS_REQUEST_TIMEOUT = 30000; // 30 seconds
const MIGROS_MAX_RETRIES = 3;
const MIGROS_RETRY_DELAY = 1000; // ms

const dlog = (...args) =>
  console.log(new Date().toISOString(), "[migros-client]", ...args);

// =========================================================
// ENCRYPTION HELPERS (Rijndael AES ECB, PKCS7, 256-bit key)
// =========================================================

/**
 * Encrypt JSON body using Rijndael AES ECB mode
 * @param {Object} bodyObj - Plain object to encrypt
 * @param {string} secretKey - Secret key for encryption
 * @returns {string} Encrypted and Base64-encoded string
 */
function encryptMigrosBody(bodyObj, secretKey) {
  if (!secretKey) {
    throw new Error("Missing secretKey for Migros encryption");
  }

  const jsonString = JSON.stringify(bodyObj);

  // Derive 256-bit key from secretKey using SHA-256
  const keyHash = crypto
    .createHash("sha256")
    .update(secretKey, "utf8")
    .digest();

  // Use AES-256-ECB with the derived key
  const cipher = crypto.createCipheriv("aes-256-ecb", keyHash, "");

  // Encrypt (cipher handles PKCS7 padding by default in Node.js)
  let encrypted = cipher.update(jsonString, "utf8", "base64");
  encrypted += cipher.final("base64");

  return encrypted;
}

/**
 * Wrap encrypted body in { value: "..." } format
 * @param {Object} bodyObj - Plain object to encrypt
 * @param {string} secretKey - Secret key for encryption
 * @returns {Object} Wrapped encrypted body
 */
function wrapEncryptedBody(bodyObj, secretKey) {
  const encrypted = encryptMigrosBody(bodyObj, secretKey);
  return { value: encrypted };
}

// =========================================================
// API REQUEST HELPER
// =========================================================

/**
 * Post to Migros API with encryption, headers, retries
 * @param {string} path - API path (e.g., "Order/v2/UpdateOrderStatus")
 * @param {string} apiKey - Restaurant API key (XApiKey header)
 * @param {Object} plainBody - Plain object to send (will be encrypted)
 * @param {string} secretKey - Secret key for encryption (from env or param)
 * @param {Object} options - Additional options { retries, timeout }
 * @returns {Promise<{ok: boolean, status: number, data: any, error?: string}>}
 */
async function postToMigros(path, apiKey, plainBody, secretKey, options = {}) {
  const {
    retries = MIGROS_MAX_RETRIES,
    timeout = MIGROS_REQUEST_TIMEOUT,
  } = options;

  secretKey = secretKey || process.env.MIGROS_SECRET_KEY;

  if (!secretKey && path !== "Store/GetDefinedActiveRestaurantApiKeys") {
    dlog("❌ Missing MIGROS_SECRET_KEY in environment");
    return {
      ok: false,
      status: 500,
      error: "Missing MIGROS_SECRET_KEY",
    };
  }

  if (!apiKey && path !== "Store/GetDefinedActiveRestaurantApiKeys") {
    dlog("❌ Missing apiKey for path:", path);
    return {
      ok: false,
      status: 400,
      error: "Missing apiKey",
    };
  }

  // Wrap body in encryption
  let requestBody;
  if (path === "Store/GetDefinedActiveRestaurantApiKeys") {
    // This endpoint does NOT require encryption
    requestBody = plainBody;
  } else {
    // All other POST requests require encryption
    requestBody = wrapEncryptedBody(plainBody, secretKey);
  }

  const url = `${MIGROS_API_BASE}/${path}`;
  const headers = {
    "Content-Type": "application/json",
  };

  // Add XApiKey header for all restaurant-specific calls (except key sync)
  if (path !== "Store/GetDefinedActiveRestaurantApiKeys" && apiKey) {
    headers["XApiKey"] = apiKey;
  }

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      dlog(`📤 [Attempt ${attempt + 1}/${retries + 1}] POST ${path}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      let responseBody;
      try {
        const text = await response.text();
        responseBody = text ? JSON.parse(text) : null;
      } catch (err) {
        responseBody = null;
      }

      if (!response.ok) {
        lastError = {
          status: response.status,
          body: responseBody || "No response body",
        };

        // Don't retry on 4xx client errors (except 429)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          dlog(`❌ [${response.status}] ${path}:`, responseBody);
          return {
            ok: false,
            status: response.status,
            data: responseBody,
            error: `HTTP ${response.status}`,
          };
        }

        // Retry on 5xx or 429
        if (attempt < retries) {
          const delay = MIGROS_RETRY_DELAY * Math.pow(2, attempt); // Exponential backoff
          dlog(`⏳ Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      dlog(`✅ [${response.status}] ${path}`);
      return {
        ok: response.ok,
        status: response.status,
        data: responseBody,
      };
    } catch (err) {
      lastError = err;

      if (err.name === "AbortError") {
        dlog(`⏱️  Request timeout (${timeout}ms) on attempt ${attempt + 1}`);
      } else {
        dlog(`❌ Request error on attempt ${attempt + 1}:`, err.message);
      }

      if (attempt < retries) {
        const delay = MIGROS_RETRY_DELAY * Math.pow(2, attempt);
        dlog(`⏳ Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
    }
  }

  dlog(`❌ Max retries exceeded for ${path}`);
  return {
    ok: false,
    status: lastError?.status || 500,
    error: lastError?.message || "Max retries exceeded",
  };
}

// =========================================================
// STATUS MAPPING
// =========================================================

/**
 * Map internal Beypro status to Migros orderStatus string
 * @param {string} status - Beypro internal status
 * @returns {string} Migros orderStatus value
 */
function mapBeyprosStatusToMigros(status) {
  const statusMap = {
    confirmed: "Approved",
    accepted: "Approved",
    pending: "Approved", // Treat pending as approved for Migros
    prepared: "Prepared",
    ready: "Prepared",
    dispatched: "Delivery",
    on_road: "Delivery",
    delivery: "Delivery",
    delivered: "Completed",
    completed: "Completed",
    cancelled: "Cancel",
    rejected: "Cancel",
  };

  const normalizedStatus = String(status || "").toLowerCase().trim();
  return statusMap[normalizedStatus] || "Approved"; // Default to Approved
}

// =========================================================
// DB HELPERS
// =========================================================

/**
 * Get Migros API key for a restaurant
 * @param {number} restaurantId - Beypro restaurant ID
 * @returns {Promise<{apiKey: string, storeId: number, storeGroupId: number}|null>}
 */
async function getMigrosApiKeyForRestaurant(restaurantId) {
  if (!restaurantId) return null;

  try {
    const { rows } = await pool.query(
      `SELECT api_key, store_id, store_group_id 
       FROM migros_restaurant_keys 
       WHERE restaurant_id = $1 AND is_active = true 
       LIMIT 1`,
      [restaurantId]
    );

    return rows[0] || null;
  } catch (err) {
    dlog("❌ Error fetching Migros API key:", err.message);
    return null;
  }
}

/**
 * Record Migros API error for monitoring
 * @param {string} endpoint - Migros endpoint
 * @param {number} status - HTTP status
 * @param {Object} error - Error object
 */
async function recordMigrosApiError(endpoint, status, error) {
  try {
    await pool.query(
      `UPDATE settings 
       SET integrations = jsonb_set(
         COALESCE(integrations, '{}'::jsonb),
         '{migros,lastApiError}',
         $1::jsonb
       )
       WHERE key = 'global'`,
      [JSON.stringify({ endpoint, status, error: String(error), timestamp: new Date().toISOString() })]
    );
  } catch (err) {
    dlog("❌ Error recording API error:", err.message);
  }
}

/**
 * Update Migros last sync time
 */
async function updateMigrosLastSyncTime() {
  try {
    await pool.query(
      `UPDATE settings 
       SET integrations = jsonb_set(
         COALESCE(integrations, '{}'::jsonb),
         '{migros,lastSyncTime}',
         to_jsonb(now())
       )
       WHERE key = 'global'`
    );
  } catch (err) {
    dlog("⚠️  Error updating sync time:", err.message);
  }
}

// =========================================================
// EXPORTS
// =========================================================

module.exports = {
  encryptMigrosBody,
  wrapEncryptedBody,
  postToMigros,
  mapBeyprosStatusToMigros,
  getMigrosApiKeyForRestaurant,
  recordMigrosApiError,
  updateMigrosLastSyncTime,
  MIGROS_API_BASE,
  MIGROS_REQUEST_TIMEOUT,
};
