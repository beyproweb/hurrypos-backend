const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const { ensureBookingQrSchema } = require("../utils/bookingQrAsync");
const {
  shouldServePublicQrImage,
  decodeGuestQrToken,
  buildGuestQrPngBuffer,
  buildGuestQrScanUrl,
} = require("../utils/guestQrImage");

function logGuestQr(event, req, extra = {}) {
  console.log("🛰️ [guest-qr-public]", event, {
    method: req.method,
    path: req.originalUrl || req.url,
    host: req.get?.("host") || "",
    origin: req.get?.("origin") || "",
    userAgent: req.get?.("user-agent") || "",
    ...extra,
  });
}

async function servePublicGuestQrImage(req, res, options) {
  const {
    token,
    expectedEntityTypes,
    tableName,
    kind,
  } = options;

  logGuestQr("request.received", req, {
    kind,
    tokenPreview: `${String(token || "").slice(0, 16)}...`,
  });
  res.setHeader("X-QR-Route", `guest-public-${kind}`);

  const decoded = decodeGuestQrToken(token, expectedEntityTypes);
  const restaurantId = Number(decoded?.restaurant_id);
  const entityId = Number(decoded?.entity_id);

  if (!Number.isFinite(restaurantId) || restaurantId <= 0 || !Number.isFinite(entityId) || entityId <= 0) {
    res.setHeader("X-QR-Result", "invalid-claims");
    logGuestQr("request.invalid_claims", req, { kind, restaurantId, entityId });
    return res.status(401).json({ error: "QR invalid", code: "qr_invalid" });
  }

  const { rows } = await pool.query(
    `
    SELECT
      id,
      restaurant_id,
      qr_status,
      qr_url,
      qr_image
    FROM ${tableName}
    WHERE restaurant_id = $1
      AND id = $2
      AND qr_token = $3
    LIMIT 1
    `,
    [restaurantId, entityId, token]
  );

  const record = rows?.[0] || null;
  if (!record) {
    res.setHeader("X-QR-Result", "record-missing");
    logGuestQr("request.record_missing", req, { kind, restaurantId, entityId });
    return res.status(404).json({ error: "QR invalid", code: "qr_invalid" });
  }
  if (String(record.qr_status || "").toLowerCase() !== "ready") {
    res.setHeader("X-QR-Result", "not-ready");
    logGuestQr("request.not_ready", req, {
      kind,
      restaurantId,
      entityId,
      qrStatus: record.qr_status,
    });
    return res.status(409).json({ error: "QR not ready", code: "qr_not_ready" });
  }

  const scanUrl = buildGuestQrScanUrl({
    req,
    kind,
    token,
    fallbackUrl: record.qr_url,
  });

  let pngBuffer = null;
  try {
    pngBuffer = await buildGuestQrPngBuffer(scanUrl, record.qr_image);
  } catch (err) {
    logGuestQr("request.render_failed", req, {
      kind,
      restaurantId,
      entityId,
      error: err?.message || String(err),
    });
    console.error(`❌ Failed to render public ${kind} QR image:`, err);
  }

  if (!pngBuffer) {
    res.setHeader("X-QR-Result", "image-unavailable");
    logGuestQr("request.image_unavailable", req, { kind, restaurantId, entityId });
    return res.status(503).json({ error: "QR image unavailable", code: "qr_image_unavailable" });
  }

  res.setHeader("X-QR-Result", "success");
  logGuestQr("request.success", req, { kind, restaurantId, entityId });
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.send(pngBuffer);
}

async function handleReservationQrImage(req, res) {
  const token = String(req.params.token || "").trim();
  if (!token) {
    return res.status(400).json({ error: "QR token is required" });
  }

  try {
    await ensureBookingQrSchema(pool);
    return await servePublicGuestQrImage(req, res, {
      token,
      expectedEntityTypes: ["order_reservation"],
      tableName: "orders",
      kind: "reservation",
    });
  } catch (err) {
    if (err?.statusCode) {
      res.setHeader("X-QR-Result", err.code || "decode-failed");
      logGuestQr("request.decode_failed", req, {
        kind: "reservation",
        error: err.message || "QR invalid",
        code: err.code || "qr_invalid",
      });
      return res.status(err.statusCode).json({
        error: err.message || "QR invalid",
        code: err.code || "qr_invalid",
      });
    }
    console.error("❌ Failed to render public reservation QR image:", err);
    return res.status(500).json({ error: "Failed to render reservation QR image" });
  }
}

async function handleConcertQrImage(req, res) {
  const token = String(req.params.token || "").trim();
  if (!token) {
    return res.status(400).json({ error: "QR token is required" });
  }

  try {
    await ensureBookingQrSchema(pool);
    return await servePublicGuestQrImage(req, res, {
      token,
      expectedEntityTypes: ["concert_booking"],
      tableName: "concert_bookings",
      kind: "concert",
    });
  } catch (err) {
    if (err?.statusCode) {
      res.setHeader("X-QR-Result", err.code || "decode-failed");
      logGuestQr("request.decode_failed", req, {
        kind: "concert",
        error: err.message || "QR invalid",
        code: err.code || "qr_invalid",
      });
      return res.status(err.statusCode).json({
        error: err.message || "QR invalid",
        code: err.code || "qr_invalid",
      });
    }
    console.error("❌ Failed to render public concert QR image:", err);
    return res.status(500).json({ error: "Failed to render concert QR image" });
  }
}

router.get("/orders/reservations/qr-image/:token", handleReservationQrImage);
router.get("/concerts/bookings/qr-image/:token", handleConcertQrImage);

router.get("/orders/reservations/qr/:token", async (req, res, next) => {
  if (!shouldServePublicQrImage(req)) return next();
  return handleReservationQrImage(req, res);
});

router.get("/concerts/bookings/qr/:token", async (req, res, next) => {
  if (!shouldServePublicQrImage(req)) return next();
  return handleConcertQrImage(req, res);
});

module.exports = router;
