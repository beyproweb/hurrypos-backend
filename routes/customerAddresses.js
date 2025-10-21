const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");

// 🔐 Require auth for tenant-safe scoping
router.use(authMiddleware);

// GET all addresses for a customer (tenant-safe)
router.get("/customers/:customerId/addresses", async (req, res) => {
  const { customerId } = req.params;
  const restaurantId = req.user.restaurant_id;
  try {
    const { rows } = await pool.query(
      `SELECT id, label, address, is_default
         FROM customer_addresses
        WHERE restaurant_id = $1 AND customer_id = $2
        ORDER BY is_default DESC, id ASC`,
      [restaurantId, customerId]
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ Failed to fetch addresses:", err);
    res.status(500).json({ error: "Failed to fetch addresses" });
  }
});

// ADD address for a customer (tenant-safe)
router.post("/customers/:customerId/addresses", async (req, res) => {
  const { customerId } = req.params;
  const { label, address, is_default } = req.body;
  const restaurantId = req.user.restaurant_id;

  if (!address) return res.status(400).json({ error: "Address required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // If is_default, unset other defaults for this tenant+customer
    if (is_default) {
      await client.query(
        `UPDATE customer_addresses
            SET is_default = FALSE
          WHERE restaurant_id = $1 AND customer_id = $2`,
        [restaurantId, customerId]
      );
    }

    // If this is the first address, force default = true (tenant-safe)
    const { rows: existing } = await client.query(
      `SELECT COUNT(*)::int AS cnt
         FROM customer_addresses
        WHERE restaurant_id = $1 AND customer_id = $2`,
      [restaurantId, customerId]
    );
    const forceDefault = (existing[0]?.cnt || 0) === 0;
    const finalDefault = !!(is_default || forceDefault);

    const result = await client.query(
      `INSERT INTO customer_addresses
         (restaurant_id, customer_id, label, address, is_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, label, address, is_default`,
      [restaurantId, customerId, label || "Home", address, finalDefault]
    );

    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to add address:", err);
    res.status(500).json({ error: "Failed to add address" });
  } finally {
    client.release();
  }
});

// UPDATE address by id (tenant-safe, fixed params)
router.patch("/customer-addresses/:addressId", async (req, res) => {
  const { addressId } = req.params;
  const { label, address, is_default } = req.body;
  const restaurantId = req.user.restaurant_id;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ✅ Fetch address to get the tenant+customer it belongs to
    const { rows } = await client.query(
      `SELECT customer_id
         FROM customer_addresses
        WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, addressId]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Address not found" });
    }
    const customerId = rows[0].customer_id;

    // If setting default, unset old defaults for this customer (tenant-safe)
    if (is_default === true) {
      await client.query(
        `UPDATE customer_addresses
            SET is_default = FALSE
          WHERE restaurant_id = $1 AND customer_id = $2`,
        [restaurantId, customerId]
      );
    }

    const result = await client.query(
      `UPDATE customer_addresses
          SET label = COALESCE($1, label),
              address = COALESCE($2, address),
              is_default = COALESCE($3, is_default)
        WHERE restaurant_id = $4 AND id = $5
        RETURNING id, label, address, is_default`,
      [label ?? null, address ?? null, is_default ?? null, restaurantId, addressId]
    );

    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to update address:", err);
    res.status(500).json({ error: "Failed to update address" });
  } finally {
    client.release();
  }
});

// DELETE address by id (tenant-safe, fixed params)
router.delete("/customer-addresses/:addressId", async (req, res) => {
  const { addressId } = req.params;
  const restaurantId = req.user.restaurant_id;

  try {
    await pool.query(
      `DELETE FROM customer_addresses
        WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, addressId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to delete address:", err);
    res.status(500).json({ error: "Failed to delete address" });
  }
});

module.exports = router;
