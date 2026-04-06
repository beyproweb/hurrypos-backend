const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { pool } = require("../db");
const {
  MARKETPLACE_CUSTOMER_SCOPE,
  ensureMarketplaceCustomerSchema,
  ensureRestaurantCustomerForMarketplace,
  getMarketplaceCustomerById,
  getRestaurantCustomerProfile,
  loginMarketplaceCustomer,
  registerMarketplaceCustomer,
  signMarketplaceCustomerToken,
  updateMarketplaceCustomerProfile,
  verifyCustomerAuthToken,
} = require("../utils/marketplaceCustomerAuth");

const QR_CUSTOMER_TOKEN_TTL = "30d";
const QR_CUSTOMER_OAUTH_STATE_TTL = "15m";
const QR_CUSTOMER_OAUTH_DEFAULT_RETURN_URL =
  process.env.QR_CUSTOMER_OAUTH_DEFAULT_RETURN_URL || "https://www.beypro.com/menu";
const QR_CUSTOMER_OAUTH_ALLOWED_RETURN_HOSTS = (
  process.env.QR_CUSTOMER_OAUTH_ALLOWED_RETURN_HOSTS ||
  "localhost,127.0.0.1,beypro.com,www.beypro.com,app.beypro.com"
)
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

let qrCustomerAuthSchemaPromise = null;
let qrCustomerOauthSchemaPromise = null;

async function ensureQrCustomerAuthSchema() {
  if (!qrCustomerAuthSchemaPromise) {
    qrCustomerAuthSchemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS qr_customer_auth (
          id SERIAL PRIMARY KEY,
          restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
          customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          phone TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          language TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS qr_customer_auth_restaurant_phone_idx
        ON qr_customer_auth (restaurant_id, phone)
      `);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS qr_customer_auth_customer_idx
        ON qr_customer_auth (customer_id)
      `);
    })().catch((err) => {
      qrCustomerAuthSchemaPromise = null;
      throw err;
    });
  }

  return qrCustomerAuthSchemaPromise;
}

async function ensureQrCustomerOauthSchema() {
  if (!qrCustomerOauthSchemaPromise) {
    qrCustomerOauthSchemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS qr_customer_oauth_accounts (
          id SERIAL PRIMARY KEY,
          restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
          customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          provider_user_id TEXT NOT NULL,
          email TEXT,
          full_name TEXT,
          raw_profile JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS qr_customer_oauth_provider_user_idx
        ON qr_customer_oauth_accounts (restaurant_id, provider, provider_user_id)
      `);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS qr_customer_oauth_customer_provider_idx
        ON qr_customer_oauth_accounts (restaurant_id, customer_id, provider)
      `);
    })().catch((err) => {
      qrCustomerOauthSchemaPromise = null;
      throw err;
    });
  }

  return qrCustomerOauthSchemaPromise;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00") && digits.length > 2) digits = digits.slice(2);
  if (digits.startsWith("90") && digits.length > 10) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length > 10) digits = digits.slice(1);
  return digits;
}

function buildPhoneCandidates(value) {
  const normalized = normalizePhone(value);
  if (!normalized) return [];
  const variants = new Set([normalized]);
  variants.add(`0${normalized}`);
  variants.add(`90${normalized}`);
  variants.add(`0090${normalized}`);
  return Array.from(variants);
}

function normalizeLanguage(value) {
  const raw = normalizeText(value).split(",")[0];
  return raw ? raw.slice(0, 32) : null;
}

function normalizeOAuthProvider(value) {
  const provider = normalizeText(value).toLowerCase();
  if (provider === "google" || provider === "apple") return provider;
  return "";
}

