const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");

router.use(authMiddleware);

// POST /api/customers - Create new customer (tenant safe)
router.post("/", async (req, res) => {
  const { name, phone, birthday, email } = req.body;
  const restaurantId = req.user.restaurant_id;
  if (!name || !phone) return res.status(400).json({ error: "Name and phone required" });

  try {
    const result = await pool.query(
      `INSERT INTO customers (restaurant_id, name, phone, birthday, email)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [restaurantId, name, phone, birthday || null, email || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error creating customer:", err);
    res.status(500).json({ error: "Failed to create customer" });
  }
});

// PATCH /api/customers/:id - Update (tenant safe)
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const restaurantId = req.user.restaurant_id;
  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(req.body)) {
    if (["name", "phone", "birthday", "email"].includes(key)) {
      fields.push(`${key} = $${idx++}`);
      values.push(value);
    }
  }
  if (!fields.length) return res.status(400).json({ error: "No valid fields" });

  values.push(restaurantId);
  values.push(id);
  const sql = `UPDATE customers SET ${fields.join(", ")}
               WHERE restaurant_id = $${idx++} AND id = $${idx}
               RETURNING *`;

  try {
    const result = await pool.query(sql, values);
    if (!result.rows.length) return res.status(404).json({ error: "Customer not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error updating customer:", err);
    res.status(500).json({ error: "Failed to update customer" });
  }
});

// GET /api/customers?search=...
router.get("/", async (req, res) => {
  const search = req.query.search || "";
  const restaurantId = req.user.restaurant_id;
  try {
    const { rows } = await pool.query(
      `
      SELECT
        c.id, c.name, c.phone, c.address, c.birthday, c.email,
        COALESCE(COUNT(o.id), 0) AS visit_count,
        COALESCE(SUM(o.total), 0) AS lifetime_value,
        MAX(o.created_at) AS last_visit
      FROM customers c
      LEFT JOIN orders o
        ON o.restaurant_id = $1
       AND o.customer_phone = c.phone
      WHERE c.restaurant_id = $1
        AND (c.name ILIKE $2 OR c.phone ILIKE $2)
      GROUP BY c.id, c.name, c.phone, c.address, c.email
      ORDER BY visit_count DESC, last_visit DESC
      LIMIT 50
      `,
      [restaurantId, `%${search}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching customers:", err);
    res.status(500).json({ error: "Failed to fetch customers" });
  }
});

// GET /api/customers/by-phone/:phone
router.get("/by-phone/:phone", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  try {
    const { rows } = await pool.query(
      "SELECT * FROM customers WHERE restaurant_id = $1 AND phone = $2 LIMIT 1",
      [restaurantId, req.params.phone]
    );
    if (!rows.length) return res.json(null);
    const c = rows[0];
    const { rows: addrs } = await pool.query(
      `SELECT id,label,address,is_default
       FROM customer_addresses
       WHERE customer_id = $1
       ORDER BY is_default DESC, id ASC`,
      [c.id]
    );
    res.json({ ...c, addresses: addrs });
  } catch (err) {
    console.error("❌ Error fetching customer by phone:", err);
    res.status(500).json({ error: "Failed to fetch customer" });
  }
});

// GET birthdays (tenant safe)
router.get("/birthdays", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  try {
    const { rows } = await pool.query(`
      SELECT
        c.id, c.name, c.phone,
        TO_CHAR(c.birthday, 'YYYY-MM-DD') AS birthday,
        COUNT(o.id) AS visit_count,
        COALESCE(SUM(o.total), 0) AS lifetime_value,
        MAX(o.created_at) AS last_visit
      FROM customers c
      LEFT JOIN orders o ON o.customer_phone = c.phone AND o.restaurant_id = $1
      WHERE c.restaurant_id = $1
        AND EXTRACT(MONTH FROM c.birthday) = EXTRACT(MONTH FROM CURRENT_DATE)
      GROUP BY c.id, c.name, c.phone, c.birthday
      ORDER BY visit_count DESC, birthday ASC
    `, [restaurantId]);
    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching birthdays:", err);
    res.status(500).json({ error: "Failed to fetch birthdays" });
  }
});

module.exports = router;
