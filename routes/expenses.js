const express = require("express");
const router = express.Router();
const { pool } = require("../db");

router.post("/expenses", async (req, res) => {
  const { type, amount, note, payment_method, created_by } = req.body;

  if (!type || !amount || isNaN(parseFloat(amount))) {
    return res.status(400).json({ error: "Missing or invalid 'type' or 'amount'" });
  }

  const allowedMethods = ["Cash", "Credit Card", "Bank Transfer", "Not Paid"];
  if (payment_method && !allowedMethods.includes(payment_method)) {
    return res.status(400).json({ error: "Invalid payment method" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO expenses (type, amount, note, payment_method, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        type.trim(),
        parseFloat(amount),
        note?.trim() || null,
        payment_method || null,
        created_by || null,
      ]
    );
    res.json({ success: true, expense: result.rows[0] });
  } catch (err) {
    console.error("❌ Failed to insert expense:", err);
    res.status(500).json({ error: "Failed to save expense" });
  }
});


router.get("/expenses", async (req, res) => {
  const { from, to, type } = req.query;

  try {
    let query = `SELECT * FROM expenses WHERE TRUE`;
    const params = [];

    if (from) {
      params.push(from);
      query += ` AND created_at >= $${params.length}`;
    }
    if (to) {
      params.push(to);
      query += ` AND created_at < ($${params.length}::date + INTERVAL '1 day')`;
    }
    if (type) {
      params.push(type);
      query += ` AND type = $${params.length}`;
    }

    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Failed to fetch expenses:", err);
    res.status(500).json({ error: "Could not load expenses" });
  }
});

router.get("/expenses/types", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT type FROM expenses ORDER BY type ASC
    `);
    res.json(result.rows.map(r => r.type));
  } catch (err) {
    console.error("❌ Failed to fetch expense types:", err);
    res.status(500).json({ error: "Could not fetch types" });
  }
});


router.delete("/expenses/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(`DELETE FROM expenses WHERE id = $1`, [id]);
    res.json({ success: true, message: "Expense deleted" });
  } catch (err) {
    console.error("❌ Failed to delete expense:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

module.exports = router;