function decodeJwtPayload(rawToken) {
  const token = normalizeText(rawToken);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function getJwtSigningSecret() {
  return process.env.JWT_SECRET || "beypro_secret_2025";
}

function signQrCustomerOAuthState(payload) {
  return jwt.sign(
    {
      purpose: "qr_customer_oauth",
      ...payload,
    },
    getJwtSigningSecret(),
    { expiresIn: QR_CUSTOMER_OAUTH_STATE_TTL }
  );
}

function verifyQrCustomerOAuthState(token) {
  const rawToken = normalizeText(token);
  if (!rawToken) return null;
  try {
    const decoded = jwt.verify(rawToken, getJwtSigningSecret());
    if (decoded?.purpose !== "qr_customer_oauth") return null;
    return decoded;
  } catch {
    return null;
  }
}

function parseApplePrivateKey(rawValue) {
  const value = normalizeText(rawValue);
  if (!value) return "";
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

function resolveGoogleOAuthConfig() {
  const clientId = normalizeText(process.env.GOOGLE_OAUTH_CLIENT_ID);
  const clientSecret = normalizeText(process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  const redirectUri = normalizeText(process.env.GOOGLE_OAUTH_REDIRECT_URI);
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

function resolveAppleOAuthConfig() {
  const clientId = normalizeText(process.env.APPLE_OAUTH_CLIENT_ID);
  const teamId = normalizeText(process.env.APPLE_OAUTH_TEAM_ID);
  const keyId = normalizeText(process.env.APPLE_OAUTH_KEY_ID);
  const privateKey = parseApplePrivateKey(process.env.APPLE_OAUTH_PRIVATE_KEY);
  const redirectUri = normalizeText(process.env.APPLE_OAUTH_REDIRECT_URI);
  if (!clientId || !teamId || !keyId || !privateKey || !redirectUri) return null;
  return {
    clientId,
    teamId,
    keyId,
    privateKey,
    redirectUri,
  };
}

function createAppleClientSecret(config) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: config.teamId,
      iat: now,
      exp: now + 60 * 60 * 24 * 180,
      aud: "https://appleid.apple.com",
      sub: config.clientId,
    },
    config.privateKey,
    {
      algorithm: "ES256",
      keyid: config.keyId,
    }
  );
}

function isAllowedReturnHost(hostname) {
  const normalizedHost = String(hostname || "").trim().toLowerCase();
  if (!normalizedHost) return false;
  return QR_CUSTOMER_OAUTH_ALLOWED_RETURN_HOSTS.some(
    (allowedHost) =>
      normalizedHost === allowedHost || normalizedHost.endsWith(`.${allowedHost}`)
  );
}

function buildOAuthFallbackReturnUrl(identifier) {
  try {
    const fallback = new URL(QR_CUSTOMER_OAUTH_DEFAULT_RETURN_URL);
    const normalizedIdentifier = normalizeText(identifier);
    if (normalizedIdentifier && !fallback.searchParams.get("identifier")) {
      fallback.searchParams.set("identifier", normalizedIdentifier);
    }
    return fallback.toString();
  } catch {
    const defaultUrl = new URL("https://www.beypro.com/menu");
    const normalizedIdentifier = normalizeText(identifier);
    if (normalizedIdentifier) {
      defaultUrl.searchParams.set("identifier", normalizedIdentifier);
    }
    return defaultUrl.toString();
  }
}

function sanitizeOAuthReturnToUrl(rawValue, identifier) {
  const candidate = normalizeText(rawValue);
  if (!candidate) {
    return buildOAuthFallbackReturnUrl(identifier);
  }

  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return buildOAuthFallbackReturnUrl(identifier);
    }
    if (!isAllowedReturnHost(parsed.hostname)) {
      return buildOAuthFallbackReturnUrl(identifier);
    }
    if (parsed.protocol === "http:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      return buildOAuthFallbackReturnUrl(identifier);
    }
    return parsed.toString();
  } catch {
    return buildOAuthFallbackReturnUrl(identifier);
  }
}

