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
const authMiddleware = require("../middleware/authMiddleware");

router.use(authMiddleware);
const { getIO } = require("../utils/socket");

const CASH_REGISTER_TYPES = new Set([
  "open",
  "close",
  "entry",
  "expense",
  "sale",
  "supplier",
  "payroll",
  "change",
]);

const { generateReportPDF, generateReportCSV } = require("../utils/exportUtils");
const { loadLocalizationForRestaurant } = require("../utils/localization");

const REPORTS_TIMEZONE = process.env.REPORTS_TIMEZONE || "Europe/Istanbul";
const RECON_QUERY_TIMEOUT_MS = Number(process.env.RECON_QUERY_TIMEOUT_MS || 4000);

// 🚀 In-memory cache for cash register status (5 second TTL)
const statusCache = new Map(); // Key: restaurantId, Value: { data, timestamp }
const STATUS_CACHE_TTL = 5000; // 5 seconds

function getCachedStatus(restaurantId) {
  const cached = statusCache.get(restaurantId);
  if (cached && Date.now() - cached.timestamp < STATUS_CACHE_TTL) {
    console.log(`📦 [${restaurantId}] Status served from cache`);
    return cached.data;
  }
  return null;
}

function setCachedStatus(restaurantId, data) {
  statusCache.set(restaurantId, { data, timestamp: Date.now() });
}

function clearCachedStatus(restaurantId) {
  statusCache.delete(restaurantId);
}

function queryWithTimeout(text, values, timeoutMs = RECON_QUERY_TIMEOUT_MS) {
  return pool.query({
    text,
    values,
    query_timeout: timeoutMs,
  });
}

function isCardMethodSql(expr) {
  return `(
    LOWER(COALESCE(${expr}, '')) LIKE '%card%'
    OR LOWER(COALESCE(${expr}, '')) LIKE '%credit%'
    OR LOWER(COALESCE(${expr}, '')) LIKE '%debit%'
    OR LOWER(COALESCE(${expr}, '')) LIKE '%pos%'
  )`;
}

function isCashMethodSql(expr) {
  return `(
    LOWER(COALESCE(${expr}, '')) LIKE '%cash%'
    OR LOWER(COALESCE(${expr}, '')) LIKE '%nakit%'
  )`;
}

// --- Register reconciliation helpers ---
const RISK_THRESHOLDS = {
  cashDiff: 50, // absolute cash variance threshold
  cardDiff: 50,
  voidTotal: 200,
  discountTotal: 150,
  cancelledCount: 5,
};

const normalizeMethod = (m) => String(m || "").trim().toLowerCase();
const isCashMethod = (m) => {
  const method = normalizeMethod(m);
  return method.includes("cash") || method.includes("nakit");
};
const isCardMethod = (m) => {
  const method = normalizeMethod(m);
  return method.includes("card") || method.includes("credit") || method.includes("debit") || method.includes("pos");
};
const categorizePayment = (method) => {
  if (isCashMethod(method)) return "cash";
  if (isCardMethod(method)) return "card";
  return "other";
};

const emptyCardTypeTotals = () => ({
  table: { total: 0, count: 0 },
  delivery: { total: 0, count: 0 },
  phone: { total: 0, count: 0 },
  takeaway: { total: 0, count: 0 },
  unknown: { total: 0, count: 0 },
  grand_total: 0,
});

function buildRiskSummary({ cashDifference = 0, cardDifference = 0, terminalProvided = false, opsSignals = {} }) {
  let score = 0;
  const flags = [];

  if (Math.abs(cashDifference) > RISK_THRESHOLDS.cashDiff) {
    score += 30;
    flags.push({
      code: "CASH_VARIANCE_HIGH",
      severity: "high",
      label: "High cash variance",
      detail: `Cash drawer differs by ${cashDifference.toFixed(2)}`,
    });
  }

  if (terminalProvided && Math.abs(cardDifference) > RISK_THRESHOLDS.cardDiff) {
    score += 25;
    flags.push({
      code: "CARD_VARIANCE",
      severity: "high",
      label: "Card variance",
      detail: `Terminal vs POS differs by ${cardDifference.toFixed(2)}`,
    });
  }

  if ((opsSignals?.void_total || 0) > RISK_THRESHOLDS.voidTotal) {
    score += 10;
    flags.push({
      code: "VOIDS_HIGH",
      severity: "medium",
      label: "Voids high",
      detail: `Voided items total ${opsSignals.void_total}`,
    });
  }

  if ((opsSignals?.discount_total || 0) > RISK_THRESHOLDS.discountTotal) {
    score += 10;
    flags.push({
      code: "DISCOUNTS_HIGH",
      severity: "medium",
      label: "Discounts high",
      detail: `Discounts total ${opsSignals.discount_total}`,
    });
  }

  if ((opsSignals?.cancelled_count || 0) > RISK_THRESHOLDS.cancelledCount) {
    score += 10;
    flags.push({
      code: "CANCELLATIONS_HIGH",
      severity: "medium",
      label: "Cancellations high",
      detail: `${opsSignals.cancelled_count} cancellations`,
    });
  }

  return {
    risk_score: Math.min(score, 100),
    flags,
  };
}

// --- Stock discrepancy helpers ---
const STOCK_VARIANCE_QTY_THRESHOLD = 1; // ignore tiny noise (<1 unit)
const STOCK_VARIANCE_VALUE_THRESHOLD = 200; // for flags

const parseJsonArray = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") return [raw].flat().filter(Boolean);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

async function resolveRegisterSessionWindow(restaurantId, openTimeParam) {
  if (!openTimeParam) return { openTime: null, closeTime: null };
  const openTs = new Date(openTimeParam);
  if (Number.isNaN(openTs.getTime())) return { openTime: null, closeTime: null };

  const { rows: openRows } = await pool.query(
    `
    SELECT created_at
    FROM cash_register_logs
    WHERE restaurant_id = $1
      AND type = 'open'
      AND created_at <= $2
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [restaurantId, openTs]
  );
  if (!openRows.length) {
    return { openTime: null, closeTime: null };
  }
  const openTime = openRows[0].created_at;

  const { rows: closeRows } = await pool.query(
    `
    SELECT created_at
    FROM cash_register_logs
    WHERE restaurant_id = $1
      AND type = 'close'
      AND created_at > $2
    ORDER BY created_at ASC
    LIMIT 1
    `,
    [restaurantId, openTime]
  );
  const closeTime = closeRows[0]?.created_at || new Date();
  return { openTime, closeTime };
}

async function loadStockCostMap(restaurantId) {
  // Determine available pricing columns on ingredient_price_history
  const { rows: priceCols } = await pool.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'ingredient_price_history'
      AND table_schema = 'public'
    `
  );
  const colNames = priceCols.map((r) => r.column_name);
  const hasPPU = colNames.includes("price_per_unit");
  const priceExpr = hasPPU ? "COALESCE(NULLIF(ip.price_per_unit, 0), 0)" : "0";
  const historyJoin = hasPPU
    ? `
    LEFT JOIN LATERAL (
      SELECT ${priceExpr} AS price_per_unit
      FROM ingredient_price_history ip
      WHERE LOWER(BTRIM(ip.ingredient_name)) = LOWER(BTRIM(s.name))
        AND LOWER(BTRIM(ip.unit)) = LOWER(BTRIM(s.unit))
      ORDER BY ip.changed_at DESC
      LIMIT 1
    ) ip ON true
    `
    : "LEFT JOIN LATERAL (SELECT 0::numeric AS price_per_unit) ip ON true";

  const { rows } = await pool.query(
    `
    SELECT
      s.id,
      s.name,
      s.unit,
      COALESCE(
        ${priceExpr},
        NULLIF(tx.price_per_unit, 0),
        0
      ) AS price_per_unit
    FROM stock s
    ${historyJoin}
    LEFT JOIN LATERAL (
      SELECT ROUND(total_cost / NULLIF(quantity, 0), 4) AS price_per_unit
      FROM transactions
      WHERE restaurant_id = s.restaurant_id
        AND LOWER(ingredient) = LOWER(s.name)
        AND unit = s.unit
        AND quantity > 0
      ORDER BY delivery_date DESC
      LIMIT 1
    ) tx ON true
    WHERE s.restaurant_id = $1
    `,
    [restaurantId]
  );

  const map = new Map();
  rows.forEach((row) => {
    const key = (row.name || "").trim().toLowerCase();
    if (!key) return;
    map.set(key, {
      stock_id: row.id,
      unit: row.unit,
      unit_cost: parseFloat(row.price_per_unit || 0),
    });
  });
  return map;
}

