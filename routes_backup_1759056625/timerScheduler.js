// timerScheduler.js
const { pool } = require("../db");
const { getIO } = require("../utils/socket");

function startKitchenTimersJob() {
  setInterval(async () => {
    try {
      // 1. Decrement all running timers
      const res = await pool.query(
        `UPDATE kitchen_timers
         SET seconds_left = seconds_left - 1, updated_at = NOW()
         WHERE running = true AND seconds_left > 0
         RETURNING *`
      );

      // 2. Find timers that just hit zero
      const finishedTimersRes = await pool.query(
        `SELECT * FROM kitchen_timers WHERE seconds_left <= 0 AND running = true`
      );
      const finishedTimers = finishedTimersRes.rows;

      // 3. Reset those timers (back to total_seconds and paused)
      if (finishedTimers.length > 0) {
        const timerIds = finishedTimers.map(t => t.id);
        await pool.query(
          `UPDATE kitchen_timers
           SET seconds_left = total_seconds, running = false, updated_at = NOW()
           WHERE id = ANY($1::int[])`,
          [timerIds]
        );
      }

      // 4. Emit changes to all clients (optional: only if any timers changed)
      if (res.rows.length > 0 || finishedTimers.length > 0) {
        // Get fresh list of all timers
        const { rows: allTimers } = await pool.query(
          `SELECT * FROM kitchen_timers ORDER BY created_at ASC`
        );
        getIO().emit("kitchen_timers_update", allTimers); // socket event
      }
    } catch (err) {
      console.error("Kitchen timer tick job error:", err);
    }
  }, 1000); // every second
}

module.exports = { startKitchenTimersJob };