function appendQueryParamsToUrl(rawUrl, params = {}) {
  const url = new URL(rawUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      url.searchParams.delete(key);
      return;
    }
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function buildOAuthSuccessRedirectUrl(returnTo, payload = {}) {
  const cleanUrl = appendQueryParamsToUrl(returnTo, {
    qr_oauth_error: null,
  });
  return appendQueryParamsToUrl(cleanUrl, {
    qr_oauth_provider: payload.provider,
    qr_oauth_token: payload.token,
  });
}

function buildOAuthErrorRedirectUrl(returnTo, payload = {}) {
  const cleanUrl = appendQueryParamsToUrl(returnTo, {
    qr_oauth_provider: null,
    qr_oauth_token: null,
  });
  return appendQueryParamsToUrl(cleanUrl, {
    qr_oauth_error: payload.error || "oauth_failed",
    qr_oauth_provider: payload.provider || null,
  });
}

function signQrCustomerToken({ customerId, restaurantId, phone }) {
  return jwt.sign(
    {
      id: customerId,
      customer_id: customerId,
      restaurant_id: restaurantId,
      phone,
      role: "customer",
      scope: "qr_customer",
      auth_source: "qr_customer",
    },
    process.env.JWT_SECRET || "beypro_secret_2025",
    { expiresIn: QR_CUSTOMER_TOKEN_TTL }
  );
}

function verifyQrCustomerToken(token) {
  const primarySecret = process.env.JWT_SECRET;
  const legacySecret =
    process.env.NODE_ENV !== "production" ? process.env.JWT_SECRET_LEGACY : "";
  const verifyWith = (secret) => jwt.verify(token, secret);

  try {
    return verifyWith(primarySecret || "beypro_secret_2025");
  } catch (err) {
    if (legacySecret && legacySecret !== primarySecret) {
      return verifyWith(legacySecret);
    }
    throw err;
  }
}

async function resolveRestaurantId(identifier) {
  const key = String(identifier || "").trim();
  if (!key) return null;

  const { rows } = await pool.query(
    `
      SELECT id
      FROM restaurants
      WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1
      LIMIT 1
    `,
    [key]
  );

  return Number(rows[0]?.id) || null;
}

async function requirePublicRestaurant(req, res, next) {
  try {
    const identifier =
      req.query.identifier ||
      req.body?.identifier ||
      req.params.identifier ||
      "";
    const restaurantId = await resolveRestaurantId(identifier);

    if (!restaurantId) {
      return res.status(400).json({ error: "Valid identifier is required" });
    }

    req.restaurantId = restaurantId;
    next();
  } catch (err) {
    console.error("❌ Public customer restaurant resolve failed:", err);
    res.status(500).json({ error: "Failed to resolve restaurant" });
  }
}

async function getCustomerAddresses(restaurantId, customerId) {
  const { rows } = await pool.query(
    `
      SELECT id, label, address, is_default
      FROM customer_addresses
      WHERE restaurant_id = $1 AND customer_id = $2
      ORDER BY is_default DESC, id ASC
    `,
    [restaurantId, customerId]
  );

  return rows;
}

async function findCustomerByPhoneIdentity(restaurantId, phone, runner = pool) {
  const candidates = buildPhoneCandidates(phone);
  if (!candidates.length) return null;

  const { rows } = await runner.query(
    `
      SELECT id, restaurant_id, name, phone, address, birthday, email
      FROM customers
      WHERE restaurant_id = $1
        AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = ANY($2::text[])
      ORDER BY id ASC
      LIMIT 1
    `,
    [restaurantId, candidates]
  );

  const customer = rows[0] || null;
  if (!customer) return null;

  const addresses = await getCustomerAddresses(restaurantId, customer.id);
  return { ...customer, addresses };
}

async function getCustomerByPhone(restaurantId, phone) {
  const { rows } = await pool.query(
    `
      SELECT id, restaurant_id, name, phone, address, birthday, email
      FROM customers
      WHERE restaurant_id = $1 AND phone = $2
      LIMIT 1
    `,
    [restaurantId, String(phone || "").trim()]
  );

  const customer = rows[0] || null;
  if (!customer) return null;

  const addresses = await getCustomerAddresses(restaurantId, customer.id);
  return { ...customer, addresses };
}

async function getCustomerById(restaurantId, customerId) {
  const { rows } = await pool.query(
    `
      SELECT id, restaurant_id, name, phone, address, birthday, email
      FROM customers
      WHERE restaurant_id = $1 AND id = $2
      LIMIT 1
    `,
    [restaurantId, customerId]
  );

  const customer = rows[0] || null;
  if (!customer) return null;

  const addresses = await getCustomerAddresses(restaurantId, customer.id);
  return { ...customer, addresses };
}

async function getQrCustomerProfileById(restaurantId, customerId, runner = pool) {
  const { rows } = await runner.query(
    `
      SELECT
        c.id,
        c.restaurant_id,
        c.name,
        c.phone,
        c.address,
        c.birthday,
        c.email,
        qca.language
      FROM customers c
      LEFT JOIN qr_customer_auth qca
        ON qca.customer_id = c.id
       AND qca.restaurant_id = c.restaurant_id
      WHERE c.restaurant_id = $1 AND c.id = $2
      LIMIT 1
    `,
    [restaurantId, customerId]
  );

  const customer = rows[0] || null;
  if (!customer) return null;

  const addresses = await getCustomerAddresses(restaurantId, customer.id);
  return { ...customer, addresses };
}

async function upsertCustomerProfile({
  runner = pool,
  restaurantId,
  name,
  phone,
  email = null,
  address = null,
}) {
  const normalizedName = normalizeText(name);
  const normalizedPhone = normalizePhone(phone);
  const normalizedEmail = normalizeEmail(email) || null;
  const normalizedAddress = normalizeText(address) || null;

  if (!normalizedName || !normalizedPhone) {
    throw new Error("Name and phone required");
  }

  const existing = await findCustomerByPhoneIdentity(restaurantId, normalizedPhone, runner);
  if (existing?.id) {
    const nextName = normalizedName || normalizeText(existing.name);
    const nextEmail = normalizedEmail || existing.email || null;
    const nextAddress = normalizedAddress || existing.address || null;

    await runner.query(
      `
        UPDATE customers
        SET name = $1,
            phone = $2,
            email = $3,
            address = $4
        WHERE restaurant_id = $5 AND id = $6
      `,
      [nextName, normalizedPhone, nextEmail, nextAddress, restaurantId, existing.id]
    );

    return existing.id;
  }

  const insert = await runner.query(
    `
      INSERT INTO customers (restaurant_id, name, phone, email, address)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `,
    [restaurantId, normalizedName, normalizedPhone, normalizedEmail, normalizedAddress]
  );

  return insert.rows[0]?.id || null;
}

async function loadQrCustomerAuth(restaurantId, phone, runner = pool) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const { rows } = await runner.query(
    `
      SELECT
        qca.id,
        qca.customer_id,
        qca.restaurant_id,
        qca.phone,
        qca.password_hash,
        qca.language
      FROM qr_customer_auth qca
      WHERE qca.restaurant_id = $1 AND qca.phone = $2
      LIMIT 1
    `,
    [restaurantId, normalizedPhone]
  );

  return rows[0] || null;
}

async function loadQrCustomerAuthByEmail(restaurantId, email, runner = pool) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const { rows } = await runner.query(
    `
      SELECT
        qca.id,
        qca.customer_id,
        qca.restaurant_id,
        qca.phone,
        qca.password_hash,
        qca.language
      FROM qr_customer_auth qca
      INNER JOIN customers c
        ON c.id = qca.customer_id
       AND c.restaurant_id = qca.restaurant_id
      WHERE qca.restaurant_id = $1
        AND LOWER(TRIM(COALESCE(c.email, ''))) = $2
      LIMIT 1
    `,
    [restaurantId, normalizedEmail]
  );

  return rows[0] || null;
}

async function getCustomerByEmail(restaurantId, email, runner = pool) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const { rows } = await runner.query(
    `
      SELECT id, restaurant_id, name, phone, address, birthday, email
      FROM customers
      WHERE restaurant_id = $1
        AND LOWER(TRIM(COALESCE(email, ''))) = $2
      ORDER BY id ASC
      LIMIT 1
    `,
    [restaurantId, normalizedEmail]
  );

  const customer = rows[0] || null;
  if (!customer) return null;

  const addresses = await getCustomerAddresses(restaurantId, customer.id);
  return { ...customer, addresses };
}

async function loadQrCustomerOauthAccount(restaurantId, provider, providerUserId, runner = pool) {
  const normalizedProvider = normalizeOAuthProvider(provider);
  const normalizedProviderUserId = normalizeText(providerUserId);
  if (!normalizedProvider || !normalizedProviderUserId) return null;

  const { rows } = await runner.query(
    `
      SELECT id, restaurant_id, customer_id, provider, provider_user_id
      FROM qr_customer_oauth_accounts
      WHERE restaurant_id = $1
        AND provider = $2
        AND provider_user_id = $3
      LIMIT 1
    `,
    [restaurantId, normalizedProvider, normalizedProviderUserId]
  );

  return rows[0] || null;
}

