const express = require("express");
const router = express.Router();
const moment = require("moment-timezone");
const authMiddleware = require("../middleware/authMiddleware");
const { pool } = require("../db");

const DEFAULT_TZ = process.env.REPORTS_TIMEZONE || "Europe/Istanbul";

router.use(authMiddleware);

const toYmd = (value) => {
  const m = value ? moment.tz(value, DEFAULT_TZ) : moment.tz(DEFAULT_TZ);
  if (!m.isValid()) return moment.tz(DEFAULT_TZ).format("YYYY-MM-DD");
  return m.format("YYYY-MM-DD");
};

const normalizeRange = (start, end) => {
  const s = toYmd(start);
  const e = toYmd(end || start);
  return moment(e).isBefore(s) ? { start: e, end: s } : { start: s, end: e };
};

async function tableExists(name) {
  try {
    const { rows } = await pool.query(`SELECT to_regclass($1) AS tbl`, [name]);
    return !!rows?.[0]?.tbl;
  } catch {
    return false;
  }
}

async function upsertCustomerTraffic({ restaurantId, date, delta, source, tableId = null, orderId = null, meta = null }) {
  const safeDelta = Number(delta);
  if (!Number.isFinite(safeDelta)) {
    throw new Error("delta must be a number");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO customer_traffic_events (restaurant_id, occurred_at, delta, table_id, order_id, source, meta)
        VALUES ($1, NOW(), $2, $3, $4, $5, $6)
        ON CONFLICT (restaurant_id, order_id)
        WHERE order_id IS NOT NULL
        DO NOTHING
      `,
      [restaurantId, safeDelta, tableId, orderId, source || null, meta]
    );

    const { rows } = await client.query(
      `
        INSERT INTO customer_traffic_daily (restaurant_id, date, customer_count, source, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (restaurant_id, date)
        DO UPDATE SET
          customer_count = customer_traffic_daily.customer_count + EXCLUDED.customer_count,
          updated_at = NOW(),
          source = COALESCE(EXCLUDED.source, customer_traffic_daily.source)
        RETURNING customer_count
      `,
      [restaurantId, date, safeDelta, source || null]
    );

    await client.query("COMMIT");
    return rows?.[0]?.customer_count ?? safeDelta;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function fetchCustomerTraffic(restaurantId, start, end) {
  if (!(await tableExists("public.customer_traffic_daily"))) return [];
  const { rows } = await pool.query(
    `SELECT date, customer_count
     FROM customer_traffic_daily
     WHERE restaurant_id = $1
       AND date BETWEEN $2 AND $3
     ORDER BY date ASC`,
    [restaurantId, start, end]
  );
  return rows;
}

async function sumCustomerTraffic(restaurantId, start, end) {
  if (!(await tableExists("public.customer_traffic_daily"))) return 0;
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(customer_count), 0) AS total
       FROM customer_traffic_daily
      WHERE restaurant_id = $1
        AND date BETWEEN $2 AND $3`,
    [restaurantId, start, end]
  );
  return Number(rows?.[0]?.total || 0);
}

const parseHm = (value) => {
  if (!value) return null;
  const parts = String(value).split(":");
  const h = Number(parts[0]);
  const m = Number(parts[1] || 0);
  if (!Number.isFinite(h)) return null;
  return h * 60 + m;
};

async function fetchStaffHours(restaurantId, start, end) {
  if (!(await tableExists("public.staff_schedule"))) return 0;
  const { rows } = await pool.query(
    `SELECT shift_start, shift_end
       FROM staff_schedule
      WHERE restaurant_id = $1
        AND shift_date BETWEEN $2 AND $3`,
    [restaurantId, start, end]
  );
  let minutes = 0;
  rows.forEach((row) => {
    const startMin = parseHm(row.shift_start);
    const endMin = parseHm(row.shift_end);
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) return;
    let diff = endMin - startMin;
    if (diff < 0) diff += 24 * 60; // cross-midnight
    minutes += diff;
  });
  return Number(minutes / 60);
}

