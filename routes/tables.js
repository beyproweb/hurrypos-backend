const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const { pool } = require("../db");

router.use(authMiddleware);

async function ensureTableColumns() {
  try {
    await pool.query(`
      ALTER TABLE tables
        ADD COLUMN IF NOT EXISTS color TEXT,
        ADD COLUMN IF NOT EXISTS label TEXT,
        ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE
    `);
  } catch (err) {
    console.warn("⚠️ Could not ensure tables columns:", err.message);
  }
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tables_restaurant_number
      ON tables(restaurant_id, number)
    `);
  } catch (err) {
    console.warn("⚠️ Could not create tables index:", err.message);
  }
}

// GET /api/tables — list table configs
router.get("/", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  await ensureTableColumns();
  try {
    const { rows } = await pool.query(
      `SELECT number, is_occupied, COALESCE(active, TRUE) AS active, color, label
       FROM tables
       WHERE restaurant_id = $1
       ORDER BY number ASC`,
      [restaurantId]
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ Failed to fetch tables:", err);
    res.status(500).json({ error: "Failed to load tables" });
  }
});

// PUT /api/tables/count { total }
router.put("/count", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  let { total } = req.body || {};
  total = parseInt(total, 10);
  if (!Number.isFinite(total) || total < 0 || total > 500) {
    return res.status(400).json({ error: "Invalid total" });
  }
  await ensureTableColumns();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT number FROM tables WHERE restaurant_id = $1`,
      [restaurantId]
    );
    const existingSet = new Set(existing.rows.map((r) => Number(r.number)));

    // Upsert 1..total as active
    for (let n = 1; n <= total; n++) {
      if (existingSet.has(n)) {
        await client.query(
          `UPDATE tables SET active = TRUE WHERE restaurant_id = $1 AND number = $2`,
          [restaurantId, n]
        );
      } else {
        await client.query(
          `INSERT INTO tables (restaurant_id, number, is_occupied, active)
           VALUES ($1, $2, FALSE, TRUE)`,
          [restaurantId, n]
        );
      }
    }

    // Deactivate tables beyond total
    await client.query(
      `UPDATE tables SET active = FALSE
       WHERE restaurant_id = $1 AND number > $2`,
      [restaurantId, total]
    );

    await client.query("COMMIT");
    res.json({ success: true, total });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to set table count:", err);
    res.status(500).json({ error: "Failed to update table count" });
  } finally {
    client.release();
  }
});

// PATCH /api/tables/:number — update single table config
router.patch("/:number", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const number = parseInt(req.params.number, 10);
  if (!Number.isFinite(number) || number <= 0) {
    return res.status(400).json({ error: "Invalid table number" });
  }
  const { color, label, active } = req.body || {};
  await ensureTableColumns();
  try {
    // Upsert style
const { rows } = await pool.query(
  `SELECT number FROM tables WHERE restaurant_id = $1 AND number = $2`,
  [restaurantId, number]
);

    if (rows.length) {
      const fields = [];
      const params = [];
      let idx = 1;
      if (color !== undefined) { fields.push(`color = $${idx++}`); params.push(color); }
      if (label !== undefined) { fields.push(`label = $${idx++}`); params.push(label); }
      if (active !== undefined) { fields.push(`active = $${idx++}`); params.push(!!active); }
      if (fields.length === 0) return res.json({ success: true });

      params.push(restaurantId, number);
      await pool.query(
        `UPDATE tables SET ${fields.join(", ")}
         WHERE restaurant_id = $${idx++} AND number = $${idx}
        `,
        params
      );
    } else {
      await pool.query(
        `INSERT INTO tables (restaurant_id, number, is_occupied, color, label, active)
         VALUES ($1, $2, FALSE, $3, $4, COALESCE($5, TRUE))`,
        [restaurantId, number, color || null, label || null, active]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to update table:", err);
    res.status(500).json({ error: "Failed to update table" });
  }
});

module.exports = router;

