const express = require("express");
const { pool } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");

const VALID_STATUSES = new Set(["pending", "approved", "cancelled", "completed"]);
const ACTIVE_QUEUE_STATUSES = ["pending", "approved"];

const toPositiveInt = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

const emitSongRequestUpdated = (io, restaurantId, payload = {}) => {
  const normalizedRestaurantId = toPositiveInt(restaurantId);
  const data = {
    restaurant_id: normalizedRestaurantId,
    ...payload,
  };
  if (normalizedRestaurantId) {
    io?.to(`restaurant_${normalizedRestaurantId}`).emit("song_request_updated", data);
    return;
  }
  io?.emit("song_request_updated", data);
};

module.exports = function songRequestsRoutes(io) {
  const router = express.Router();

  router.post("/song-requests", async (req, res) => {
    const restaurantId = toPositiveInt(req.body?.restaurant_id ?? req.body?.restaurantId);
    const tableNumber = toPositiveInt(req.body?.table_number ?? req.body?.tableNumber);
    const songName = String(req.body?.song_name ?? req.body?.songName ?? "").trim();

    if (!restaurantId || !tableNumber || !songName) {
      return res
        .status(400)
        .json({ error: "restaurant_id, table_number, and song_name are required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [restaurantId]);

      const countResult = await client.query(
        `SELECT COUNT(*)::int AS pending_count
           FROM song_requests
          WHERE restaurant_id = $1
            AND status::text = ANY($2::text[])`,
        [restaurantId, ACTIVE_QUEUE_STATUSES]
      );
      const queueNumber = Number(countResult.rows[0]?.pending_count || 0) + 1;

      const insertResult = await client.query(
        `INSERT INTO song_requests (
          restaurant_id,
          table_number,
          song_name,
          status,
          queue_number
        )
        VALUES ($1, $2, $3, 'pending', $4)
        RETURNING *`,
        [restaurantId, tableNumber, songName, queueNumber]
      );

      await client.query("COMMIT");

      const requestRow = insertResult.rows[0] || null;
      emitSongRequestUpdated(io, restaurantId, {
        action: "created",
        request: requestRow,
      });

      return res.status(201).json({ request: requestRow });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("❌ Failed to create song request:", err);
      return res.status(500).json({ error: "Failed to create song request" });
    } finally {
      client.release();
    }
  });

  router.get("/song-requests", async (req, res) => {
    const restaurantId = toPositiveInt(req.query?.restaurant_id ?? req.query?.restaurantId);
    const tableNumber = toPositiveInt(req.query?.table_number ?? req.query?.tableNumber);

    if (!restaurantId) {
      return res.status(400).json({ error: "restaurant_id is required" });
    }

    try {
      const params = [restaurantId];
      const where = ["restaurant_id = $1", "status NOT IN ('completed', 'cancelled')"];

      if (tableNumber) {
        params.push(tableNumber);
        where.push(`table_number = $${params.length}`);
      }

      const result = await pool.query(
        `SELECT *
           FROM song_requests
          WHERE ${where.join(" AND ")}
          ORDER BY queue_number ASC, created_at ASC`,
        params
      );

      return res.json(result.rows);
    } catch (err) {
      console.error("❌ Failed to fetch song requests:", err);
      return res.status(500).json({ error: "Failed to fetch song requests" });
    }
  });

  router.patch("/song-requests/:id", authMiddleware, async (req, res) => {
    const id = toPositiveInt(req.params?.id);
    const restaurantId = toPositiveInt(req.user?.restaurant_id);
    const status = String(req.body?.status || "").trim().toLowerCase();

    if (!id || !restaurantId) {
      return res.status(400).json({ error: "Invalid request" });
    }

    if (!VALID_STATUSES.has(status) || status === "pending") {
      return res.status(400).json({ error: "status must be approved, completed, or cancelled" });
    }

    try {
      const client = await pool.connect();
      let requestRow = null;
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [restaurantId]);

        const result = await client.query(
          `UPDATE song_requests
              SET status = $1
            WHERE id = $2
              AND restaurant_id = $3
          RETURNING *`,
          [status, id, restaurantId]
        );

        requestRow = result.rows[0] || null;
        if (!requestRow) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Song request not found" });
        }

        if (status === "completed" || status === "cancelled") {
          await client.query(
             `WITH ranked AS (
                SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS next_queue_number
                  FROM song_requests
                WHERE restaurant_id = $1
                  AND status::text = ANY($2::text[])
             )
             UPDATE song_requests AS sr
                SET queue_number = ranked.next_queue_number
               FROM ranked
              WHERE sr.id = ranked.id`,
            [restaurantId, ACTIVE_QUEUE_STATUSES]
          );
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      emitSongRequestUpdated(io, restaurantId, {
        action: "updated",
        request: requestRow,
      });

      return res.json({ request: requestRow });
    } catch (err) {
      console.error("❌ Failed to update song request:", err);
      return res.status(500).json({ error: "Failed to update song request" });
    }
  });

  return router;
};