async function fetchCleaningExpenses(restaurantId, start, end) {
  if (!(await tableExists("public.expenses"))) return 0;
  // Accept both a text column "type" and category-based cleaning flags
  const colRes = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'expenses'`
  );
  const cols = colRes.rows.map((r) => r.column_name);
  const hasCategory = cols.includes("category");
  const hasCategoryId = cols.includes("category_id") && (await tableExists("public.expense_categories"));
  const filters = [
    "LOWER(type) = 'cleaning'",
    "LOWER(type) LIKE '%clean%'",
    "LOWER(type) LIKE '%temizlik%'",
  ];
  if (hasCategory) {
    filters.push("LOWER(category) = 'cleaning'");
    filters.push("LOWER(category) LIKE '%clean%'");
    filters.push("LOWER(category) LIKE '%temizlik%'");
  }
  if (hasCategoryId)
    filters.push(
      "category_id IN (SELECT id FROM expense_categories WHERE LOWER(name) LIKE '%clean%')"
    );

  const where = filters.length ? `(${filters.join(" OR ")})` : "FALSE";

  console.log(
    "[analytics] Cleaning expense query",
    JSON.stringify({ restaurantId, start, end, filters }, null, 2)
  );

  const { rows } = await pool.query(
    `
      SELECT COALESCE(SUM(amount), 0) AS total
        FROM expenses
       WHERE restaurant_id = $1
         AND ${where}
         AND created_at >= $2::date
         AND created_at < ($3::date + INTERVAL '1 day')
    `,
    [restaurantId, start, end]
  );

  console.log(
    "[analytics] Cleaning expense result",
    JSON.stringify(rows?.[0] || {}, null, 2)
  );

  let total = Number(rows?.[0]?.total || 0);

  // Fallback: use supplier transactions items that are marked cleaning
  if (total === 0) {
    try {
      const { rows: txnRows } = await pool.query(
        `
          SELECT COALESCE(SUM(COALESCE((item->>'total_cost')::numeric,0)),0) AS total
          FROM transactions t
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(t.items::jsonb) = 'array' THEN t.items::jsonb
              ELSE '[]'::jsonb
            END
          ) AS item
          LEFT JOIN stock s
            ON s.restaurant_id = t.restaurant_id
           AND LOWER(BTRIM(s.name)) = LOWER(BTRIM(item->>'ingredient'))
           AND LOWER(BTRIM(s.unit)) = LOWER(BTRIM(item->>'unit'))
          LEFT JOIN products p
            ON p.restaurant_id = t.restaurant_id
           AND LOWER(BTRIM(p.name)) = LOWER(BTRIM(item->>'ingredient'))
          WHERE t.restaurant_id = $1
            AND t.created_at >= $2::date
            AND t.created_at < ($3::date + INTERVAL '1 day')
            AND (
              COALESCE((item->>'is_cleaning_supply')::boolean, false) = TRUE
              OR COALESCE(s.is_cleaning_supply, FALSE) = TRUE
              OR COALESCE(p.is_cleaning_supply, FALSE) = TRUE
              OR LOWER(COALESCE(item->>'ingredient','')) LIKE '%clean%'
              OR LOWER(COALESCE(item->>'ingredient','')) LIKE '%temizlik%'
            )
        `,
        [restaurantId, start, end]
      );
      total = Number(txnRows?.[0]?.total || 0);
      console.log("[analytics] Cleaning expense fallback (transactions) total:", total);
    } catch (fallbackErr) {
      console.warn("⚠️ Cleaning expense fallback failed:", fallbackErr.message);
    }
  }

  return total;
}

async function fetchCleaningExpensesDaily(restaurantId, start, end) {
  let rows = [];

  if (await tableExists("public.expenses")) {
    const colRes = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'expenses'`
    );
    const cols = colRes.rows.map((r) => r.column_name);
    const hasCategory = cols.includes("category");
    const hasCategoryId = cols.includes("category_id") && (await tableExists("public.expense_categories"));
    const filters = [
      "LOWER(type) = 'cleaning'",
      "LOWER(type) LIKE '%clean%'",
      "LOWER(type) LIKE '%temizlik%'",
    ];
    if (hasCategory) {
      filters.push("LOWER(category) = 'cleaning'");
      filters.push("LOWER(category) LIKE '%clean%'");
      filters.push("LOWER(category) LIKE '%temizlik%'");
    }
    if (hasCategoryId)
      filters.push(
        "category_id = ANY (ARRAY[ (SELECT id FROM expense_categories WHERE LOWER(name)='cleaning' LIMIT 1) ])"
      );
    const where = filters.length ? `(${filters.join(" OR ")})` : "FALSE";

    const expenseRes = await pool.query(
      `
        SELECT DATE(created_at) AS date, COALESCE(SUM(amount), 0) AS total
          FROM expenses
         WHERE restaurant_id = $1
           AND ${where}
           AND created_at >= $2::date
           AND created_at < ($3::date + INTERVAL '1 day')
         GROUP BY DATE(created_at)
         ORDER BY DATE(created_at) ASC
      `,
      [restaurantId, start, end]
    );
    rows = expenseRes.rows || [];
  }

  const totalFromExpenses = rows.reduce((sum, r) => sum + (Number(r?.total) || 0), 0);
  if (totalFromExpenses > 0) return rows;

  // Fallback: derive daily cleaning spend from supplier transaction items.
  try {
    const { rows: txnRows } = await pool.query(
      `
        SELECT DATE(t.created_at) AS date,
               COALESCE(SUM(COALESCE((item->>'total_cost')::numeric,0)),0) AS total
        FROM transactions t
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(t.items::jsonb) = 'array' THEN t.items::jsonb
            ELSE '[]'::jsonb
          END
        ) AS item
        LEFT JOIN stock s
          ON s.restaurant_id = t.restaurant_id
         AND LOWER(BTRIM(s.name)) = LOWER(BTRIM(item->>'ingredient'))
         AND LOWER(BTRIM(s.unit)) = LOWER(BTRIM(item->>'unit'))
        LEFT JOIN products p
          ON p.restaurant_id = t.restaurant_id
         AND LOWER(BTRIM(p.name)) = LOWER(BTRIM(item->>'ingredient'))
        WHERE t.restaurant_id = $1
          AND t.created_at >= $2::date
          AND t.created_at < ($3::date + INTERVAL '1 day')
          AND (
            COALESCE((item->>'is_cleaning_supply')::boolean, false) = TRUE
            OR COALESCE(s.is_cleaning_supply, FALSE) = TRUE
            OR COALESCE(p.is_cleaning_supply, FALSE) = TRUE
            OR LOWER(COALESCE(item->>'ingredient','')) LIKE '%clean%'
            OR LOWER(COALESCE(item->>'ingredient','')) LIKE '%temizlik%'
          )
        GROUP BY DATE(t.created_at)
        ORDER BY DATE(t.created_at) ASC
      `,
      [restaurantId, start, end]
    );
    return txnRows || [];
  } catch (fallbackErr) {
    console.warn("⚠️ Cleaning expense daily fallback failed:", fallbackErr.message);
    return rows;
  }
}

