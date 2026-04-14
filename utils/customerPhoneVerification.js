const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { normalizeTrPhoneForApi } = require("./phone");

const QR_CUSTOMER_PHONE_OTP_LENGTH = Number(
  process.env.QR_CUSTOMER_PHONE_OTP_LENGTH || 6
);
const QR_CUSTOMER_PHONE_OTP_TTL_SECONDS = Math.max(
  60,
  Number(process.env.QR_CUSTOMER_PHONE_OTP_TTL_SECONDS || 300)
);
const QR_CUSTOMER_PHONE_OTP_COOLDOWN_SECONDS = Math.max(
  15,
  Number(process.env.QR_CUSTOMER_PHONE_OTP_COOLDOWN_SECONDS || 45)
);
const QR_CUSTOMER_PHONE_OTP_MAX_SENDS_PER_WINDOW = Math.max(
  1,
  Number(process.env.QR_CUSTOMER_PHONE_OTP_MAX_SENDS_PER_WINDOW || 5)
);
const QR_CUSTOMER_PHONE_OTP_WINDOW_SECONDS = Math.max(
  60,
  Number(process.env.QR_CUSTOMER_PHONE_OTP_WINDOW_SECONDS || 900)
);
const QR_CUSTOMER_PHONE_OTP_MAX_VERIFY_ATTEMPTS = Math.max(
  1,
  Number(process.env.QR_CUSTOMER_PHONE_OTP_MAX_VERIFY_ATTEMPTS || 5)
);
const QR_CUSTOMER_PHONE_OTP_SECRET = String(
  process.env.QR_CUSTOMER_PHONE_OTP_SECRET || process.env.JWT_SECRET || ""
).trim();
const QR_CUSTOMER_PHONE_VERIFICATION_TOKEN_TTL =
  process.env.QR_CUSTOMER_PHONE_VERIFICATION_TOKEN_TTL || "30d";
const PHONE_VERIFICATION_SCOPE = "qr_phone_verification";
const PHONE_VERIFICATION_PURPOSE = "qr_phone_verification";

let qrCustomerPhoneOtpSchemaPromise = null;

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizePhone(value) {
  return normalizeTrPhoneForApi(value);
}

