const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { normalizeTrPhoneForApi } = require("./phone");

const MARKETPLACE_CUSTOMER_SCOPE = "marketplace_customer";
const MARKETPLACE_CUSTOMER_TOKEN_TTL =
  process.env.MARKETPLACE_CUSTOMER_TOKEN_TTL || "30d";

let marketplaceCustomerSchemaPromise = null;

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizePhone(value) {
  return normalizeTrPhoneForApi(value);
}

function normalizeLanguage(value) {
  const raw = normalizeText(value).split(",")[0];
  return raw ? raw.slice(0, 32) : null;
}

function getJwtSecret() {
  return process.env.JWT_SECRET || "beypro_secret_2025";
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function ensureMarketplaceCustomerSchema() {
  if (!marketplaceCustomerSchemaPromise) {
    marketplaceCustomerSchemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS marketplace_customers (
          id SERIAL PRIMARY KEY,
          full_name TEXT NOT NULL,
          phone TEXT NOT NULL,
          email TEXT,
          address TEXT,
          password_hash TEXT NOT NULL,
          language TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS marketplace_customers_phone_norm_idx
        ON marketplace_customers ((regexp_replace(COALESCE(phone, ''), '\\D', '', 'g')))
        WHERE COALESCE(phone, '') <> ''
      `);

      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS marketplace_customers_email_norm_idx
        ON marketplace_customers ((LOWER(TRIM(COALESCE(email, '')))))
        WHERE COALESCE(email, '') <> ''
      `);
    })().catch((error) => {
      marketplaceCustomerSchemaPromise = null;
      throw error;
    });
  }

  return marketplaceCustomerSchemaPromise;
}

