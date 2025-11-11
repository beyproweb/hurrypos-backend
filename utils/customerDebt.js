const { pool } = require("../db");

let debtColumnEnsured = false;

async function ensureCustomerDebtColumn() {
  if (debtColumnEnsured) return true;
  try {
    await pool.query(
      `ALTER TABLE customers
         ADD COLUMN IF NOT EXISTS debt NUMERIC(12,2) NOT NULL DEFAULT 0`
    );
    debtColumnEnsured = true;
    return true;
  } catch (err) {
    console.error("⚠️ Failed to ensure customers.debt column:", err.message);
    debtColumnEnsured = false;
    return false;
  }
}

function normalizeAmount(amount) {
  const parsed = Number.parseFloat(amount);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100) / 100;
}

async function upsertCustomerShell(client, restaurantId, { name, phone }) {
  const trimmedPhone = (phone || "").trim();
  if (!trimmedPhone) return null;
  const safeName = (name || "").trim() || "Customer";
  await client.query(
    `INSERT INTO customers (restaurant_id, name, phone)
     VALUES ($1, $2, $3)
     ON CONFLICT (restaurant_id, phone)
     DO UPDATE SET name = COALESCE(NULLIF($2, ''), customers.name)
     RETURNING id`,
    [restaurantId, safeName, trimmedPhone]
  );
  return trimmedPhone;
}

async function increaseCustomerDebt(client, restaurantId, customer, amount) {
  const delta = normalizeAmount(amount);
  if (delta <= 0 || !customer) return null;
  await ensureCustomerDebtColumn();
  const phone = await upsertCustomerShell(client, restaurantId, customer);
  if (!phone) return null;
  await client.query(
    `UPDATE customers
        SET debt = COALESCE(debt, 0)::numeric + $3
      WHERE restaurant_id = $1 AND phone = $2`,
    [restaurantId, phone, delta]
  );
  return delta;
}

async function decreaseCustomerDebt(client, restaurantId, customer, amount) {
  const delta = normalizeAmount(amount);
  if (delta <= 0 || !customer?.phone) return null;
  await ensureCustomerDebtColumn();
  const phone = (customer.phone || "").trim();
  if (!phone) return null;
  await client.query(
    `UPDATE customers
        SET debt = GREATEST(0, COALESCE(debt, 0)::numeric - $3)
      WHERE restaurant_id = $1 AND phone = $2`,
    [restaurantId, phone, delta]
  );
  return delta;
}

module.exports = {
  ensureCustomerDebtColumn,
  increaseCustomerDebt,
  decreaseCustomerDebt,
};
