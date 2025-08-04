const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// Allowed setting sections
const allowedSections = [
  "notifications", "appearance", "payments", "register",
  "users", "subscription", "integrations", "log_files" ,"localization"
];

// POST /settings/shop-hours
router.post("/shop-hours/all", async (req, res) => {
  const { hours } = req.body;

  if (!hours || typeof hours !== "object") {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const [day, { open, close }] of Object.entries(hours)) {
      await client.query(`
        INSERT INTO shop_hours (day, open_time, close_time)
        VALUES ($1, $2, $3)
        ON CONFLICT (day) DO UPDATE
        SET open_time = EXCLUDED.open_time,
            close_time = EXCLUDED.close_time
      `, [day, open, close]);
    }

    await client.query("COMMIT");
    res.json({ message: "Shop hours updated" });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to save shop hours:", err);
    res.status(500).json({ error: "Failed to save shop hours" });
  } finally {
    client.release();
  }
});

// ✅ LOG ROUTES (under /api/settings/logs)

// Supplier cart logs
router.get("/logs/suppliers", async (req, res) => {
  const { from, to } = req.query;

  try {
    const result = await pool.query(
      `
      SELECT
        to_char(sc.scheduled_at, 'YYYY-MM-DD') AS date,
        'Supplier Order to ID ' || sc.supplier_id || ' (' || COUNT(sci.id) || ' items)' AS action,
        'System' AS user
      FROM supplier_carts sc
      LEFT JOIN supplier_cart_items sci ON sci.cart_id = sc.id
      WHERE sc.archived = true
        AND sc.scheduled_at BETWEEN $1 AND $2
      GROUP BY sc.id
      ORDER BY sc.scheduled_at DESC
      `,
      [from || "2000-01-01", to || "2100-01-01"]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching supplier cart logs:", err);
    res.status(500).json({ error: "Failed to fetch supplier cart logs." });
  }
});

// Payment logs
router.get("/logs/payments", async (req, res) => {
  const { from, to } = req.query;
  try {
    const result = await pool.query(
      `
      SELECT to_char(delivery_date, 'YYYY-MM-DD') AS date,
             'Paid ' || amount_paid || '₺ via ' || payment_method AS action,
             'System' AS user
      FROM transactions
      WHERE ingredient = 'Payment'
        AND delivery_date BETWEEN $1 AND $2
      ORDER BY delivery_date DESC
      `,
      [from || "2000-01-01", to || "2100-01-01"]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Payment logs failed:", err);
    res.status(500).json({ error: "Payment log error" });
  }
});

// Register logs
router.get("/logs/:type", async (req, res) => {
  const { type } = req.params;
  const { from, to } = req.query;
  const fromDate = from || "2000-01-01";
  const toDate = to || "2100-01-01";

  try {
    let result;

    if (type === "register") {
      result = await pool.query(
        `
          SELECT date::text AS date, type AS action, 'System' AS user
          FROM cash_register_logs
          WHERE date BETWEEN $1 AND $2
          ORDER BY date DESC
        `,
        [fromDate, toDate]
      );
    } else if (type === "login") {
      // Example for login logs; adapt this for your actual table/fields!
      result = await pool.query(
        `
          SELECT
            to_char(login_time, 'YYYY-MM-DD') AS date,
            'User Login: ' || username AS action,
            username AS user
          FROM user_login_logs
          WHERE login_time BETWEEN $1 AND $2
          ORDER BY login_time DESC
        `,
        [fromDate, toDate]
      );
    } else {
      // Add more else-if blocks for new log types as needed.
      return res.status(400).json({ error: `Log type "${type}" not supported.` });
    }

    res.json(result.rows);
  } catch (err) {
    console.error(`❌ Error fetching ${type} logs:`, err);
    res.status(500).json({ error: `Log fetch failed for ${type}` });
  }
});


router.get("/shop-hours/all", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT day, open_time, close_time
      FROM shop_hours
      ORDER BY id
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Failed to load shop hours:", err);
    res.status(500).json({ error: "Failed to load shop hours" });
  }
});

