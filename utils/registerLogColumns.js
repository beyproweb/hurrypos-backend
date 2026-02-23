const { pool } = require("../db");

let ensuredCashLogStaffColumns = false;
let ensuredTenantColumn = false;
let ensuredReconciliationColumns = false;

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

    // Reconciliation snapshot columns (idempotent)
    if (!ensuredReconciliationColumns) {
      await pool.query(
        `ALTER TABLE cash_register_logs
           ADD COLUMN IF NOT EXISTS terminal_card_total NUMERIC(12,2),
           ADD COLUMN IF NOT EXISTS terminal_cash_total NUMERIC(12,2),
           ADD COLUMN IF NOT EXISTS terminal_grand_total NUMERIC(12,2),
           ADD COLUMN IF NOT EXISTS terminal_tx_count INT,
           ADD COLUMN IF NOT EXISTS terminal_refund_total NUMERIC(12,2),
           ADD COLUMN IF NOT EXISTS terminal_report_url TEXT,
           ADD COLUMN IF NOT EXISTS terminal_parse_confidence JSONB,
           ADD COLUMN IF NOT EXISTS expected_cash_total NUMERIC(12,2) NOT NULL DEFAULT 0,
           ADD COLUMN IF NOT EXISTS counted_cash_total NUMERIC(12,2) NOT NULL DEFAULT 0,
           ADD COLUMN IF NOT EXISTS cash_difference NUMERIC(12,2) NOT NULL DEFAULT 0,
           ADD COLUMN IF NOT EXISTS pos_card_total NUMERIC(12,2) NOT NULL DEFAULT 0,
           ADD COLUMN IF NOT EXISTS pos_cash_total NUMERIC(12,2) NOT NULL DEFAULT 0,
           ADD COLUMN IF NOT EXISTS pos_other_total NUMERIC(12,2) NOT NULL DEFAULT 0,
           ADD COLUMN IF NOT EXISTS card_difference NUMERIC(12,2) NOT NULL DEFAULT 0,
           ADD COLUMN IF NOT EXISTS risk_score INT NOT NULL DEFAULT 0,
           ADD COLUMN IF NOT EXISTS risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb
        `
      );
      ensuredReconciliationColumns = true;
    }
  } catch (err) {
    console.warn("⚠️ Unable to ensure cash_register_logs columns:", err.message);
  }
}

module.exports = { ensureCashLogColumns };
