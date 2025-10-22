// routes/extras-groups.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");

async function resolveRestaurantId(req) {
  const identifier = req.query.identifier;
  let restaurant_id = req.user?.restaurant_id;

  if (identifier) {
    if (/^\d+$/.test(identifier)) {
      restaurant_id = Number(identifier);
    } else {
      const result = await pool.query("SELECT id FROM restaurants WHERE slug = $1", [identifier]);
      restaurant_id = result.rows[0]?.id;
    }
  }

  return restaurant_id;
}

/**
 * GET /api/extras-groups
 * Fetch all extras groups for the current tenant (restaurant)
 */
router.get("/", async (req, res) => {
  const restaurant_id = await resolveRestaurantId(req);
  if (!restaurant_id) return res.status(400).json({ error: "Missing restaurant ID" });

  try {
    const result = await pool.query(
      `
      SELECT
        g.id,
        g.group_name,
        COALESCE(
          json_agg(
            json_build_object(
              'id', i.id,
              'name', i.ingredient_name,
              'extraPrice', i.price,
              'unit', i.unit,
              'amount', i.amount
            )
          ) FILTER (WHERE i.id IS NOT NULL),
          '[]'
        ) AS items
      FROM extras_groups g
      LEFT JOIN extras_group_items i ON i.group_id = g.id
      WHERE g.restaurant_id = $1
      GROUP BY g.id, g.group_name
      ORDER BY g.id ASC
      `,
      [restaurant_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching extras groups:", err.stack || err);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * GET /api/extras-groups/:id
 * Fetch one group with all its items
 */
router.get("/:id", async (req, res) => {
  const restaurant_id = await resolveRestaurantId(req);
  const { id } = req.params;
  if (!restaurant_id) return res.status(400).json({ error: "Missing restaurant ID" });

  try {
    const result = await pool.query(
      `
      SELECT
        g.id,
        g.group_name,
        COALESCE(
          json_agg(
            json_build_object(
              'id', i.id,
              'name', i.ingredient_name,
              'extraPrice', i.price,
              'unit', i.unit,
              'amount', i.amount
            )
          ) FILTER (WHERE i.id IS NOT NULL),
          '[]'
        ) AS items
      FROM extras_groups g
      LEFT JOIN extras_group_items i ON i.group_id = g.id
      WHERE g.restaurant_id = $1 AND g.id = $2
      GROUP BY g.id, g.group_name
      `,
      [restaurant_id, id]
    );

    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error fetching extras group by id:", err.stack || err);
    res.status(500).json({ error: "Database error" });
  }
});

// Require auth for mutations and non-public endpoints
router.use(authMiddleware);

/**
 * POST /api/extras-groups
 * Create a new extras group with its items
 */
router.post("/", async (req, res) => {
  const restaurant_id = req.user?.restaurant_id;
  const { group_name, items } = req.body;

  if (!restaurant_id) return res.status(400).json({ error: "Missing restaurant ID" });
  if (!group_name || !Array.isArray(items))
    return res.status(400).json({ error: "Invalid payload" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const groupRes = await client.query(
      `INSERT INTO extras_groups (restaurant_id, group_name)
       VALUES ($1, $2)
       RETURNING id, group_name`,
      [restaurant_id, group_name]
    );
    const groupId = groupRes.rows[0].id;

    for (const item of items) {
      if (!item.name) continue;
      await client.query(
        `INSERT INTO extras_group_items
         (group_id, ingredient_name, price, amount, unit)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          groupId,
          item.name,
          item.price ?? 0,
          item.amount !== undefined && item.amount !== null && item.amount !== ""
            ? parseFloat(item.amount)
            : 1,
          item.unit || "",
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, id: groupId });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to create extras group:", err);
    res.status(500).json({ error: "Database error" });
  } finally {
    client.release();
  }
});

/**
 * PUT /api/extras-groups/:id
 * Update an existing group and replace its items
 */
router.put("/:id", async (req, res) => {
  const restaurant_id = req.user?.restaurant_id;
  const { id } = req.params;
  const { group_name, items } = req.body;

  if (!restaurant_id) return res.status(400).json({ error: "Missing restaurant ID" });
  if (!group_name || !Array.isArray(items))
    return res.status(400).json({ error: "Invalid payload" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE extras_groups
       SET group_name = $1
       WHERE restaurant_id = $2 AND id = $3`,
      [group_name, restaurant_id, id]
    );

    await client.query("DELETE FROM extras_group_items WHERE group_id = $1", [id]);

    for (const item of items) {
      if (!item.name) continue;
      await client.query(
        `INSERT INTO extras_group_items (group_id, ingredient_name, price, amount, unit)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          id,
          item.name,
          item.price ?? 0,
          item.amount !== undefined && item.amount !== null && item.amount !== ""
            ? parseFloat(item.amount)
            : 1,
          item.unit || "",
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to update extras group:", err);
    res.status(500).json({ error: "Database error" });
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/extras-groups/:id
 * Delete a group and its items
 */
router.delete("/:id", async (req, res) => {
  const restaurant_id = req.user?.restaurant_id;
  const { id } = req.params;
  if (!restaurant_id) return res.status(400).json({ error: "Missing restaurant ID" });

  try {
    await pool.query("DELETE FROM extras_group_items WHERE group_id = $1", [id]);
    await pool.query(
      "DELETE FROM extras_groups WHERE restaurant_id = $1 AND id = $2",
      [restaurant_id, id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error deleting extras group:", err.stack || err);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
