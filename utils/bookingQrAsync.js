const jwt = require("jsonwebtoken");

let QRCodeLib = null;
try {
  // Optional dependency resolved from the current install tree.
  // If unavailable, we still keep qr_url/qr_token generation working.
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  QRCodeLib = require("qrcode");
} catch {
  QRCodeLib = null;
}

let ensureBookingQrSchemaPromise = null;

function normalizePublicBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "").replace(/\/api$/i, "");
}

function getFallbackPublicApiBaseUrl() {
  return normalizePublicBaseUrl(
    process.env.PUBLIC_API_BASE_URL ||
      process.env.PUBLIC_API_BASE ||
      process.env.API_BASE_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      process.env.URL ||
      "https://hurrypos-backend.onrender.com"
  );
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
  const envBase = getFallbackPublicApiBaseUrl();
  if (envBase) return envBase;
  const requestOrigin = resolveRequestOrigin(req);
  if (
    requestOrigin &&
    !/localhost|127\.0\.0\.1|\[::1\]/i.test(requestOrigin)
  ) {
    return requestOrigin;
  }
  return getFallbackPublicApiBaseUrl();
}

async function ensureBookingQrSchema(pool) {
  if (!ensureBookingQrSchemaPromise) {
    ensureBookingQrSchemaPromise = (async () => {
      const statements = [
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_token TEXT`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_url TEXT`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_image TEXT`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_status TEXT`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_last_error TEXT`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_ready_at TIMESTAMPTZ`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_generated_at TIMESTAMPTZ`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_qr_token_unique ON orders (qr_token) WHERE qr_token IS NOT NULL AND btrim(qr_token) <> ''`,
        `ALTER TABLE concert_bookings ADD COLUMN IF NOT EXISTS qr_token TEXT`,
        `ALTER TABLE concert_bookings ADD COLUMN IF NOT EXISTS qr_url TEXT`,
        `ALTER TABLE concert_bookings ADD COLUMN IF NOT EXISTS qr_image TEXT`,
        `ALTER TABLE concert_bookings ADD COLUMN IF NOT EXISTS qr_status TEXT`,
        `ALTER TABLE concert_bookings ADD COLUMN IF NOT EXISTS qr_last_error TEXT`,
        `ALTER TABLE concert_bookings ADD COLUMN IF NOT EXISTS qr_ready_at TIMESTAMPTZ`,
        `ALTER TABLE concert_bookings ADD COLUMN IF NOT EXISTS qr_generated_at TIMESTAMPTZ`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_concert_bookings_qr_token_unique ON concert_bookings (qr_token) WHERE qr_token IS NOT NULL AND btrim(qr_token) <> ''`,
      ];

      for (const sql of statements) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query(sql);
      }
    })().catch((err) => {
      ensureBookingQrSchemaPromise = null;
      throw err;
    });
  }

  return ensureBookingQrSchemaPromise;
}

function scheduleBackgroundTask(label, task) {
  setImmediate(async () => {
    try {
      await task();
    } catch (err) {
      console.error(`❌ Background task failed: ${label}`, err);
    }
  });
}

function buildQrToken(payload) {
  return jwt.sign(
    {
      token_type: "guest_checkin_qr",
      ...payload,
    },
    process.env.JWT_SECRET,
    { expiresIn: "365d" }
  );
}

async function buildQrArtifacts({ entityType, restaurantId, entityId, req }) {
  const token = buildQrToken({
    entity_type: entityType,
    restaurant_id: restaurantId,
    entity_id: entityId,
  });

  const apiBase = resolvePublicApiBaseUrl(req);
  const qrUrl =
    entityType === "concert_booking"
      ? `${apiBase}/api/concerts/bookings/qr/${encodeURIComponent(token)}`
      : `${apiBase}/api/orders/reservations/qr/${encodeURIComponent(token)}`;

  let qrImage = null;
  if (QRCodeLib?.toDataURL) {
    try {
      qrImage = await QRCodeLib.toDataURL(qrUrl, {
        margin: 1,
        width: 320,
      });
    } catch (err) {
      console.warn("⚠️ Failed to render QR image data URL:", err?.message || err);
    }
  }

  return { token, qrUrl, qrImage };
}

async function markOrderQrPending(pool, restaurantId, orderId) {
  await ensureBookingQrSchema(pool);
  await pool.query(
    `
    UPDATE orders
    SET qr_status = CASE
          WHEN LOWER(COALESCE(qr_status, '')) = 'ready' THEN qr_status
          ELSE 'pending'
        END,
        qr_last_error = NULL
    WHERE restaurant_id = $1
      AND id = $2
    `,
    [restaurantId, orderId]
  );
}

async function markConcertBookingQrPending(pool, restaurantId, bookingId) {
  await ensureBookingQrSchema(pool);
  await pool.query(
    `
    UPDATE concert_bookings
    SET qr_status = CASE
          WHEN LOWER(COALESCE(qr_status, '')) = 'ready' THEN qr_status
          ELSE 'pending'
        END,
        qr_last_error = NULL
    WHERE restaurant_id = $1
      AND id = $2
    `,
    [restaurantId, bookingId]
  );
}

function scheduleRetry(label, task, attempt) {
  const delayMs = Math.min(30000, 1000 * Math.max(1, 2 ** Math.max(0, attempt - 1)));
  setTimeout(() => {
    scheduleBackgroundTask(label, task);
  }, delayMs);
}

async function loadOrderQrRecord(pool, restaurantId, orderId) {
  const { rows } = await pool.query(
    `
    SELECT id, qr_status, qr_token, qr_url, qr_image
    FROM orders
    WHERE restaurant_id = $1
      AND id = $2
    LIMIT 1
    `,
    [restaurantId, orderId]
  );
  return rows[0] || null;
}

async function loadConcertBookingQrRecord(pool, restaurantId, bookingId) {
  const { rows } = await pool.query(
    `
    SELECT id, qr_status, qr_token, qr_url, qr_image
    FROM concert_bookings
    WHERE restaurant_id = $1
      AND id = $2
    LIMIT 1
    `,
    [restaurantId, bookingId]
  );
  return rows[0] || null;
}

async function queueOrderReservationQrEmailJob({
  pool,
  restaurantId,
  orderId,
  confirmationType,
  explicitCustomerEmail = "",
  triggeredFrom = "orders.reservations.qr_async",
  req = null,
  sendEmail = true,
  attempt = 1,
  maxAttempts = 3,
}) {
  await ensureBookingQrSchema(pool);

  const record = await loadOrderQrRecord(pool, restaurantId, orderId);
  if (!record) return;

  let qrPayload = {
    qrStatus: String(record.qr_status || "").trim().toLowerCase(),
    qrToken: String(record.qr_token || "").trim(),
    qrUrl: String(record.qr_url || "").trim(),
  };

  if (qrPayload.qrStatus !== "ready" || !qrPayload.qrToken || !qrPayload.qrUrl) {
    try {
      await pool.query(
        `
        UPDATE orders
        SET qr_status = 'processing',
            qr_last_error = NULL
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [restaurantId, orderId]
      );

      const artifacts = await buildQrArtifacts({
        entityType: "order_reservation",
        restaurantId,
        entityId: orderId,
        req,
      });

      await pool.query(
        `
        UPDATE orders
        SET qr_token = $3,
            qr_url = $4,
            qr_image = $5,
            qr_status = 'ready',
            qr_generated_at = NOW(),
            qr_ready_at = NOW(),
            qr_last_error = NULL
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [restaurantId, orderId, artifacts.token, artifacts.qrUrl, artifacts.qrImage]
      );
    } catch (err) {
      const lastError = err?.message || "qr_generation_failed";
      await pool.query(
        `
        UPDATE orders
        SET qr_status = CASE
              WHEN $3::int >= $4::int THEN 'failed'
              ELSE 'pending'
            END,
            qr_last_error = $5
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [restaurantId, orderId, attempt, maxAttempts, lastError]
      );

      if (attempt < maxAttempts) {
        scheduleRetry(
          `order_reservation_qr_retry:${orderId}:${attempt + 1}`,
          () =>
            queueOrderReservationQrEmailJob({
              pool,
              restaurantId,
              orderId,
              confirmationType,
              explicitCustomerEmail,
              triggeredFrom,
              req,
              sendEmail,
              attempt: attempt + 1,
              maxAttempts,
            }),
          attempt + 1
        );
        return;
      }

      if (!sendEmail) return;
      const { sendOrderCustomerConfirmationEmail } = require("./customerConfirmationEmail");
      await sendOrderCustomerConfirmationEmail({
        pool,
        restaurantId,
        orderId,
        confirmationType,
        explicitCustomerEmail,
        triggeredFrom: `${triggeredFrom}.fallback_no_qr`,
        req,
      });
      return;
    }
  }

  if (!sendEmail) return;
  const { sendOrderCustomerConfirmationEmail } = require("./customerConfirmationEmail");
  await sendOrderCustomerConfirmationEmail({
    pool,
    restaurantId,
    orderId,
    confirmationType,
    explicitCustomerEmail,
    triggeredFrom,
    req,
  });
}

async function queueConcertBookingQrEmailJob({
  pool,
  restaurantId,
  bookingId,
  explicitCustomerEmail = "",
  triggeredFrom = "concerts.bookings.qr_async",
  req = null,
  sendEmail = true,
  attempt = 1,
  maxAttempts = 3,
}) {
  await ensureBookingQrSchema(pool);

  const record = await loadConcertBookingQrRecord(pool, restaurantId, bookingId);
  if (!record) return;

  let qrPayload = {
    qrStatus: String(record.qr_status || "").trim().toLowerCase(),
    qrToken: String(record.qr_token || "").trim(),
    qrUrl: String(record.qr_url || "").trim(),
  };

  if (qrPayload.qrStatus !== "ready" || !qrPayload.qrToken || !qrPayload.qrUrl) {
    try {
      await pool.query(
        `
        UPDATE concert_bookings
        SET qr_status = 'processing',
            qr_last_error = NULL
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [restaurantId, bookingId]
      );

      const artifacts = await buildQrArtifacts({
        entityType: "concert_booking",
        restaurantId,
        entityId: bookingId,
        req,
      });

      await pool.query(
        `
        UPDATE concert_bookings
        SET qr_token = $3,
            qr_url = $4,
            qr_image = $5,
            qr_status = 'ready',
            qr_generated_at = NOW(),
            qr_ready_at = NOW(),
            qr_last_error = NULL
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [restaurantId, bookingId, artifacts.token, artifacts.qrUrl, artifacts.qrImage]
      );
    } catch (err) {
      const lastError = err?.message || "qr_generation_failed";
      await pool.query(
        `
        UPDATE concert_bookings
        SET qr_status = CASE
              WHEN $3::int >= $4::int THEN 'failed'
              ELSE 'pending'
            END,
            qr_last_error = $5
        WHERE restaurant_id = $1
          AND id = $2
        `,
        [restaurantId, bookingId, attempt, maxAttempts, lastError]
      );

      if (attempt < maxAttempts) {
        scheduleRetry(
          `concert_booking_qr_retry:${bookingId}:${attempt + 1}`,
          () =>
            queueConcertBookingQrEmailJob({
              pool,
              restaurantId,
              bookingId,
              explicitCustomerEmail,
              triggeredFrom,
              req,
              sendEmail,
              attempt: attempt + 1,
              maxAttempts,
            }),
          attempt + 1
        );
        return;
      }

      if (!sendEmail) return;
      const { sendConcertCustomerConfirmationEmail } = require("./customerConfirmationEmail");
      await sendConcertCustomerConfirmationEmail({
        pool,
        restaurantId,
        bookingId,
        explicitCustomerEmail,
        triggeredFrom: `${triggeredFrom}.fallback_no_qr`,
        req,
      });
      return;
    }
  }

  if (!sendEmail) return;
  const { sendConcertCustomerConfirmationEmail } = require("./customerConfirmationEmail");
  await sendConcertCustomerConfirmationEmail({
    pool,
    restaurantId,
    bookingId,
    explicitCustomerEmail,
    triggeredFrom,
    req,
  });
}

module.exports = {
  ensureBookingQrSchema,
  scheduleBackgroundTask,
  markOrderQrPending,
  markConcertBookingQrPending,
  queueOrderReservationQrEmailJob,
  queueConcertBookingQrEmailJob,
};