router.get("/localization", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT key, value FROM settings WHERE key IN ('language', 'currency')`
    );

    const settings = {};
    result.rows.forEach(({ key, value }) => {
      settings[key] = value;
    });

    res.json(settings);
  } catch (err) {
    console.error("❌ Error fetching localization:", err);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

router.post("/localization", async (req, res) => {
  const { language, currency } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO settings (key, value)
       VALUES ('language', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [language]
    );

    await client.query(
      `INSERT INTO settings (key, value)
       VALUES ('currency', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [currency]
    );

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Error saving localization settings:", err);
    res.status(500).json({ error: "Failed to save settings" });
  } finally {
    client.release();
  }
});

// ✅ GET /api/settings/:section
router.get("/:section", async (req, res) => {
  const { section } = req.params;

  if (!allowedSections.includes(section)) {
    console.warn(`⚠️ Invalid GET section: ${section}`);
    return res.status(400).json({ error: "Invalid section" });
  }

  try {
    const result = await pool.query(
      `SELECT ${section} FROM settings WHERE key = 'global' LIMIT 1`
    );
    const raw = result.rows?.[0]?.[section] || {};

    const defaults = {
      notifications: {
        enabled: true,
        defaultSound: "ding",
        channels: { kitchen: "app", cashier: "app", manager: "app" },
        escalation: { enabled: true, delayMinutes: 3 },
        eventSounds: {
          new_order: "new_order.mp3",
          order_preparing: "pop",
          order_ready: "chime",
          order_delivered: "success",
          payment_made: "cash",
          stock_low: "warning",
          stock_restocked: "ding",
          order_delayed: "alarm",
          driver_arrived: "horn",
        },
      }
    };

    const merged = section === "notifications"
      ? {
          ...defaults.notifications,
          ...raw,
          eventSounds: {
            ...defaults.notifications.eventSounds,
            ...(raw?.eventSounds || {}),
          },
        }
      : raw;

    res.json(merged);
  } catch (err) {
    console.error(`❌ Failed to fetch ${section} settings:`, err);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

// ✅ POST /api/settings/:section
router.post("/:section", async (req, res) => {
  const { section } = req.params;
  let newData = req.body;

  if (!allowedSections.includes(section)) {
    console.warn(`⚠️ Invalid POST section: ${section}`);
    return res.status(400).json({ error: "Invalid section" });
  }

  if (section === "notifications") {
    const defaults = {
      enabled: true,
      defaultSound: "ding",
      channels: { kitchen: "app", cashier: "app", manager: "app" },
      escalation: { enabled: true, delayMinutes: 3 },
      eventSounds: {
        new_order: "new_order.mp3",
        order_preparing: "pop",
        order_ready: "chime",
        order_delivered: "success",
        payment_made: "cash",
        stock_low: "warning",
        stock_restocked: "ding",
        order_delayed: "alarm",
        driver_arrived: "horn",
      },
    };

    newData = {
      ...defaults,
      ...newData,
      eventSounds: {
        ...defaults.eventSounds,
        ...(newData?.eventSounds || {}),
      },
    };
  }

  try {
    await pool.query(
      `UPDATE settings SET ${section} = $1::jsonb WHERE key = 'global'`,
      [JSON.stringify(newData)]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(`❌ Failed to save ${section} settings:`, err);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

// GET /api/settings/qr-menu-disabled
router.get("/qr-menu-disabled", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT value FROM settings WHERE key = 'qr-menu-disabled' LIMIT 1"
    );
    res.json({ disabled: result.rows[0]?.value === "true" });
  } catch (err) {
    console.error("❌ Failed to fetch qr-menu-disabled:", err);
    res.status(500).json({ error: "Failed to fetch qr-menu-disabled" });
  }
});

// POST /api/settings/qr-menu-disabled
router.post("/qr-menu-disabled", async (req, res) => {
  const { disabled } = req.body; // expects boolean
  try {
    await pool.query(
      `INSERT INTO settings (key, value)
       VALUES ('qr-menu-disabled', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(!!disabled)]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to update qr-menu-disabled:", err);
    res.status(500).json({ error: "Failed to update qr-menu-disabled" });
  }
});


module.exports = router;