function buildSyntheticPhoneSeed(provider, providerUserId, attempt = 0) {
  const hashBuffer = crypto
    .createHash("sha256")
    .update(`${provider}:${providerUserId}:${attempt}`)
    .digest();

  let digits = "";
  for (const byte of hashBuffer) {
    digits += String(byte % 10);
    if (digits.length >= 10) break;
  }

  if (digits.length < 10) {
    digits = `${digits}${"0".repeat(10 - digits.length)}`;
  }
  if (digits[0] === "0") {
    digits = `9${digits.slice(1)}`;
  }

  return digits.slice(0, 10);
}

async function generateUniqueSyntheticPhone(restaurantId, provider, providerUserId, runner = pool) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = buildSyntheticPhoneSeed(provider, providerUserId, attempt);
    const existing = await runner.query(
      `
        SELECT id
        FROM customers
        WHERE restaurant_id = $1
          AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $2
        LIMIT 1
      `,
      [restaurantId, candidate]
    );
    if (!existing.rows.length) {
      return candidate;
    }
  }

  return `${Date.now()}`.slice(-10);
}

function resolveOauthCustomerName({ provider, name, email }) {
  const normalizedName = normalizeText(name);
  if (normalizedName) return normalizedName;

  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) {
    const localPart = normalizedEmail.split("@")[0] || "";
    if (localPart) return localPart;
  }

  return provider === "apple" ? "Apple User" : "Google User";
}

async function upsertQrCustomerOauthAccount(
  {
    restaurantId,
    customerId,
    provider,
    providerUserId,
    email = null,
    fullName = null,
    rawProfile = null,
  },
  runner = pool
) {
  const normalizedProvider = normalizeOAuthProvider(provider);
  const normalizedProviderUserId = normalizeText(providerUserId);
  const normalizedEmail = normalizeEmail(email) || null;
  const normalizedFullName = normalizeText(fullName) || null;
  if (!normalizedProvider || !normalizedProviderUserId || !customerId || !restaurantId) {
    throw new Error("Invalid OAuth account payload");
  }

  await runner.query(
    `
      INSERT INTO qr_customer_oauth_accounts
        (restaurant_id, customer_id, provider, provider_user_id, email, full_name, raw_profile)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (restaurant_id, provider, provider_user_id)
      DO UPDATE
      SET customer_id = EXCLUDED.customer_id,
          email = EXCLUDED.email,
          full_name = EXCLUDED.full_name,
          raw_profile = EXCLUDED.raw_profile,
          updated_at = NOW()
    `,
    [
      restaurantId,
      customerId,
      normalizedProvider,
      normalizedProviderUserId,
      normalizedEmail,
      normalizedFullName,
      JSON.stringify(rawProfile || {}),
    ]
  );
}

async function resolveOrCreateQrCustomerForOauth(
  { restaurantId, provider, providerUserId, email = null, name = null, rawProfile = null },
  runner = pool
) {
  const existingOauth = await loadQrCustomerOauthAccount(
    restaurantId,
    provider,
    providerUserId,
    runner
  );
  if (existingOauth?.customer_id) {
    await upsertQrCustomerOauthAccount(
      {
        restaurantId,
        customerId: existingOauth.customer_id,
        provider,
        providerUserId,
        email,
        fullName: name,
        rawProfile,
      },
      runner
    );
    return Number(existingOauth.customer_id);
  }

  const normalizedEmail = normalizeEmail(email) || null;
  const matchingCustomerByEmail = normalizedEmail
    ? await getCustomerByEmail(restaurantId, normalizedEmail, runner)
    : null;

  let customerId = Number(matchingCustomerByEmail?.id || 0);
  if (!Number.isFinite(customerId) || customerId <= 0) {
    const syntheticPhone = await generateUniqueSyntheticPhone(
      restaurantId,
      provider,
      providerUserId,
      runner
    );
    const displayName = resolveOauthCustomerName({
      provider,
      name,
      email: normalizedEmail,
    });

    const insertCustomer = await runner.query(
      `
        INSERT INTO customers (restaurant_id, name, phone, email, address)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `,
      [restaurantId, displayName, syntheticPhone, normalizedEmail, null]
    );
    customerId = Number(insertCustomer.rows[0]?.id || 0);
  }

  if (Number.isFinite(customerId) && customerId > 0) {
    await upsertQrCustomerOauthAccount(
      {
        restaurantId,
        customerId,
        provider,
        providerUserId,
        email: normalizedEmail,
        fullName: name,
        rawProfile,
      },
      runner
    );
    return customerId;
  }

  throw new Error("Failed to resolve customer for OAuth login");
}

async function exchangeGoogleCodeForProfile(code) {
  const config = resolveGoogleOAuthConfig();
  if (!config) {
    throw new Error("Google OAuth is not configured");
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: normalizeText(code),
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    }),
  });

  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok) {
    throw new Error(tokenPayload?.error_description || tokenPayload?.error || "Google token exchange failed");
  }

  const claims = decodeJwtPayload(tokenPayload?.id_token);
  if (!claims?.sub) {
    throw new Error("Google identity payload is missing subject");
  }
  if (normalizeText(claims?.aud) !== config.clientId) {
    throw new Error("Google identity audience mismatch");
  }

  return {
    provider: "google",
    providerUserId: normalizeText(claims.sub),
    email: normalizeEmail(claims.email) || null,
    name: normalizeText(claims.name),
    rawProfile: claims,
  };
}

