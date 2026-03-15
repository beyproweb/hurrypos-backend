const express = require("express");
const router = express.Router();
const { pool } = require("../db");

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
