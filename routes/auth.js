// routes/auth.js
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const {
  MARKETPLACE_CUSTOMER_SCOPE,
  ensureMarketplaceCustomerSchema,
  getMarketplaceCustomerById,
  loginMarketplaceCustomer,
  registerMarketplaceCustomer,
  signMarketplaceCustomerToken,
  verifyCustomerAuthToken,
} = require("../utils/marketplaceCustomerAuth");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function shouldUseMarketplaceCustomerScope(payload = {}) {
  const normalizedScope = String(
    payload.scope || payload.auth_scope || payload.audience || payload.authSource || ""
  )
    .trim()
    .toLowerCase();

  return (
    normalizedScope === MARKETPLACE_CUSTOMER_SCOPE ||
    payload.marketplace === true ||
    payload.customer_auth === true
  );
}

function mapMarketplaceAuthError(error, fallbackMessage) {
  const statusCode = Number(error?.statusCode || 0);
  if (statusCode >= 400 && statusCode < 500) {
    return {
      statusCode,
      error: String(error?.message || fallbackMessage),
    };
  }
  return {
    statusCode: 500,
    error: fallbackMessage,
  };
}

const POS_GOOGLE_OAUTH_STATE_TTL = "15m";
const POS_GOOGLE_TRANSFER_TOKEN_TTL = "2m";
const POS_GOOGLE_ALLOWED_RETURN_HOSTS = (
  process.env.POS_GOOGLE_OAUTH_ALLOWED_RETURN_HOSTS ||
  "localhost,127.0.0.1,beypro.com,www.beypro.com,app.beypro.com"
)
  .split(",")
  .map((host) => String(host || "").trim().toLowerCase())
  .filter(Boolean);

function normalizeText(value) {
  return String(value || "").trim();
}