async function fetchStockMovementColumns() {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'stock_movements'`
  );
  return rows.map((r) => r.column_name);
}

async function fetchActualStockChanges(restaurantId, startTs, endTs) {
  const { rows: existsRows } = await pool.query(
    `SELECT to_regclass('public.stock_movements') AS tbl`
  );
  if (!existsRows[0]?.tbl) return [];

  const cols = await fetchStockMovementColumns();
  const hasRestaurantId = cols.includes("restaurant_id");
  const hasQtyIn = cols.includes("qty_in");
  const hasQtyOut = cols.includes("qty_out");
  const hasQtyAdjust = cols.includes("qty_adjust");
  const hasQuantity = cols.includes("quantity");
  const hasDirection = cols.includes("direction");
  const hasReason = cols.includes("reason");
  const hasSource = cols.includes("source");
  const hasIngredientId = cols.includes("ingredient_id");
  const hasIngredientName = cols.includes("ingredient_name");
  const hasUnit = cols.includes("unit");

  let netExprParts = [];
  if (hasQtyIn) netExprParts.push("COALESCE(sm.qty_in,0)");
  if (hasQtyOut) netExprParts.push("-COALESCE(sm.qty_out,0)");
  if (hasQtyAdjust) netExprParts.push("COALESCE(sm.qty_adjust,0)");
  if (netExprParts.length === 0 && hasQuantity) {
    if (hasDirection) {
      netExprParts.push(
        "CASE WHEN LOWER(COALESCE(sm.direction,'')) IN ('out','deduct','consume') THEN -COALESCE(sm.quantity,0) ELSE COALESCE(sm.quantity,0) END"
      );
    } else {
      netExprParts.push("COALESCE(sm.quantity,0)");
    }
  }
  const netExpr = netExprParts.length ? netExprParts.join(" + ") : "0";

  const filters = [];
  if (hasReason) {
    filters.push(
      "AND (LOWER(COALESCE(sm.reason,'')) NOT IN ('inventory_count','inventory','count'))"
    );
  }
  if (hasSource) {
    filters.push("AND (LOWER(COALESCE(sm.source,'')) NOT IN ('supplier','purchase'))");
  }

  const query = `
    SELECT
      ${hasIngredientId ? "sm.ingredient_id" : "COALESCE(sm.stock_id, NULL)"} AS ingredient_id,
      ${
        hasIngredientName
          ? "COALESCE(sm.ingredient_name, s.name)"
          : "COALESCE(s.name, 'Unknown')"
      } AS ingredient_name,
      ${hasUnit ? "sm.unit" : "COALESCE(s.unit, '')"} AS unit,
      SUM(${netExpr}) AS actual_change
    FROM stock_movements sm
    LEFT JOIN stock s ON s.id = sm.stock_id
    WHERE sm.restaurant_id = $1
      AND sm.created_at >= $2
      AND sm.created_at < $3
      ${filters.join("\n")}
    GROUP BY 1,2,3
  `;

  const params = hasRestaurantId
    ? [restaurantId, startTs, endTs]
    : [restaurantId, startTs, endTs];
  const queryWithTenant = hasRestaurantId
    ? query
    : query.replace(
        "WHERE sm.restaurant_id = $1",
        "WHERE COALESCE(s.restaurant_id, $1) = $1"
      );

  const { rows } = await pool.query(queryWithTenant, params);
  return rows;
}

async function fetchTheoreticalUsage(restaurantId, startTs, endTs, costMap) {
  const { rows } = await pool.query(
    `
    SELECT
      oi.product_id,
      COALESCE(oi.quantity, 0) AS qty,
      p.ingredients,
      p.name AS product_name
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    JOIN products p ON oi.product_id = p.id
    WHERE o.restaurant_id = $1
      AND o.created_at >= $2
      AND o.created_at < $3
      AND (o.is_paid = true OR LOWER(o.status) IN ('paid','closed','confirmed'))
    `,
    [restaurantId, startTs, endTs]
  );

  const totals = new Map();

  for (const row of rows) {
    const qty = parseFloat(row.qty || 0);
    if (!Number.isFinite(qty) || qty === 0) continue;

    const ingList = parseJsonArray(row.ingredients);
    if (!Array.isArray(ingList) || ingList.length === 0) continue;

    for (const ing of ingList) {
      const name = (ing?.ingredient || ing?.name || "").trim();
      const unit = ing?.unit || "";
      const ingQty = parseFloat(ing?.quantity || 0);
      if (!name || !Number.isFinite(ingQty)) continue;
      const key = name.toLowerCase();
      const prev = totals.get(key) || { ingredient_name: name, unit, theoretical_used_qty: 0 };
      prev.theoretical_used_qty += ingQty * qty;
      // keep unit from first occurrence
      totals.set(key, prev);
    }
  }

  // hydrate with cost/id
  const enriched = [];
  for (const [key, val] of totals.entries()) {
    const costInfo = costMap.get(key) || {};
    enriched.push({
      ingredient_id: costInfo.stock_id || null,
      ingredient_name: val.ingredient_name,
      unit: val.unit || costInfo.unit || "",
      theoretical_used_qty: val.theoretical_used_qty,
      unit_cost: parseFloat(costInfo.unit_cost || 0),
    });
  }
  return enriched;
}

async function buildStockDiscrepancy({ restaurantId, openTime }) {
  const session = await resolveRegisterSessionWindow(restaurantId, openTime);
  if (!session.openTime || !session.closeTime) {
    return {
      session: { openTime: session.openTime, closeTime: session.closeTime },
      summary: {
        variance_value_total: 0,
        negative_variance_value_total: 0,
        positive_variance_value_total: 0,
      },
      items: [],
      flags: [],
    };
  }

  const startTs = session.openTime;
  const endTs = session.closeTime;

  const costMap = await loadStockCostMap(restaurantId);
  const theoretical = await fetchTheoreticalUsage(restaurantId, startTs, endTs, costMap);
  if (!theoretical.length) {
    return {
      session: { openTime: startTs, closeTime: endTs },
      summary: {
        variance_value_total: 0,
        negative_variance_value_total: 0,
        positive_variance_value_total: 0,
      },
      items: [],
      flags: [],
    };
  }

  const actualRows = await fetchActualStockChanges(restaurantId, startTs, endTs);
  const actualMap = new Map();
  actualRows.forEach((row) => {
    const key = (row.ingredient_name || "").trim().toLowerCase();
    if (!key) return;
    actualMap.set(key, parseFloat(row.actual_change || 0));
  });

  const items = [];
  for (const item of theoretical) {
    const key = (item.ingredient_name || "").trim().toLowerCase();
    const theoretical_used_qty = item.theoretical_used_qty || 0;
    const actual_change = actualMap.has(key) ? actualMap.get(key) : 0;
    const variance_qty = actual_change - theoretical_used_qty;
    const unit_cost = item.unit_cost || 0;

    if (!Number.isFinite(unit_cost) || unit_cost <= 0) continue;
    if (Math.abs(variance_qty) < STOCK_VARIANCE_QTY_THRESHOLD) continue;

    const variance_value = variance_qty * unit_cost;
    items.push({
      ingredient_id: item.ingredient_id,
      ingredient_name: item.ingredient_name,
      unit: item.unit,
      theoretical_used_qty,
      actual_change,
      variance_qty,
      variance_value,
    });
  }

  if (!items.length) {
    return {
      session: { openTime: startTs, closeTime: endTs },
      summary: {
        variance_value_total: 0,
        negative_variance_value_total: 0,
        positive_variance_value_total: 0,
      },
      items: [],
      flags: [],
    };
  }

  items.sort((a, b) => Math.abs(b.variance_value) - Math.abs(a.variance_value));
  const topItems = items.slice(0, 10);

  let variance_value_total = 0;
  let negative_variance_value_total = 0;
  let positive_variance_value_total = 0;
  for (const it of topItems) {
    variance_value_total += it.variance_value;
    if (it.variance_value < 0) negative_variance_value_total += it.variance_value;
    else positive_variance_value_total += it.variance_value;
  }

  const flags = [];
  if (Math.abs(variance_value_total) > STOCK_VARIANCE_VALUE_THRESHOLD) {
    flags.push({ code: "STOCK_VARIANCE_HIGH", severity: "medium" });
  }
  if (Math.abs(negative_variance_value_total) > STOCK_VARIANCE_VALUE_THRESHOLD) {
    flags.push({ code: "STOCK_NEGATIVE_VARIANCE", severity: "high" });
  }

  return {
    session: { openTime: startTs, closeTime: endTs },
    summary: {
      variance_value_total,
      negative_variance_value_total,
      positive_variance_value_total,
    },
    items: topItems,
    flags,
  };
}

async function fetchPosPaymentTotals(restaurantId, startTs, endTs) {
  const sessionTsExpr = orderEventTimestampExpr("o");
  const sessionRangeExpr = sessionRangeExprForTs(sessionTsExpr, "o", 2, 3);
  const params = [restaurantId, startTs, endTs];
  console.log("🔎 [reconciliation] POS totals window", {
    restaurantId,
    startTs,
    endTs,
  });
  const [receiptRes, paymentsRes, ordersRes] = await Promise.all([
    pool.query(
      `
        SELECT LOWER(BTRIM(rm.payment_method)) AS method, SUM(rm.amount) AS value
        FROM receipt_methods rm
        JOIN orders o ON rm.receipt_id = o.receipt_id
        WHERE o.restaurant_id = $1
          AND (o.is_paid = true OR LOWER(o.status) IN ('confirmed', 'paid', 'closed'))
          AND ${sessionRangeExpr}
        GROUP BY LOWER(BTRIM(rm.payment_method))
      `,
      params
    ),
    pool.query(
      `
        SELECT LOWER(BTRIM(p.payment_method)) AS method, SUM(p.amount) AS value
        FROM payments p
        JOIN orders o ON p.order_id = o.id
        WHERE o.restaurant_id = $1
          AND p.amount > 0
          AND p.payment_method IS NOT NULL
          AND p.payment_method != ''
          AND ${sessionRangeExpr}
        GROUP BY LOWER(BTRIM(p.payment_method))
      `,
      params
    ),
    pool.query(
      `
        SELECT LOWER(BTRIM(o.payment_method)) AS method, SUM(o.total) AS value
        FROM orders o
        WHERE o.restaurant_id = $1
          AND (o.is_paid = true OR LOWER(o.status) IN ('confirmed', 'paid', 'closed'))
          AND o.payment_method IS NOT NULL
          AND o.payment_method != ''
          AND NOT EXISTS (SELECT 1 FROM receipt_methods rm WHERE rm.receipt_id = o.receipt_id)
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.amount > 0)
          AND ${sessionRangeExpr}
        GROUP BY LOWER(BTRIM(o.payment_method))
      `,
      params
    ),
  ]);

  console.log("🔎 [reconciliation] POS totals rows", {
    receipt: receiptRes.rows,
    payments: paymentsRes.rows,
    orders: ordersRes.rows,
  });

  const totals = new Map();
  const addRows = (rows) => {
    rows.forEach((row) => {
      const method = row.method || "unknown";
      const value = parseFloat(row.value || 0);
      totals.set(method, (totals.get(method) || 0) + value);
    });
  };
  addRows(receiptRes.rows);
  addRows(paymentsRes.rows);
  addRows(ordersRes.rows);

  if (totals.size === 0) {
    const fallback = await pool.query(
      `
        SELECT LOWER(BTRIM(o.payment_method)) AS method, SUM(o.total) AS value
        FROM orders o
        WHERE o.restaurant_id = $1
          AND o.payment_method IS NOT NULL
          AND o.payment_method != ''
          AND ${sessionRangeExpr}
      GROUP BY LOWER(BTRIM(o.payment_method))
      `,
      params
    );
    console.log("🔎 [reconciliation] POS totals fallback rows", fallback.rows);
    addRows(fallback.rows);
  }

  let cash_total = 0;
  let card_total = 0;
  let other_total = 0;
  let grand_total = 0;

  for (const [method, value] of totals.entries()) {
    grand_total += value;
    const category = categorizePayment(method);
    if (category === "cash") cash_total += value;
    else if (category === "card") card_total += value;
    else other_total += value;
  }

  return {
    totals,
    posTotals: {
      cash_total,
      card_total,
      other_total,
      grand_total,
    },
  };
}

async function fetchCardTotalsByOrderType(restaurantId, startTs, endTs) {
  const sessionTsExpr = orderEventTimestampExpr("o");
  const sessionRangeExpr = sessionRangeExprForTs(sessionTsExpr, "o", 2, 3);
  const params = [restaurantId, startTs, endTs];
  const cardTotals = new Map();

  const normalizeType = (t) => {
    const lower = String(t || "").toLowerCase();
    if (["table", "delivery", "phone", "takeaway"].includes(lower)) return lower;
    if (lower === "packet") return "delivery";
    return "unknown";
  };

  const addRows = (rows) => {
    rows.forEach((row) => {
      const orderType = normalizeType(row.order_type || "unknown");
      const total = parseFloat(row.total || 0);
      const count = parseInt(row.count || 0, 10) || 0;
      const prev = cardTotals.get(orderType) || { total: 0, count: 0 };
      cardTotals.set(orderType, {
        total: prev.total + total,
        count: prev.count + count,
      });
    });
  };

  const [receiptRows, paymentRows, orderRows] = await Promise.all([
    pool.query(
      `
        SELECT COALESCE(NULLIF(o.order_type, ''), 'unknown') AS order_type,
               SUM(rm.amount) AS total,
               COUNT(DISTINCT o.id) AS count
        FROM receipt_methods rm
        JOIN orders o ON rm.receipt_id = o.receipt_id
        WHERE o.restaurant_id = $1
          AND (o.is_paid = true OR LOWER(o.status) IN ('confirmed', 'paid', 'closed'))
          AND ${sessionRangeExpr}
          AND (
            LOWER(BTRIM(rm.payment_method)) LIKE '%card%'
            OR LOWER(BTRIM(rm.payment_method)) LIKE '%credit%'
            OR LOWER(BTRIM(rm.payment_method)) LIKE '%debit%'
            OR LOWER(BTRIM(rm.payment_method)) LIKE '%pos%'
          )
        GROUP BY 1
      `,
      params
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(o.order_type, ''), 'unknown') AS order_type,
               SUM(p.amount) AS total,
               COUNT(DISTINCT o.id) AS count
        FROM payments p
        JOIN orders o ON p.order_id = o.id
        WHERE o.restaurant_id = $1
          AND ${sessionRangeExpr}
          AND p.amount > 0
          AND (
            LOWER(BTRIM(p.payment_method)) LIKE '%card%'
            OR LOWER(BTRIM(p.payment_method)) LIKE '%credit%'
            OR LOWER(BTRIM(p.payment_method)) LIKE '%debit%'
            OR LOWER(BTRIM(p.payment_method)) LIKE '%pos%'
          )
        GROUP BY 1
      `,
      params
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(o.order_type, ''), 'unknown') AS order_type,
               SUM(o.total) AS total,
               COUNT(*) AS count
        FROM orders o
        WHERE o.restaurant_id = $1
          AND (o.is_paid = true OR LOWER(o.status) IN ('confirmed', 'paid', 'closed'))
          AND o.payment_method IS NOT NULL
          AND o.payment_method != ''
          AND (
            LOWER(o.payment_method) LIKE '%card%'
            OR LOWER(o.payment_method) LIKE '%credit%'
            OR LOWER(o.payment_method) LIKE '%debit%'
            OR LOWER(o.payment_method) LIKE '%pos%'
          )
          AND NOT EXISTS (SELECT 1 FROM receipt_methods rm WHERE rm.receipt_id = o.receipt_id)
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.amount > 0)
          AND ${sessionRangeExpr}
        GROUP BY 1
      `,
      params
    ),
  ]);

  addRows(receiptRows.rows);
  addRows(paymentRows.rows);
  addRows(orderRows.rows);

  if (cardTotals.size === 0) {
    const fallback = await pool.query(
      `
        SELECT COALESCE(NULLIF(o.order_type, ''), 'unknown') AS order_type,
               SUM(o.total) AS total,
               COUNT(*) AS count
        FROM orders o
        WHERE o.restaurant_id = $1
          AND o.payment_method IS NOT NULL
          AND o.payment_method != ''
          AND (
            LOWER(o.payment_method) LIKE '%card%'
            OR LOWER(o.payment_method) LIKE '%credit%'
            OR LOWER(o.payment_method) LIKE '%debit%'
            OR LOWER(o.payment_method) LIKE '%pos%'
          )
          AND ${sessionRangeExpr}
        GROUP BY 1
      `,
      params
    );
    addRows(fallback.rows);
  }

  const base = emptyCardTypeTotals();
  for (const [orderType, data] of cardTotals.entries()) {
    if (!base[orderType]) base[orderType] = { total: 0, count: 0 };
    base[orderType].total += data.total;
    base[orderType].count += data.count;
    base.grand_total += data.total;
  }

  return base;
}

async function fetchCardTotalsByOrderTypeLite(restaurantId, startTs, endTs) {
  const sessionTsExpr = orderEventTimestampExpr("o");
  const sessionRangeExpr = sessionRangeExprForTs(sessionTsExpr, "o", 2, 3);
  const params = [restaurantId, startTs, endTs];

  const normalizeType = (t) => {
    const lower = String(t || "").toLowerCase();
    if (["table", "delivery", "phone", "takeaway"].includes(lower)) return lower;
    if (lower === "packet") return "delivery";
    return "unknown";
  };

  // NOTE: "Lite" must still be correct for split payments.
  // Prefer receipt_methods (and then payments) when available; only fall back to orders.total.
  const { rows } = await queryWithTimeout(
    `
      WITH base_orders AS (
        SELECT
          o.id,
          o.receipt_id,
          COALESCE(NULLIF(o.order_type, ''), 'unknown') AS order_type,
          o.total,
          o.payment_method
        FROM orders o
        WHERE o.restaurant_id = $1
          AND (o.is_paid = true OR LOWER(COALESCE(o.status, '')) IN ('confirmed', 'paid', 'closed'))
          AND ${sessionRangeExpr}
      ),
      card_rows AS (
        -- 1) Prefer receipt_methods (handles split receipts correctly)
        SELECT
          bo.order_type,
          bo.id AS order_id,
          rm.amount AS amount
        FROM base_orders bo
        JOIN receipt_methods rm ON rm.receipt_id = bo.receipt_id
        WHERE ${isCardMethodSql("rm.payment_method")}

        UNION ALL

        -- 2) Next, payments (only if no receipt_methods exist for the order)
        SELECT
          bo.order_type,
          bo.id AS order_id,
          p.amount AS amount
        FROM base_orders bo
        JOIN payments p ON p.order_id = bo.id
        WHERE p.amount > 0
          AND ${isCardMethodSql("p.payment_method")}
          AND NOT EXISTS (SELECT 1 FROM receipt_methods rm2 WHERE rm2.receipt_id = bo.receipt_id)

        UNION ALL

        -- 3) Final fallback: orders.total (only if neither receipt_methods nor payments exist)
        SELECT
          bo.order_type,
          bo.id AS order_id,
          bo.total AS amount
        FROM base_orders bo
        WHERE bo.payment_method IS NOT NULL
          AND bo.payment_method != ''
          AND ${isCardMethodSql("bo.payment_method")}
          AND NOT EXISTS (SELECT 1 FROM receipt_methods rm2 WHERE rm2.receipt_id = bo.receipt_id)
          AND NOT EXISTS (SELECT 1 FROM payments p2 WHERE p2.order_id = bo.id AND p2.amount > 0)
      )
      SELECT
        order_type,
        SUM(amount) AS total,
        COUNT(DISTINCT order_id) AS count
      FROM card_rows
      GROUP BY 1
    `,
    params
  );

  const base = emptyCardTypeTotals();
  for (const row of rows) {
    const orderType = normalizeType(row.order_type || "unknown");
    const total = parseFloat(row.total || 0);
    const count = parseInt(row.count || 0, 10) || 0;
    if (!base[orderType]) base[orderType] = { total: 0, count: 0 };
    base[orderType].total += total;
    base[orderType].count += count;
    base.grand_total += total;
  }

  return base;
}

async function fetchPosTotalsLite(restaurantId, startTs, endTs) {
  const sessionTsExpr = orderEventTimestampExpr("o");
  const sessionRangeExpr = sessionRangeExprForTs(sessionTsExpr, "o", 2, 3);
  const params = [restaurantId, startTs, endTs];

  // NOTE: "Lite" must still be correct for split receipts.
  // Prefer receipt_methods (and then payments) when available; only fall back to orders.total.
  const { rows } = await queryWithTimeout(
    `
      WITH base_orders AS (
        SELECT
          o.id,
          o.receipt_id,
          o.total,
          o.payment_method
        FROM orders o
        WHERE o.restaurant_id = $1
          AND (o.is_paid = true OR LOWER(COALESCE(o.status, '')) IN ('confirmed', 'paid', 'closed'))
          AND ${sessionRangeExpr}
      ),
      sources AS (
        -- 1) receipt_methods preferred
        SELECT
          CASE WHEN ${isCashMethodSql("rm.payment_method")} THEN rm.amount ELSE 0 END AS cash_amount,
          CASE WHEN ${isCardMethodSql("rm.payment_method")} THEN rm.amount ELSE 0 END AS card_amount,
          CASE
            WHEN rm.payment_method IS NULL OR rm.payment_method = '' THEN 0
            WHEN ${isCashMethodSql("rm.payment_method")} THEN 0
            WHEN ${isCardMethodSql("rm.payment_method")} THEN 0
            ELSE rm.amount
          END AS other_amount
        FROM base_orders bo
        JOIN receipt_methods rm ON rm.receipt_id = bo.receipt_id

        UNION ALL

        -- 2) payments only when no receipt_methods exist
        SELECT
          CASE WHEN ${isCashMethodSql("p.payment_method")} THEN p.amount ELSE 0 END AS cash_amount,
          CASE WHEN ${isCardMethodSql("p.payment_method")} THEN p.amount ELSE 0 END AS card_amount,
          CASE
            WHEN p.payment_method IS NULL OR p.payment_method = '' THEN 0
            WHEN ${isCashMethodSql("p.payment_method")} THEN 0
            WHEN ${isCardMethodSql("p.payment_method")} THEN 0
            ELSE p.amount
          END AS other_amount
        FROM base_orders bo
        JOIN payments p ON p.order_id = bo.id
        WHERE p.amount > 0
          AND NOT EXISTS (SELECT 1 FROM receipt_methods rm2 WHERE rm2.receipt_id = bo.receipt_id)

        UNION ALL

        -- 3) orders.total fallback when neither receipt_methods nor payments exist
        SELECT
          CASE WHEN ${isCashMethodSql("bo.payment_method")} THEN bo.total ELSE 0 END AS cash_amount,
          CASE WHEN ${isCardMethodSql("bo.payment_method")} THEN bo.total ELSE 0 END AS card_amount,
          CASE
            WHEN bo.payment_method IS NULL OR bo.payment_method = '' THEN 0
            WHEN ${isCashMethodSql("bo.payment_method")} THEN 0
            WHEN ${isCardMethodSql("bo.payment_method")} THEN 0
            ELSE bo.total
          END AS other_amount
        FROM base_orders bo
        WHERE bo.payment_method IS NOT NULL
          AND bo.payment_method != ''
          AND NOT EXISTS (SELECT 1 FROM receipt_methods rm2 WHERE rm2.receipt_id = bo.receipt_id)
          AND NOT EXISTS (SELECT 1 FROM payments p2 WHERE p2.order_id = bo.id AND p2.amount > 0)
      )
      SELECT
        COALESCE(SUM(cash_amount), 0) AS cash_total,
        COALESCE(SUM(card_amount), 0) AS card_total,
        COALESCE(SUM(other_amount), 0) AS other_total
      FROM sources
    `,
    params
  );

  const cash_total = parseFloat(rows?.[0]?.cash_total || 0);
  const card_total = parseFloat(rows?.[0]?.card_total || 0);
  const other_total = parseFloat(rows?.[0]?.other_total || 0);
  return {
    cash_total,
    card_total,
    other_total,
    grand_total: cash_total + card_total + other_total,
  };
}

async function fetchCashSalesLite(restaurantId, startTs, endTs) {
  const params = [restaurantId, startTs, endTs];

  const receiptRes = await queryWithTimeout(
    `
      SELECT COALESCE(SUM(rm.amount), 0) AS total
      FROM receipt_methods rm
      JOIN orders o ON rm.receipt_id = o.receipt_id
      WHERE o.restaurant_id = $1
        AND COALESCE(o.kitchen_delivered_at, o.created_at) >= $2::timestamptz
        AND COALESCE(o.kitchen_delivered_at, o.created_at) < $3::timestamptz
        AND (LOWER(COALESCE(o.status, '')) IN ('paid', 'closed') OR o.is_paid = true)
        AND ${isCashMethodSql("rm.payment_method")}
    `,
    params
  ).catch(() => ({ rows: [{ total: 0 }] }));

  const paymentsRes = await queryWithTimeout(
    `
      SELECT COALESCE(SUM(p.amount), 0) AS total
      FROM payments p
      JOIN orders o ON p.order_id = o.id
      WHERE o.restaurant_id = $1
        AND COALESCE(o.kitchen_delivered_at, o.created_at) >= $2::timestamptz
        AND COALESCE(o.kitchen_delivered_at, o.created_at) < $3::timestamptz
        AND (LOWER(COALESCE(o.status, '')) IN ('paid', 'closed') OR o.is_paid = true)
        AND ${isCashMethodSql("p.payment_method")}
        AND (
          o.receipt_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM receipt_methods rm2 WHERE rm2.receipt_id = o.receipt_id
          )
        )
    `,
    params
  ).catch(() => ({ rows: [{ total: 0 }] }));

  const ordersRes = await queryWithTimeout(
    `
      SELECT COALESCE(SUM(o.total), 0) AS total
      FROM orders o
      WHERE o.restaurant_id = $1
        AND COALESCE(o.kitchen_delivered_at, o.created_at) >= $2::timestamptz
        AND COALESCE(o.kitchen_delivered_at, o.created_at) < $3::timestamptz
        AND (LOWER(COALESCE(o.status, '')) IN ('paid', 'closed') OR o.is_paid = true)
        AND ${isCashMethodSql("o.payment_method")}
        AND NOT EXISTS (SELECT 1 FROM receipt_methods rm2 WHERE rm2.receipt_id = o.receipt_id)
        AND NOT EXISTS (SELECT 1 FROM payments p2 WHERE p2.order_id = o.id)
    `,
    params
  ).catch(() => ({ rows: [{ total: 0 }] }));

  const receiptTotal = parseFloat(receiptRes.rows?.[0]?.total || 0);
  const paymentsTotal = parseFloat(paymentsRes.rows?.[0]?.total || 0);
  const ordersTotal = parseFloat(ordersRes.rows?.[0]?.total || 0);
  const total = receiptTotal + paymentsTotal + ordersTotal;
  console.log("💵 [reconciliation] cash-sales-lite", {
    restaurantId,
    startTs,
    endTs,
    receiptTotal,
    paymentsTotal,
    ordersTotal,
    total,
  });
  return total;
}

async function fetchCashExpenses(restaurantId, startTs, endTs, options = {}) {
  const includeTransactions = options.includeTransactions !== false;
  const cashMethods = ["cash", "Cash", "CASH"];

  const res1 = await pool
    .query({
      text: `
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM cash_register_logs
      WHERE restaurant_id = $1
        AND type = 'expense'
        AND created_at >= $2
        AND created_at < $3
      `,
      values: [restaurantId, startTs, endTs],
      query_timeout: RECON_QUERY_TIMEOUT_MS,
    })
    .catch(() => ({ rows: [{ total: 0 }] }));

  const res2 = includeTransactions
    ? await pool
        .query({
          text: `
          SELECT COALESCE(SUM(amount_paid), 0) AS total
          FROM transactions
          WHERE restaurant_id = $1
            AND delivery_date >= $2
            AND delivery_date < $3
            AND payment_method = ANY($4)
          `,
          values: [restaurantId, startTs, endTs, cashMethods],
          query_timeout: RECON_QUERY_TIMEOUT_MS,
        })
        .catch(() => ({ rows: [{ total: 0 }] }))
    : { rows: [{ total: 0 }] };

  const res3 = await pool
    .query({
      text: `
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM staff_payments
      WHERE restaurant_id = $1
        AND created_at >= $2
        AND created_at < $3
        AND payment_method = ANY($4)
      `,
      values: [restaurantId, startTs, endTs, cashMethods],
      query_timeout: RECON_QUERY_TIMEOUT_MS,
    })
    .catch(() => ({ rows: [{ total: 0 }] }));

  const from_register = parseFloat(res1.rows[0].total || 0);
  const from_transactions = parseFloat(res2.rows[0].total || 0);
  const from_staff = parseFloat(res3.rows[0].total || 0);

  return {
    cash_expenses_total: from_register + from_transactions + from_staff,
    cash_refunds_total: 0,
    cash_expenses_breakdown: {
      from_register,
      from_transactions,
      from_staff,
    },
  };
}

async function fetchOpsSignals(restaurantId, startTs, endTs) {
  const [discountRes, cancelledRes, pmChangeRes] = await Promise.all([
    pool
      .query(
        `
        SELECT COALESCE(SUM(discount_value), 0) AS total
        FROM orders
        WHERE restaurant_id = $1
          AND created_at >= $2
          AND created_at < $3
      `,
        [restaurantId, startTs, endTs]
      )
      .catch(() => ({ rows: [{ total: 0 }] })),
    pool.query(
      `
      SELECT COUNT(*) AS cnt
      FROM orders
      WHERE restaurant_id = $1
        AND created_at >= $2
        AND created_at < $3
        AND LOWER(status) IN ('cancelled','canceled')
    `,
      [restaurantId, startTs, endTs]
    ),
    pool
      .query(
        `
        SELECT COUNT(*) AS cnt
        FROM payment_method_changes pmc
        JOIN orders o ON pmc.order_id = o.id
        WHERE o.restaurant_id = $1
          AND COALESCE(pmc.created_at, o.updated_at, o.created_at) >= $2
          AND COALESCE(pmc.created_at, o.updated_at, o.created_at) < $3
      `,
        [restaurantId, startTs, endTs]
      )
      .catch(() => ({ rows: [{ cnt: 0 }] })),
  ]);

  return {
    void_count: 0,
    void_total: 0,
    discount_total: parseFloat(discountRes?.rows?.[0]?.total || 0),
    cancelled_count: parseInt(cancelledRes?.rows?.[0]?.cnt || 0, 10) || 0,
    payment_method_change_count:
      parseInt(pmChangeRes?.rows?.[0]?.cnt || 0, 10) || 0,
  };
}

async function buildRegisterReconciliationSnapshot({
  restaurantId,
  openTime,
  nowTime = new Date(),
  mode = "full",
}) {
  const nowTs = new Date(nowTime);
  const nowIso = nowTs.toISOString();
  const errors = [];

  if (!openTime) {
    return {
      session: { openTime: null, nowTime: nowIso },
      posTotals: { cash_total: 0, card_total: 0, other_total: 0, grand_total: 0 },
      cardByOrderType: emptyCardTypeTotals(),
      cashReconciliation: {
        opening_float: 0,
        expected_cash_total: 0,
        cash_expenses_total: 0,
        cash_refunds_total: 0,
      },
      opsSignals: {
        void_count: 0,
        void_total: 0,
        discount_total: 0,
        cancelled_count: 0,
        payment_method_change_count: 0,
      },
      stockSignals: {
        has_stock_module: true,
        variance_items: [],
        variance_value_total: 0,
      },
      risk: { risk_score: 0, flags: [] },
      partial: false,
      errors: [],
    };
  }

  const openTs = new Date(openTime);
  if (Number.isNaN(openTs.getTime())) {
    return {
      session: { openTime, nowTime: nowIso },
      posTotals: { cash_total: 0, card_total: 0, other_total: 0, grand_total: 0 },
      cardByOrderType: emptyCardTypeTotals(),
      cashReconciliation: {
        opening_float: 0,
        expected_cash_total: 0,
        cash_expenses_total: 0,
        cash_refunds_total: 0,
      },
      opsSignals: {
        void_count: 0,
        void_total: 0,
        discount_total: 0,
        cancelled_count: 0,
        payment_method_change_count: 0,
      },
      stockSignals: {
        has_stock_module: true,
        variance_items: [],
        variance_value_total: 0,
      },
      risk: { risk_score: 0, flags: [] },
      partial: false,
      errors: [],
    };
  }

  const startTs = openTs.toISOString();
  let posTotals = { cash_total: 0, card_total: 0, other_total: 0, grand_total: 0 };
  let cardByOrderType = emptyCardTypeTotals();
  let expenses = {
    cash_expenses_total: 0,
    cash_refunds_total: 0,
    cash_expenses_breakdown: { from_register: 0, from_transactions: 0, from_staff: 0 },
  };
  let opsSignals = {
    void_count: 0,
    void_total: 0,
    discount_total: 0,
    cancelled_count: 0,
    payment_method_change_count: 0,
  };
  let cashSalesForExpected = null;

  // ⚡ ESSENTIAL MODE: Skip heavy queries, just get opening float
  if (mode === "essential") {
    console.log(`⚡ [reconciliation] ESSENTIAL mode - skipping heavy queries for ${restaurantId}`);
    const essentialResults = await Promise.allSettled([
      fetchPosTotalsLite(restaurantId, startTs, nowIso),
      fetchCardTotalsByOrderTypeLite(restaurantId, startTs, nowIso),
      fetchCashExpenses(restaurantId, startTs, nowIso, { includeTransactions: true }),
      fetchCashSalesLite(restaurantId, startTs, nowIso),
    ]);

    if (essentialResults[0].status === "fulfilled") {
      posTotals = essentialResults[0].value || posTotals;
    } else {
      errors.push({
        section: "posTotalsLite",
        message: String(essentialResults[0].reason?.message || essentialResults[0].reason),
      });
    }

    if (essentialResults[1].status === "fulfilled") {
      cardByOrderType = essentialResults[1].value || cardByOrderType;
      if (!posTotals.card_total) {
        posTotals.card_total = cardByOrderType?.grand_total || 0;
        posTotals.grand_total = posTotals.cash_total + posTotals.card_total + posTotals.other_total;
      }
    } else {
      errors.push({
        section: "cardByOrderTypeLite",
        message: String(essentialResults[1].reason?.message || essentialResults[1].reason),
      });
    }

    if (essentialResults[2].status === "fulfilled") {
      expenses = essentialResults[2].value || expenses;
    } else {
      errors.push({
        section: "cashExpensesLite",
        message: String(essentialResults[2].reason?.message || essentialResults[2].reason),
      });
    }

    if (essentialResults[3].status === "fulfilled") {
      cashSalesForExpected = Number(essentialResults[3].value || 0);
    } else {
      errors.push({
        section: "cashSalesLite",
        message: String(essentialResults[3].reason?.message || essentialResults[3].reason),
      });
    }
  } else {
    // FULL MODE: Run all heavy queries IN PARALLEL for speed
    const results = await Promise.allSettled([
      fetchPosPaymentTotals(restaurantId, startTs, nowIso),
      fetchCardTotalsByOrderType(restaurantId, startTs, nowIso),
      fetchCashExpenses(restaurantId, startTs, nowIso, { includeTransactions: true }),
      fetchOpsSignals(restaurantId, startTs, nowIso),
    ]);

    // Extract results
    if (results[0].status === "fulfilled") {
      posTotals = results[0].value.posTotals || posTotals;
    } else {
      errors.push({ section: "posTotals", message: String(results[0].reason?.message || results[0].reason) });
    }

    if (results[1].status === "fulfilled") {
      cardByOrderType = results[1].value || cardByOrderType;
    } else {
      errors.push({ section: "cardByOrderType", message: String(results[1].reason?.message || results[1].reason) });
    }

    if (results[2].status === "fulfilled") {
      expenses = results[2].value || expenses;
    } else {
      errors.push({ section: "cashExpenses", message: String(results[2].reason?.message || results[2].reason) });
    }

    if (results[3].status === "fulfilled") {
      opsSignals = results[3].value || opsSignals;
    } else {
      errors.push({ section: "opsSignals", message: String(results[3].reason?.message || results[3].reason) });
    }
  }

  // Opening float from the relevant open log
  let openRows = [];
  let openingFloat = 0;
  try {
    const res = await pool.query(
      `
      SELECT created_at, amount
      FROM cash_register_logs
      WHERE restaurant_id = $1
        AND type = 'open'
        AND created_at <= $2::timestamptz
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [restaurantId, openTs.toISOString()]
    );
    openRows = res.rows || [];
    console.log("🔎 [reconciliation] opening float lookup", {
      restaurantId,
      openTime: openTs.toISOString(),
      openRow: openRows[0] || null,
    });
    openingFloat = parseFloat(openRows?.[0]?.amount || 0);
  } catch (err) {
    errors.push({ section: "openingFloat", message: String(err?.message || err) });
  }
  if (!openingFloat) {
    try {
      const { rows: prevClose } = await pool.query(
        `
        SELECT amount
        FROM cash_register_logs
        WHERE restaurant_id = $1
          AND type = 'close'
          AND created_at < $2::timestamptz
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [restaurantId, openTs.toISOString()]
      );
      openingFloat = parseFloat(prevClose?.[0]?.amount || 0);
    } catch (err) {
      errors.push({ section: "openingFloatFallback", message: String(err?.message || err) });
    }
  }

  const expected_cash_total =
    openingFloat +
    (cashSalesForExpected != null ? cashSalesForExpected : posTotals.cash_total || 0) -
    (expenses.cash_expenses_total || 0) -
    (expenses.cash_refunds_total || 0);

  console.log("💵 [reconciliation] expected-cash components", {
    restaurantId,
    mode,
    openTime: openRows?.[0]?.created_at || startTs,
    openingFloat,
    cashSalesForExpected:
      cashSalesForExpected != null ? cashSalesForExpected : posTotals.cash_total || 0,
    expenses: expenses.cash_expenses_total || 0,
    refunds: expenses.cash_refunds_total || 0,
    expected_cash_total,
  });

  return {
    session: { openTime: openRows?.[0]?.created_at || startTs, nowTime: nowIso },
    posTotals,
    cardByOrderType,
    cashReconciliation: {
      opening_float: openingFloat,
      expected_cash_total,
      cash_expenses_total: expenses.cash_expenses_total || 0,
      cash_refunds_total: expenses.cash_refunds_total || 0,
    },
    opsSignals,
    stockSignals: {
      has_stock_module: true,
      variance_items: [],
      variance_value_total: 0,
    },
    risk: buildRiskSummary({ cashDifference: 0, cardDifference: 0, terminalProvided: false, opsSignals }),
    snapshot_mode: mode,
    partial: errors.length > 0 || mode !== "full",
    errors,
  };
}

// IMPORTANT: "Today's sales" should follow when an order is completed/delivered,
// not necessarily when it was created (orders can stay open overnight).
const orderEventTimestampExpr = (alias = "o") =>
  `COALESCE(${alias}.kitchen_delivered_at, ${alias}.created_at)`;

// History should follow when money is taken (paid_at) if possible, otherwise fall back to delivered/created.
const orderHistoryTimestampExpr = (alias = "o") =>
  `COALESCE(
     (SELECT MAX(oi.paid_at) FROM order_items oi WHERE oi.order_id = ${alias}.id),
     ${alias}.kitchen_delivered_at,
     ${alias}.created_at
   )`;

const rangeExprForTs = (tsExpr, alias = "o", startIdx = 2, endIdx = 3) => {
  const start = `$${startIdx}`;
  const end = `$${endIdx}`;
  return `(
    CASE
      WHEN pg_typeof(${alias}.created_at) = 'timestamp with time zone'::regtype
        THEN ${tsExpr} >= (${start}::date AT TIME ZONE '${REPORTS_TIMEZONE}')
         AND ${tsExpr} < ((${end}::date + INTERVAL '1 day') AT TIME ZONE '${REPORTS_TIMEZONE}')
      ELSE ${tsExpr} >= ${start}::date
       AND ${tsExpr} < (${end}::date + INTERVAL '1 day')
    END
  )`;
};

const sessionRangeExprForTs = (tsExpr, alias = "o", startIdx = 2, endIdx = 3) => {
  const start = `$${startIdx}`;
  const end = `$${endIdx}`;
  return `(
    CASE
      WHEN pg_typeof(${alias}.created_at) = 'timestamp with time zone'::regtype
        THEN ${tsExpr} >= ${start}::timestamptz
         AND ${tsExpr} < ${end}::timestamptz
      ELSE ${tsExpr} >= (${start}::timestamptz AT TIME ZONE '${REPORTS_TIMEZONE}')
       AND ${tsExpr} < (${end}::timestamptz AT TIME ZONE '${REPORTS_TIMEZONE}')
    END
  )`;
};

const orderRangeExpr = (alias = "o", startIdx = 2, endIdx = 3) => {
  const start = `$${startIdx}`;
  const end = `$${endIdx}`;
  const ts = orderEventTimestampExpr(alias);
  return `(
    CASE
      WHEN pg_typeof(${alias}.created_at) = 'timestamp with time zone'::regtype
        THEN ${ts} >= (${start}::date AT TIME ZONE '${REPORTS_TIMEZONE}')
         AND ${ts} < ((${end}::date + INTERVAL '1 day') AT TIME ZONE '${REPORTS_TIMEZONE}')
      ELSE ${ts} >= ${start}::date
       AND ${ts} < (${end}::date + INTERVAL '1 day')
    END
  )`;
};

router.post("/export/pdf", async (req, res) => {
  try {
    const { from, to, sections } = req.body;
    const restaurantId = req.user.restaurant_id;
    let currency;
    try {
      const localization = await loadLocalizationForRestaurant(restaurantId);
      currency = localization?.currency;
    } catch (err) {
      console.warn(
        "⚠️ Failed to load localization for PDF export:",
        err?.message || err
      );
    }
    const pdfBuffer = await generateReportPDF({ from, to, sections, currency });
    res.setHeader("Content-Type", "routerlication/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=report.pdf");
    res.send(pdfBuffer);
  } catch (err) {
    console.error("❌ PDF export failed:", err);
    res.status(500).send(`Failed to export PDF: ${err.message}`);
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



// Tenant-safe and consistent /reports/summary
router.get("/summary", async (req, res) => {
  try {
    const client = await pool.connect();
    const { from, to } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const startDate = from || today;
    const endDate = to || today;
    const restaurantId = req.user.restaurant_id;

    // Gross Sales (orders)
    const grossSalesRes = await client.query(
      `
      SELECT COALESCE(SUM(o.total), 0) AS gross_sales
      FROM orders o
      WHERE o.restaurant_id = $1
        AND (o.is_paid = true OR LOWER(o.status) IN ('confirmed', 'paid', 'closed'))
        AND ${orderRangeExpr("o", 2, 3)}
      `,
      [restaurantId, startDate, endDate]
    );
    const grossSales = parseFloat(grossSalesRes.rows[0]?.gross_sales || 0);

    // Daily Sales (same as gross_sales for consistency)
    // Receipt methods can be unreliable, so we use gross_sales as the source of truth
    const dailySales = grossSales;

    // Net Sales (after discount)
    const netSalesRes = await client.query(
      `
      SELECT COALESCE(SUM(o.total - COALESCE(p.discount_value, 0)), 0) AS net_sales
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE o.restaurant_id = $1
        AND (o.is_paid = true OR LOWER(o.status) IN ('confirmed', 'paid', 'closed'))
        AND ${orderRangeExpr("o", 2, 3)}
      GROUP BY o.id
      `,
      [restaurantId, startDate, endDate]
    );
    const netSales = parseFloat(netSalesRes.rows[0]?.net_sales || 0);

    // Expenses (supplier + staff + tracked expenses)
    const [supplierRes, staffRes, trackedExpensesRes] = await Promise.all([
      client.query(`
        SELECT COALESCE(SUM(amount_paid), 0) AS total
        FROM transactions
        WHERE restaurant_id = $1
          AND ingredient = 'Payment'
          AND delivery_date >= $2::date
          AND delivery_date < ($3::date + INTERVAL '1 day')
      `, [restaurantId, startDate, endDate]),
      client.query(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM staff_payments
        WHERE restaurant_id = $1
          AND created_at >= $2::date
          AND created_at < ($3::date + INTERVAL '1 day')
      `, [restaurantId, startDate, endDate]),
      client.query(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM expenses
        WHERE restaurant_id = $1
          AND created_at >= $2::date
          AND created_at < ($3::date + INTERVAL '1 day')
      `, [restaurantId, startDate, endDate])
    ]);
    const expensesToday =
      parseFloat(supplierRes.rows[0]?.total || 0) + 
      parseFloat(staffRes.rows[0]?.total || 0) + 
      parseFloat(trackedExpensesRes.rows[0]?.total || 0);

    // Profit
    const profit = netSales - expensesToday;

    // Average Order Value
    const avgRes = await client.query(
      `
      SELECT COUNT(*) AS order_count, COALESCE(SUM(o.total), 0) AS total_sum
      FROM orders o
      WHERE o.restaurant_id = $1
        AND (o.is_paid = true OR LOWER(o.status) IN ('confirmed', 'paid', 'closed'))
        AND ${orderRangeExpr("o", 2, 3)}
      `,
      [restaurantId, startDate, endDate]
    );

    const orderCount = parseInt(avgRes.rows[0]?.order_count || 0, 10);
    const totalSum = parseFloat(avgRes.rows[0]?.total_sum || 0);
    const avgOrderValue = orderCount > 0 ? totalSum / orderCount : 0;

    res.json({
      daily_sales: dailySales,
      gross_sales: grossSales,
      net_sales: netSales,
      expenses_today: expensesToday,
      profit,
      average_order_value: avgOrderValue,
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
          kitchen_delivered_at,
          created_at,
          receipt_id,
          customer_name,
          customer_phone,
          customer_address,
          takeaway_notes,
          external_id,
          external_source,
          external_expedition_type,
          payment_method,
          debt_paid_at,
          cancellation_reason,
          cancelled_at
        FROM orders o
        WHERE o.restaurant_id = $1
          AND (
            LOWER(o.status) IN ('paid', 'closed', 'cancelled', 'canceled')
            OR EXISTS (
              SELECT 1
              FROM order_items oi
              WHERE oi.order_id = o.id
                AND oi.paid_at IS NOT NULL
            )
            OR EXISTS (
              SELECT 1
              FROM payments p
              WHERE p.order_id = o.id
            )
          )
          AND ${rangeExprForTs(orderHistoryTimestampExpr("o"), "o", 2, 3)}
        ORDER BY o.created_at DESC
      `,
      [req.user.restaurant_id, from, to]
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
  const restaurantId = req.user.restaurant_id;

  try {
    const dateClause = from && to ? `AND ${orderRangeExpr("o", 2, 3)}` : "";
    const dateParams = from && to ? [restaurantId, from, to] : [restaurantId];

    const [receiptRes, paymentsRes, ordersRes] = await Promise.all([
      pool.query(
        `
          SELECT LOWER(BTRIM(rm.payment_method)) AS method, SUM(rm.amount) AS value
          FROM receipt_methods rm
          JOIN orders o ON rm.receipt_id = o.receipt_id
          WHERE o.restaurant_id = $1
            AND (o.is_paid = true OR LOWER(o.status) IN ('confirmed', 'paid', 'closed'))
            ${dateClause}
          GROUP BY LOWER(BTRIM(rm.payment_method))
        `,
        dateParams
      ),
      pool.query(
        `
          SELECT LOWER(BTRIM(p.payment_method)) AS method, SUM(p.amount) AS value
          FROM payments p
          JOIN orders o ON p.order_id = o.id
          WHERE o.restaurant_id = $1
            AND p.amount > 0
            AND p.payment_method IS NOT NULL
            AND p.payment_method != ''
            ${dateClause}
          GROUP BY LOWER(BTRIM(p.payment_method))
        `,
        dateParams
      ),
      pool.query(
        `
          SELECT LOWER(BTRIM(o.payment_method)) AS method, SUM(o.total) AS value
          FROM orders o
          WHERE o.restaurant_id = $1
            AND (o.is_paid = true OR LOWER(o.status) IN ('confirmed', 'paid', 'closed'))
            AND o.payment_method IS NOT NULL
            AND o.payment_method != ''
            AND NOT EXISTS (
              SELECT 1
              FROM receipt_methods rm
              WHERE rm.receipt_id = o.receipt_id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM payments p
              WHERE p.order_id = o.id
                AND p.amount > 0
            )
            ${dateClause}
          GROUP BY LOWER(BTRIM(o.payment_method))
        `,
        dateParams
      ),
    ]);

    const totals = new Map();
    const addRows = (rows) => {
      rows.forEach((row) => {
        const method = row.method || "unknown";
        const value = parseFloat(row.value || 0);
        totals.set(method, (totals.get(method) || 0) + value);
      });
    };

    addRows(receiptRes.rows);
    addRows(paymentsRes.rows);
    addRows(ordersRes.rows);

    const formatted = Array.from(totals.entries()).map(([method, value]) => ({
      method,
      value,
    }));

    res.json(formatted);
  } catch (err) {
    console.error("❌ Error fetching payment method data:", err);
    res.status(500).json({ error: "Failed to load payment method data" });
  }
});

// GET /reports/sales-by-payment-method-detailed
router.get("/sales-by-payment-method-detailed", async (req, res) => {
  const { from, to } = req.query;
  const restaurantId = req.user.restaurant_id;
  let dateFilter = "";
  const params = [restaurantId];

  if (from && to) {
    params.push(from, to);
    dateFilter = `AND ${orderRangeExpr("o", 2, 3)}`;
  }

  try {
    const result = await pool.query(`
      SELECT
        rm.payment_method,
        SUM(rm.amount) AS total,
        SUM(rm.amount) FILTER (WHERE sub.cnt = 1) AS single_total,
        SUM(rm.amount) FILTER (WHERE sub.cnt > 1) AS split_total
      FROM receipt_methods rm
      JOIN orders o ON rm.receipt_id = o.receipt_id
      JOIN (
        SELECT receipt_id, COUNT(*) AS cnt
        FROM receipt_methods
        GROUP BY receipt_id
      ) sub ON rm.receipt_id = sub.receipt_id
      WHERE o.restaurant_id = $1
        AND LOWER(o.status) = 'closed' ${dateFilter}
      GROUP BY rm.payment_method
      ORDER BY total DESC
    `, params);

    const formatted = result.rows.map(r => ({
      method: r.payment_method,
      total: parseFloat(r.total),
      single: parseFloat(r.single_total) || 0,
      split: parseFloat(r.split_total) || 0,
    }));

    res.json(formatted);
  } catch (err) {
    console.error("❌ Error fetching detailed payment breakdown:", err);
    res.status(500).json({ error: "Failed to load detailed payment data" });
  }
});

// GET /reports/profit-loss?timeframe=daily|weekly|monthly&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/profit-loss", async (req, res) => {
  const { timeframe, from, to } = req.query;
  const restaurantId = req.user?.restaurant_id;
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
        WHERE o.restaurant_id = $1
          AND o.status IN ('paid', 'closed')
          AND o.created_at >= $2::date
          AND o.created_at < ($3::date + INTERVAL '1 day')
        GROUP BY group_date
      ),
      supplier_losses AS (
        SELECT
          TO_CHAR(t.delivery_date, ${dateFormat}) AS group_date,
          COALESCE(SUM(t.amount_paid), 0) AS loss
        FROM transactions t
        WHERE t.restaurant_id = $1
          AND t.ingredient = 'Payment'
          AND t.delivery_date >= $2::date
          AND t.delivery_date < ($3::date + INTERVAL '1 day')
        GROUP BY group_date
      ),
      staff_losses AS (
        SELECT
          TO_CHAR(sp.created_at, ${dateFormat}) AS group_date,
          COALESCE(SUM(sp.amount), 0) AS loss
        FROM staff_payments sp
        WHERE sp.restaurant_id = $1
          AND sp.created_at >= $2::date
          AND sp.created_at < ($3::date + INTERVAL '1 day')
        GROUP BY group_date
      ),
      tracked_losses AS (
        SELECT
          TO_CHAR(e.created_at, ${dateFormat}) AS group_date,
          COALESCE(SUM(e.amount), 0) AS loss
        FROM expenses e
        WHERE e.restaurant_id = $1
          AND e.created_at >= $2::date
          AND e.created_at < ($3::date + INTERVAL '1 day')
        GROUP BY group_date
      ),
      date_keys AS (
        SELECT group_date FROM order_profits
        UNION
        SELECT group_date FROM supplier_losses
        UNION
        SELECT group_date FROM staff_losses
        UNION
        SELECT group_date FROM tracked_losses
      )
      SELECT
        dk.group_date AS date,
        COALESCE(op.profit, 0) AS profit,
        (
          COALESCE(sl.loss, 0) +
          COALESCE(stl.loss, 0) +
          COALESCE(tl.loss, 0)
        ) AS loss
      FROM date_keys dk
      LEFT JOIN order_profits op ON dk.group_date = op.group_date
      LEFT JOIN supplier_losses sl ON dk.group_date = sl.group_date
      LEFT JOIN staff_losses stl ON dk.group_date = stl.group_date
      LEFT JOIN tracked_losses tl ON dk.group_date = tl.group_date
      ORDER BY date
    `, [restaurantId, startDate, endDate]);

    res.json(
      result.rows.map((row) => ({
        date: row.date,
        profit: parseFloat(row.profit || 0),
        loss: parseFloat(row.loss || 0),
      }))
    );
  } catch (err) {
    console.error("❌ Error in /reports/profit-loss:", err);
    res.status(500).json({ error: "Failed to fetch profit/loss report" });
  }
});


router.get("/staff-performance", async (req, res) => {
  const { from, to } = req.query;
  const restaurantId = req.user?.restaurant_id;

  if (!from || !to) return res.status(400).json({ error: "Missing date range" });

  try {
    const result = await pool.query(
      `
      SELECT
        COALESCE(
          s.name,
          CASE
            WHEN o.order_type IN ('online', 'packet') THEN 'Online Orders'
            WHEN o.order_type = 'phone' THEN 'Phone Orders'
            ELSE 'Unassigned'
          END
        ) AS staff_name,
        COUNT(DISTINCT o.id) AS orders_handled,
        COALESCE(SUM(o.total), 0) AS total_sales,
        COALESCE(AVG(o.total), 0) AS avg_order_value,
        COALESCE(SUM(oi.quantity), 0) AS total_items_sold
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN staff s ON o.created_by = s.id
      WHERE o.restaurant_id = $1
        AND o.status IN ('paid', 'closed')
        AND o.created_at >= $2::date
        AND o.created_at < ($3::date + INTERVAL '1 day')
      GROUP BY 1
      ORDER BY total_sales DESC
      `,
      [restaurantId, from, to]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error in /reports/staff-performance:", err);
    res.status(500).json({ error: "Failed to fetch staff performance" });
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
    const restaurantId = req.user.restaurant_id;

    if (!openTime) {
      return res.status(400).json({ error: "Missing openTime in query" });
    }

    // 1. Manual cash expenses logged in register (incl. change mapped to expense)
    const res1 = await pool.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM cash_register_logs
      WHERE restaurant_id = $1
        AND type = 'expense'
        AND created_at >= $2
      `,
      [restaurantId, openTime]
    );

    // 2. Supplier cash transactions
    const res2 = await pool.query(
      `
      SELECT COALESCE(SUM(amount_paid), 0) AS total
      FROM transactions
      WHERE restaurant_id = $1 AND delivery_date >= $2 AND LOWER(payment_method) = 'cash'
      `,
      [restaurantId, openTime]
    );

    // 3. Staff cash payouts
    const res3 = await pool.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM staff_payments
      WHERE restaurant_id = $1 AND created_at >= $2 AND LOWER(payment_method) = 'cash'
      `,
      [restaurantId, openTime]
    );

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
  const restaurantId = req.user.restaurant_id;

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
      WHERE restaurant_id = $1
        AND is_paid = true
      GROUP BY ${groupBy}
      ORDER BY ${groupBy} ASC
      `,
      [restaurantId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching sales trends:", err);
    res.status(500).json({ error: "Failed to load sales trends" });
  }
});

