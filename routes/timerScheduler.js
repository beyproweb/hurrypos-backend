// timerScheduler.js
const { pool } = require("../db");
const { getIO } = require("../utils/socket");

function startKitchenTimersJob() {
  setInterval(async () => {
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
    } catch (err) {
      console.error("Kitchen timer tick job error:", err.message);
    }
  }, 5000); // broadcast every 5s
}

module.exports = { startKitchenTimersJob };