function decodeJwtPayload(token) {
  const rawToken = normalizeText(token);
  if (!rawToken) return null;
  const parts = rawToken.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function getJwtSecret() {
  return process.env.JWT_SECRET || "beypro_secret_2025";
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getRequestOrigin(req) {
  const forwardedProto = normalizeText(req.get("x-forwarded-proto")).split(",")[0]?.trim();
  const forwardedHost = normalizeText(req.get("x-forwarded-host")).split(",")[0]?.trim();
  const host = forwardedHost || normalizeText(req.get("host"));
  let protocol = forwardedProto || normalizeText(req.protocol) || "https";

  if (protocol !== "http" && protocol !== "https") {
    protocol =
      host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https";
  }

  if (!host) {
    return protocol === "http"
      ? "http://localhost:5000"
      : "https://beypro.com";
  }
  return `${protocol}://${host}`;
}

function resolvePosGoogleOAuthConfig(req) {
  const clientId = normalizeText(
    process.env.GOOGLE_POS_OAUTH_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID
  );
  const clientSecret = normalizeText(
    process.env.GOOGLE_POS_OAUTH_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );

  const requestOrigin = getRequestOrigin(req);
  let requestHost = "";
  try {
    requestHost = new URL(requestOrigin).hostname || "";
  } catch {
    requestHost = "";
  }
  const isLocalRequestHost =
    requestHost === "localhost" || requestHost === "127.0.0.1";
  const defaultRedirectUri = isLocalRequestHost
    ? "http://localhost:5000/api/auth/google/callback"
    : "https://beypro.com/api/auth/google/callback";

  const envRedirectUri = normalizeText(
    process.env.GOOGLE_POS_OAUTH_REDIRECT_URI || process.env.GOOGLE_OAUTH_REDIRECT_URI
  );
  let redirectUri = envRedirectUri || defaultRedirectUri;

  try {
    const parsed = new URL(redirectUri);
    const callbackPath = "/api/auth/google/callback";
    if (parsed.pathname !== callbackPath) {
      redirectUri = defaultRedirectUri;
    }
  } catch {
    redirectUri = defaultRedirectUri;
  }

  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }
  return { clientId, clientSecret, redirectUri };
}

function isAllowedReturnHost(hostname) {
  const normalizedHost = String(hostname || "").trim().toLowerCase();
  if (!normalizedHost) return false;
  return POS_GOOGLE_ALLOWED_RETURN_HOSTS.some(
    (allowedHost) =>
      normalizedHost === allowedHost || normalizedHost.endsWith(`.${allowedHost}`)
  );
}

function buildDefaultPosReturnTo(req) {
  const configuredDefault = normalizeText(process.env.POS_GOOGLE_OAUTH_DEFAULT_RETURN_URL);
  if (configuredDefault) {
    try {
      const parsed = new URL(configuredDefault);
      if (
        ["http:", "https:"].includes(parsed.protocol) &&
        isAllowedReturnHost(parsed.hostname) &&
        (parsed.protocol !== "http:" ||
          parsed.hostname === "localhost" ||
          parsed.hostname === "127.0.0.1")
      ) {
        return parsed.toString();
      }
    } catch {
      // ignore invalid override and fall back to automatic defaults
    }
  }

  const origin = getRequestOrigin(req);
  try {
    const host = new URL(origin).hostname || "";
    if (host === "localhost" || host === "127.0.0.1") {
      return "http://localhost:5173/login";
    }
  } catch {
    // fall back to production login host
  }
  return "https://beypro.com/login";
}

function sanitizePosReturnToUrl(rawValue, req) {
  const fallback = buildDefaultPosReturnTo(req);
  const candidate = normalizeText(rawValue);
  if (!candidate) return fallback;

  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) return fallback;
    if (!isAllowedReturnHost(parsed.hostname)) return fallback;
    if (
      parsed.protocol === "http:" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1"
    ) {
      return fallback;
    }
    return parsed.toString();
  } catch {
    return fallback;
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

function signPosGoogleOAuthState(payload) {
  return jwt.sign(
    {
      purpose: "pos_google_oauth",
      ...payload,
    },
    getJwtSecret(),
    { expiresIn: POS_GOOGLE_OAUTH_STATE_TTL }
  );
}

function verifyPosGoogleOAuthState(token) {
  const rawToken = normalizeText(token);
  if (!rawToken) return null;
  try {
    const decoded = jwt.verify(rawToken, getJwtSecret());
    if (decoded?.purpose !== "pos_google_oauth") return null;
    return decoded;
  } catch {
    return null;
  }
}

function signPosGoogleTransferToken(payload) {
  return jwt.sign(
    {
      purpose: "pos_google_oauth_transfer",
      ...payload,
    },
    getJwtSecret(),
    { expiresIn: POS_GOOGLE_TRANSFER_TOKEN_TTL }
  );
}

function verifyPosGoogleTransferToken(token) {
  const rawToken = normalizeText(token);
  if (!rawToken) return null;
  try {
    const decoded = jwt.verify(rawToken, getJwtSecret());
    if (decoded?.purpose !== "pos_google_oauth_transfer") return null;
    return decoded;
  } catch {
    return null;
  }
}

function resolvePosGoogleAllowedClientIds() {
  const explicitList = String(process.env.GOOGLE_POS_OAUTH_ALLOWED_CLIENT_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const fallbackSingle = normalizeText(
    process.env.GOOGLE_POS_OAUTH_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID
  );
  if (fallbackSingle && !explicitList.includes(fallbackSingle)) {
    explicitList.push(fallbackSingle);
  }
  return explicitList;
}

async function verifyGoogleIdToken(idToken) {
  const rawToken = normalizeText(idToken);
  if (!rawToken) {
    throw createHttpError(400, "Google credential is required.");
  }

  const allowedClientIds = resolvePosGoogleAllowedClientIds();
  if (!allowedClientIds.length) {
    throw createHttpError(503, "Google login is not configured.");
  }

  const endpoint = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(rawToken)}`;
  const response = await fetch(endpoint);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createHttpError(401, "Google credential is invalid or expired.");
  }

  const audience = normalizeText(payload.aud);
  if (!allowedClientIds.includes(audience)) {
    throw createHttpError(401, "Google credential audience mismatch.");
  }

  const issuer = normalizeText(payload.iss);
  if (issuer !== "accounts.google.com" && issuer !== "https://accounts.google.com") {
    throw createHttpError(401, "Google credential issuer mismatch.");
  }

  const email = normalizeEmail(payload.email);
  if (!email) {
    throw createHttpError(401, "Google account email is missing.");
  }
  if (String(payload.email_verified || "").toLowerCase() !== "true") {
    throw createHttpError(401, "Google account email is not verified.");
  }

  const expUnix = Number(payload.exp || 0);
  if (!Number.isFinite(expUnix) || expUnix * 1000 <= Date.now()) {
    throw createHttpError(401, "Google credential has expired.");
  }

  return {
    email,
    name: normalizeText(payload.name),
    picture: normalizeText(payload.picture),
    sub: normalizeText(payload.sub),
  };
}

async function exchangeGoogleAuthorizationCodeForIdentity(code, config) {
  const authorizationCode = normalizeText(code);
  if (!authorizationCode) {
    throw createHttpError(400, "Missing Google authorization code.");
  }
  if (!config?.clientId || !config?.clientSecret || !config?.redirectUri) {
    throw createHttpError(503, "Google login is not configured.");
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: authorizationCode,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    }),
  });
  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok) {
    throw createHttpError(
      401,
      tokenPayload?.error_description || tokenPayload?.error || "Google code exchange failed."
    );
  }

  const idToken = normalizeText(tokenPayload?.id_token);
  if (!idToken) {
    throw createHttpError(401, "Google identity token is missing.");
  }

  return verifyGoogleIdToken(idToken);
}

async function findPosUserByEmail(normalizedEmail) {
  let user = null;
  let source = null;

  if (process.env.NODE_ENV !== "production") {
    console.log("🛠️ Querying users table…");
  }
  const userRes = await pool.query(
    `SELECT id, full_name, email, password_hash, role, restaurant_id
     FROM users
     WHERE LOWER(TRIM(email)) = $1`,
    [normalizedEmail]
  );

  if (userRes.rows.length > 0) {
    user = userRes.rows[0];
    source = "users";
    if (process.env.NODE_ENV !== "production") {
      console.log("✅ Found user in users table:", user.email);
    }
  }

  if (!user) {
    if (process.env.NODE_ENV !== "production") {
      console.log("🛠️ Querying staff table…");
    }
    const staffRes = await pool.query(
      `SELECT id, name, email, pin, restaurant_id, role
       FROM staff WHERE LOWER(TRIM(email)) = $1 LIMIT 1`,
      [normalizedEmail]
    );

    if (staffRes.rows.length > 0) {
      user = staffRes.rows[0];
      source = "staff";
      if (process.env.NODE_ENV !== "production") {
        console.log("✅ Found user in staff table:", user.email);
      }
    }
  }

  return { user, source };
}

async function resolvePosPermissionsForUser(user) {
  let permissions = [];
  const roleKey = user.role?.toLowerCase();
  if (process.env.NODE_ENV !== "production") {
    console.log("🔍 Looking for role permissions for roleKey:", roleKey);
  }

  let mergedRoles = {};
  let overridePermissions = null;
  let hasModernConfig = false;

  try {
    const modernResult = await pool.query(
      `SELECT settings
       FROM user_settings
       WHERE restaurant_id = $1 AND section = 'users'
       LIMIT 1`,
      [user.restaurant_id]
    );

    if (modernResult.rows.length > 0) {
      const modernSettings = modernResult.rows[0].settings || {};
      const modernKeys = Object.keys(modernSettings || {});
      if (process.env.NODE_ENV !== "production") {
        console.log("🆕 user_settings payload keys:", modernKeys);
      }

      if (
        modernSettings.roles &&
        typeof modernSettings.roles === "object" &&
        Object.keys(modernSettings.roles).length > 0
      ) {
        hasModernConfig = true;
        const normalizedModernRoles = Object.entries(modernSettings.roles).reduce(
          (acc, [key, value]) => {
            if (Array.isArray(value)) {
              acc[key.toLowerCase()] = value.map((perm) => String(perm).toLowerCase());
            }
            return acc;
          },
          {}
        );

        mergedRoles = { ...mergedRoles, ...normalizedModernRoles };
        if (process.env.NODE_ENV !== "production") {
          console.log(
            "🆕 Loaded role definitions from user_settings:",
            Object.keys(normalizedModernRoles)
          );
        }
      }

      const overrideContainers = [
        modernSettings.users,
        modernSettings.overrides,
        modernSettings.individual,
        modernSettings.staff,
      ].filter(Boolean)[0];

      if (overrideContainers && typeof overrideContainers === "object") {
        const normalizedOverrides = Object.entries(overrideContainers).reduce(
          (acc, [key, value]) => {
            const lowerKey = String(key).toLowerCase();
            let perms = [];

            if (Array.isArray(value)) {
              perms = value;
            } else if (value && Array.isArray(value.permissions)) {
              perms = value.permissions;
            }

            if (perms.length > 0) {
              acc[lowerKey] = perms.map((perm) => String(perm).toLowerCase());
            }

            return acc;
          },
          {}
        );

        const userIdKey = user.id != null ? String(user.id) : null;
        const emailKey = user.email ? user.email.toLowerCase() : null;
        const overrideSource =
          (userIdKey && normalizedOverrides[userIdKey]) ||
          (emailKey && normalizedOverrides[emailKey]) ||
          null;

        if (overrideSource && Array.isArray(overrideSource) && overrideSource.length > 0) {
          overridePermissions = overrideSource;
          if (process.env.NODE_ENV !== "production") {
            console.log(
              "✅ Applying individual permission override from user_settings:",
              overridePermissions
            );
          }
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Error loading permissions from user_settings:", err);
  }

  if (!hasModernConfig) {
    try {
      const legacyResult = await pool.query(
        `SELECT key, value, users
         FROM settings
         WHERE restaurant_id = $1
           AND key IN ('users', 'global')`,
        [user.restaurant_id]
      );

      if (process.env.NODE_ENV !== "production") {
        console.log("📊 Legacy settings rows:", legacyResult.rows.length, "rows");
      }
      legacyResult.rows.forEach((row) => {
        if (process.env.NODE_ENV !== "production") {
          console.log(
            `  - legacy key: ${row.key}, has value: ${!!row.value}, has users: ${!!row.users}`
          );
        }
      });

      let valueConfig = {};
      let usersConfig = {};
      for (const row of legacyResult.rows) {
        if (row.key === "users" && row.value) valueConfig = row.value;
        if (row.key === "global" && row.users) usersConfig = row.users;
      }

      const legacyMerged = {
        roles: {
          ...(usersConfig.roles || {}),
          ...(valueConfig.roles || {}),
        },
      };

      const normalizedLegacyRoles = Object.entries(legacyMerged.roles || {}).reduce(
        (acc, [key, value]) => {
          if (Array.isArray(value)) {
            acc[key.toLowerCase()] = value.map((perm) => String(perm).toLowerCase());
          }
          return acc;
        },
        {}
      );

      mergedRoles = { ...normalizedLegacyRoles, ...mergedRoles };
      if (process.env.NODE_ENV !== "production") {
        console.log("🔎 Using legacy settings (no modern config found):", Object.keys(mergedRoles));
      }
    } catch (err) {
      console.error("⚠️ Error loading permissions from legacy settings:", err);
    }
  } else if (process.env.NODE_ENV !== "production") {
    console.log("✅ Modern config exists - skipping legacy settings. Roles:", Object.keys(mergedRoles));
  }

  const availableRoles = Object.keys(mergedRoles || {});
  let resolvedPermissions = [];

  if (overridePermissions && overridePermissions.length > 0) {
    resolvedPermissions = overridePermissions;
    if (process.env.NODE_ENV !== "production") {
      console.log("✅ Using individual override permissions:", resolvedPermissions);
    }
  } else if (roleKey && mergedRoles?.[roleKey]) {
    resolvedPermissions = mergedRoles[roleKey];
    if (process.env.NODE_ENV !== "production") {
      console.log(`✅ Found role permissions for '${roleKey}':`, resolvedPermissions);
    }
  } else if (mergedRoles?.boss) {
    resolvedPermissions = mergedRoles.boss;
    if (process.env.NODE_ENV !== "production") {
      console.log(`✅ Role '${roleKey}' not found, using boss role:`, resolvedPermissions);
    }
  } else if (roleKey === "boss" && mergedRoles?.admin) {
    resolvedPermissions = mergedRoles.admin;
    if (process.env.NODE_ENV !== "production") {
      console.log("✅ Boss role maps to admin:", resolvedPermissions);
    }
  } else {
    console.warn(
      `⚠️ No permissions found for role '${roleKey}', available roles:`,
      availableRoles
    );
  }

  permissions = Array.from(
    new Set(
      (resolvedPermissions || []).map((perm) =>
        String(perm).toLowerCase().replace(/-/g, ".")
      )
    )
  );
  if (process.env.NODE_ENV !== "production") {
    console.log(`✅ Final permissions for ${roleKey}:`, permissions);
  }
  return permissions;
}

function signPosToken(user, source) {
  return jwt.sign(
    {
      id: user.id,
      name: user.name || user.full_name,
      role: user.role || "staff",
      restaurant_id: user.restaurant_id,
      auth_source: source,
    },
    getJwtSecret(),
    { expiresIn: "7d" }
  );
}

async function buildPosLoginResponse(user, source, loginMethod = "password") {
  const token = signPosToken(user, source);
  const permissions = await resolvePosPermissionsForUser(user);

  return {
    success: true,
    message: "Login successful",
    source,
    login_method: loginMethod,
    user: {
      id: user.id,
      name: user.name || user.full_name,
      email: user.email,
      role: user.role,
      restaurant_id: user.restaurant_id,
      auth_source: source,
      permissions,
    },
    token,
  };
}

router.post("/login", async (req, res) => {
  if (shouldUseMarketplaceCustomerScope(req.body || {})) {
    try {
      await ensureMarketplaceCustomerSchema();
      const customer = await loginMarketplaceCustomer({
        email: req.body?.email,
        login: req.body?.login || req.body?.phone || req.body?.email,
        password: req.body?.password,
        phone: req.body?.phone,
      });
      const token = signMarketplaceCustomerToken({
        customerId: customer.id,
        email: customer.email,
        phone: customer.phone,
      });

      return res.json({
        success: true,
        scope: MARKETPLACE_CUSTOMER_SCOPE,
        token,
        customer,
      });
    } catch (error) {
      const mapped = mapMarketplaceAuthError(error, "Failed to log in");
      return res.status(mapped.statusCode).json({
        success: false,
        scope: MARKETPLACE_CUSTOMER_SCOPE,
        error: mapped.error,
      });
    }
  }

  const { email, password } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (process.env.NODE_ENV !== "production") {
    console.log("🔑 Login Debug");
    console.log("➡️ Incoming email:", email);
    console.log("➡️ Normalized email:", normalizedEmail);
    console.log("➡️ DB URL exists?", !!process.env.DATABASE_URL);
    console.log("➡️ JWT_SECRET exists?", !!process.env.JWT_SECRET);
  }

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: "Email and password required",
    });
  }

  try {
    const { user, source } = await findPosUserByEmail(normalizedEmail);
    if (!user) {
      console.warn("❌ No user found for email:", normalizedEmail);
      return res.status(401).json({
        success: false,
        error: "User not found or invalid credentials",
      });
    }

    let passwordMatch = false;
    try {
      passwordMatch =
        source === "staff"
          ? normalizeText(user.pin) === normalizeText(password)
          : await bcrypt.compare(password, user.password_hash);
    } catch {
      passwordMatch = false;
    }

    if (!passwordMatch) {
      console.warn("❌ Invalid password for:", email);
      return res.status(401).json({
        success: false,
        error: "Invalid password",
      });
    }

    if (process.env.NODE_ENV !== "production") {
      console.log(`✅ ${source} login success:`, user.email);
    }

    const payload = await buildPosLoginResponse(user, source, "password");
    return res.json(payload);
  } catch (err) {
    console.error("❌ Login error:", err.message, err.stack);
    return res.status(500).json({
      success: false,
      error: "Internal server error during login",
    });
  }
});

router.get("/google", async (req, res) => {
  const returnTo = sanitizePosReturnToUrl(
    req.query?.return_to || req.query?.returnTo,
    req
  );
  try {
    const config = resolvePosGoogleOAuthConfig(req);
    if (!config) {
      return res.redirect(
        302,
        appendQueryParamsToUrl(returnTo, {
          google_oauth_error: "google_not_configured",
          google_oauth: null,
          transfer_token: null,
        })
      );
    }

    const state = signPosGoogleOAuthState({
      returnTo,
      clientId: config.clientId,
    });

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", config.clientId);
    authUrl.searchParams.set("redirect_uri", config.redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid email profile");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("prompt", "select_account");
    return res.redirect(302, authUrl.toString());
  } catch (error) {
    console.error("❌ POS Google OAuth start failed:", error);
    return res.redirect(
      302,
      appendQueryParamsToUrl(returnTo, {
        google_oauth_error: "oauth_start_failed",
        google_oauth: null,
        transfer_token: null,
      })
    );
  }
});

router.get("/google/callback", async (req, res) => {
  const unverifiedStatePayload = decodeJwtPayload(req.query?.state);
  const statePayload = verifyPosGoogleOAuthState(req.query?.state);
  const returnTo = sanitizePosReturnToUrl(
    statePayload?.returnTo ||
      unverifiedStatePayload?.returnTo ||
      req.query?.return_to ||
      req.query?.returnTo,
    req
  );

  const redirectWithError = (errorCode) =>
    res.redirect(
      302,
      appendQueryParamsToUrl(returnTo, {
        google_oauth_error: errorCode || "oauth_callback_failed",
        google_oauth: null,
        transfer_token: null,
      })
    );

  if (!statePayload) {
    return redirectWithError("invalid_oauth_state");
  }

  const oauthError = normalizeText(req.query?.error);
  if (oauthError) {
    return redirectWithError(oauthError);
  }

  const authorizationCode = normalizeText(req.query?.code);
  if (!authorizationCode) {
    return redirectWithError("missing_oauth_code");
  }

  try {
    const config = resolvePosGoogleOAuthConfig(req);
    if (!config) {
      return redirectWithError("google_not_configured");
    }
    if (statePayload?.clientId && statePayload.clientId !== config.clientId) {
      return redirectWithError("invalid_oauth_state");
    }

    const googleIdentity = await exchangeGoogleAuthorizationCodeForIdentity(
      authorizationCode,
      config
    );
    const { user, source } = await findPosUserByEmail(googleIdentity.email);
    if (!user) {
      return redirectWithError("user_not_linked");
    }

    const transferToken = signPosGoogleTransferToken({
      user_id: user.id,
      email: googleIdentity.email,
      source,
    });

    return res.redirect(
      302,
      appendQueryParamsToUrl(returnTo, {
        google_oauth: "1",
        transfer_token: transferToken,
        google_oauth_error: null,
      })
    );
  } catch (error) {
    console.error("❌ POS Google OAuth callback failed:", error);
    return redirectWithError("oauth_callback_failed");
  }
});

router.post("/google/complete", async (req, res) => {
  try {
    const transferToken = normalizeText(
      req.body?.transfer_token || req.body?.token || ""
    );
    const transferPayload = verifyPosGoogleTransferToken(transferToken);
    if (!transferPayload?.email) {
      return res.status(401).json({
        success: false,
        error: "Google authorization token is invalid or expired.",
      });
    }

    const normalizedEmail = normalizeEmail(transferPayload.email);
    const { user, source } = await findPosUserByEmail(normalizedEmail);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: "This Google account is not linked to a POS user.",
      });
    }
    if (
      transferPayload.user_id &&
      Number(transferPayload.user_id) !== Number(user.id)
    ) {
      return res.status(401).json({
        success: false,
        error: "Google authorization token is invalid or expired.",
      });
    }

    const payload = await buildPosLoginResponse(
      user,
      source || normalizeText(transferPayload.source) || "users",
      "google_oauth"
    );
    return res.json(payload);
  } catch (error) {
    console.error("❌ POS Google OAuth complete failed:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to complete Google login.",
    });
  }
});

router.post("/google", async (req, res) => {
  try {
    const credential =
      req.body?.credential || req.body?.id_token || req.body?.google_token || "";
    const googleIdentity = await verifyGoogleIdToken(credential);

    const { user, source } = await findPosUserByEmail(googleIdentity.email);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: "This Google account is not linked to a POS user.",
      });
    }

    const payload = await buildPosLoginResponse(user, source, "google");
    return res.json({
      ...payload,
      google_profile: {
        email: googleIdentity.email,
        name: googleIdentity.name,
        picture: googleIdentity.picture,
      },
    });
  } catch (error) {
    const statusCode = Number(error?.statusCode || 500);
    const isClientError = statusCode >= 400 && statusCode < 500;
    return res.status(isClientError ? statusCode : 500).json({
      success: false,
      error: String(
        isClientError ? error?.message || "Google login failed." : "Google login failed."
      ),
    });
  }
});

router.post("/register", async (req, res) => {
  try {
    await ensureMarketplaceCustomerSchema();

    const customer = await registerMarketplaceCustomer({
      address: req.body?.address,
      email: req.body?.email,
      language: req.body?.language,
      name: req.body?.name || req.body?.full_name || req.body?.username,
      password: req.body?.password,
      phone: req.body?.phone,
    });

    const token = signMarketplaceCustomerToken({
      customerId: customer.id,
      email: customer.email,
      phone: customer.phone,
    });

    return res.status(201).json({
      success: true,
      scope: MARKETPLACE_CUSTOMER_SCOPE,
      token,
      customer,
    });
  } catch (error) {
    const mapped = mapMarketplaceAuthError(error, "Failed to register customer account");
    return res.status(mapped.statusCode).json({
      success: false,
      scope: MARKETPLACE_CUSTOMER_SCOPE,
      error: mapped.error,
    });
  }
});

router.get("/me", async (req, res) => {
  try {
    const authHeader = String(req.headers.authorization || "");
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        scope: MARKETPLACE_CUSTOMER_SCOPE,
        error: "Customer session required",
      });
    }

    await ensureMarketplaceCustomerSchema();

    const token = authHeader.slice(7).trim();
    const decoded = verifyCustomerAuthToken(token);
    if (
      !decoded?.customer_id ||
      String(decoded.scope || "").toLowerCase() !== MARKETPLACE_CUSTOMER_SCOPE
    ) {
      return res.status(401).json({
        success: false,
        scope: MARKETPLACE_CUSTOMER_SCOPE,
        error: "Invalid customer session",
      });
    }

    const customer = await getMarketplaceCustomerById(decoded.customer_id);
    if (!customer?.id) {
      return res.status(404).json({
        success: false,
        scope: MARKETPLACE_CUSTOMER_SCOPE,
        error: "Customer account not found",
      });
    }

    return res.json({
      success: true,
      scope: MARKETPLACE_CUSTOMER_SCOPE,
      customer,
    });
  } catch (error) {
    const mapped = mapMarketplaceAuthError(error, "Failed to resolve customer session");
    return res.status(mapped.statusCode).json({
      success: false,
      scope: MARKETPLACE_CUSTOMER_SCOPE,
      error: mapped.error,
    });
  }
});

module.exports = router;
