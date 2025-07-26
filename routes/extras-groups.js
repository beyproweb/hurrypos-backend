// routes/extras-groups.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// GET /api/extras-groups - fetch ALL groups with their items
// GET /api/extras-groups - Fetch all groups WITH items
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        g.id,
        g.group_name,
        COALESCE(
          json_agg(json_build_object('id', i.id, 'name', i.ingredient_name, 'extraPrice', i.price))
          FILTER (WHERE i.id IS NOT NULL),
          '[]'
        ) AS items
      FROM extras_groups g
      LEFT JOIN extras_group_items i ON i.group_id = g.id
      GROUP BY g.id, g.group_name
      ORDER BY g.id ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching extras groups:", err.stack || err);
    res.status(500).json({ error: "Database error" });
  }
});

// (Optional) GET /api/extras-groups/:id - fetch single group
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM extras_groups WHERE id = $1", [id]);
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error fetching group by id:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// POST /api/extras-groups - create new group with items
router.post("/", async (req, res) => {
  const { group_name, items } = req.body;
  if (!group_name || !Array.isArray(items)) {
    return res.status(400).json({ error: "Invalid payload" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const groupRes = await client.query(
      "INSERT INTO extras_groups (group_name) VALUES ($1) RETURNING id, group_name",
      [group_name]
    );
    const groupId = groupRes.rows[0].id;
    for (const item of items) {
      if (!item.name) continue;
      await client.query(
        "INSERT INTO extras_group_items (group_id, ingredient_name, price) VALUES ($1, $2, $3)",
        [groupId, item.name, item.price || 0]
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
// PUT /api/extras-groups/:id - update group name and replace items
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { group_name, items } = req.body;
  if (!group_name || !Array.isArray(items)) {
    return res.status(400).json({ error: "Invalid payload" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE extras_groups SET group_name = $1 WHERE id = $2",
      [group_name, id]
    );
    await client.query("DELETE FROM extras_group_items WHERE group_id = $1", [id]);
    for (const item of items) {
      if (!item.name) continue;
      await client.query(
        "INSERT INTO extras_group_items (group_id, ingredient_name, price) VALUES ($1, $2, $3)",
        [id, item.name, item.price || 0]
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

// DELETE /api/extras-groups/:id - Delete an extras group and its items
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    // First, delete all items in this group
    await pool.query("DELETE FROM extras_group_items WHERE group_id = $1", [id]);
    // Then, delete the group itself
    await pool.query("DELETE FROM extras_groups WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error deleting group:", err.stack || err);
    res.status(500).json({ error: "Database error" });
  }
});


module.exports = router;
