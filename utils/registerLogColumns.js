const { pool } = require("../db");

let ensuredCashLogStaffColumns = false;
let ensuredTenantColumn = false;

async function ensureCashLogColumns() {
  try {
    // Idempotent: add missing columns used by register logging
    if (!ensuredCashLogStaffColumns) {
      await pool.query(
        "ALTER TABLE cash_register_logs ADD COLUMN IF NOT EXISTS staff_name TEXT"
      );
      await pool.query(
        "ALTER TABLE cash_register_logs ADD COLUMN IF NOT EXISTS staff_id TEXT"
      );
      ensuredCashLogStaffColumns = true;
    }

    // Tenant safety: ensure restaurant_id exists on logs
    if (!ensuredTenantColumn) {
      await pool.query(
        "ALTER TABLE cash_register_logs ADD COLUMN IF NOT EXISTS restaurant_id INTEGER"
      );
      // Lightweight index for common filters
      await pool.query(
        "CREATE INDEX IF NOT EXISTS idx_cash_register_logs_restaurant_date ON cash_register_logs (restaurant_id, date)"
      );
      await pool.query(
        "CREATE INDEX IF NOT EXISTS idx_cash_register_logs_restaurant_created ON cash_register_logs (restaurant_id, created_at)"
      );
      ensuredTenantColumn = true;
    }
  } catch (err) {
    console.warn("⚠️ Unable to ensure cash_register_logs columns:", err.message);
  }
}

module.exports = { ensureCashLogColumns };
