const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");

const QR_CUSTOMER_TOKEN_TTL = "30d";
let qrCustomerAuthSchemaPromise = null;

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

async function requireQrCustomerSession(req, res, next) {
  try {
    await ensureQrCustomerAuthSchema();

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Customer session required" });
    }

    const token = authHeader.slice(7).trim();
    const decoded = verifyQrCustomerToken(token);
    if (!decoded?.customer_id || decoded?.scope !== "qr_customer") {
      return res.status(401).json({ error: "Invalid customer session" });
    }

    if (Number(decoded.restaurant_id) !== Number(req.restaurantId)) {
      return res.status(403).json({ error: "Customer session does not match this restaurant" });
    }

    const customer = await getQrCustomerProfileById(req.restaurantId, decoded.customer_id);
    if (!customer?.id) {
      return res.status(401).json({ error: "Customer session is no longer valid" });
    }

    req.qrCustomer = customer;
    req.qrCustomerToken = decoded;
    next();
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

router.post("/customer-auth/register", requirePublicRestaurant, async (req, res) => {
  const restaurantId = req.restaurantId;
  const name = normalizeText(req.body?.name || req.body?.username);
  const phone = normalizePhone(req.body?.phone);
  const email = normalizeEmail(req.body?.email) || null;
  const address = normalizeText(req.body?.address) || null;
  const password = normalizeText(req.body?.password);
  const language =
    normalizeLanguage(req.body?.language) ||
    normalizeLanguage(req.get?.("accept-language")) ||
    null;

  if (!name || !phone || !password) {
    return res.status(400).json({ error: "Name, phone, and password are required" });
  }

  await ensureQrCustomerAuthSchema();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [restaurantId, phone]);

    const existingAuth = await loadQrCustomerAuth(restaurantId, phone, client);
    if (existingAuth?.customer_id) {
      await client.query("ROLLBACK");
      return res
        .status(409)
        .json({ error: "An account already exists for this phone number. Please log in." });
    }

    const customerId = await upsertCustomerProfile({
      runner: client,
      restaurantId,
      name,
      phone,
      email,
      address,
    });

    const passwordHash = await bcrypt.hash(password, 10);
    await client.query(
      `
        INSERT INTO qr_customer_auth
          (restaurant_id, customer_id, phone, password_hash, language)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [restaurantId, customerId, phone, passwordHash, language]
    );

    await client.query("COMMIT");

    const customer = await getQrCustomerProfileById(restaurantId, customerId);
    const token = signQrCustomerToken({
      customerId,
      restaurantId,
      phone,
    });

    return res.status(201).json({ token, customer });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("❌ QR customer register rollback failed:", rollbackErr);
    }
    console.error("❌ QR customer register failed:", err);
    return res.status(500).json({ error: "Failed to register customer account" });
  } finally {
    client.release();
  }
});

router.post("/customer-auth/login", requirePublicRestaurant, async (req, res) => {
  const restaurantId = req.restaurantId;
  const login = normalizeText(req.body?.login || req.body?.phone || req.body?.email);
  const phone = normalizePhone(login);
  const email = normalizeEmail(login);
  const password = normalizeText(req.body?.password);

  if ((!phone && !email) || !password) {
    return res.status(400).json({ error: "Phone number or email and password are required" });
  }

  try {
    await ensureQrCustomerAuthSchema();

    const authRecord = phone
      ? await loadQrCustomerAuth(restaurantId, phone)
      : await loadQrCustomerAuthByEmail(restaurantId, email);
    if (!authRecord?.customer_id) {
      return res
        .status(404)
        .json({ error: "No account found for this phone number or email. Please register." });
    }

    const isValid = await bcrypt.compare(password, authRecord.password_hash || "");
    if (!isValid) {
      return res.status(401).json({ error: "Incorrect password." });
    }

    const customer = await getQrCustomerProfileById(restaurantId, authRecord.customer_id);
    if (!customer?.id) {
      return res.status(404).json({ error: "Customer account not found" });
    }

    const token = signQrCustomerToken({
      customerId: authRecord.customer_id,
      restaurantId,
      phone: authRecord.phone,
    });

    return res.json({ token, customer });
  } catch (err) {
    console.error("❌ QR customer login failed:", err);
    return res.status(500).json({ error: "Failed to log in" });
  }
});

router.get(
  "/customer-auth/me",
  requirePublicRestaurant,
  requireQrCustomerSession,
  async (req, res) => {
    return res.json({ customer: req.qrCustomer });
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
