const express = require("express");
const router = express.Router();
const { pool, io } = require("../db");
const {
  emitOrderUpdate,
  emitStockUpdate,
  emitOrderConfirmed,
  emitOrderDelivered,
  emitAlert,
} = require("../utils/realtime");

const { getIO } = require("../utils/socket");

const { generateReportPDF, generateReportCSV } = require("../utils/exportUtils");

router.post("/export/pdf", async (req, res) => {
  try {
    const { from, to, sections } = req.body;
    const pdfBuffer = await generateReportPDF({ from, to, sections });
    res.setHeader("Content-Type", "routerlication/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=report.pdf");
    res.send(pdfBuffer);
  } catch (err) {
    console.error("❌ PDF export failed:", err);
    res.status(500).send(`Failed to export PDF: ${err.message}`); // ✅ Add error message
  }
});


router.post("/export/csv", async (req, res) => {
  try {
    const { from, to, sections } = req.body;
    const csvString = await generateReportCSV({ from, to, sections });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=report.csv");
    res.send(csvString);
  } catch (err) {
    console.error("❌ CSV export failed:", err);
    res.status(500).send("Failed to export CSV");
  }
});



// GET /reports/summary - Returns gross sales, net sales, expenses today, and profit
router.get("/summary", async (req, res) => {
  try {
    const client = await pool.connect();

    // Daily sales (today only, timezone-aware)
    const dailySalesRes = await client.query(`
      SELECT COALESCE(SUM(amount), 0) AS daily_sales
      FROM receipt_methods
      WHERE created_at >= CURRENT_DATE AT TIME ZONE 'Europe/Istanbul'
        AND created_at < (CURRENT_DATE + INTERVAL '1 day') AT TIME ZONE 'Europe/Istanbul'
    `);
    const dailySales = parseFloat(dailySalesRes.rows[0].daily_sales);

    // Gross sales (all time)
    const grossSalesRes = await client.query(`
      SELECT COALESCE(SUM(total), 0) AS gross_sales
      FROM orders
      WHERE is_paid = true
    `);
    const grossSales = parseFloat(grossSalesRes.rows[0].gross_sales);

    // Net sales
    const netSalesRes = await client.query(`
      SELECT COALESCE(SUM(total - p.discount_value), 0) AS net_sales
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      JOIN products p ON oi.product_id = p.id
      WHERE o.status IN ('paid', 'closed')
    `);
    const netSales = parseFloat(netSalesRes.rows[0].net_sales);

    // Expenses today (from transactions and staff_payments)
    const [supplierRes, staffRes] = await Promise.all([
      client.query(`
        SELECT COALESCE(SUM(amount_paid), 0) AS total
        FROM transactions
        WHERE ingredient = 'Payment'
          AND delivery_date >= CURRENT_DATE AT TIME ZONE 'Europe/Istanbul'
          AND delivery_date < (CURRENT_DATE + INTERVAL '1 day') AT TIME ZONE 'Europe/Istanbul'
      `),
      client.query(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM staff_payments
        WHERE created_at >= CURRENT_DATE AT TIME ZONE 'Europe/Istanbul'
          AND created_at < (CURRENT_DATE + INTERVAL '1 day') AT TIME ZONE 'Europe/Istanbul'
      `)
    ]);

    const expensesToday =
      parseFloat(supplierRes.rows[0].total) + parseFloat(staffRes.rows[0].total);

    const profit = netSales - expensesToday;

    res.json({
      daily_sales: dailySales,
      gross_sales: grossSales,
      net_sales: netSales,
      expenses_today: expensesToday,
      profit,
    });

    client.release();
  } catch (err) {
    console.error("❌ Error in /reports/summary:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


// GET /reports/history (INCLUDE payment_method)
router.get("/history", async (req, res) => {
  const { from, to } = req.query;

  if (!from || !to) {
    return res.status(400).json({ error: "Missing from/to query parameters" });
  }

  try {
    const result = await pool.query(
      `
        SELECT
          id,
          table_number,
          status,
          total,
          order_type,
          created_at,
          receipt_id,
          customer_name,
          customer_address,
          payment_method  -- << CRUCIAL FIX: explicitly select this column
        FROM orders
        WHERE status = 'closed'
        AND created_at >= $1::date
        AND created_at < ($2::date + INTERVAL '1 day')
        ORDER BY created_at DESC
      `,
      [from, to]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching order history:", err);
    res.status(500).json({ error: "Failed to fetch order history" });
  }
});


// GET /reports/sales-by-payment-method
router.get("/sales-by-payment-method", async (req, res) => {
  const { from, to } = req.query;
  let dateFilter = "";

  if (from && to) {
    dateFilter = `AND created_at >= '${from}' AND created_at < '${to}'::date + INTERVAL '1 day'`;
  }

  try {
    const result = await pool.query(`
      SELECT payment_method, SUM(total) AS value
      FROM orders
      WHERE is_paid = true AND payment_method IS NOT NULL AND payment_method != ''
      ${dateFilter}
      GROUP BY payment_method
    `);

    const formatted = result.rows.map((row) => ({
      method: row.payment_method,
      value: parseFloat(row.value),
    }));

    res.json(formatted);
  } catch (err) {
    console.error("❌ Error fetching payment method data:", err);
    res.status(500).json({ error: "Failed to load payment method data" });
  }
});


// GET /reports/profit-loss?range=daily|weekly|monthly
router.get("/profit-loss", async (req, res) => {
  const { timeframe, from, to } = req.query;

  const startDate = from || "2000-01-01";
  const endDate = to || "2100-01-01";

  let groupByClause = "";
  let dateFormat = "";

  if (timeframe === "weekly") {
    groupByClause = "TO_CHAR(o.created_at, 'IYYY-IW')";
    dateFormat = "'IYYY-IW'";
  } else if (timeframe === "monthly") {
    groupByClause = "TO_CHAR(o.created_at, 'YYYY-MM')";
    dateFormat = "'YYYY-MM'";
  } else {
    groupByClause = "TO_CHAR(o.created_at, 'YYYY-MM-DD')";
    dateFormat = "'YYYY-MM-DD'";
  }

  try {
    const result = await pool.query(`
      WITH order_profits AS (
        SELECT
          ${groupByClause} AS group_date,
          COALESCE(SUM(o.total - p.discount_value), 0) AS profit
        FROM orders o
        LEFT JOIN order_items oi ON o.id = oi.order_id
        LEFT JOIN products p ON oi.product_id = p.id
        WHERE o.status IN ('paid', 'closed')
          AND o.created_at >= $1::date
          AND o.created_at < ($2::date + INTERVAL '1 day')
        GROUP BY group_date
      ),
      payment_losses AS (
        SELECT
          TO_CHAR(t.delivery_date, ${dateFormat}) AS group_date,
          COALESCE(SUM(t.amount_paid), 0) AS loss
        FROM transactions t
        WHERE t.ingredient = 'Payment'
          AND t.delivery_date >= $1::date
          AND t.delivery_date < ($2::date + INTERVAL '1 day')
        GROUP BY group_date
      )
      SELECT
        op.group_date AS date,
        op.profit,
        COALESCE(pl.loss, 0) AS loss
      FROM order_profits op
      LEFT JOIN payment_losses pl ON op.group_date = pl.group_date
      ORDER BY date
    `, [startDate, endDate]);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error in /reports/profit-loss:", err);
    res.status(500).json({ error: "Failed to fetch profit/loss report" });
  }
});


// GET /reports/daily-expenses
router.get("/daily-expenses", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        TO_CHAR(delivery_date, 'YYYY-MM-DD') AS date,
        SUM(total_cost) AS total_expense
      FROM transactions
      WHERE ingredient != 'Payment'
      GROUP BY date
      ORDER BY date DESC
      LIMIT 30
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error in /reports/daily-expenses:", err);
    res.status(500).json({ error: "Failed to fetch daily expenses" });
  }
});

// GET /reports/daily-cash-expenses?openTime=...
router.get("/daily-cash-expenses", async (req, res) => {
  try {
    const openTime = req.query.openTime;

    if (!openTime) {
      return res.status(400).json({ error: "Missing openTime in query" });
    }

    // 1. Manual cash payments from register
    const res1 = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM payments
      WHERE paid_at >= $1 AND LOWER(payment_method) = 'cash'
    `, [openTime]);

    // 2. Supplier cash transactions
    const res2 = await pool.query(`
      SELECT COALESCE(SUM(amount_paid), 0) AS total
      FROM transactions
      WHERE delivery_date >= $1 AND LOWER(payment_method) = 'cash'
    `, [openTime]);

    // 3. Staff cash payouts (assuming all staff payments are in cash)
    const res3 = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM staff_payments
      WHERE created_at >= $1
    `, [openTime]);

    // Total unified expense
    const totalExpense =
      parseFloat(res1.rows[0].total || 0) +
      parseFloat(res2.rows[0].total || 0) +
      parseFloat(res3.rows[0].total || 0);

    res.json([
      {
        from_register: parseFloat(res1.rows[0].total || 0),
        from_transactions: parseFloat(res2.rows[0].total || 0),
        from_staff: parseFloat(res3.rows[0].total || 0),
        total_expense: totalExpense,
      },
    ]);
  } catch (err) {
    console.error("❌ Error in time-based cash expenses:", err);
    res.status(500).json({ error: "Failed to fetch filtered expenses" });
  }
});

// GET /reports/sales-trends
router.get("/sales-trends", async (req, res) => {
  const { type = "daily" } = req.query;

  let groupBy, labelFormat;
  switch (type) {
    case "hourly":
      groupBy = `DATE_TRUNC('hour', created_at)`;
      labelFormat = `TO_CHAR(DATE_TRUNC('hour', created_at), 'HH24:00')`;
      break;
    case "weekly":
      groupBy = `DATE_TRUNC('week', created_at)`;
      labelFormat = `TO_CHAR(DATE_TRUNC('week', created_at), 'IYYY-"W"IW')`;  // e.g., 2025-W18
      break;
    case "yearly":
      groupBy = `DATE_TRUNC('month', created_at)`;
      labelFormat = `TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM')`;
      break;
    case "daily":
    default:
      groupBy = `DATE_TRUNC('day', created_at)`;
      labelFormat = `TO_CHAR(DATE_TRUNC('day', created_at), 'YYYY-MM-DD')`;
      break;
  }

  try {
    const result = await pool.query(
      `
      SELECT
        ${labelFormat} AS label,
        SUM(total) AS sales
      FROM orders
      WHERE is_paid = true
      GROUP BY ${groupBy}
      ORDER BY ${groupBy} ASC
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching sales trends:", err);
    res.status(500).json({ error: "Failed to load sales trends" });
  }
});

// GET /reports/sales-by-category?from=2025-05-01&to=2025-05-13
router.get("/sales-by-category", async (req, res) => {
  const { from, to } = req.query;

  const fromDate = from || "2000-01-01";
  const toDate = to || "2100-01-01";

  try {
    const result = await pool.query(`
      SELECT p.category, COALESCE(SUM(oi.price * oi.quantity), 0) AS total_sales
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN orders o ON oi.order_id = o.id
      WHERE o.is_paid = true
        AND o.created_at >= $1
        AND o.created_at < ($2::date + INTERVAL '1 day')
      GROUP BY p.category
      ORDER BY total_sales DESC
    `, [fromDate, toDate]);

    const formatted = result.rows.map(row => ({
      category: row.category || "Uncategorized",
      total: parseFloat(row.total_sales),
    }));

    res.json(formatted);
  } catch (err) {
    console.error("❌ Error fetching sales by category:", err);
    res.status(500).json({ error: "Failed to load category sales" });
  }
});

// GET /reports/sales-by-category-detailed?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/sales-by-category-detailed", async (req, res) => {
  const { from, to } = req.query;

  const fromDate = from || "2000-01-01";
  const toDate = to || "2100-01-01";

  try {
    const result = await pool.query(`
      SELECT
        p.category,
        p.name,
        SUM(oi.quantity) AS quantity,
        SUM(oi.quantity * oi.price) AS total
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN orders o ON oi.order_id = o.id
      WHERE o.is_paid = true
        AND o.created_at >= $1
        AND o.created_at < ($2::date + INTERVAL '1 day')
      GROUP BY p.category, p.name
      ORDER BY p.category, total DESC
    `, [fromDate, toDate]);

    const grouped = {};
    for (const row of result.rows) {
      const cat = row.category || "Uncategorized";
      if (!grouped[cat]) grouped[cat] = [];

      grouped[cat].push({
        name: row.name,
        quantity: Number(row.quantity),
        total: parseFloat(row.total),
      });
    }

    res.json(grouped);
  } catch (err) {
    console.error("❌ Error in /sales-by-category-detailed:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /reports/category-trends?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/category-trends", async (req, res) => {
  const { from, to } = req.query;
  const fromDate = from || "2000-01-01";
  const toDate   = to   || "2100-01-01";

  try {
    const result = await pool.query(`
      SELECT
        DATE(o.created_at) AS date,
        p.category,
        SUM(oi.quantity * oi.price) AS total
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN orders o   ON oi.order_id   = o.id
      WHERE o.is_paid = true
        AND o.created_at >= $1::date
        AND o.created_at <  ($2::date + INTERVAL '1 day')
      GROUP BY date, p.category
      ORDER BY date ASC
    `, [fromDate, toDate]);

    // pivot into [{ date, CatA: 123, CatB: 456, … }, …]
    const map = {};
    result.rows.forEach(r => {
  const day = r.date;     // already "2025-05-14"
  map[day] = map[day] || { date: day };
  map[day][r.category || "Uncategorized"] = parseFloat(r.total);
    });

    res.json(Object.values(map));
  } catch (err) {
    console.error("❌ Error in /reports/category-trends:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


// GET /reports/cash-register-history?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/cash-register-history", async (req, res) => {

  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: "Missing date range" });

  try {
    const result = await pool.query(`
            WITH opens AS (
        SELECT date, amount AS opening_cash FROM cash_register_logs WHERE type = 'open'
      ),
      closes AS (
        SELECT date, amount AS closing_cash FROM cash_register_logs WHERE type = 'close'
      ),
      sales AS (
        SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS date, SUM(amount) AS cash_sales
        FROM receipt_methods
        WHERE LOWER(payment_method) = 'cash'
        GROUP BY 1
      ),
      supplier AS (
        SELECT TO_CHAR(delivery_date, 'YYYY-MM-DD') AS date, SUM(amount_paid) AS supplier_expenses
        FROM transactions
        WHERE LOWER(payment_method) = 'cash'
        GROUP BY 1
      ),
      staff AS (
        SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS date, SUM(amount) AS staff_expenses
        FROM staff_payments
        GROUP BY 1
      ),
      drawer AS (
        SELECT date, SUM(amount) AS register_expenses
        FROM cash_register_logs
        WHERE type = 'expense'
        GROUP BY 1
      ),
      entries AS (
        SELECT date, SUM(amount) AS register_entries
        FROM cash_register_logs
        WHERE type = 'entry'
        GROUP BY 1
      )
      SELECT
        o.date,
        o.opening_cash::numeric AS opening_cash,
        COALESCE(c.closing_cash, 0)::numeric AS closing_cash,
        COALESCE(s.cash_sales, 0)::numeric AS cash_sales,
        COALESCE(sup.supplier_expenses, 0)::numeric AS supplier_expenses,
        COALESCE(st.staff_expenses, 0)::numeric AS staff_expenses,
        COALESCE(d.register_expenses, 0)::numeric AS register_expenses,
        COALESCE(e.register_entries, 0)::numeric AS register_entries
      FROM opens o
      LEFT JOIN closes c ON c.date = o.date
      LEFT JOIN sales s ON s.date = TO_CHAR(o.date, 'YYYY-MM-DD')
      LEFT JOIN supplier sup ON sup.date = TO_CHAR(o.date, 'YYYY-MM-DD')
      LEFT JOIN staff st ON st.date = TO_CHAR(o.date, 'YYYY-MM-DD')
      LEFT JOIN drawer d ON d.date = o.date
      LEFT JOIN entries e ON e.date = o.date
      WHERE o.date BETWEEN $1 AND $2
      ORDER BY o.date DESC;

    `, [from, to]);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ DB error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /reports/cash-register-events?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/cash-register-events", async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: "Missing date range" });

  try {
    const result = await pool.query(`
      SELECT
        type, amount, created_at, date, note
      FROM cash_register_logs
      WHERE date BETWEEN $1 AND $2
      ORDER BY created_at ASC
    `, [from, to]);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ DB error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/cash-register-trends", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        date,
        SUM(CASE WHEN type = 'open' THEN amount ELSE 0 END) AS opening_cash,
        SUM(CASE WHEN type = 'close' THEN amount ELSE 0 END) AS closing_cash
      FROM cash_register_logs
      GROUP BY date
      ORDER BY date DESC
      LIMIT 30
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Failed to load cash register trends:", err);
    res.status(500).json({ error: "Failed to load cash trends" });
  }
});

router.get("/order-items", async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: "Missing date range" });

  try {
    const result = await pool.query(`
      SELECT oi.*, p.name AS product_name
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      JOIN products p ON oi.product_id = p.id
      WHERE o.created_at >= $1::date AND o.created_at < ($2::date + INTERVAL '1 day')

        AND o.is_paid = true
    `, [from, to]);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching order items for report:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

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

// GET /daily-cash-total?openTime=...
router.get("/daily-cash-total", async (req, res) => {
  try {
    const openTime = req.query.openTime;

    if (!openTime || openTime === "null" || openTime === "undefined") {
      console.warn("⚠️ Invalid or missing openTime in query");
      return res.json({ cash_total: 0 });
    }

    const result = await pool.query(
      `
      SELECT COALESCE(SUM(CAST(amount AS FLOAT)), 0) AS cash_total
      FROM receipt_methods
      WHERE LOWER(payment_method) = 'cash'
        AND created_at >= $1
      `,
      [openTime]
    );

    res.json({ cash_total: parseFloat(result.rows[0].cash_total) });
  } catch (err) {
    console.error("❌ Failed to calculate daily cash total:", err);
    res.status(500).json({ error: "Failed to fetch cash total" });
  }
});


// POST /cash-register-log
router.post("/cash-register-log", async (req, res) => {
  const { type, amount, note } = req.body;
  const now = new Date();
const istNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Istanbul" }));
const todayStr = istNow.toISOString().slice(0, 10);


  // Allow open, close, entry, expense
  if (!["open", "close", "entry", "expense"].includes(type) || amount == null) {
    return res.status(400).json({ error: "Invalid type or amount" });
  }

  try {
    // Keep close logic unchanged (block if orders open or before shop close time)
    if (type === "close") {
      const openOrdersRes = await pool.query(`
        SELECT COUNT(*) FROM orders WHERE status != 'closed'
      `);
      const openCount = parseInt(openOrdersRes.rows[0].count, 10);
      if (openCount > 0) {
        return res.status(400).json({
          error: `Cannot close register while ${openCount} order(s) are still open.`,
        });
      }

      // Shop close time logic
      const istanbulNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Istanbul" }));
      const dayName = istanbulNow.toLocaleDateString("en-US", { weekday: "long" });
      const currentHM = istanbulNow.toTimeString().slice(0, 5);

      const result = await pool.query(
        `SELECT close_time FROM shop_hours WHERE LOWER(day) = LOWER($1)`,
        [dayName]
      );
      const shopCloseTime = result.rows[0]?.close_time;

      if (shopCloseTime && currentHM < shopCloseTime) {
        return res.status(403).json({ error: `Cannot close before ${shopCloseTime}` });
      }
    }

    // Save the log (with note)
    await pool.query(
      `
      INSERT INTO cash_register_logs (date, type, amount, note)
      VALUES ($1, $2, $3, $4)
      `,
      [todayStr, type, amount, note || null]
    );

    res.json({ status: "ok" });
  } catch (err) {
    console.error("❌ Failed to insert cash register log:", err);
    res.status(500).json({ error: "Database error" });
  }
});




// GET /cash-register-status
router.get("/cash-register-status", async (req, res) => {
  try {
    const now = new Date();
    const istTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Istanbul" }));

    // 1. Get latest open log (regardless of day)
    const { rows: openLogs } = await pool.query(`
      SELECT * FROM cash_register_logs
      WHERE type = 'open'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const lastOpen = openLogs[0];

    if (!lastOpen) {
      return res.json({
        status: "unopened",
        yesterday_close: null,
        last_open_at: null,
      });
    }

    // 2. Get first close after last open
    const { rows: closeLogs } = await pool.query(`
      SELECT * FROM cash_register_logs
      WHERE type = 'close' AND created_at > $1
      ORDER BY created_at ASC
      LIMIT 1
    `, [lastOpen.created_at]);
    const lastClose = closeLogs[0] || null;

    // If open (not closed after last open): show last close BEFORE open
    if (!lastClose || new Date(lastClose.created_at) < new Date(lastOpen.created_at)) {
      const { rows: prevCloses } = await pool.query(`
        SELECT amount FROM cash_register_logs
        WHERE type = 'close' AND created_at < $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [lastOpen.created_at]);
      const prevCloseAmount = prevCloses[0]?.amount ?? null;
      return res.json({
        status: "open",
        opening_cash: lastOpen.amount,
        yesterday_close: prevCloseAmount,   // << always most recent close before open
        last_open_at: lastOpen.created_at,
      });
    }

    // If closed, show most recent close (which should be after last open)
    return res.json({
      status: "closed",
      opening_cash: lastOpen.amount,
      yesterday_close: lastClose.amount,    // << always most recent close
      last_open_at: lastOpen.created_at,
      last_close_at: lastClose.created_at,
    });

  } catch (err) {
    console.error("❌ Failed to load register status:", err);
    res.status(500).json({ error: "Failed to fetch register status" });
  }
});


// GET /reports/last-register-closes?limit=5
router.get("/last-register-closes", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "5", 10);

    const result = await pool.query(`
      SELECT amount, created_at
      FROM cash_register_logs
      WHERE type = 'close'
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching past closing cash logs:", err);
    res.status(500).json({ error: "Failed to fetch closing history" });
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

// ✅ Support both single and sub-orders in split receipts
// POST /api/orders/receipt-methods
router.post("/receipt-methods", async (req, res) => {
  let { receipt_id, methods, order_id } = req.body;

  try {
    // --- PATCH: always assign receipt_id if missing and order_id given ---
    if ((!receipt_id || receipt_id === 'null') && order_id) {
      // Generate a new UUID and update the order
      const { rows } = await pool.query(
        "UPDATE orders SET receipt_id = gen_random_uuid() WHERE id = $1 RETURNING receipt_id",
        [order_id]
      );
      receipt_id = rows[0].receipt_id;
    }
    if (!receipt_id || typeof methods !== 'object') {
      return res.status(400).json({ error: "Invalid payload: missing receipt_id" });
    }

    // Always clean and re-insert methods for this receipt
    await pool.query(`DELETE FROM receipt_methods WHERE receipt_id = $1`, [receipt_id]);
    for (const [method, amount] of Object.entries(methods)) {
      if (parseFloat(amount) > 0) {
        await pool.query(
          `INSERT INTO receipt_methods (receipt_id, payment_method, amount)
           VALUES ($1, $2, $3)`,
          [receipt_id, method, amount]
        );
      }
    }

    // Update payment_method on order to show all splits (Cash+Card+...)
    const paymentMethodStr = Object.keys(methods)
      .filter(k => parseFloat(methods[k]) > 0)
      .join("+");
    const { rows: orderRows } = await pool.query(
      `SELECT id, payment_method FROM orders WHERE receipt_id = $1`,
      [receipt_id]
    );
    if (orderRows.length > 0) {
      const orderId = orderRows[0].id;
      const oldMethod = orderRows[0].payment_method;
      if (oldMethod !== paymentMethodStr) {
        await pool.query(
          `UPDATE orders SET payment_method = $1 WHERE id = $2`,
          [paymentMethodStr, orderId]
        );
        await pool.query(
          `INSERT INTO payment_method_changes (order_id, old_method, new_method, changed_by)
           VALUES ($1, $2, $3, $4)`,
          [orderId, oldMethod, paymentMethodStr, req.user?.username || 'system']
        );
      }
    }

    res.json({ message: "Receipt methods inserted successfully", receipt_id });
  } catch (err) {
    console.error("❌ Error inserting receipt methods:", err);
    res.status(500).json({ error: "Failed to insert receipt methods" });
  }
});

// GET /api/reports/supplier-cash-payments?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/supplier-cash-payments", async (req, res) => {
  const { from, to } = req.query;
  try {
    const result = await pool.query(`
      SELECT
        t.amount_paid AS amount,
        t.created_at,
        s.name AS note,
        'supplier' AS type
      FROM transactions t
      JOIN suppliers s ON t.supplier_id = s.id
      WHERE t.ingredient = 'Payment'
        AND LOWER(t.payment_method) = 'cash'
        AND t.delivery_date >= $1
        AND t.delivery_date < ($2::date + INTERVAL '1 day')
      ORDER BY t.created_at ASC
    `, [from, to]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch supplier cash payments" });
  }
});

// GET /api/reports/staff-cash-payments?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/staff-cash-payments", async (req, res) => {
  const { from, to } = req.query;
  try {
    const result = await pool.query(`
      SELECT
        sp.amount,
        sp.created_at,
        s.name AS note,
        'staff' AS type
      FROM staff_payments sp
      JOIN staff s ON sp.staff_id = s.id
      WHERE LOWER(sp.payment_method) = 'cash'
        AND sp.created_at >= $1
        AND sp.created_at < ($2::date + INTERVAL '1 day')
      ORDER BY sp.created_at ASC
    `, [from, to]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch staff cash payments" });
  }
});


// ✅ GET all payment methods used for a specific receipt
router.get("/receipt-methods/:receipt_id", async (req, res) => {
  const { receipt_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT payment_method, amount
       FROM receipt_methods
       WHERE receipt_id = $1
       ORDER BY id ASC`,
      [receipt_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching receipt methods:", err);
    res.status(500).json({ error: "Failed to fetch receipt methods" });
  }
});

// ✅ INSERT receipt_methods for a given receipt
async function insertReceiptMethods(receiptId, methodAmounts = {}) {
  const entries = Object.entries(methodAmounts).filter(([_, amount]) => parseFloat(amount) > 0);
  for (const [method, amount] of entries) {
    await pool.query(
      `INSERT INTO receipt_methods (receipt_id, payment_method, amount)
       VALUES ($1, $2, $3)`,
      [receiptId, method, amount]
    );
  }
}

// ✅ GET /orders/history
router.get("/orders/history", async (req, res) => {
  const { from, to } = req.query;

  if (!from || !to) {
    return res.status(400).json({ error: "Missing from/to query parameters" });
  }

  try {
    const result = await pool.query(
      `
        SELECT * FROM orders
        WHERE status = 'closed'
        AND created_at >= $1::date
        AND created_at < ($2::date + INTERVAL '1 day')
        ORDER BY created_at DESC
      `,
      [from, to]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching order history:", err);
    res.status(500).json({ error: "Failed to fetch order history" });
  }
});

// PATCH /orders/:id/items/payment-method
router.patch("/orders/:id/items/payment-method", async (req, res) => {
  const { id } = req.params;
  const { payment_method } = req.body;

  try {
    const result = await pool.query(
      `UPDATE order_items
       SET payment_method = $1
       WHERE order_id = $2 AND paid_at IS NOT NULL`,
      [payment_method, id]
    );

    res.json({ updated: result.rowCount });
  } catch (err) {
    console.error("❌ Error updating payment method:", err);
    res.status(500).json({ error: "Failed to update item payment method" });
  }
});

module.exports = router;