function normalizeOtpCode(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function getJwtSecret() {
  return process.env.JWT_SECRET || "beypro_secret_2025";
}

function createHttpError(statusCode, message, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code || "";
  return error;
}

async function ensureQrCustomerPhoneOtpSchema() {
  if (!qrCustomerPhoneOtpSchemaPromise) {
    qrCustomerPhoneOtpSchemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS qr_customer_phone_otps (
          id SERIAL PRIMARY KEY,
          restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
          marketplace_customer_id INTEGER REFERENCES marketplace_customers(id) ON DELETE CASCADE,
          phone_number TEXT NOT NULL,
          normalized_phone TEXT NOT NULL,
          code_hash TEXT NOT NULL,
          code_salt TEXT NOT NULL,
          purpose TEXT NOT NULL DEFAULT 'checkout_contact',
          expires_at TIMESTAMPTZ NOT NULL,
          consumed_at TIMESTAMPTZ,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 5,
          resend_count INTEGER NOT NULL DEFAULT 0,
          request_ip TEXT,
          user_agent TEXT,
          last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS qr_customer_phone_otps_lookup_idx
        ON qr_customer_phone_otps (restaurant_id, normalized_phone, purpose, created_at DESC)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS qr_customer_phone_otps_active_idx
        ON qr_customer_phone_otps (restaurant_id, normalized_phone, consumed_at, expires_at)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS qr_customer_phone_otps_ip_idx
        ON qr_customer_phone_otps (restaurant_id, request_ip, created_at DESC)
      `);
    })().catch((error) => {
      qrCustomerPhoneOtpSchemaPromise = null;
      throw error;
    });
  }

  return qrCustomerPhoneOtpSchemaPromise;
}

function generatePhoneOtpCode() {
  const size = Math.min(8, Math.max(4, QR_CUSTOMER_PHONE_OTP_LENGTH));
  const min = 10 ** (size - 1);
  const max = 10 ** size;
  return String(crypto.randomInt(min, max));
}

function generatePhoneOtpSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function hashPhoneOtpCode(code, salt) {
  const normalizedCode = normalizeOtpCode(code);
  const normalizedSalt = normalizeText(salt);
  const secret = QR_CUSTOMER_PHONE_OTP_SECRET || getJwtSecret();
  return crypto
    .createHash("sha256")
    .update(`${normalizedSalt}:${normalizedCode}:${secret}`)
    .digest("hex");
}

function timingSafeEqualPhoneOtpHash(left, right) {
  const leftBuffer = Buffer.from(normalizeText(left), "hex");
  const rightBuffer = Buffer.from(normalizeText(right), "hex");
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function calculatePhoneOtpRetryAfterSeconds(latestOtp) {
  if (!latestOtp?.last_sent_at) return 0;
  const lastSentMs = Date.parse(latestOtp.last_sent_at);
  if (!Number.isFinite(lastSentMs)) return 0;
  const elapsedSeconds = Math.floor((Date.now() - lastSentMs) / 1000);
  return Math.max(0, QR_CUSTOMER_PHONE_OTP_COOLDOWN_SECONDS - elapsedSeconds);
}

async function getLatestPhoneOtpRecord(restaurantId, phone, runner = pool) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const { rows } = await runner.query(
    `
      SELECT
        id,
        restaurant_id,
        marketplace_customer_id,
        phone_number,
        normalized_phone,
        code_hash,
        code_salt,
        purpose,
        expires_at,
        consumed_at,
        attempt_count,
        max_attempts,
        resend_count,
        last_sent_at,
        created_at
      FROM qr_customer_phone_otps
      WHERE restaurant_id = $1
        AND normalized_phone = $2
        AND purpose = 'checkout_contact'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [Number(restaurantId), normalizedPhone]
  );

  return rows[0] || null;
}

async function countRecentPhoneOtpRequests(
  {
    restaurantId,
    phone,
    requestIp = "",
    marketplaceCustomerId = null,
    windowSeconds = QR_CUSTOMER_PHONE_OTP_WINDOW_SECONDS,
  },
  runner = pool
) {
  const normalizedPhone = normalizePhone(phone);
  const normalizedIp = normalizeText(requestIp);
  const parsedMarketplaceCustomerId = Number(marketplaceCustomerId || 0);
  const parsedRestaurantId = Number(restaurantId || 0);

  if (!normalizedPhone || !Number.isFinite(parsedRestaurantId) || parsedRestaurantId <= 0) {
    return 0;
  }

  const { rows } = await runner.query(
    `
      SELECT COUNT(*)::int AS total
      FROM qr_customer_phone_otps
      WHERE restaurant_id = $1
        AND purpose = 'checkout_contact'
        AND created_at >= NOW() - make_interval(secs => $2)
        AND (
          normalized_phone = $3
          OR ($4 <> '' AND request_ip = $4)
          OR ($5 > 0 AND marketplace_customer_id = $5)
        )
    `,
    [
      parsedRestaurantId,
      windowSeconds,
      normalizedPhone,
      normalizedIp,
      parsedMarketplaceCustomerId,
    ]
  );

  return Number(rows[0]?.total || 0);
}

function isVerifiedMarketplacePhone(marketplaceCustomer, phoneNumber) {
  if (!marketplaceCustomer?.id) return false;
  if (marketplaceCustomer.phone_verified !== true) return false;
  const normalizedPhone = normalizePhone(phoneNumber);
  const accountPhone = normalizePhone(marketplaceCustomer.phone);
  return Boolean(normalizedPhone && accountPhone && normalizedPhone === accountPhone);
}

function isMarketplaceSessionPhoneMatch(marketplaceCustomer, phoneNumber) {
  if (!marketplaceCustomer?.id) return false;
  const normalizedPhone = normalizePhone(phoneNumber);
  const accountPhone = normalizePhone(marketplaceCustomer.phone);
  return Boolean(normalizedPhone && accountPhone && normalizedPhone === accountPhone);
}

function isVerifiedQrCustomerPhone(qrCustomer, phoneNumber) {
  if (!qrCustomer?.id) return false;
  if (qrCustomer.phone_verified !== true) return false;
  const normalizedPhone = normalizePhone(phoneNumber);
  const accountPhone = normalizePhone(qrCustomer.phone);
  return Boolean(normalizedPhone && accountPhone && normalizedPhone === accountPhone);
}

function isQrCustomerSessionPhoneMatch(qrCustomer, phoneNumber) {
  if (!qrCustomer?.id) return false;
  const normalizedPhone = normalizePhone(phoneNumber);
  const accountPhone = normalizePhone(qrCustomer.phone);
  return Boolean(normalizedPhone && accountPhone && normalizedPhone === accountPhone);
}

function normalizePhoneVerificationToken(value) {
  return normalizeText(value);
}

function signPhoneVerificationTrustToken({
  restaurantId,
  marketplaceCustomerId = null,
  phoneNumber,
  trustLevel = "otp_verified",
}) {
  const normalizedPhone = normalizePhone(phoneNumber);
  const parsedRestaurantId = Number(restaurantId || 0);
  const parsedMarketplaceCustomerId = Number(marketplaceCustomerId || 0);
  if (!normalizedPhone) {
    throw createHttpError(400, "Valid phone number is required", "invalid_phone");
  }
  if (!Number.isFinite(parsedRestaurantId) || parsedRestaurantId <= 0) {
    throw createHttpError(
      400,
      "Valid restaurant id is required",
      "invalid_restaurant"
    );
  }

  return jwt.sign(
    {
      purpose: PHONE_VERIFICATION_PURPOSE,
      scope: PHONE_VERIFICATION_SCOPE,
      trust_level: normalizeText(trustLevel) || "otp_verified",
      restaurant_id: parsedRestaurantId,
      marketplace_customer_id:
        Number.isFinite(parsedMarketplaceCustomerId) && parsedMarketplaceCustomerId > 0
          ? parsedMarketplaceCustomerId
          : null,
      phone: normalizedPhone,
    },
    getJwtSecret(),
    {
      expiresIn: QR_CUSTOMER_PHONE_VERIFICATION_TOKEN_TTL,
    }
  );
}

function verifyPhoneVerificationTrustToken(rawToken) {
  const token = normalizePhoneVerificationToken(rawToken);
  if (!token) {
    throw createHttpError(401, "Phone verification token required", "token_required");
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (
      decoded?.purpose !== PHONE_VERIFICATION_PURPOSE ||
      String(decoded?.scope || "").trim().toLowerCase() !== PHONE_VERIFICATION_SCOPE
    ) {
      throw createHttpError(401, "Invalid phone verification token", "invalid_token");
    }
    return decoded;
  } catch (error) {
    if (error?.statusCode) throw error;
    throw createHttpError(401, "Invalid or expired phone verification token", "invalid_token");
  }
}

function assertCheckoutPhoneVerification({
  restaurantId,
  phoneNumber,
  marketplaceCustomer = null,
  qrCustomer = null,
  phoneVerificationToken = "",
}) {
  const normalizedPhone = normalizePhone(phoneNumber);
  if (!normalizedPhone) {
    return {
      ok: false,
      statusCode: 400,
      code: "invalid_phone",
      message: "Valid phone number is required.",
    };
  }

  if (isVerifiedMarketplacePhone(marketplaceCustomer, normalizedPhone)) {
    return {
      ok: true,
      normalizedPhone,
      verifiedBy: "marketplace_account",
      decodedToken: null,
    };
  }

  if (isMarketplaceSessionPhoneMatch(marketplaceCustomer, normalizedPhone)) {
    return {
      ok: true,
      normalizedPhone,
      verifiedBy: "marketplace_session_phone_match",
      decodedToken: null,
    };
  }

  if (isVerifiedQrCustomerPhone(qrCustomer, normalizedPhone)) {
    return {
      ok: true,
      normalizedPhone,
      verifiedBy: "qr_customer_verified_phone",
      decodedToken: null,
    };
  }

  if (isQrCustomerSessionPhoneMatch(qrCustomer, normalizedPhone)) {
    return {
      ok: true,
      normalizedPhone,
      verifiedBy: "qr_customer_session_phone_match",
      decodedToken: null,
    };
  }

  const token = normalizePhoneVerificationToken(phoneVerificationToken);
  if (!token) {
    return {
      ok: false,
      statusCode: 403,
      code: "phone_verification_required",
      message: "Phone verification is required before checkout.",
    };
  }

  let decoded;
  try {
    decoded = verifyPhoneVerificationTrustToken(token);
  } catch (error) {
    return {
      ok: false,
      statusCode: Number(error?.statusCode || 401),
      code: String(error?.code || "invalid_phone_verification_token"),
      message:
        String(error?.message || "").trim() ||
        "Invalid or expired phone verification token.",
    };
  }

  const tokenPhone = normalizePhone(decoded?.phone);
  if (!tokenPhone || tokenPhone !== normalizedPhone) {
    return {
      ok: false,
      statusCode: 403,
      code: "phone_verification_mismatch",
      message: "Phone verification does not match this phone number.",
    };
  }

  const tokenRestaurantId = Number(decoded?.restaurant_id || 0);
  if (
    Number.isFinite(tokenRestaurantId) &&
    tokenRestaurantId > 0 &&
    Number(tokenRestaurantId) !== Number(restaurantId)
  ) {
    return {
      ok: false,
      statusCode: 403,
      code: "phone_verification_restaurant_mismatch",
      message: "Phone verification token does not match this restaurant.",
    };
  }

  if (marketplaceCustomer?.id) {
    const tokenMarketplaceCustomerId = Number(decoded?.marketplace_customer_id || 0);
    if (!Number.isFinite(tokenMarketplaceCustomerId) || tokenMarketplaceCustomerId <= 0) {
      return {
        ok: false,
        statusCode: 403,
        code: "phone_verification_account_required",
        message: "Phone verification token does not match the logged-in account.",
      };
    }
    if (tokenMarketplaceCustomerId !== Number(marketplaceCustomer.id)) {
      return {
        ok: false,
        statusCode: 403,
        code: "phone_verification_account_mismatch",
        message: "Phone verification token does not match the logged-in account.",
      };
    }
  }

  return {
    ok: true,
    normalizedPhone,
    verifiedBy: "otp_token",
    decodedToken: decoded,
  };
}

async function markMarketplaceCustomerPhoneVerified(
  { marketplaceCustomerId, phoneNumber },
  runner = pool
) {
  const parsedMarketplaceCustomerId = Number(marketplaceCustomerId || 0);
  const normalizedPhone = normalizePhone(phoneNumber);
  if (
    !Number.isFinite(parsedMarketplaceCustomerId) ||
    parsedMarketplaceCustomerId <= 0 ||
    !normalizedPhone
  ) {
    return null;
  }

  const { rows } = await runner.query(
    `
      UPDATE marketplace_customers
      SET
        phone = $1,
        phone_verified = TRUE,
        phone_verified_at = NOW(),
        updated_at = NOW()
      WHERE id = $2
      RETURNING
        id,
        full_name,
        phone,
        email,
        address,
        phone_verified,
        phone_verified_at,
        language,
        created_at,
        updated_at
    `,
    [normalizedPhone, parsedMarketplaceCustomerId]
  );

  return rows[0] || null;
}

function maskPhoneNumber(phoneNumber) {
  const normalized = normalizePhone(phoneNumber);
  if (!normalized || normalized.length < 6) return normalized;
  return `${normalized.slice(0, 4)}***${normalized.slice(-3)}`;
}

module.exports = {
  QR_CUSTOMER_PHONE_OTP_LENGTH,
  QR_CUSTOMER_PHONE_OTP_TTL_SECONDS,
  QR_CUSTOMER_PHONE_OTP_COOLDOWN_SECONDS,
  QR_CUSTOMER_PHONE_OTP_MAX_SENDS_PER_WINDOW,
  QR_CUSTOMER_PHONE_OTP_WINDOW_SECONDS,
  QR_CUSTOMER_PHONE_OTP_MAX_VERIFY_ATTEMPTS,
  PHONE_VERIFICATION_SCOPE,
  ensureQrCustomerPhoneOtpSchema,
  normalizePhoneVerificationToken,
  normalizePhoneForVerification: normalizePhone,
  normalizePhoneOtpCode: normalizeOtpCode,
  generatePhoneOtpCode,
  generatePhoneOtpSalt,
  hashPhoneOtpCode,
  timingSafeEqualPhoneOtpHash,
  calculatePhoneOtpRetryAfterSeconds,
  getLatestPhoneOtpRecord,
  countRecentPhoneOtpRequests,
  isVerifiedMarketplacePhone,
  isMarketplaceSessionPhoneMatch,
  signPhoneVerificationTrustToken,
  verifyPhoneVerificationTrustToken,
  assertCheckoutPhoneVerification,
  markMarketplaceCustomerPhoneVerified,
  maskPhoneNumber,
  createHttpError,
};
