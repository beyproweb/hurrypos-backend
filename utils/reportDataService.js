// utils/reportDataService.js
const pool = require("../db");

async function getSummary(from, to) {
  const res = await pool.query(`
    SELECT
      COALESCE(SUM(o.total), 0) AS gross_sales,
      COALESCE(SUM(o.total - p.discount_value), 0) AS net_sales,
      COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.created_at BETWEEN $1 AND $2), 0) AS total_expenses,
      COALESCE(SUM(o.total), 0) - COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.created_at BETWEEN $1 AND $2), 0) AS profit
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN products p ON oi.product_id = p.id
    WHERE o.is_paid = true AND o.created_at BETWEEN $1 AND $2
  `, [from, to]);
  const { gross_sales, net_sales, total_expenses, profit } = res.rows[0];
  return {
    gross_sales: parseFloat(gross_sales),
    net_sales: parseFloat(net_sales),
    total_expenses: parseFloat(total_expenses),
    profit: parseFloat(profit)
  };
}

async function getSalesByPayment(from, to) {
  const res = await pool.query(
    `SELECT payment_method AS method, SUM(total) AS value
     FROM orders
     WHERE is_paid = true AND created_at BETWEEN $1 AND $2
     GROUP BY payment_method`,
    [from, to]
  );
  return res.rows.map(r => ({ method: r.method, value: parseFloat(r.value) }));
}

async function getSalesByCategory(from, to) {
  const res = await pool.query(`
    SELECT p.category, SUM(oi.quantity * oi.price) AS total
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    JOIN orders o ON oi.order_id = o.id
    WHERE o.is_paid = true AND o.created_at BETWEEN $1 AND $2
    GROUP BY p.category
  `, [from, to]);
  return res.rows.map(r => ({ category: r.category||"Uncategorized", total: parseFloat(r.total) }));
}

async function getCategoryTrends(from, to) {
  const res = await pool.query(`
    SELECT TO_CHAR(o.created_at, 'YYYY-MM-DD') AS date, p.category, SUM(oi.quantity * oi.price) AS total
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    JOIN orders o ON oi.order_id = o.id
    WHERE o.is_paid = true AND o.created_at BETWEEN $1 AND $2
    GROUP BY date, p.category
    ORDER BY date ASC
  `, [from, to]);
  const map = {};
  for (const row of res.rows) {
    const d = row.date;
    map[d] = map[d] || { date: d };
    map[d][row.category||"Uncategorized"] = parseFloat(row.total);
  }
  return Object.values(map);
}

async function getCashTrends(from, to) {
  const res = await pool.query(`
    SELECT
      TO_CHAR(created_at, 'YYYY-MM-DD') AS date,
      SUM(CASE WHEN type = 'open' THEN amount ELSE 0 END) AS opening_cash,
      SUM(CASE WHEN type = 'close' THEN amount ELSE 0 END) AS closing_cash
    FROM cash_register_logs
    WHERE created_at BETWEEN $1 AND $2
    GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD')
    ORDER BY date DESC
  `, [from, to]);
  return res.rows;
}


async function getSalesTrends(from, to) {
  const res = await pool.query(`
    SELECT TO_CHAR(DATE_TRUNC('day', created_at), 'YYYY-MM-DD') AS label,
           SUM(total) AS sales
    FROM orders
    WHERE is_paid = true AND created_at BETWEEN $1 AND $2
    GROUP BY label
    ORDER BY label ASC
  `, [from, to]);
  return res.rows.map(r => ({ label: r.label, sales: parseFloat(r.sales) }));
}

async function getExpensesBreakdown(from, to) {
  const res = await pool.query(`
    SELECT type, SUM(amount) AS total
    FROM expenses
    WHERE created_at BETWEEN $1 AND $2
    GROUP BY type
  `, [from, to]);
  return res.rows.map(r => ({ type: r.type, total: parseFloat(r.total) }));
}

async function getProfitLoss(from, to) {
  const res = await pool.query(`
    WITH profits AS (
      SELECT TO_CHAR(o.created_at,'YYYY-MM-DD') AS date, SUM(o.total - COALESCE(p.discount_value,0)) AS profit
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE o.is_paid = true AND o.created_at BETWEEN $1 AND $2
      GROUP BY date
    ), losses AS (
      SELECT TO_CHAR(delivery_date,'YYYY-MM-DD') AS date, SUM(amount_paid) AS loss
      FROM transactions
      WHERE delivery_date BETWEEN $1 AND $2
      GROUP BY date
    )
    SELECT p.date, COALESCE(p.profit,0) AS profit, COALESCE(l.loss,0) AS loss
    FROM profits p
    LEFT JOIN losses l ON l.date = p.date
    ORDER BY p.date ASC
  `, [from, to]);
  return res.rows.map(r => ({
    date: r.date,
    profit: parseFloat(r.profit),
    loss: parseFloat(r.loss)
  }));
}



module.exports = {
  getSummary,
  getSalesByPayment,
  getSalesByCategory,
  getCategoryTrends,
  getCashTrends,
  getSalesTrends,
  getExpensesBreakdown,
  getProfitLoss
};