async function fetchCleaningUsage(restaurantId, start, end) {
  const hasMovements = await tableExists("public.stock_movements");
  const hasStock = await tableExists("public.stock");
  if (!hasMovements || !hasStock) {
    return { total_units: 0, total_value: 0, by_product: [] };
  }

  const { rows: stockRows } = await pool.query(
    `
      SELECT id, name, unit, COALESCE(is_cleaning_supply, FALSE) AS is_cleaning_supply
        FROM stock s
       WHERE s.restaurant_id = $1
         AND (
           COALESCE(s.is_cleaning_supply, FALSE) = TRUE
           OR LOWER(COALESCE(s.name, '')) LIKE '%clean%'
           OR EXISTS (
             SELECT 1 FROM products p
              WHERE p.restaurant_id = s.restaurant_id
                AND LOWER(BTRIM(p.name)) = LOWER(BTRIM(s.name))
                AND COALESCE(p.is_cleaning_supply, FALSE) = TRUE
           )
         )
    `,
    [restaurantId]
  );
  const stockIds = stockRows.map((r) => r.id).filter(Boolean);
  if (!stockIds.length) return { total_units: 0, total_value: 0, by_product: [] };

  // Optional fallback cost source: latest known batch cost for each stock item.
  let latestBatchCostByStockId = new Map();
  try {
    if (await tableExists("public.stock_batches")) {
      const { rows: batchCostRows } = await pool.query(
        `
          SELECT DISTINCT ON (stock_id)
                 stock_id,
                 COALESCE(cost_price, 0) AS cost_price
            FROM stock_batches
           WHERE restaurant_id = $1
             AND stock_id = ANY($2)
             AND COALESCE(cost_price, 0) > 0
           ORDER BY stock_id, created_at DESC
        `,
        [restaurantId, stockIds]
      );
      latestBatchCostByStockId = new Map(
        (batchCostRows || []).map((r) => [Number(r.stock_id), Number(r.cost_price || 0)])
      );
    }
  } catch (costErr) {
    console.warn("⚠️ Cleaning usage batch-cost fallback failed:", costErr.message);
  }

  // Dynamically adapt to varying stock_movements schemas
  const colRes = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'stock_movements'`
  );
  const cols = colRes.rows.map((r) => r.column_name);
  const hasQtyOut = cols.includes("qty_out");
  const hasQty = cols.includes("qty");
  const hasQtyAdjust = cols.includes("qty_adjust");
  const hasQuantity = cols.includes("quantity");
  const hasDirection = cols.includes("direction");
  const hasMovementType = cols.includes("movement_type");

  const directionCheck = hasDirection
    ? "LOWER(COALESCE(sm.direction,''))"
    : hasMovementType
    ? "LOWER(COALESCE(sm.movement_type,''))"
    : "''";

  const qtyExprParts = [];
  if (hasQtyOut) qtyExprParts.push("COALESCE(sm.qty_out,0)");
  if (hasQty) qtyExprParts.push("COALESCE(sm.qty,0)");
  if (hasQtyAdjust) qtyExprParts.push("GREATEST(COALESCE(sm.qty_adjust,0),0)");
  if (hasQuantity) {
    qtyExprParts.push(
      `CASE WHEN ${directionCheck} IN ('out','deduct','consume','usage','used','waste') THEN COALESCE(sm.quantity,0) ELSE 0 END`
    );
  }
  const qtyExpr = qtyExprParts.length ? qtyExprParts.join(" + ") : "0";

  const movementTypeSelect = hasMovementType
    ? "sm.movement_type AS movement_type,"
    : "NULL::text AS movement_type,";
  const directionSelect = hasDirection
    ? "sm.direction AS direction,"
    : "NULL::text AS direction,";
  const stockColRes = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'stock'`
  );
  const stockCols = stockColRes.rows.map((r) => r.column_name);
  const stockCostCandidates = [
    "price_per_unit",
    "unit_price",
    "cost_price",
    "purchase_price",
    "price",
  ].filter((col) => stockCols.includes(col));
  const stockCostExpr = stockCostCandidates.length
    ? `COALESCE(${stockCostCandidates.map((col) => `NULLIF(s.${col}, 0)`).join(", ")}, 0)`
    : "0";

  const { rows } = await pool.query(
    `
      SELECT
        sm.stock_id,
        (${qtyExpr}) AS qty_out_value,
        ${movementTypeSelect}
        ${directionSelect}
        sm.cost_price,
        sm.total_value,
        sm.unit,
        sm.created_at,
        s.name,
        s.unit AS stock_unit,
        ${stockCostExpr} AS stock_cost_price
      FROM stock_movements sm
      LEFT JOIN stock s ON s.id = sm.stock_id
     WHERE sm.restaurant_id = $1
       AND sm.stock_id = ANY($2)
       AND sm.created_at >= $3::date
       AND sm.created_at < ($4::date + INTERVAL '1 day')
    `,
    [restaurantId, stockIds, start, end]
  );

  const byProduct = new Map();
  for (const row of rows) {
    const movement = String(row.movement_type || "").toLowerCase();
    const direction = String(row.direction || "").toLowerCase();
    const numericQty = Math.abs(Number(row.qty_out_value) || 0);
    const movementLooksOut =
      movement.includes("waste") ||
      movement.includes("usage") ||
      movement.includes("consume") ||
      movement.includes("used") ||
      movement.includes("deduct") ||
      movement.includes("out") ||
      movement.includes("decrease") ||
      movement.includes("loss");
    const movementLooksIn =
      movement.includes("increase") ||
      movement.includes("restock") ||
      movement.includes("receive") ||
      movement === "in" ||
      movement.startsWith("in_") ||
      movement.endsWith("_in");
    const directionLooksOut =
      direction.includes("out") ||
      direction.includes("usage") ||
      direction.includes("consume") ||
      direction.includes("used") ||
      direction.includes("deduct");

    let isOut;
    if (hasMovementType || hasDirection) {
      isOut = (movementLooksOut || directionLooksOut) && !movementLooksIn;
    } else {
      // Legacy schema fallback: without type/direction metadata, qty_out_value is treated as usage.
      isOut = numericQty > 0;
    }
    if (!isOut || !numericQty) continue;

    const unitCost =
      Number(
        row.cost_price ||
          row.stock_cost_price ||
          latestBatchCostByStockId.get(Number(row.stock_id)) ||
          0
      ) || 0;
    const value = unitCost ? unitCost * numericQty : Number(row.total_value || 0) || 0;
    const key = row.stock_id || row.name || `stock-${movement}`;
    const entry =
      byProduct.get(key) ||
      {
        stock_id: row.stock_id,
        product_name: row.name || `Stock ${row.stock_id}`,
        unit: row.unit || row.stock_unit || "",
        total_units: 0,
        total_value: 0,
      };
    entry.total_units += numericQty;
    entry.total_value += value;
    byProduct.set(key, entry);
  }

  const byProductArr = Array.from(byProduct.values()).sort(
    (a, b) => Number(b.total_value || 0) - Number(a.total_value || 0)
  );

  const total_units = byProductArr.reduce((sum, p) => sum + (p.total_units || 0), 0);
  const total_value = byProductArr.reduce((sum, p) => sum + (p.total_value || 0), 0);

  return { total_units, total_value, by_product: byProductArr };
}