async function exchangeAppleCodeForProfile(code) {
  const config = resolveAppleOAuthConfig();
  if (!config) {
    throw new Error("Apple OAuth is not configured");
  }

  const tokenResponse = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: createAppleClientSecret(config),
      code: normalizeText(code),
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    }),
  });

  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok) {
    throw new Error(tokenPayload?.error_description || tokenPayload?.error || "Apple token exchange failed");
  }

  const claims = decodeJwtPayload(tokenPayload?.id_token);
  if (!claims?.sub) {
    throw new Error("Apple identity payload is missing subject");
  }
  if (normalizeText(claims?.aud) !== config.clientId) {
    throw new Error("Apple identity audience mismatch");
  }

  return {
    provider: "apple",
    providerUserId: normalizeText(claims.sub),
    email: normalizeEmail(claims.email) || null,
    name: normalizeText(claims.name),
    rawProfile: claims,
  };
}

async function requireQrCustomerSession(req, res, next) {
  try {
    await ensureQrCustomerAuthSchema();
    await ensureMarketplaceCustomerSchema();

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Customer session required" });
    }

    const token = authHeader.slice(7).trim();
    const decoded = verifyCustomerAuthToken(token);
    if (!decoded?.customer_id) {
      return res.status(401).json({ error: "Invalid customer session" });
    }

    const scope = String(decoded.scope || "").toLowerCase();
    if (scope === MARKETPLACE_CUSTOMER_SCOPE) {
      const marketplaceCustomer = await getMarketplaceCustomerById(decoded.customer_id);
      if (!marketplaceCustomer?.id) {
        return res.status(401).json({ error: "Customer session is no longer valid" });
      }

      const localCustomerId = await ensureRestaurantCustomerForMarketplace({
        restaurantId: req.restaurantId,
        marketplaceCustomer,
      });
      const customer = await getRestaurantCustomerProfile(req.restaurantId, localCustomerId);
      if (!customer?.id) {
        return res.status(401).json({ error: "Customer session is no longer valid" });
      }

      req.marketplaceCustomer = marketplaceCustomer;
      req.qrCustomer = customer;
      req.qrCustomerToken = {
        ...decoded,
        customer_id: customer.id,
        marketplace_customer_id: marketplaceCustomer.id,
      };
      return next();
    }

    if (scope !== "qr_customer") {
      return res.status(401).json({ error: "Invalid customer session" });
    }

    if (Number(decoded.restaurant_id) !== Number(req.restaurantId)) {
      return res
        .status(403)
        .json({ error: "Customer session does not match this restaurant" });
    }

    const customer = await getQrCustomerProfileById(
      req.restaurantId,
      decoded.customer_id
    );
    if (!customer?.id) {
      return res.status(401).json({ error: "Customer session is no longer valid" });
    }

    req.qrCustomer = customer;
    req.qrCustomerToken = decoded;
    return next();
  } catch (err) {
    console.error("❌ QR customer session validation failed:", err);
    res.status(401).json({ error: "Invalid or expired customer session" });
  }
}

router.get("/customers/by-phone/:phone", requirePublicRestaurant, async (req, res) => {
  try {
    const customer = await getCustomerByPhone(req.restaurantId, req.params.phone);
    res.json(customer);
  } catch (err) {
    console.error("❌ Public customer lookup failed:", err);
    res.status(500).json({ error: "Failed to fetch customer" });
  }
});

