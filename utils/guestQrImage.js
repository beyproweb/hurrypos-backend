const jwt = require("jsonwebtoken");

let QRCodeLib = null;
try {
  QRCodeLib = require("qrcode");
} catch {
  QRCodeLib = null;
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

module.exports = {
  shouldServePublicQrImage,
  decodeGuestQrToken,
  buildGuestQrPngBuffer,
};
