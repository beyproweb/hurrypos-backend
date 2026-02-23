// routes/maintenance.js
const path = require("path");
const fs = require("fs");
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { saveNotification } = require("../utils/realtime");
const auth = require("../middleware/authMiddleware");
const multer = require("multer");

// ---------- Multer storage (reuses /uploads served by server.js) ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "..", "public", "uploads", "maintenance");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const base = String(Date.now());
    cb(null, `m_${base}${ext || ".jpg"}`);
  },
});
const upload = multer({ storage });

// ---------- Helpers ----------
const pick = (obj = {}, keys = []) =>
  keys.reduce((acc, k) => (obj[k] !== undefined ? (acc[k] = obj[k], acc) : acc), {});
const nowIso = () => new Date().toISOString();

// all routes protected / tenant-safe
router.use(auth);

// GET /api/maintenance?status=open&assigned_to=12
router.get("/", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { status, assigned_to } = req.query;

  try {
    let q = `SELECT m.*, s.name AS assigned_name
             FROM maintenance_issues m
             LEFT JOIN staff s
               ON s.restaurant_id = m.restaurant_id
              AND s.id = m.assigned_to
            WHERE m.restaurant_id = $1`;
    const params = [restaurantId];
    let i = 2;

    if (status) {
      q += ` AND m.status = $${i++}`;
      params.push(status);
    }
    if (assigned_to) {
      q += ` AND m.assigned_to = $${i++}`;
      params.push(Number(assigned_to));
    }
    q += " ORDER BY m.created_at DESC";

    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) {
    console.error("❌ maintenance list error:", err);
    res.status(500).json({ error: "Failed to fetch issues" });
  }
});

// POST /api/maintenance (multipart form ok)
router.post("/", upload.single("photo"), async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const body = req.body || {};
  const file = req.file;

  try {
    const data = pick(body, [
      "title",
      "description",
      "priority",
    ]);

    if (!data.title) {
      return res.status(400).json({ error: "Title is required" });
    }

    let assigned_to = body.assigned_to ? Number(body.assigned_to) : null;

    // validate staff belongs to tenant if provided
    if (assigned_to) {
      const s = await pool.query(
        `SELECT 1 FROM staff WHERE restaurant_id = $1 AND id = $2`,
        [restaurantId, assigned_to]
      );
      if (s.rowCount === 0) assigned_to = null;
    }

    const photo_url = file
      ? `/uploads/maintenance/${file.filename}`
      : null;

    const insert = await pool.query(
      `INSERT INTO maintenance_issues
         (restaurant_id, title, description, status, assigned_to, photo_url, created_by, priority)
       VALUES
         ($1, $2, $3, 'open', $4, $5, $6, COALESCE($7, 'medium'))
       RETURNING *`,
      [
        restaurantId,
        data.title,
        data.description || "",
        assigned_to,
        photo_url,
        req.user.id || null,
        data.priority,
      ]
    );

    const row = insert.rows[0];
    req.app.get("io")?.to(`restaurant_${restaurantId}`).emit("maintenance_created", row);

    saveNotification({
      restaurantId,
      message: `🛠️ Maintenance created: ${row.title}`,
      type: "maintenance",
      stockId: null,
      extra: { issueId: row.id, status: row.status, priority: row.priority },
    });
    res.status(201).json(row);
  } catch (err) {
    console.error("❌ maintenance create error:", err);
    res.status(500).json({ error: "Failed to create issue" });
  }
});