function toPublicMarketplaceCustomer(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    full_name: normalizeText(row.full_name),
    name: normalizeText(row.full_name),
    username: normalizeText(row.full_name),
    phone: normalizePhone(row.phone),
    email: normalizeEmail(row.email) || "",
    address: normalizeText(row.address),
    language: normalizeLanguage(row.language),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function getMarketplaceCustomerById(customerId, runner = pool) {
  await ensureMarketplaceCustomerSchema();
  const parsedId = Number(customerId);
  if (!Number.isFinite(parsedId) || parsedId <= 0) {
    return null;
  }

  const { rows } = await runner.query(
    `
      SELECT
        id,
        full_name,
        phone,
        email,
        address,
        language,
        created_at,
        updated_at
      FROM marketplace_customers
      WHERE id = $1
      LIMIT 1
    `,
    [parsedId]
  );

  return toPublicMarketplaceCustomer(rows[0] || null);
}

async function findMarketplaceCustomerForLogin(login, runner = pool) {
  await ensureMarketplaceCustomerSchema();

  const normalizedLogin = normalizeText(login);
  const normalizedPhone = normalizePhone(normalizedLogin);
  const normalizedEmail = normalizeEmail(normalizedLogin);

  if (!normalizedPhone && !normalizedEmail) {
    return null;
  }

  const { rows } = await runner.query(
    `
      SELECT
        id,
        full_name,
        phone,
        email,
        address,
        password_hash,
        language,
        created_at,
        updated_at
      FROM marketplace_customers
      WHERE
        regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1
        OR (LOWER(TRIM(COALESCE(email, ''))) = $2 AND $2 <> '')
      ORDER BY id ASC
      LIMIT 1
    `,
    [normalizedPhone, normalizedEmail]
  );

  return rows[0] || null;
}

async function findMarketplaceCustomerForRegistration({ phone, email }, runner = pool) {
  await ensureMarketplaceCustomerSchema();

  const normalizedPhone = normalizePhone(phone);
  const normalizedEmail = normalizeEmail(email);

  const { rows } = await runner.query(
    `
      SELECT id
      FROM marketplace_customers
      WHERE
        regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1
        OR (LOWER(TRIM(COALESCE(email, ''))) = $2 AND $2 <> '')
      LIMIT 1
    `,
    [normalizedPhone, normalizedEmail]
  );

  return rows[0] || null;
}

async function registerMarketplaceCustomer(payload = {}, runner = pool) {
  await ensureMarketplaceCustomerSchema();

  const fullName = normalizeText(payload.name || payload.full_name || payload.username);
  const phone = normalizePhone(payload.phone);
  const email = normalizeEmail(payload.email) || null;
  const address = normalizeText(payload.address) || null;
  const password = normalizeText(payload.password);
  const language = normalizeLanguage(payload.language) || null;

  if (!fullName || !phone || !password) {
    throw createHttpError(400, "Name, phone, and password are required");
  }

  const existing = await findMarketplaceCustomerForRegistration({ phone, email }, runner);
  if (existing?.id) {
    throw createHttpError(
      409,
      "An account already exists for this phone number or email. Please log in."
    );
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await runner.query(
    `
      INSERT INTO marketplace_customers
        (full_name, phone, email, address, password_hash, language)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING
        id,
        full_name,
        phone,
        email,
        address,
        language,
        created_at,
        updated_at
    `,
    [fullName, phone, email, address, passwordHash, language]
  );

  return toPublicMarketplaceCustomer(rows[0] || null);
}

async function loginMarketplaceCustomer(payload = {}, runner = pool) {
  await ensureMarketplaceCustomerSchema();

  const login = normalizeText(payload.login || payload.phone || payload.email);
  const password = normalizeText(payload.password);

  if (!login || !password) {
    throw createHttpError(400, "Phone number or email and password are required");
  }

  const existing = await findMarketplaceCustomerForLogin(login, runner);
  if (!existing?.id) {
    throw createHttpError(
      404,
      "No account found for this phone number or email. Please register."
    );
  }

  const validPassword = await bcrypt.compare(password, existing.password_hash || "");
  if (!validPassword) {
    throw createHttpError(401, "Incorrect password.");
  }

  return toPublicMarketplaceCustomer(existing);
}

async function updateMarketplaceCustomerProfile(customerId, payload = {}, runner = pool) {
  await ensureMarketplaceCustomerSchema();

  const existing = await getMarketplaceCustomerById(customerId, runner);
  if (!existing?.id) {
    throw createHttpError(404, "Customer account not found");
  }

  const fullName = normalizeText(payload.name || payload.full_name || payload.username || existing.full_name);
  const phone = normalizePhone(payload.phone || existing.phone);
  const email =
    payload.email === undefined
      ? normalizeEmail(existing.email) || null
      : normalizeEmail(payload.email) || null;
  const address =
    payload.address === undefined
      ? normalizeText(existing.address) || null
      : normalizeText(payload.address) || null;
  const language =
    payload.language === undefined
      ? normalizeLanguage(existing.language) || null
      : normalizeLanguage(payload.language) || null;

  if (!fullName || !phone) {
    throw createHttpError(400, "Name and phone are required");
  }

  const conflict = await runner.query(
    `
      SELECT id
      FROM marketplace_customers
      WHERE id <> $1
        AND (
          regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $2
          OR (LOWER(TRIM(COALESCE(email, ''))) = $3 AND $3 <> '')
        )
      LIMIT 1
    `,
    [existing.id, phone, email || ""]
  );

  if (conflict.rows.length) {
    throw createHttpError(409, "Another account already uses this phone number or email.");
  }

  const { rows } = await runner.query(
    `
      UPDATE marketplace_customers
      SET full_name = $1,
          phone = $2,
          email = $3,
          address = $4,
          language = $5,
          updated_at = NOW()
      WHERE id = $6
      RETURNING
        id,
        full_name,
        phone,
        email,
        address,
        language,
        created_at,
        updated_at
    `,
    [fullName, phone, email, address, language, existing.id]
  );

  return toPublicMarketplaceCustomer(rows[0] || null);
}

function signMarketplaceCustomerToken({ customerId, phone = "", email = "" }) {
  const parsedId = Number(customerId);
  if (!Number.isFinite(parsedId) || parsedId <= 0) {
    throw new Error("Valid customer id is required to sign marketplace customer token");
  }

  return jwt.sign(
    {
      id: parsedId,
      customer_id: parsedId,
      phone: normalizePhone(phone),
      email: normalizeEmail(email) || null,
      role: "customer",
      scope: MARKETPLACE_CUSTOMER_SCOPE,
      auth_source: MARKETPLACE_CUSTOMER_SCOPE,
    },
    getJwtSecret(),
    { expiresIn: MARKETPLACE_CUSTOMER_TOKEN_TTL }
  );
}

function verifyCustomerAuthToken(token) {
  const rawToken = normalizeText(token);
  if (!rawToken) {
    throw createHttpError(401, "Customer session required");
  }

  const primarySecret = process.env.JWT_SECRET;
  const legacySecret =
    process.env.NODE_ENV !== "production" ? process.env.JWT_SECRET_LEGACY : "";
  const verifyWith = (secret) => jwt.verify(rawToken, secret);

  try {
    return verifyWith(primarySecret || "beypro_secret_2025");
  } catch (error) {
    if (legacySecret && legacySecret !== primarySecret) {
      return verifyWith(legacySecret);
    }
    throw error;
  }
}

async function getRestaurantCustomerProfile(restaurantId, customerId, runner = pool) {
  const parsedRestaurantId = Number(restaurantId);
  const parsedCustomerId = Number(customerId);
  if (
    !Number.isFinite(parsedRestaurantId) ||
    parsedRestaurantId <= 0 ||
    !Number.isFinite(parsedCustomerId) ||
    parsedCustomerId <= 0
  ) {
    return null;
  }

  const { rows } = await runner.query(
    `
      SELECT id, restaurant_id, name, phone, address, birthday, email
      FROM customers
      WHERE restaurant_id = $1 AND id = $2
      LIMIT 1
    `,
    [parsedRestaurantId, parsedCustomerId]
  );

  if (!rows.length) return null;

  const customer = rows[0];
  const addresses = await runner.query(
    `
      SELECT id, label, address, is_default
      FROM customer_addresses
      WHERE restaurant_id = $1 AND customer_id = $2
      ORDER BY is_default DESC, id ASC
    `,
    [parsedRestaurantId, parsedCustomerId]
  );

  return {
    ...customer,
    addresses: addresses.rows,
  };
}

async function ensureRestaurantCustomerForMarketplace(
  { restaurantId, marketplaceCustomer },
  runner = pool
) {
  const parsedRestaurantId = Number(restaurantId);
  if (!Number.isFinite(parsedRestaurantId) || parsedRestaurantId <= 0) {
    throw createHttpError(400, "Valid restaurant id is required");
  }

  const customer = marketplaceCustomer || null;
  if (!customer?.id) {
    throw createHttpError(400, "Marketplace customer is required");
  }

  const customerName =
    normalizeText(customer.full_name || customer.name || customer.username) ||
    "Customer";
  const customerPhone = normalizePhone(customer.phone);
  const customerEmail = normalizeEmail(customer.email) || null;
  const customerAddress = normalizeText(customer.address) || null;

  if (!customerPhone) {
    throw createHttpError(400, "Marketplace customer phone is required");
  }

  const existing = await runner.query(
    `
      SELECT id
      FROM customers
      WHERE restaurant_id = $1
        AND (
          regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $2
          OR (LOWER(TRIM(COALESCE(email, ''))) = $3 AND $3 <> '')
        )
      ORDER BY id ASC
      LIMIT 1
    `,
    [parsedRestaurantId, customerPhone, customerEmail || ""]
  );

  let localCustomerId = Number(existing.rows?.[0]?.id || 0);

  if (localCustomerId > 0) {
    await runner.query(
      `
        UPDATE customers
        SET name = $1,
            phone = $2,
            email = $3,
            address = COALESCE($4, address)
        WHERE restaurant_id = $5 AND id = $6
      `,
      [customerName, customerPhone, customerEmail, customerAddress, parsedRestaurantId, localCustomerId]
    );
  } else {
    const inserted = await runner.query(
      `
        INSERT INTO customers (restaurant_id, name, phone, email, address)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `,
      [parsedRestaurantId, customerName, customerPhone, customerEmail, customerAddress]
    );
    localCustomerId = Number(inserted.rows?.[0]?.id || 0);
  }

  if (!localCustomerId) {
    throw createHttpError(500, "Failed to link marketplace account to restaurant customer");
  }

  if (customerAddress) {
    try {
      await runner.query(
        `
          INSERT INTO customer_addresses (customer_id, address, is_default, restaurant_id)
          VALUES ($1, $2, true, $3)
          ON CONFLICT (customer_id, address)
          DO UPDATE SET is_default = EXCLUDED.is_default
        `,
        [localCustomerId, customerAddress, parsedRestaurantId]
      );
    } catch (error) {
      console.warn(
        "⚠️ Failed to persist marketplace customer default address:",
        error?.message || error
      );
    }
  }

  return localCustomerId;
}

module.exports = {
  MARKETPLACE_CUSTOMER_SCOPE,
  ensureMarketplaceCustomerSchema,
  normalizeMarketplaceEmail: normalizeEmail,
  normalizeMarketplaceLanguage: normalizeLanguage,
  normalizeMarketplacePhone: normalizePhone,
  normalizeMarketplaceText: normalizeText,
  signMarketplaceCustomerToken,
  verifyCustomerAuthToken,
  getMarketplaceCustomerById,
  loginMarketplaceCustomer,
  registerMarketplaceCustomer,
  updateMarketplaceCustomerProfile,
  ensureRestaurantCustomerForMarketplace,
  getRestaurantCustomerProfile,
  createHttpError,
};