// GET /reports/sales-by-category
router.get("/sales-by-category", async (req, res) => {
  const { from, to } = req.query;
  const restaurantId = req.user.restaurant_id;

  const fromDate = from || "2000-01-01";
  const toDate = to || "2100-01-01";

  try {
    const result = await pool.query(`
      SELECT p.category, COALESCE(SUM(oi.price * oi.quantity), 0) AS total_sales
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN orders o ON oi.order_id = o.id
      WHERE o.restaurant_id = $1
        AND (o.is_paid = true OR LOWER(o.status) IN ('confirmed', 'paid', 'closed'))
        AND ${orderRangeExpr("o", 2, 3)}
      GROUP BY p.category
      ORDER BY total_sales DESC
    `, [restaurantId, fromDate, toDate]);

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
  const restaurantId = req.user.restaurant_id;

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
      WHERE o.restaurant_id = $1
        AND (o.is_paid = true OR LOWER(o.status) IN ('confirmed', 'paid', 'closed'))
        AND ${orderRangeExpr("o", 2, 3)}
      GROUP BY p.category, p.name
      ORDER BY p.category, total DESC
    `, [restaurantId, fromDate, toDate]);

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
  const restaurantId = req.user.restaurant_id;
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
      WHERE o.restaurant_id = $1
        AND o.is_paid = true
        AND o.created_at >= $2::date
        AND o.created_at <  ($3::date + INTERVAL '1 day')
      GROUP BY date, p.category
      ORDER BY date ASC
    `, [restaurantId, fromDate, toDate]);

    // pivot into [{ date, CatA: 123, CatB: 456, ... }, ...]
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
  const restaurantId = req.user.restaurant_id;

  try {
    const result = await pool.query(
      `
      WITH opens AS (
        SELECT DISTINCT ON (date) date, amount AS opening_cash
        FROM cash_register_logs
        WHERE restaurant_id = $1
          AND type = 'open'
          AND date BETWEEN $2::date AND $3::date
        ORDER BY date, created_at DESC
      ),
      closes AS (
        SELECT DISTINCT ON (date) date, amount AS closing_cash
        FROM cash_register_logs
        WHERE restaurant_id = $1
          AND type = 'close'
          AND date BETWEEN $2::date AND $3::date
        ORDER BY date, created_at DESC
      ),
      sales_all AS (
        SELECT date, SUM(amount) AS total_cash
        FROM cash_register_logs
        WHERE restaurant_id = $1
          AND type = 'sale'
          AND date BETWEEN $2::date AND $3::date
        GROUP BY 1
      ),
      supplier AS (
        SELECT t.delivery_date::date AS date, SUM(t.amount_paid) AS supplier_expenses
        FROM transactions t
        WHERE t.restaurant_id = $1
          AND LOWER(t.payment_method) = 'cash'
          AND t.delivery_date >= $2::date
          AND t.delivery_date < ($3::date + INTERVAL '1 day')
        GROUP BY 1
      ),
      staff AS (
        SELECT sp.created_at::date AS date, SUM(sp.amount) AS staff_expenses
        FROM staff_payments sp
        WHERE sp.restaurant_id = $1
          AND sp.created_at >= $2::date
          AND sp.created_at < ($3::date + INTERVAL '1 day')
        GROUP BY 1
      ),
      drawer AS (
        SELECT date, SUM(amount) AS register_expenses
        FROM cash_register_logs
        WHERE restaurant_id = $1
          AND type = 'expense'
          AND date BETWEEN $2::date AND $3::date
        GROUP BY 1
      ),
      entries AS (
        SELECT date, SUM(amount) AS register_entries
        FROM cash_register_logs
        WHERE restaurant_id = $1
          AND type = 'entry'
          AND date BETWEEN $2::date AND $3::date
        GROUP BY 1
      )
      SELECT
        o.date,
        o.opening_cash::numeric AS opening_cash,
        COALESCE(c.closing_cash, 0)::numeric AS closing_cash,
        COALESCE(sa.total_cash, 0)::numeric AS cash_sales,
        COALESCE(sup.supplier_expenses, 0)::numeric AS supplier_expenses,
        COALESCE(st.staff_expenses, 0)::numeric AS staff_expenses,
        COALESCE(d.register_expenses, 0)::numeric AS register_expenses,
        COALESCE(e.register_entries, 0)::numeric AS register_entries
      FROM opens o
      LEFT JOIN closes c ON c.date = o.date
      LEFT JOIN sales_all sa ON sa.date = o.date
      LEFT JOIN supplier sup ON sup.date = o.date
      LEFT JOIN staff st ON st.date = o.date
      LEFT JOIN drawer d ON d.date = o.date
      LEFT JOIN entries e ON e.date = o.date
      ORDER BY o.date DESC;
      `,
      [restaurantId, from, to]
    );

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
  const restaurantId = req.user.restaurant_id;

  try {
    const result = await pool.query(
      `
      SELECT type, amount, created_at, date, note
      FROM cash_register_logs
      WHERE restaurant_id = $1
        AND date BETWEEN $2 AND $3
      ORDER BY created_at ASC
      `,
      [restaurantId, from, to]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ DB error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/cash-register-trends", async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const result = await pool.query(
      `
      SELECT
        date,
        SUM(CASE WHEN type = 'open' THEN amount ELSE 0 END) AS opening_cash,
        SUM(CASE WHEN type = 'close' THEN amount ELSE 0 END) AS closing_cash
      FROM cash_register_logs
      WHERE restaurant_id = $1
      GROUP BY date
      ORDER BY date DESC
      LIMIT 30
      `,
      [restaurantId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Failed to load cash register trends:", err);
    res.status(500).json({ error: "Failed to load cash trends" });
  }
});

router.get("/order-items", async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: "Missing date range" });
  const restaurantId = req.user.restaurant_id;

  try {
    const result = await pool.query(`
      SELECT oi.*, p.name AS product_name
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE o.restaurant_id = $1
        AND ${orderRangeExpr("o", 2, 3)}
        AND (o.is_paid = true OR LOWER(o.status) IN ('confirmed', 'paid', 'closed'))
    `, [restaurantId, from, to]);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching order items for report:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

router.post("/expenses", async (req, res) => {
  const { type, amount, note, payment_method, created_by } = req.body;
  const restaurantId = req.user?.restaurant_id;

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
    try {
      const { emitReportsRefresh } = require("../utils/realtime");
      emitReportsRefresh(req.app.get("io"), restaurantId, {
        source: "expense_created",
        type: type?.trim?.() || type,
        amount: parseFloat(amount),
        payment_method: payment_method || null,
      });
    } catch (_) {}
  } catch (err) {
    console.error("❌ Failed to insert expense:", err);
    res.status(500).json({ error: "Failed to save expense" });
  }
});


router.get("/expenses", async (req, res) => {
  const { from, to, type } = req.query;
  const restaurantId = req.user.restaurant_id;

  try {
    let query = `SELECT * FROM expenses WHERE restaurant_id = $1`;
    const params = [restaurantId];

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

router.get("/daily-cash-total", async (req, res) => {
  try {
    const openTime = req.query.openTime;
    const restaurantId = req.user.restaurant_id;

    if (!openTime || openTime === "null" || openTime === "undefined") {
      console.warn("⚠️ Invalid or missing openTime in query");
      return res.json({ cash_total: 0 });
    }

    const result = await pool.query(
      `
      SELECT COALESCE(SUM(rm.amount), 0) AS cash_total
      FROM receipt_methods rm
      JOIN orders o ON rm.receipt_id = o.receipt_id
      WHERE o.restaurant_id = $1
        AND COALESCE(o.kitchen_delivered_at, o.created_at) >= $2::timestamptz
        AND LOWER(rm.payment_method) = 'cash'
        AND (LOWER(COALESCE(o.status, '')) IN ('paid', 'closed') OR o.is_paid = true)
      `,
      [restaurantId, openTime]
    );

    const value = parseFloat(result.rows?.[0]?.cash_total || 0);
    res.json({ cash_total: value });
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

  // Normalize and validate type/amount
  const normalizedType = String(type || "").toLowerCase().trim();
  const ALLOWED_DB_TYPES = new Set(["open", "close", "entry", "expense"]);
  const mappedType = normalizedType === "change" ? "expense" : normalizedType;

  const countedCashRaw =
    mappedType === "close"
      ? req.body?.counted_cash_total ?? req.body?.countedCashTotal ?? amount
      : amount;
  const numericAmount = Number(countedCashRaw);

  if (!ALLOWED_DB_TYPES.has(mappedType) || !Number.isFinite(numericAmount)) {
    return res.status(400).json({ error: "Invalid type or amount" });
  }

  // Optional terminal inputs for reconciliation
  const terminalCardRaw =
    req.body?.terminal_card_total ?? req.body?.terminalCardTotal ?? null;
  const terminalCashRaw =
    req.body?.terminal_cash_total ?? req.body?.terminalCashTotal ?? null;
  const terminalGrandRaw =
    req.body?.terminal_grand_total ?? req.body?.terminalGrandTotal ?? null;
  const terminalTxRaw = req.body?.terminal_tx_count ?? req.body?.terminalTxCount ?? null;
  const terminalRefundRaw =
    req.body?.terminal_refund_total ?? req.body?.terminalRefundTotal ?? null;
  const terminalReportUrl =
    req.body?.terminal_report_url ?? req.body?.terminalReportUrl ?? null;
  const terminalParseConfidence =
    req.body?.terminal_parse_confidence ?? req.body?.terminalParseConfidence ?? null;

  const terminalCardTotal =
    terminalCardRaw === null || terminalCardRaw === undefined
      ? null
      : Number(terminalCardRaw);
  const terminalCashTotal =
    terminalCashRaw === null || terminalCashRaw === undefined
      ? null
      : Number(terminalCashRaw);
  const terminalGrandTotal =
    terminalGrandRaw === null || terminalGrandRaw === undefined
      ? null
      : Number(terminalGrandRaw);
  const terminalTxCount =
    terminalTxRaw === null || terminalTxRaw === undefined ? null : Number(terminalTxRaw);
  const terminalRefundTotal =
    terminalRefundRaw === null || terminalRefundRaw === undefined
      ? null
      : Number(terminalRefundRaw);

  if (mappedType === "close") {
    if (numericAmount < 0) {
      return res.status(400).json({ error: "counted_cash_total must be >= 0" });
    }
    if (terminalCardTotal !== null && (!Number.isFinite(terminalCardTotal) || terminalCardTotal < 0)) {
      return res.status(400).json({ error: "terminal_card_total must be >= 0 when provided" });
    }
    if (terminalCashTotal !== null && (!Number.isFinite(terminalCashTotal) || terminalCashTotal < 0)) {
      return res.status(400).json({ error: "terminal_cash_total must be >= 0 when provided" });
    }
    if (terminalGrandTotal !== null && (!Number.isFinite(terminalGrandTotal) || terminalGrandTotal < 0)) {
      return res.status(400).json({ error: "terminal_grand_total must be >= 0 when provided" });
    }
    if (terminalTxCount !== null && (!Number.isInteger(terminalTxCount) || terminalTxCount < 0)) {
      return res.status(400).json({ error: "terminal_tx_count must be a non-negative integer" });
    }
    if (
      terminalRefundTotal !== null &&
      (!Number.isFinite(terminalRefundTotal) || terminalRefundTotal < 0)
    ) {
      return res.status(400).json({ error: "terminal_refund_total must be >= 0 when provided" });
    }
  }

  try {
    // Keep close logic unchanged (block if orders open or before shop close time)
    if (mappedType === "close") {
      const openOrdersRes = await pool.query(
        `SELECT COUNT(*) FROM orders
         WHERE restaurant_id = $1
           AND LOWER(COALESCE(status, '')) NOT IN ('closed', 'cancelled', 'canceled')`,
        [req.user.restaurant_id]
      );

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
    const restaurantId = req.user.restaurant_id;
    const staffName =
      req.user?.name ||
      req.user?.username ||
      req.user?.full_name ||
      req.user?.email ||
      null;
    const staffId = req.user?.id || req.user?.user_id || null;

    // Simple path for non-close events
    if (mappedType !== "close") {
      await pool.query(
        `
        INSERT INTO cash_register_logs (date, type, amount, note, staff_name, staff_id, restaurant_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          todayStr,
          mappedType,
          numericAmount,
          note || null,
          staffName,
          staffId?.toString() || null,
          restaurantId,
        ]
      );
      clearCachedStatus(restaurantId);
      clearReconciliationCacheForRestaurant(restaurantId);
      return res.json({ status: "ok" });
    }

    // ---- Close register with reconciliation snapshot ----
    const { rows: openRows } = await pool.query(
      `
      SELECT *
      FROM cash_register_logs
      WHERE restaurant_id = $1 AND type = 'open'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [restaurantId]
    );
    const lastOpen = openRows[0];
    if (!lastOpen) {
      return res.status(400).json({ error: "No open register session found." });
    }

    const { rows: alreadyClosed } = await pool.query(
      `
      SELECT 1 FROM cash_register_logs
      WHERE restaurant_id = $1 AND type = 'close' AND created_at > $2
      LIMIT 1
      `,
      [restaurantId, lastOpen.created_at]
    );
    if (alreadyClosed.length) {
      return res.status(400).json({ error: "Register already closed for this session." });
    }

    const expectedCash = Number(lastOpen.amount || 0);
    const posCardTotal = 0;
    const posCashTotal = 0;
    const posOtherTotal = 0;
    const countedCashTotal = numericAmount;
    const cash_difference = countedCashTotal - expectedCash;
    const card_difference = (terminalCardTotal || 0) - posCardTotal;

    const risk = buildRiskSummary({
      cashDifference: cash_difference,
      cardDifference: card_difference,
      terminalProvided: terminalCardTotal !== null,
      opsSignals: {},
    });

    const insertRes = await pool.query(
      `
      INSERT INTO cash_register_logs (
        date, type, amount, note, staff_name, staff_id, restaurant_id,
        terminal_card_total, terminal_cash_total, terminal_grand_total,
        terminal_tx_count, terminal_refund_total, terminal_report_url,
        terminal_parse_confidence,
        expected_cash_total, counted_cash_total, cash_difference,
        pos_card_total, pos_cash_total, pos_other_total, card_difference,
        risk_score, risk_flags
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17,
        $18, $19, $20, $21,
        $22, $23
      )
      RETURNING *
      `,
      [
        todayStr,
        mappedType,
        countedCashTotal,
        note || null,
        staffName,
        staffId?.toString() || null,
        restaurantId,
        terminalCardTotal,
        terminalCashTotal,
        terminalGrandTotal,
        terminalTxCount,
        terminalRefundTotal,
        terminalReportUrl || null,
        terminalParseConfidence ? JSON.stringify(terminalParseConfidence) : null,
        expectedCash,
        countedCashTotal,
        cash_difference,
        posCardTotal,
        posCashTotal,
        posOtherTotal,
        card_difference,
        risk.risk_score,
        JSON.stringify(risk.flags || []),
      ]
    );

    clearCachedStatus(restaurantId);
    clearReconciliationCacheForRestaurant(restaurantId);
    return res.json({
      status: "closed",
      log: insertRes.rows?.[0],
      reconciliation: {
        session: {
          openTime: lastOpen.created_at,
          nowTime: now.toISOString(),
        },
        posTotals: {
          cash_total: posCashTotal,
          card_total: posCardTotal,
          other_total: posOtherTotal,
          grand_total: posCashTotal + posCardTotal + posOtherTotal,
        },
        cashReconciliation: {
          opening_float: Number(lastOpen.amount || 0),
          expected_cash_total: expectedCash,
          cash_expenses_total: 0,
          cash_refunds_total: 0,
        },
        opsSignals: {
          void_count: 0,
          void_total: 0,
          discount_total: 0,
          cancelled_count: 0,
          payment_method_change_count: 0,
        },
        snapshot_mode: "close-lite",
        partial: true,
        errors: [],
        cash_difference,
        card_difference,
        risk,
      },
    });
  } catch (err) {
    console.error("❌ Failed to insert cash register log:", err);
    res.status(500).json({ error: "Database error" });
  }
});




// GET /cash-register-status
router.get("/cash-register-status", async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const forceFresh = Boolean(req.query?._t || req.query?.force_fresh);

    // 🚀 CHECK CACHE FIRST (unless explicitly forced fresh)
    if (!forceFresh) {
      const cached = getCachedStatus(restaurantId);
      if (cached) {
        return res.json(cached);
      }
    }

    const now = new Date();
    const istTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Istanbul" }));

    // 1. Get latest open log (regardless of day) for this tenant
    const { rows: openLogs } = await pool.query(
      `
      SELECT * FROM cash_register_logs
      WHERE restaurant_id = $1 AND type = 'open'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [restaurantId]
    );
    const lastOpen = openLogs[0];

    if (!lastOpen) {
      const result = {
        status: "unopened",
        yesterday_close: null,
        last_open_at: null,
      };
      setCachedStatus(restaurantId, result);
      return res.json(result);
    }

    // 2. Get first close after last open for this tenant
    const { rows: closeLogs } = await pool.query(
      `
      SELECT * FROM cash_register_logs
      WHERE restaurant_id = $1 AND type = 'close' AND created_at > $2
      ORDER BY created_at ASC
      LIMIT 1
      `,
      [restaurantId, lastOpen.created_at]
    );
    const lastClose = closeLogs[0] || null;

    // If open (not closed after last open): show last close BEFORE open
    if (!lastClose || new Date(lastClose.created_at) < new Date(lastOpen.created_at)) {
      const { rows: prevCloses } = await pool.query(
        `
        SELECT amount FROM cash_register_logs
        WHERE restaurant_id = $1 AND type = 'close' AND created_at < $2
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [restaurantId, lastOpen.created_at]
      );
      const prevCloseAmount = prevCloses[0]?.amount ?? null;
      const result = {
        status: "open",
        opening_cash: lastOpen.amount,
        yesterday_close: prevCloseAmount,   // << always most recent close before open
        last_open_at: lastOpen.created_at,
      };
      setCachedStatus(restaurantId, result);
      return res.json(result);
    }

    // If closed, show most recent close (which should be after last open)
    const result = {
      status: "closed",
      opening_cash: lastOpen.amount,
      yesterday_close: lastClose.amount,    // << always most recent close
      last_open_at: lastOpen.created_at,
      last_close_at: lastClose.created_at,
    };
    setCachedStatus(restaurantId, result);
    return res.json(result);

  } catch (err) {
    console.error("❌ Failed to load register status:", err);
    res.status(500).json({ error: "Failed to fetch register status" });
  }
});

// GET /reports/cash-register-snapshot
router.get("/cash-register-snapshot", async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;

    const { rows: openRows } = await pool.query(
      `
      SELECT *
      FROM cash_register_logs
      WHERE restaurant_id = $1 AND type = 'open'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [restaurantId]
    );

    if (!openRows.length) {
      return res.json({
        status: "unopened",
        available: 0,
        opening_cash: 0,
        last_open_at: null,
        last_close_at: null,
      });
    }

    const lastOpen = openRows[0];

    const { rows: closeRows } = await pool.query(
      `
      SELECT *
      FROM cash_register_logs
      WHERE restaurant_id = $1 AND type = 'close' AND created_at > $2
      ORDER BY created_at ASC
      LIMIT 1
      `,
      [restaurantId, lastOpen.created_at]
    );

    const lastClose = closeRows[0] || null;

    if (lastClose && new Date(lastClose.created_at) > new Date(lastOpen.created_at)) {
      return res.json({
        status: "closed",
        available: parseFloat(lastClose.amount || 0),
        opening_cash: parseFloat(lastOpen.amount || 0),
        last_open_at: lastOpen.created_at,
        last_close_at: lastClose.created_at,
      });
    }

    const { rows: adjustmentsRows } = await pool.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN type IN ('entry', 'sale') THEN amount ELSE 0 END), 0) AS inflow,
        COALESCE(SUM(CASE WHEN type IN ('expense', 'supplier', 'payroll', 'change') THEN amount ELSE 0 END), 0) AS outflow
      FROM cash_register_logs
      WHERE restaurant_id = $1 AND created_at >= $2
      `,
      [restaurantId, lastOpen.created_at]
    );

    const inflow = parseFloat(adjustmentsRows[0]?.inflow || 0);
    const outflow = parseFloat(adjustmentsRows[0]?.outflow || 0);
    const openingCash = parseFloat(lastOpen.amount || 0);
    const available = openingCash + inflow - outflow;

    return res.json({
      status: "open",
      available,
      opening_cash: openingCash,
      last_open_at: lastOpen.created_at,
      last_close_at: null,
    });
  } catch (err) {
    console.error("❌ Failed to fetch cash register snapshot:", err);
    res.status(500).json({ error: "Failed to fetch cash snapshot" });
  }
});

// GET /reports/register-reconciliation?openTime=ISO_TIMESTAMP
// In-memory cache to avoid repeated reconciliation queries on each modal open.
// Keyed by restaurantId + openTime ISO.
const reconciliationCache = new Map();
const RECONCILIATION_TTL_MS = 5_000;

function getReconciliationCacheKey(restaurantId, openTime) {
  return `${restaurantId}:${openTime || "none"}`;
}

function clearReconciliationCacheForRestaurant(restaurantId) {
  const prefix = `${restaurantId}:`;
  for (const key of reconciliationCache.keys()) {
    if (String(key).startsWith(prefix)) reconciliationCache.delete(key);
  }
}

router.get("/register-reconciliation", async (req, res) => {
  try {
    const t0 = performance.now();
    const restaurantId = req.user.restaurant_id;
    const openTime = req.query.openTime;
    const requestedMode = String(req.query.mode || "essential").toLowerCase() === "full" ? "full" : "essential";
    const key = getReconciliationCacheKey(restaurantId, openTime);
    const cached = reconciliationCache.get(key);

    // Return cached quickly while fresh.
    if (
      cached?.snapshot &&
      Date.now() - (cached.updatedAt || 0) <= RECONCILIATION_TTL_MS &&
      (requestedMode !== "full" || cached.snapshot?.snapshot_mode === "full")
    ) {
      const elapsed = performance.now() - t0;
      console.log(`📦 [${restaurantId}] Reconciliation from cache (${elapsed.toFixed(0)}ms)`);
      console.log("💵 [reconciliation] cache payload", {
        restaurantId,
        openTime,
        requestedMode,
        snapshot_mode: cached.snapshot?.snapshot_mode,
        expected_cash_total: cached.snapshot?.cashReconciliation?.expected_cash_total,
        pos_cash_total: cached.snapshot?.posTotals?.cash_total,
        card_grand_total: cached.snapshot?.cardByOrderType?.grand_total,
      });
      return res.json(cached.snapshot);
    }

    // Cache miss or stale cache: rebuild a snapshot (essential by default; full when requested).
    const t1 = performance.now();
    const essential = await buildRegisterReconciliationSnapshot({
      restaurantId,
      openTime,
      mode: requestedMode,
    });
    const elapsedEssential = performance.now() - t1;
    reconciliationCache.set(key, { snapshot: essential, updatedAt: Date.now() });
    console.log(
      `${requestedMode === "full" ? "🧮" : "⚡"} [${restaurantId}] ${
        requestedMode === "full" ? "Full" : "Essential"
      } reconciliation built (${elapsedEssential.toFixed(0)}ms)`
    );
    console.log("💵 [reconciliation] fresh payload", {
      restaurantId,
      openTime,
      requestedMode,
      snapshot_mode: essential?.snapshot_mode,
      expected_cash_total: essential?.cashReconciliation?.expected_cash_total,
      pos_cash_total: essential?.posTotals?.cash_total,
      card_grand_total: essential?.cardByOrderType?.grand_total,
      errors: essential?.errors,
    });

    const totalElapsed = performance.now() - t0;
    console.log(`   └─ Total response time: ${totalElapsed.toFixed(0)}ms`);
    return res.json(essential);
  } catch (err) {
    console.error("❌ Failed to build register reconciliation:", err);
    // If fresh rebuild fails, return last cached snapshot as a fallback.
    const restaurantId = req.user?.restaurant_id;
    const openTime = req.query?.openTime;
    const key = getReconciliationCacheKey(restaurantId, openTime);
    const cached = reconciliationCache.get(key);
    if (cached?.snapshot) {
      console.warn("⚠️ Returning stale reconciliation cache due to rebuild failure");
      return res.json(cached.snapshot);
    }
    res.status(500).json({ error: "Failed to build register reconciliation" });
  }
});

// GET /reports/stock-discrepancy?openTime=ISO_TIMESTAMP
router.get("/stock-discrepancy", async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const openTime = req.query.openTime;
    const result = await buildStockDiscrepancy({ restaurantId, openTime });
    res.json(result);
  } catch (err) {
    console.error("❌ Failed to build stock discrepancy:", err);
    res.status(500).json({ error: "Failed to build stock discrepancy" });
  }
});


// GET /reports/last-register-closes?limit=5
router.get("/last-register-closes", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "5", 10);

    const result = await pool.query(
      `
      SELECT amount, created_at, terminal_report_url
      FROM cash_register_logs
      WHERE restaurant_id = $1 AND type = 'close'
      ORDER BY created_at DESC
      LIMIT $2
      `,
      [req.user.restaurant_id, limit]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching past closing cash logs:", err);
    res.status(500).json({ error: "Failed to fetch closing history" });
  }
});


