// timerScheduler.js
const { pool } = require("../db");
const { getIO } = require("../utils/socket");

function startKitchenTimersJob() {
  const BASE_INTERVAL_MS = 5000;
  const MAX_BACKOFF_MS = 60000;
  let isRunning = false;
  let failureCount = 0;

  const tick = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      const { rows: restaurants } = await pool.query(
        `SELECT DISTINCT restaurant_id FROM kitchen_timers`
      );

      for (const { restaurant_id } of restaurants) {
        const { rows: timers } = await pool.query(
          `SELECT id, restaurant_id, total_seconds, running,
                  CASE
                    WHEN running = true THEN
                      GREATEST(total_seconds - EXTRACT(EPOCH FROM (NOW() - started_at))::INT, 0)
                    ELSE
                      seconds_left
                  END AS seconds_left
           FROM kitchen_timers
           WHERE restaurant_id = $1
           ORDER BY created_at ASC`,
          [restaurant_id]
        );

        getIO().to(`restaurant_${restaurant_id}`).emit("kitchen_timers_update", timers);
      }
      failureCount = 0;
    } catch (err) {
      failureCount += 1;
      console.error("Kitchen timer tick job error:", err.message);
    } finally {
      isRunning = false;
      const backoffFactor = Math.min(failureCount, 4);
      const nextDelay = Math.min(
        BASE_INTERVAL_MS * Math.pow(2, backoffFactor),
        MAX_BACKOFF_MS
      );
      setTimeout(tick, nextDelay);
    }
  };

  setTimeout(tick, BASE_INTERVAL_MS);
}

module.exports = { startKitchenTimersJob };