async function buildDailySeries(restaurantId, start, end) {
  const [traffic, expenses] = await Promise.all([
    fetchCustomerTraffic(restaurantId, start, end),
    fetchCleaningExpensesDaily(restaurantId, start, end),
  ]);

  const trafficMap = new Map(traffic.map((row) => [toYmd(row.date), Number(row.customer_count || 0)]));
  const expenseMap = new Map(expenses.map((row) => [toYmd(row.date), Number(row.total || 0)]));

  const startM = moment(start);
  const endM = moment(end);
  const days = endM.diff(startM, "days");
  const series = [];
  for (let i = 0; i <= days; i++) {
    const d = startM.clone().add(i, "days").format("YYYY-MM-DD");
    const customers = trafficMap.get(d) || 0;
    const cleaningExpense = expenseMap.get(d) || 0;
    series.push({
      date: d,
      customer_count: customers,
      cleaning_expense: cleaningExpense,
      cleaning_cost_per_customer: customers > 0 ? cleaningExpense / customers : 0,
    });
  }
  return series;
}

async function buildMetrics(restaurantId, start, end, opts = {}) {
  const [total_customers, total_staff_hours, cleaning_expense_total, cleaning_stock_usage_total] =
    await Promise.all([
      sumCustomerTraffic(restaurantId, start, end),
      fetchStaffHours(restaurantId, start, end),
      fetchCleaningExpenses(restaurantId, start, end),
      fetchCleaningUsage(restaurantId, start, end),
    ]);

  const cleaning_cost_per_customer =
    total_customers > 0 ? cleaning_expense_total / total_customers : 0;
  const cleaning_cost_per_staff_hour =
    total_staff_hours > 0 ? cleaning_expense_total / total_staff_hours : 0;
  const cleaning_usage_per_100_customers =
    total_customers > 0 ? (cleaning_stock_usage_total.total_units / total_customers) * 100 : 0;

  const base = {
    total_customers,
    total_staff_hours,
    cleaning_expense_total,
    cleaning_cost_per_customer,
    cleaning_cost_per_staff_hour,
    cleaning_stock_usage_total,
    cleaning_usage_per_100_customers,
  };

  if (opts.includeDaily) {
    base.daily_metrics = await buildDailySeries(restaurantId, start, end);
  }

  return base;
}