router.post("/customers", requirePublicRestaurant, async (req, res) => {
  const restaurantId = req.restaurantId;
  const name = String(req.body?.name || "").trim();
  const phone = String(req.body?.phone || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase() || null;
  const address = String(req.body?.address || "").trim() || null;

  if (!name || !phone) {
    return res.status(400).json({ error: "Name and phone required" });
  }

  try {
    const existing = await getCustomerByPhone(restaurantId, phone);
    if (existing?.id) {
      const nextName = name || existing.name;
      const nextEmail = email || existing.email || null;

      await pool.query(
        `
          UPDATE customers
          SET name = $1,
              email = $2,
              address = COALESCE($3, address)
          WHERE restaurant_id = $4 AND id = $5
        `,
        [nextName, nextEmail, address, restaurantId, existing.id]
      );

      const updated = await getCustomerById(restaurantId, existing.id);
      return res.json(updated);
    }

    const insert = await pool.query(
      `
        INSERT INTO customers (restaurant_id, name, phone, email, address)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `,
      [restaurantId, name, phone, email, address]
    );

    const customer = await getCustomerById(restaurantId, insert.rows[0].id);
    res.json(customer);
  } catch (err) {
    console.error("❌ Public customer create failed:", err);
    res.status(500).json({ error: "Failed to save customer" });
  }
});

router.patch("/customers/:id", requirePublicRestaurant, async (req, res) => {
  const restaurantId = req.restaurantId;
  const { id } = req.params;
  const payload = { ...req.body };

  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(payload)) {
    if (["name", "phone", "birthday", "email", "address"].includes(key)) {
      fields.push(`${key} = $${idx++}`);
      values.push(value === "" ? null : value);
    }
  }

  if (!fields.length) {
    return res.status(400).json({ error: "No valid fields" });
  }

  values.push(restaurantId, id);

  try {
    const result = await pool.query(
      `
        UPDATE customers
        SET ${fields.join(", ")}
        WHERE restaurant_id = $${idx++} AND id = $${idx}
        RETURNING id
      `,
      values
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const customer = await getCustomerById(restaurantId, result.rows[0].id);
    res.json(customer);
  } catch (err) {
    console.error("❌ Public customer update failed:", err);
    res.status(500).json({ error: "Failed to update customer" });
  }
});

router.get(
  "/customer-auth/oauth/:provider/start",
  requirePublicRestaurant,
  async (req, res) => {
    const provider = normalizeOAuthProvider(req.params.provider);
    const identifier = normalizeText(
      req.query.identifier || req.body?.identifier || req.params.identifier
    );
    const returnTo = sanitizeOAuthReturnToUrl(
      req.query.return_to || req.get?.("referer"),
      identifier
    );

    if (!provider) {
      return res.redirect(
        302,
        buildOAuthErrorRedirectUrl(returnTo, { error: "unsupported_provider" })
      );
    }

    try {
      const state = signQrCustomerOAuthState({
        provider,
        restaurantId: req.restaurantId,
        identifier,
        returnTo,
      });

      if (provider === "google") {
        const config = resolveGoogleOAuthConfig();
        if (!config) {
          return res.redirect(
            302,
            buildOAuthErrorRedirectUrl(returnTo, {
              provider,
              error: "google_not_configured",
            })
          );
        }

        const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authUrl.searchParams.set("client_id", config.clientId);
        authUrl.searchParams.set("redirect_uri", config.redirectUri);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", "openid email profile");
        authUrl.searchParams.set("state", state);
        authUrl.searchParams.set("prompt", "select_account");
        return res.redirect(302, authUrl.toString());
      }

      if (provider === "apple") {
        const config = resolveAppleOAuthConfig();
        if (!config) {
          return res.redirect(
            302,
            buildOAuthErrorRedirectUrl(returnTo, {
              provider,
              error: "apple_not_configured",
            })
          );
        }

        const authUrl = new URL("https://appleid.apple.com/auth/authorize");
        authUrl.searchParams.set("client_id", config.clientId);
        authUrl.searchParams.set("redirect_uri", config.redirectUri);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("response_mode", "query");
        authUrl.searchParams.set("scope", "name email");
        authUrl.searchParams.set("state", state);
        authUrl.searchParams.set(
          "nonce",
          crypto.randomBytes(12).toString("hex")
        );
        return res.redirect(302, authUrl.toString());
      }

      return res.redirect(
        302,
        buildOAuthErrorRedirectUrl(returnTo, { error: "unsupported_provider" })
      );
    } catch (err) {
      console.error("❌ QR customer OAuth start failed:", err);
      return res.redirect(
        302,
        buildOAuthErrorRedirectUrl(returnTo, {
          provider: provider || null,
          error: "oauth_start_failed",
        })
      );
    }
  }
);

router.get("/customer-auth/oauth/:provider/callback", async (req, res) => {
  const provider = normalizeOAuthProvider(req.params.provider);
  const statePayload = verifyQrCustomerOAuthState(req.query.state);
  const stateProvider = normalizeOAuthProvider(statePayload?.provider);
  const stateIdentifier = normalizeText(statePayload?.identifier);
  const restaurantId = Number(statePayload?.restaurantId || 0);
  const returnTo = sanitizeOAuthReturnToUrl(
    statePayload?.returnTo,
    stateIdentifier
  );

  if (!provider || !statePayload || provider !== stateProvider || !restaurantId) {
    return res.redirect(
      302,
      buildOAuthErrorRedirectUrl(returnTo, {
        provider: provider || null,
        error: "invalid_oauth_state",
      })
    );
  }

  const oauthError = normalizeText(req.query.error);
  if (oauthError) {
    return res.redirect(
      302,
      buildOAuthErrorRedirectUrl(returnTo, {
        provider,
        error: oauthError,
      })
    );
  }

  const authorizationCode = normalizeText(req.query.code);
  if (!authorizationCode) {
    return res.redirect(
      302,
      buildOAuthErrorRedirectUrl(returnTo, {
        provider,
        error: "missing_oauth_code",
      })
    );
  }

  try {
    await ensureQrCustomerAuthSchema();
    await ensureQrCustomerOauthSchema();

    const profile =
      provider === "google"
        ? await exchangeGoogleCodeForProfile(authorizationCode)
        : await exchangeAppleCodeForProfile(authorizationCode);

    const profileProviderUserId = normalizeText(profile?.providerUserId);
    if (!profileProviderUserId) {
      throw new Error("OAuth provider user id is missing");
    }

    const client = await pool.connect();
    let customerId = null;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
        restaurantId,
        `${provider}:${profileProviderUserId}`,
      ]);

      customerId = await resolveOrCreateQrCustomerForOauth(
        {
          restaurantId,
          provider,
          providerUserId: profileProviderUserId,
          email: profile?.email || null,
          name: profile?.name || null,
          rawProfile: profile?.rawProfile || null,
        },
        client
      );

      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("❌ QR customer OAuth rollback failed:", rollbackErr);
      }
      throw err;
    } finally {
      client.release();
    }

    const customer = await getQrCustomerProfileById(restaurantId, customerId);
    if (!customer?.id) {
      throw new Error("OAuth customer account could not be resolved");
    }

    const token = signQrCustomerToken({
      customerId,
      restaurantId,
      phone: normalizePhone(customer.phone) || "",
    });

    return res.redirect(
      302,
      buildOAuthSuccessRedirectUrl(returnTo, {
        provider,
        token,
      })
    );
  } catch (err) {
    console.error("❌ QR customer OAuth callback failed:", err);
    return res.redirect(
      302,
      buildOAuthErrorRedirectUrl(returnTo, {
        provider,
        error: "oauth_callback_failed",
      })
    );
  }
});

