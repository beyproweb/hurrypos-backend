const { pool } = require("../db");

let ensuredCashLogStaffColumns = false;

async function ensureCashLogColumns() {
  if (ensuredCashLogStaffColumns) return;
  try {
    await pool.query(
      "ALTER TABLE cash_register_logs ADD COLUMN IF NOT EXISTS staff_name TEXT"
    );
    await pool.query(
      "ALTER TABLE cash_register_logs ADD COLUMN IF NOT EXISTS staff_id TEXT"
    );
    ensuredCashLogStaffColumns = true;
  } catch (err) {
    console.warn("⚠️ Unable to ensure cash_register_logs staff columns:", err.message);
  }
}

module.exports = { ensureCashLogColumns };