// PUT /api/maintenance/:id  (title/desc/priority/assigned_to/status)
router.put("/:id", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const id = Number(req.params.id);
  const body = req.body || {};

  try {
    // clamp fields
    const allowed = pick(body, [
      "title",
      "description",
      "priority",
      "status",
      "assigned_to",
    ]);

    if (allowed.assigned_to !== undefined && allowed.assigned_to !== null) {
      // validate tenant staff
      const s = await pool.query(
        `SELECT 1 FROM staff WHERE restaurant_id = $1 AND id = $2`,
        [restaurantId, Number(allowed.assigned_to)]
      );
      if (s.rowCount === 0) allowed.assigned_to = null;
    }

    // resolved_at toggle
    const setResolvedAt =
      allowed.status === "resolved"
        ? ", resolved_at = NOW()"
        : allowed.status
        ? ", resolved_at = NULL"
        : "";

    const keys = Object.keys(allowed);
    if (keys.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const setSql = keys
      .map((k, idx) => `${k} = $${idx + 3}`)
      .join(", ");

    const params = [restaurantId, id, ...keys.map((k) => (k === "assigned_to" ? (allowed[k] ? Number(allowed[k]) : null) : allowed[k]))];

    const q = `
      UPDATE maintenance_issues
         SET ${setSql},
             updated_at = NOW()
             ${setResolvedAt}
       WHERE restaurant_id = $1 AND id = $2
       RETURNING *`;

    const { rows } = await pool.query(q, params);
    if (!rows.length) return res.status(404).json({ error: "Issue not found" });

    const updated = rows[0];
    req.app.get("io")?.to(`restaurant_${restaurantId}`).emit("maintenance_updated", updated);

    if (allowed.status) {
      const verb = updated.status === "resolved" ? "resolved" : `set to ${updated.status}`;
      saveNotification({
        restaurantId,
        message: `🛠️ Maintenance ${verb}: ${updated.title}`,
        type: "maintenance",
        stockId: null,
        extra: { issueId: updated.id, status: updated.status, priority: updated.priority },
      });
    }
    res.json(updated);
  } catch (err) {
    console.error("❌ maintenance update error:", err);
    res.status(500).json({ error: "Failed to update issue" });
  }
});

// PATCH quick actions
router.patch("/:id/start", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const id = Number(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE maintenance_issues
          SET status = 'in_progress', updated_at = NOW()
        WHERE restaurant_id = $1 AND id = $2
        RETURNING *`,
      [restaurantId, id]
    );
    if (!rows.length) return res.status(404).json({ error: "Issue not found" });
    req.app.get("io")?.to(`restaurant_${restaurantId}`).emit("maintenance_updated", rows[0]);

    saveNotification({
      restaurantId,
      message: `🛠️ Maintenance started: ${rows[0].title}`,
      type: "maintenance",
      stockId: null,
      extra: { issueId: rows[0].id, status: rows[0].status, priority: rows[0].priority },
    });
    res.json(rows[0]);
  } catch (err) {
    console.error("❌ maintenance start error:", err);
    res.status(500).json({ error: "Failed to start" });
  }
});

router.patch("/:id/resolve", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const id = Number(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE maintenance_issues
          SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
        WHERE restaurant_id = $1 AND id = $2
        RETURNING *`,
      [restaurantId, id]
    );
    if (!rows.length) return res.status(404).json({ error: "Issue not found" });
    req.app.get("io")?.to(`restaurant_${restaurantId}`).emit("maintenance_updated", rows[0]);

    saveNotification({
      restaurantId,
      message: `✅ Maintenance resolved: ${rows[0].title}`,
      type: "maintenance",
      stockId: null,
      extra: { issueId: rows[0].id, status: rows[0].status, priority: rows[0].priority },
    });
    res.json(rows[0]);
  } catch (err) {
    console.error("❌ maintenance resolve error:", err);
    res.status(500).json({ error: "Failed to resolve" });
  }
});

// DELETE /api/maintenance/:id
router.delete("/:id", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const id = Number(req.params.id);
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM maintenance_issues WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, id]
    );
    if (!rowCount) return res.status(404).json({ error: "Issue not found" });
    req.app.get("io")?.to(`restaurant_${restaurantId}`).emit("maintenance_deleted", { id });

    saveNotification({
      restaurantId,
      message: `🗑️ Maintenance deleted (#${id})`,
      type: "maintenance",
      stockId: null,
      extra: { issueId: id, status: "deleted" },
    });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ maintenance delete error:", err);
    res.status(500).json({ error: "Failed to delete issue" });
  }
});

// COMMENTS (optional)
router.get("/:id/comments", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const id = Number(req.params.id);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM maintenance_comments
        WHERE restaurant_id = $1 AND issue_id = $2
        ORDER BY created_at ASC`,
      [restaurantId, id]
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ fetch comments error:", err);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

router.post("/:id/comments", async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const id = Number(req.params.id);
  const { note } = req.body || {};
  if (!note) return res.status(400).json({ error: "Note is required" });

  try {
    const { rows } = await pool.query(
      `INSERT INTO maintenance_comments (restaurant_id, issue_id, author_id, note)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [restaurantId, id, req.user.id || null, note]
    );
    const created = rows[0];
    req.app.get("io")?.to(`restaurant_${restaurantId}`).emit("maintenance_comment", created);
    res.status(201).json(created);
  } catch (err) {
    console.error("❌ add comment error:", err);
    res.status(500).json({ error: "Failed to add comment" });
  }
});

module.exports = router;