router.post("/customer-auth/register", requirePublicRestaurant, async (req, res) => {
  const restaurantId = req.restaurantId;
  try {
    await ensureMarketplaceCustomerSchema();

    const language =
      normalizeLanguage(req.body?.language) ||
      normalizeLanguage(req.get?.("accept-language")) ||
      null;
    const marketplaceCustomer = await registerMarketplaceCustomer({
      address: req.body?.address,
      email: req.body?.email,
      language,
      name: req.body?.name || req.body?.username,
      password: req.body?.password,
      phone: req.body?.phone,
    });

    const customerId = await ensureRestaurantCustomerForMarketplace({
      restaurantId,
      marketplaceCustomer,
    });
    const customer = await getRestaurantCustomerProfile(restaurantId, customerId);
    const token = signMarketplaceCustomerToken({
      customerId: marketplaceCustomer.id,
      email: marketplaceCustomer.email,
      phone: marketplaceCustomer.phone,
    });

    return res.status(201).json({
      token,
      customer,
      marketplace_user: marketplaceCustomer,
    });
  } catch (err) {
    const statusCode = Number(err?.statusCode || 0);
    if (statusCode >= 400 && statusCode < 500) {
      return res.status(statusCode).json({
        error: String(err?.message || "Failed to register customer account"),
      });
    }
    console.error("❌ QR customer register failed:", err);
    return res.status(500).json({ error: "Failed to register customer account" });
  }
});

router.post("/customer-auth/login", requirePublicRestaurant, async (req, res) => {
  const restaurantId = req.restaurantId;
  try {
    await ensureMarketplaceCustomerSchema();
    const marketplaceCustomer = await loginMarketplaceCustomer({
      email: req.body?.email,
      login: req.body?.login || req.body?.phone || req.body?.email,
      password: req.body?.password,
      phone: req.body?.phone,
    });

    const customerId = await ensureRestaurantCustomerForMarketplace({
      restaurantId,
      marketplaceCustomer,
    });
    const customer = await getRestaurantCustomerProfile(restaurantId, customerId);
    const token = signMarketplaceCustomerToken({
      customerId: marketplaceCustomer.id,
      email: marketplaceCustomer.email,
      phone: marketplaceCustomer.phone,
    });

    return res.json({
      token,
      customer,
      marketplace_user: marketplaceCustomer,
    });
  } catch (err) {
    const statusCode = Number(err?.statusCode || 0);
    if (statusCode >= 400 && statusCode < 500) {
      return res.status(statusCode).json({
        error: String(err?.message || "Failed to log in"),
      });
    }
    console.error("❌ QR customer login failed:", err);
    return res.status(500).json({ error: "Failed to log in" });
  }
});

router.get(
  "/customer-auth/me",
  requirePublicRestaurant,
  requireQrCustomerSession,
  async (req, res) => {
    return res.json({
      customer: req.qrCustomer,
      marketplace_user: req.marketplaceCustomer || null,
    });
  }
);

router.patch(
  "/customer-auth/me",
  requirePublicRestaurant,
  requireQrCustomerSession,
  async (req, res) => {
    const restaurantId = req.restaurantId;
    const currentCustomer = req.qrCustomer;
    const nextName = normalizeText(req.body?.name || req.body?.username || currentCustomer?.name);
    const nextPhone = normalizePhone(req.body?.phone || currentCustomer?.phone);
    const nextEmail =
      req.body?.email === undefined
        ? normalizeEmail(currentCustomer?.email) || null
        : normalizeEmail(req.body?.email) || null;
    const nextAddress =
      req.body?.address === undefined
        ? normalizeText(currentCustomer?.address) || null
        : normalizeText(req.body?.address) || null;
    const nextLanguage =
      req.body?.language === undefined
        ? normalizeLanguage(currentCustomer?.language)
        : normalizeLanguage(req.body?.language);

    if (!currentCustomer?.id) {
      return res.status(401).json({ error: "Customer session required" });
    }

    if (!nextName || !nextPhone) {
      return res.status(400).json({ error: "Name and phone are required" });
    }

    if (req.marketplaceCustomer?.id) {
      await ensureMarketplaceCustomerSchema();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const updatedMarketplaceCustomer = await updateMarketplaceCustomerProfile(
          req.marketplaceCustomer.id,
          {
            address: nextAddress,
            email: nextEmail,
            language: nextLanguage,
            name: nextName,
            phone: nextPhone,
          },
          client
        );

        const localCustomerId = await ensureRestaurantCustomerForMarketplace(
          {
            restaurantId,
            marketplaceCustomer: updatedMarketplaceCustomer,
          },
          client
        );

        await client.query("COMMIT");
        const customer = await getRestaurantCustomerProfile(
          restaurantId,
          localCustomerId
        );

        return res.json({
          customer,
          marketplace_user: updatedMarketplaceCustomer,
        });
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          console.error(
            "❌ Marketplace customer profile rollback failed:",
            rollbackErr
          );
        }
        const statusCode = Number(err?.statusCode || 0);
        if (statusCode >= 400 && statusCode < 500) {
          return res.status(statusCode).json({
            error: String(err?.message || "Failed to update customer profile"),
          });
        }
        console.error("❌ Marketplace customer profile update failed:", err);
        return res.status(500).json({ error: "Failed to update customer profile" });
      } finally {
        client.release();
      }
    }

    await ensureQrCustomerAuthSchema();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
        restaurantId,
        nextPhone,
      ]);

      const conflictingAuth = await client.query(
        `
          SELECT customer_id
          FROM qr_customer_auth
          WHERE restaurant_id = $1 AND phone = $2 AND customer_id <> $3
          LIMIT 1
        `,
        [restaurantId, nextPhone, currentCustomer.id]
      );
      if (conflictingAuth.rows.length) {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ error: "Another account already uses this phone number." });
      }

      const conflictingCustomer = await findCustomerByPhoneIdentity(restaurantId, nextPhone, client);
      if (conflictingCustomer?.id && Number(conflictingCustomer.id) !== Number(currentCustomer.id)) {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ error: "Another customer already uses this phone number." });
      }

      await client.query(
        `
          UPDATE customers
          SET name = $1,
              phone = $2,
              email = $3,
              address = $4
          WHERE restaurant_id = $5 AND id = $6
        `,
        [nextName, nextPhone, nextEmail, nextAddress, restaurantId, currentCustomer.id]
      );

      await client.query(
        `
          UPDATE qr_customer_auth
          SET phone = $1,
              language = $2,
              updated_at = NOW()
          WHERE restaurant_id = $3 AND customer_id = $4
        `,
        [nextPhone, nextLanguage, restaurantId, currentCustomer.id]
      );

      await client.query("COMMIT");

      const customer = await getQrCustomerProfileById(restaurantId, currentCustomer.id);
      return res.json({ customer });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("❌ QR customer profile rollback failed:", rollbackErr);
      }
      console.error("❌ QR customer profile update failed:", err);
      return res.status(500).json({ error: "Failed to update customer profile" });
    } finally {
      client.release();
    }
  }
);

