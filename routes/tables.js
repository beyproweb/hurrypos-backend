const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const { attachAllowedModules } = require("../middleware/moduleGuard");
const { pool } = require("../db");
const jwt = require("jsonwebtoken");

// Secret for signing table-level QR tokens
const TABLE_QR_SECRET =
  process.env.TABLE_QR_SECRET ||
  process.env.JWT_SECRET ||
  "table_qr_secret_2025";

router.use(authMiddleware);
router.use(async (req, res, next) => {
  const allowed = await attachAllowedModules(req);
  if (Array.isArray(allowed) && !allowed.includes("pos_core")) {
    const isAllowed =
      req.method === "GET" &&
      (req.path === "/" || /^\/\d+\/qr-token\/?$/.test(req.path || ""));
    const isAllowedWrite =
      req.method === "PUT" && /^\/count\/?$/.test(req.path || "");
    if (!isAllowed && !isAllowedWrite) {
      return res.status(403).json({ error: "MODULE_NOT_ALLOWED" });
    }
  }
  return next();
});

async function ensureTableColumns() {
  try {
    await pool.query(`
      ALTER TABLE tables
        ADD COLUMN IF NOT EXISTS color TEXT,
        ADD COLUMN IF NOT EXISTS label TEXT,
        ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS seats INTEGER,
        ADD COLUMN IF NOT EXISTS area TEXT,
        ADD COLUMN IF NOT EXISTS guests INTEGER
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
  const activeOnly =
    req.query.active === "true" ||
    (Array.isArray(req.allowed_modules) && !req.allowed_modules.includes("pos_core"));

  try {
    const { rows } = await pool.query(
      `SELECT number,
              COALESCE(active, TRUE) AS active,
              color, label,
              seats,
              area,
              guests
       FROM tables
       WHERE restaurant_id = $1
         ${activeOnly ? "AND COALESCE(active, TRUE) = TRUE" : ""}
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
          `INSERT INTO tables (restaurant_id, number, active)
           VALUES ($1, $2, TRUE)`,
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

// GET /api/tables/:number/qr-token — generate a short-lived JWT for this table
router.get("/:number/qr-token", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const number = parseInt(req.params.number, 10);

  if (!Number.isFinite(number) || number <= 0) {
    return res.status(400).json({ error: "Invalid table number" });
  }

  try {
    // Ensure the table exists for this restaurant
    const existing = await pool.query(
      `SELECT id FROM tables WHERE restaurant_id = $1 AND number = $2 LIMIT 1`,
      [restaurantId, number]
    );

    if (!existing.rows.length) {
      return res.status(404).json({ error: "Table not found" });
    }

    const token = jwt.sign(
      {
        type: "table",
        restaurant_id: restaurantId,
        table_number: number,
      },
      TABLE_QR_SECRET,
      { expiresIn: "7d" }
    );

    const restaurantRes = await pool.query(
      "SELECT slug, qr_code_id FROM restaurants WHERE id = $1 LIMIT 1",
      [restaurantId]
    );
    const restaurant = restaurantRes.rows[0] || {};
    const identifier =
      restaurant.slug ||
      restaurant.qr_code_id ||
      String(restaurantId);

    const base =
      process.env.PUBLIC_QR_BASE_URL ||
      process.env.QR_BASE_URL ||
      "https://pos.beypro.com";
    const cleanBase = base.replace(/\/+$/, "");

    const url = `${cleanBase}/qr?mode=table&table=${encodeURIComponent(
      number
    )}&token=${encodeURIComponent(token)}&identifier=${encodeURIComponent(identifier)}`;

    res.json({ success: true, token, url });
  } catch (err) {
    console.error("❌ Failed to generate table QR token:", err);
    res.status(500).json({ error: "Failed to generate table QR token" });
  }
});

// PATCH /api/tables/:number — update single table config
router.patch("/:number", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const number = parseInt(req.params.number, 10);

  if (!Number.isFinite(number) || number <= 0) {
    return res.status(400).json({ error: "Invalid table number" });
  }

  // Now receiving new fields:
  const { color, label, active, seats, area, guests } = req.body || {};

  await ensureTableColumns();

  try {
    let guestsValue = undefined;
    if (guests !== undefined) {
      if (guests === null || guests === "") {
        guestsValue = null;
      } else {
        const guestsNum = Number(guests);
        if (!Number.isFinite(guestsNum) || guestsNum < 0 || guestsNum > 500) {
          return res.status(400).json({ error: "Invalid guests" });
        }
        guestsValue = Math.trunc(guestsNum);
      }
    }

    // Does table exist?
    const { rows } = await pool.query(
      `SELECT number FROM tables 
       WHERE restaurant_id = $1 AND number = $2`,
      [restaurantId, number]
    );

    if (rows.length) {
      // === UPDATE EXISTING ENTRY ===
      const fields = [];
      const params = [];
      let idx = 1;

      if (color !== undefined) {
        fields.push(`color = $${idx++}`);
        params.push(color);
      }
      if (label !== undefined) {
        fields.push(`label = $${idx++}`);
        params.push(label);
      }
      if (active !== undefined) {
        fields.push(`active = $${idx++}`);
        params.push(!!active);
      }
      if (seats !== undefined) {
        fields.push(`seats = $${idx++}`);
        params.push(Number(seats));
      }
      if (area !== undefined) {
        fields.push(`area = $${idx++}`);
        params.push(area);
      }
      if (guestsValue !== undefined) {
        fields.push(`guests = $${idx++}`);
        params.push(guestsValue);
      }

      // Nothing to update
      if (fields.length === 0) {
        return res.json({ success: true });
      }

      // Add WHERE params
      params.push(restaurantId, number);

      await pool.query(
        `UPDATE tables 
         SET ${fields.join(", ")}
         WHERE restaurant_id = $${idx++} AND number = $${idx}`,
        params
      );
    } else {
      // === INSERT NEW ENTRY ===
      await pool.query(
        `INSERT INTO tables 
           (restaurant_id, number, color, label, active, seats, area, guests)
         VALUES ($1, $2, $3, $4, COALESCE($5, TRUE), $6, $7, $8)`,
        [
          restaurantId,
          number,
          color || null,
          label || null,
          active,
          seats || null,
          area || null,
          guestsValue === undefined ? null : guestsValue,
        ]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to update table:", err);
    res.status(500).json({ error: "Failed to update table" });
  }
});

module.exports = router;