function averageMetrics(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const len = list.length;
  const sumField = (field) =>
    list.reduce((sum, m) => sum + (Number(m?.[field] || 0)), 0) / len;

  const cleaningStock = list
    .map((m) => m?.cleaning_stock_usage_total)
    .filter(Boolean);
  const avgCleaningStock = cleaningStock.length
    ? {
        total_units:
          cleaningStock.reduce((s, v) => s + (Number(v.total_units) || 0), 0) / cleaningStock.length,
        total_value:
          cleaningStock.reduce((s, v) => s + (Number(v.total_value) || 0), 0) / cleaningStock.length,
        by_product: [],
      }
    : { total_units: 0, total_value: 0, by_product: [] };

  return {
    total_customers: sumField("total_customers"),
    total_staff_hours: sumField("total_staff_hours"),
    cleaning_expense_total: sumField("cleaning_expense_total"),
    cleaning_cost_per_customer: sumField("cleaning_cost_per_customer"),
    cleaning_cost_per_staff_hour: sumField("cleaning_cost_per_staff_hour"),
    cleaning_stock_usage_total: avgCleaningStock,
    cleaning_usage_per_100_customers: sumField("cleaning_usage_per_100_customers"),
  };
}

function buildDeltas(current, baseline) {
  const delta = {};
  const keys = [
    "total_customers",
    "total_staff_hours",
    "cleaning_expense_total",
    "cleaning_cost_per_customer",
    "cleaning_cost_per_staff_hour",
    "cleaning_usage_per_100_customers",
  ];
  keys.forEach((key) => {
    const base = Number(baseline?.[key] || 0);
    if (!base) {
      delta[key] = null;
      return;
    }
    const curr = Number(current?.[key] || 0);
    delta[key] = ((curr - base) / base) * 100;
  });
  return delta;
}

