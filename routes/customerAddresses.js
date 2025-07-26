const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// GET all addresses for a customer
router.get('/customers/:customerId/addresses', async (req, res) => {
  const { customerId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT id, label, address, is_default FROM customer_addresses WHERE customer_id = $1 ORDER BY is_default DESC, id ASC`,
      [customerId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch addresses" });
  }
});

// ADD address for a customer
router.post('/customers/:customerId/addresses', async (req, res) => {
  const { customerId } = req.params;
  const { label, address, is_default } = req.body;
  if (!address) return res.status(400).json({ error: "Address required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // If is_default, unset old defaults for this customer
    if (is_default) {
      await client.query(
        `UPDATE customer_addresses SET is_default = FALSE WHERE customer_id = $1`,
        [customerId]
      );
    }
    // If this is the first address, force is_default = true
    const { rows: existing } = await client.query(
      `SELECT COUNT(*) FROM customer_addresses WHERE customer_id = $1`, [customerId]
    );
    const forceDefault = existing[0].count === "0";
    const finalDefault = is_default || forceDefault;

    const result = await client.query(
      `INSERT INTO customer_addresses (customer_id, label, address, is_default)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [customerId, label || "Home", address, finalDefault]
    );

    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Failed to add address" });
  } finally {
    client.release();
  }
});

// UPDATE address by id
router.patch('/customer-addresses/:addressId', async (req, res) => {
  const { addressId } = req.params;
  const { label, address, is_default } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Fetch address to get customer_id
    const { rows } = await client.query(
      `SELECT customer_id FROM customer_addresses WHERE id = $1`, [addressId]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Address not found" });
    const customerId = rows[0].customer_id;

    // If setting default, unset old defaults
    if (is_default) {
      await client.query(
        `UPDATE customer_addresses SET is_default = FALSE WHERE customer_id = $1`,
        [customerId]
      );
    }

    const result = await client.query(
      `UPDATE customer_addresses
         SET label = COALESCE($1, label),
             address = COALESCE($2, address),
             is_default = COALESCE($3, is_default)
         WHERE id = $4
         RETURNING *`,
      [label, address, is_default, addressId]
    );
    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Failed to update address" });
  } finally {
    client.release();
  }
});

// DELETE address by id
router.delete('/customer-addresses/:addressId', async (req, res) => {
  const { addressId } = req.params;
  try {
    await pool.query(
      `DELETE FROM customer_addresses WHERE id = $1`, [addressId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete address" });
  }
});

module.exports = router;
