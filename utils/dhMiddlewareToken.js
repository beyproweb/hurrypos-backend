const jwt = require("jsonwebtoken");

const tokenCache = new Map(); // origin|username -> { token, expiresAtMs }

const decodeJwtExpMs = (token) => {
  if (!token) return null;
  try {
    const decoded = jwt.decode(token);
    const expSeconds = decoded?.exp;
    if (!Number.isFinite(expSeconds)) return null;
    return expSeconds * 1000;
  } catch {
    return null;
  }
};

const extractTokenFromLoginResponse = (json) => {
  if (!json || typeof json !== "object") return null;
  return (
    json.access_token ||
    json.accessToken ||
    json.token ||
    json.jwt ||
    json.id_token ||
    null
  );
};

const extractExpiresInSeconds = (json) => {
  if (!json || typeof json !== "object") return null;
  const value = json.expires_in ?? json.expiresIn ?? json.expires ?? null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : null;
};

const resolveLoginOrigin = (callbackOrigin) => {
  const explicit =
    process.env.DH_MW_BASE_URL ||
    process.env.DELIVERYHERO_MW_BASE_URL ||
    process.env.MIDDLEWARE_BASE_URL ||
    "";
  if (explicit) {
    try {
      return new URL(explicit).origin;
    } catch {
      // ignore
    }
  }

  if (typeof callbackOrigin !== "string" || !callbackOrigin) return callbackOrigin;

  // Most DH deployments provide callback URLs on `vendor-api-*` hosts, while
  // `/v2/login` lives on the `integration-middleware-*` host.
  if (callbackOrigin.includes("vendor-api")) {
    return callbackOrigin.replace("vendor-api", "integration-middleware");
  }

  return callbackOrigin;
};

const login = async ({ origin, username, password }) => {
  const url = `${origin}/v2/login`;
  const body = new URLSearchParams();
  body.set("username", username);
  body.set("password", password);
  body.set("grant_type", "client_credentials");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = json?.message || json?.error || text || `Login failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  const token = extractTokenFromLoginResponse(json);
  if (!token) {
    const err = new Error("Login response missing access token");
    err.status = res.status;
    err.body = text;
    throw err;
  }

  const now = Date.now();
  const expiresInSeconds = extractExpiresInSeconds(json);
  const jwtExpMs = decodeJwtExpMs(token);
  const expiresAtMs =
    (Number.isFinite(expiresInSeconds) ? now + expiresInSeconds * 1000 : null) ||
    jwtExpMs ||
    now + 5 * 60 * 1000; // fallback 5m

  return { token, expiresAtMs };
};

const getCacheKey = (origin, username) => `${origin}|${username}`;

const getOriginFromUrl = (url) => {
  const parsed = new URL(url);
  return parsed.origin;
};

async function getMiddlewareBearerForCallbackUrl(callbackUrl) {
  const username = process.env.DH_MW_USERNAME || process.env.MIDDLEWARE_USERNAME || "";
  const password = process.env.DH_MW_PASSWORD || process.env.MIDDLEWARE_PASSWORD || "";
  if (!username || !password) {
    return null;
  }

  const callbackOrigin = getOriginFromUrl(callbackUrl);
  const loginOrigin = resolveLoginOrigin(callbackOrigin);
  const key = getCacheKey(loginOrigin, username);
  const cached = tokenCache.get(key);
  const now = Date.now();
  if (cached?.token && cached.expiresAtMs && cached.expiresAtMs - now > 30_000) {
    return `Bearer ${cached.token}`;
  }

  const next = await login({ origin: loginOrigin, username, password });
  tokenCache.set(key, next);
  return `Bearer ${next.token}`;
}

function clearMiddlewareBearerForCallbackUrl(callbackUrl) {
  const username = process.env.DH_MW_USERNAME || process.env.MIDDLEWARE_USERNAME || "";
  if (!username) return;
  try {
    const callbackOrigin = getOriginFromUrl(callbackUrl);
    const loginOrigin = resolveLoginOrigin(callbackOrigin);
    tokenCache.delete(getCacheKey(loginOrigin, username));
  } catch {
    // ignore
  }
}

module.exports = {
  getMiddlewareBearerForCallbackUrl,
  clearMiddlewareBearerForCallbackUrl,
};