router.post(
  "/customer-addresses/customers/:customerId/addresses",
  requirePublicRestaurant,
  async (req, res) => {
    const restaurantId = req.restaurantId;
    const { customerId } = req.params;
    const { label, address, is_default } = req.body || {};

    if (!String(address || "").trim()) {
      return res.status(400).json({ error: "Address required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      if (is_default) {
        await client.query(
          `
            UPDATE customer_addresses
            SET is_default = FALSE
            WHERE restaurant_id = $1 AND customer_id = $2
          `,
          [restaurantId, customerId]
        );
      }

      const { rows: existingRows } = await client.query(
        `
          SELECT id
          FROM customer_addresses
          WHERE restaurant_id = $1 AND customer_id = $2 AND address = $3
          LIMIT 1
        `,
        [restaurantId, customerId, String(address).trim()]
      );

      let addressId = existingRows[0]?.id || null;
      if (addressId) {
        await client.query(
          `
            UPDATE customer_addresses
            SET label = COALESCE($1, label),
                is_default = COALESCE($2, is_default)
            WHERE restaurant_id = $3 AND id = $4
          `,
          [label || null, is_default ?? null, restaurantId, addressId]
        );
      } else {
        const insert = await client.query(
          `
            INSERT INTO customer_addresses
              (restaurant_id, customer_id, label, address, is_default)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
          `,
          [restaurantId, customerId, label || "Default", String(address).trim(), !!is_default]
        );
        addressId = insert.rows[0].id;
      }

      if (is_default) {
        await client.query(
          `
            UPDATE customers
            SET address = $1
            WHERE restaurant_id = $2 AND id = $3
          `,
          [String(address).trim(), restaurantId, customerId]
        );
      }

      await client.query("COMMIT");

      const { rows } = await pool.query(
        `
          SELECT id, label, address, is_default
          FROM customer_addresses
          WHERE restaurant_id = $1 AND id = $2
          LIMIT 1
        `,
        [restaurantId, addressId]
      );

      res.json(rows[0] || null);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("❌ Public customer address create failed:", err);
      res.status(500).json({ error: "Failed to save address" });
    } finally {
      client.release();
    }
  }
);

router.patch(
  "/customer-addresses/customer-addresses/:addressId",
  requirePublicRestaurant,
  async (req, res) => {
    const restaurantId = req.restaurantId;
    const { addressId } = req.params;
    const { label, address, is_default } = req.body || {};

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `
          SELECT customer_id
          FROM customer_addresses
          WHERE restaurant_id = $1 AND id = $2
          LIMIT 1
        `,
        [restaurantId, addressId]
      );

      if (!rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Address not found" });
      }

      if (is_default === true) {
        await client.query(
          `
            UPDATE customer_addresses
            SET is_default = FALSE
            WHERE restaurant_id = $1 AND customer_id = $2
          `,
          [restaurantId, rows[0].customer_id]
        );
      }

      const result = await client.query(
        `
          UPDATE customer_addresses
          SET label = COALESCE($1, label),
              address = COALESCE($2, address),
              is_default = COALESCE($3, is_default)
          WHERE restaurant_id = $4 AND id = $5
          RETURNING id, label, address, is_default
        `,
        [label ?? null, address ?? null, is_default ?? null, restaurantId, addressId]
      );

      if (is_default === true && result.rows[0]?.address) {
        await client.query(
          `
            UPDATE customers
            SET address = $1
            WHERE restaurant_id = $2 AND id = $3
          `,
          [result.rows[0].address, restaurantId, rows[0].customer_id]
        );
      }

      await client.query("COMMIT");
      res.json(result.rows[0] || null);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("❌ Public customer address update failed:", err);
      res.status(500).json({ error: "Failed to update address" });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