function buildAlerts(current, baseline, previousPeriod = null) {
  const alerts = [];
  if (!baseline && !previousPeriod) return alerts;
  const entries = [
    ["cleaning_cost_per_customer", "warning", "Cleaning cost per customer is elevated"],
    ["cleaning_cost_per_staff_hour", "warning", "Cleaning cost per staff hour is elevated"],
    ["cleaning_usage_per_100_customers", "warning", "Cleaning usage per 100 customers is elevated"],
    ["cleaning_expense_total", "warning", "Cleaning expenses are elevated"],
  ];

  entries.forEach(([key, severity, title]) => {
    const curr = Number(current?.[key] || 0);
    const baselineValue = Number(baseline?.[key] || 0);
    const previousValue = Number(previousPeriod?.[key] || 0);
    const comparisonValue =
      baselineValue > 0
        ? baselineValue
        : previousValue > 0
        ? previousValue
        : 0;
    const comparisonSource = baselineValue > 0 ? "baseline" : previousValue > 0 ? "previous period" : null;

    if (!comparisonValue) {
      if (curr > 0) {
        alerts.push({
          alert_type: key,
          severity: "info",
          title: `${title} (no baseline)`,
          message: `${key.replace(/_/g, " ")} has activity in the current period but no baseline data exists yet`,
          metric_key: key,
          current_value: curr,
          baseline_value: 0,
          threshold: null,
        });
      }
      return;
    }
    if (curr <= comparisonValue * 1.25) return;
    alerts.push({
      alert_type: key,
      severity,
      title,
      message: `${key.replace(/_/g, " ")} is ${((curr - comparisonValue) / comparisonValue * 100).toFixed(1)}% above ${comparisonSource}`,
      metric_key: key,
      current_value: curr,
      baseline_value: comparisonValue,
      threshold: comparisonValue * 1.25,
    });
  });

  return alerts;
}

