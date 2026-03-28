const jwt = require("jsonwebtoken");

let QRCodeLib = null;
try {
  QRCodeLib = require("qrcode");
} catch {
  QRCodeLib = null;
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "").replace(/\/api$/i, "");
}

function resolveRequestOrigin(req) {
  if (!req) return "";
  const forwardedProto = String(req.get?.("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const host = String(req.get?.("host") || "").trim();
  if (!host) return "";
  const isLocalHost =
    host.includes("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
  const protocol = forwardedProto || (isLocalHost ? "http" : "https");
  return `${protocol}://${host}`;
}

function resolvePublicApiBaseUrl(req) {
  const envBase = normalizePublicBaseUrl(
    process.env.PUBLIC_API_BASE_URL ||
      process.env.PUBLIC_API_BASE ||
      process.env.API_BASE_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      process.env.URL ||
      "https://hurrypos-backend.onrender.com"
  );
  if (envBase) return envBase;
  const requestOrigin = resolveRequestOrigin(req);
  if (requestOrigin && !/localhost|127\.0\.0\.1|\[::1\]/i.test(requestOrigin)) {
    return requestOrigin;
  }
  return "https://hurrypos-backend.onrender.com";
}

function shouldServePublicQrImage(req) {
  const format = String(req?.query?.format || req?.query?.render || req?.query?.mode || "")
    .trim()
    .toLowerCase();
  return format === "image" || format === "png";
}

function decodeGuestQrToken(token, expectedEntityTypes = []) {
  if (!process.env.JWT_SECRET) {
    const error = new Error("JWT secret is not configured");
    error.statusCode = 500;
    throw error;
  }

  let decoded;
  try {
    decoded = jwt.verify(String(token || "").trim(), process.env.JWT_SECRET);
  } catch {
    const error = new Error("QR invalid");
    error.statusCode = 401;
    error.code = "qr_invalid";
    throw error;
  }

  const normalizedTokenType = String(decoded?.token_type || "").trim().toLowerCase();
  const normalizedEntityType = String(decoded?.entity_type || "").trim().toLowerCase();
  const allowedEntityTypes = []
    .concat(expectedEntityTypes || [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);

  if (normalizedTokenType !== "guest_checkin_qr") {
    const error = new Error("QR invalid");
    error.statusCode = 401;
    error.code = "qr_invalid";
    throw error;
  }
  if (allowedEntityTypes.length && !allowedEntityTypes.includes(normalizedEntityType)) {
    const error = new Error("QR invalid");
    error.statusCode = 401;
    error.code = "qr_invalid";
    throw error;
  }

  return decoded;
}

function extractPngBufferFromDataUrl(dataUrl) {
  const raw = String(dataUrl || "").trim();
  if (!raw) return null;
  const match = raw.match(/^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match?.[1]) return null;
  try {
    return Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  } catch {
    return null;
  }
}

async function buildGuestQrPngBuffer(scanUrl, qrImageDataUrl = "") {
  const fromDataUrl = extractPngBufferFromDataUrl(qrImageDataUrl);
  if (fromDataUrl) return fromDataUrl;
  if (!QRCodeLib?.toBuffer || !String(scanUrl || "").trim()) return null;
  return QRCodeLib.toBuffer(String(scanUrl).trim(), {
    type: "png",
    margin: 1,
    width: 320,
  });
}

function buildGuestQrScanUrl({ req, kind, token, fallbackUrl = "" }) {
  const tokenValue = String(token || "").trim();
  if (!tokenValue) return "";

  const direct = String(fallbackUrl || "").trim();
  if (direct) {
    try {
      const parsed = new URL(direct);
      if (!/localhost|127\.0\.0\.1|\[::1\]/i.test(parsed.hostname)) {
        return parsed.toString();
      }
    } catch {
      // ignore malformed stored URLs and rebuild canonically
    }
  }

  const apiBase = resolvePublicApiBaseUrl(req);
  const path =
    kind === "concert"
      ? `/api/concerts/bookings/qr/${encodeURIComponent(tokenValue)}`
      : `/api/orders/reservations/qr/${encodeURIComponent(tokenValue)}`;
  return `${apiBase}${path}`;
}

module.exports = {
  shouldServePublicQrImage,
  decodeGuestQrToken,
  buildGuestQrPngBuffer,
  buildGuestQrScanUrl,
};
