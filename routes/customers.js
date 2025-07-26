const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// POST /api/customers - Create new customer
router.post("/", async (req, res) => {

  const { name, phone, birthday, email } = req.body;
  if (!name || !phone) return res.status(400).json({ error: "Name and phone are required" });

  try {
    const result = await pool.query(
      `INSERT INTO customers (name, phone, birthday, email)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, phone, birthday || null, email || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error creating customer:", err);
    res.status(500).json({ error: "Failed to create customer" });
  }
});

// PATCH /api/customers/:id - Update customer
// PATCH /api/customers/:id - Update customer (safe)
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(req.body)) {
    if (["name", "phone", "birthday", "email"].includes(key)) {
      fields.push(`${key} = $${idx++}`);
      values.push(value);
    }
  }
  if (!fields.length) return res.status(400).json({ error: "No valid fields to update." });

  values.push(id);
  const sql = `UPDATE customers SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`;

  try {
    const result = await pool.query(sql, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Customer not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error updating customer:", err);
    res.status(500).json({ error: "Failed to update customer" });
  }
});

router.get('/', async (req, res) => {
  const search = req.query.search || '';
  try {
    const query = `
      SELECT
        c.id,
        c.name,
        c.phone,
        c.address,
        c.birthday,
        c.email,
        COALESCE(COUNT(o.id), 0) AS visit_count,
        COALESCE(SUM(o.total), 0) AS lifetime_value,
        MAX(o.created_at) AS last_visit
      FROM customers c
      LEFT JOIN orders o
        ON o.customer_phone = c.phone AND (o.customer_name = c.name OR c.name IS NULL OR c.name = '')
      WHERE c.name ILIKE $1 OR c.phone ILIKE $1
      GROUP BY c.id, c.name, c.phone, c.address, c.email
      ORDER BY visit_count DESC, last_visit DESC
      LIMIT 50
    `;
    const { rows } = await pool.query(query, [`%${search}%`]);
    res.json(rows);
  } catch (err) {
    console.error('Error searching customers:', err);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});


// GET /api/customers/birthdays
router.get("/birthdays", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c.id,
        c.name,
        c.phone,
        TO_CHAR(c.birthday, 'YYYY-MM-DD') AS birthday,
        COUNT(o.id) AS visit_count,
        COALESCE(SUM(o.total), 0) AS lifetime_value,
        MAX(o.created_at) AS last_visit
      FROM customers c
      LEFT JOIN orders o ON o.customer_phone = c.phone
      WHERE EXTRACT(MONTH FROM c.birthday) = EXTRACT(MONTH FROM CURRENT_DATE)
      GROUP BY c.id, c.name, c.phone, c.birthday
      ORDER BY visit_count DESC, birthday ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching birthday customers:", err);
    res.status(500).json({ error: "Failed to fetch birthday customers" });
  }
});

module.exports = router;