router.delete("/expenses/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(`DELETE FROM expenses WHERE restaurant_id = $1 AND id = $1`, [id]);
    res.json({ success: true, message: "Expense deleted" });
  } catch (err) {
    console.error("❌ Failed to delete expense:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

// Support both single and sub-orders in split receipts
// POST /api/orders/receipt-methods
router.post("/receipt-methods", async (req, res) => {
  let { receipt_id, methods, order_id } = req.body;

  try {
    // --- PATCH: always assign receipt_id if missing and order_id given ---
    if ((!receipt_id || receipt_id === 'null') && order_id) {
      // Generate a new UUID and update the order
      const { rows } = await pool.query(
        "UPDATE orders SET receipt_id = gen_random_uuid() WHERE restaurant_id = $1 AND id = $1 RETURNING receipt_id",
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
      `SELECT id, payment_method FROM orders WHERE restaurant_id = $1 WHERE restaurant_id = $1 WHERE receipt_id = $1`,
      [receipt_id]
    );
    if (orderRows.length > 0) {
      const orderId = orderRows[0].id;
      const oldMethod = orderRows[0].payment_method;
      if (oldMethod !== paymentMethodStr) {
        await pool.query(
          `UPDATE orders SET payment_method = $1 WHERE restaurant_id = $1 AND id = $2`,
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
  const restaurantId = req.user?.restaurant_id; // tenant-safe scope

  try {
    const result = await pool.query(
      `
      SELECT
        t.amount_paid AS amount,
        t.created_at,
        s.name AS note,
        'supplier' AS type
      FROM transactions t
      JOIN suppliers s ON t.supplier_id = s.id
      WHERE t.restaurant_id = $1
        AND t.ingredient = 'Payment'
        AND LOWER(t.payment_method) = 'cash'
        AND t.delivery_date >= $2::date
        AND t.delivery_date < ($3::date + INTERVAL '1 day')
      ORDER BY t.created_at ASC
      `,
      [restaurantId, from, to]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Failed to fetch supplier cash payments:", err);
    res.status(500).json({ error: "Failed to fetch supplier cash payments" });
  }
});

// GET /api/reports/staff-cash-payments?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/staff-cash-payments", async (req, res) => {
  const { from, to } = req.query;
  const restaurantId = req.user.restaurant_id;
  try {
    const result = await pool.query(
      `
      SELECT
        sp.amount,
        sp.created_at,
        s.name AS note,
        'staff' AS type
      FROM staff_payments sp
      JOIN staff s ON sp.staff_id = s.id
      WHERE sp.restaurant_id = $1
        AND LOWER(sp.payment_method) = 'cash'
        AND sp.created_at >= $2
        AND sp.created_at < ($3::date + INTERVAL '1 day')
      ORDER BY sp.created_at ASC
      `,
      [restaurantId, from, to]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch staff cash payments" });
  }
});

// GET /api/reports/staff-payments?from=YYYY-MM-DD&to=YYYY-MM-DD
// Includes all staff payments (any payment method) for the period
router.get("/staff-payments", async (req, res) => {
  const { from, to } = req.query;
  const restaurantId = req.user.restaurant_id;
  if (!from || !to) return res.status(400).json({ error: "Missing date range" });

  try {
    const result = await pool.query(
      `
      SELECT
        sp.amount,
        sp.created_at,
        sp.payment_method,
        s.name AS note,
        'staff' AS type
      FROM staff_payments sp
      JOIN staff s ON sp.staff_id = s.id
      WHERE sp.restaurant_id = $1
        AND sp.created_at >= $2::date
        AND sp.created_at < ($3::date + INTERVAL '1 day')
      ORDER BY sp.created_at ASC
      `,
      [restaurantId, from, to]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Failed to fetch staff payments:", err);
    res.status(500).json({ error: "Failed to fetch staff payments" });
  }
});

// GET /api/reports/supplier-payments?from=YYYY-MM-DD&to=YYYY-MM-DD
// Includes all supplier payments (any payment method) for the period
router.get("/supplier-payments", async (req, res) => {
  const { from, to } = req.query;
  const restaurantId = req.user?.restaurant_id;
  if (!from || !to) return res.status(400).json({ error: "Missing date range" });

  try {
    const result = await pool.query(
      `
      SELECT
        t.amount_paid AS amount,
        t.created_at,
        t.payment_method,
        s.name AS note,
        'supplier' AS type
      FROM transactions t
      JOIN suppliers s ON t.supplier_id = s.id
      WHERE t.restaurant_id = $1
        AND t.ingredient = 'Payment'
        AND t.delivery_date >= $2::date
        AND t.delivery_date < ($3::date + INTERVAL '1 day')
      ORDER BY t.created_at ASC
      `,
      [restaurantId, from, to]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Failed to fetch supplier payments:", err);
    res.status(500).json({ error: "Failed to fetch supplier payments" });
  }
});


// GET all payment methods used for a specific receipt
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

// INSERT receipt_methods for a given receipt
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

// GET /orders/history
router.get("/orders/history", async (req, res) => {
  const { from, to } = req.query;

  if (!from || !to) {
    return res.status(400).json({ error: "Missing from/to query parameters" });
  }

  try {
    const result = await pool.query(
      `
        SELECT * FROM orders
        WHERE status IN ('closed', 'cancelled')
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

// GET /api/reports/online-sales?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/online-sales", async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: "Missing from/to" });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        o.order_type,
        o.payment_method,
        COALESCE(SUM(o.total), 0) AS total
      FROM orders o
      WHERE LOWER(o.status) IN ('paid','closed')
        AND o.order_type IN ('online','packet')  -- extend later with Trendyol, Getir
        AND ${orderRangeExpr("o", 1, 2)}
      GROUP BY o.order_type, o.payment_method
      ORDER BY o.order_type, o.payment_method
      `,
      [from, to]
    );

    // reshape into { platform: { total, payments: [{method, total}] } }
    const platforms = {};
    for (const row of result.rows) {
      const platform = row.order_type || "unknown";
      if (!platforms[platform]) {
        platforms[platform] = { total: 0, payments: [] };
      }
      platforms[platform].payments.push({
        method: row.payment_method || "Unknown",
        total: parseFloat(row.total),
      });
      platforms[platform].total += parseFloat(row.total);
    }

    res.json(platforms);
  } catch (err) {
    console.error("❌ Error fetching online sales:", err);
    res.status(500).json({ error: "Failed to fetch online sales" });
  }
});

module.exports = router;