router.post("/customer-traffic/increment", async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const { delta, date, source = "table_overview", meta = null } = req.body || {};
    if (!Number.isFinite(Number(delta))) {
      return res.status(400).json({ error: "delta is required and must be a number" });
    }
    const ymd = toYmd(date);
    const customer_count = await upsertCustomerTraffic({
      restaurantId,
      date: ymd,
      delta,
      source,
      tableId: meta?.table_id || null,
      orderId: meta?.order_id || null,
      meta,
    });
    return res.json({ date: ymd, customer_count });
  } catch (err) {
    console.error("❌ /analytics/customer-traffic/increment failed:", err);
    return res.status(500).json({ error: "Failed to increment customer traffic" });
  }
});

router.get("/customer-traffic", async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const { start_date, end_date } = req.query;
    const { start, end } = normalizeRange(start_date, end_date || start_date);
    const rows = await fetchCustomerTraffic(restaurantId, start, end);
    return res.json(rows);
  } catch (err) {
    console.error("❌ /analytics/customer-traffic failed:", err);
    return res.status(500).json({ error: "Failed to fetch customer traffic" });
  }
});

router.get("/operational-efficiency", async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const { start_date, end_date } = req.query;
    const { start, end } = normalizeRange(start_date, end_date || start_date);
    const periodDays = Math.max(moment(end).diff(moment(start), "days") + 1, 1);

    const current = await buildMetrics(restaurantId, start, end, { includeDaily: true });

    const prevEnd = moment(start).subtract(1, "day");
    const prevStart = prevEnd.clone().subtract(periodDays - 1, "days");
    const previous_period = await buildMetrics(
      restaurantId,
      prevStart.format("YYYY-MM-DD"),
      prevEnd.format("YYYY-MM-DD")
    );

    const baselineRanges = [];
    let cursorEnd = prevEnd.clone();
    for (let i = 0; i < 3; i++) {
      const bEnd = cursorEnd.clone();
      const bStart = cursorEnd.clone().subtract(periodDays - 1, "days");
      baselineRanges.push({ start: bStart.format("YYYY-MM-DD"), end: bEnd.format("YYYY-MM-DD") });
      cursorEnd = bStart.clone().subtract(1, "day");
    }
    const baselineMetricsList = [];
    for (const r of baselineRanges) {
      baselineMetricsList.push(await buildMetrics(restaurantId, r.start, r.end));
    }
    const baseline = averageMetrics(baselineMetricsList);

    const delta_percent = buildDeltas(current, baseline || previous_period);
    const alerts = buildAlerts(current, baseline, previous_period);

    return res.json({
      start_date: start,
      end_date: end,
      ...current,
      comparisons: {
        previous_period: { range: { start: prevStart.format("YYYY-MM-DD"), end: prevEnd.format("YYYY-MM-DD") }, ...previous_period },
        baseline,
        delta_percent,
      },
      alerts,
    });
  } catch (err) {
    console.error("❌ /analytics/operational-efficiency failed:", err);
    return res.status(500).json({ error: "Failed to fetch operational efficiency" });
  }
});

module.exports = router;
