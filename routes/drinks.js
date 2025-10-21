const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
const { emitOrderUpdate } = require("../utils/realtime"); // optional reuse pattern

module.exports = function (io) {
  // ✅ Require authentication for all drink routes
  router.use(authMiddleware);

  // GET /api/drinks — all drinks for this tenant
  router.get("/", async (req, res) => {
    try {
      const { restaurant_id } = req.user;
      const { rows } = await pool.query(
        `SELECT * FROM drinks WHERE restaurant_id = $1 ORDER BY name ASC`,
        [restaurant_id]
      );
      res.json(rows);
    } catch (err) {
      console.error("❌ Failed to load drinks:", err);
      res.status(500).json({ error: "Failed to load drinks" });
    }
  });

  // POST /api/drinks — add a drink for this tenant
  router.post("/", async (req, res) => {
    const { name } = req.body;
    const { restaurant_id } = req.user;

    if (!name || !name.trim())
      return res.status(400).json({ error: "Name required" });

    try {
      const { rows } = await pool.query(
        `INSERT INTO drinks (restaurant_id, name)
         VALUES ($1, $2)
         RETURNING *`,
        [restaurant_id, name.trim()]
      );

      const drink = rows[0];

      // ✅ Emit tenant-scoped socket event
      io.to(`restaurant_${restaurant_id}`).emit("drink_added", drink);
      console.log(`🥤 [drinks] Added: ${drink.name} (restaurant_${restaurant_id})`);

      res.json(drink);
    } catch (err) {
      if (err.code === "23505") {
        return res.status(400).json({ error: "Drink already exists" });
      }
      console.error("❌ Failed to add drink:", err);
      res.status(500).json({ error: "Failed to add drink" });
    }
  });

  // DELETE /api/drinks/:id — remove a drink safely
  router.delete("/:id", async (req, res) => {
    const { restaurant_id } = req.user;
    const { id } = req.params;

    try {
      const result = await pool.query(
        `DELETE FROM drinks
         WHERE restaurant_id = $1 AND id = $2
         RETURNING *`,
        [restaurant_id, id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Drink not found" });
      }

      // ✅ Emit tenant-scoped socket event
      io.to(`restaurant_${restaurant_id}`).emit("drink_deleted", { id: Number(id) });
      console.log(`🗑️ [drinks] Deleted drink ID ${id} (restaurant_${restaurant_id})`);

      res.json({ success: true });
    } catch (err) {
      console.error("❌ Failed to delete drink:", err);
      res.status(500).json({ error: "Failed to delete drink" });
    }
  });

  return router;
};
