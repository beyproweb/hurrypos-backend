const express = require('express');
const router = express.Router();
const { pool } = require("../db");
const { getIO } = require("../utils/socket");
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ AI Voice Command Task Parser
// ✅ AI Voice Command Task Parser (Multilingual)
router.post("/voice-command", async (req, res) => {
  console.log("🎙️ /voice-command hit");
  const { message, created_by } = req.body;
  const clientLang = req.headers["x-client-lang"] || "en"; // from frontend
  if (!created_by) {
    return res.status(400).json({ error: "Missing created_by" });
  }

  const langMap = {
    tr: "Turkish",
    de: "German",
    fr: "French",
    en: "English"
  };
  const languageLabel = langMap[clientLang] || "English";

  try {
    const staffRes = await pool.query("SELECT name FROM staff");
    const staffNames = staffRes.rows.map(r => r.name).join(", ");

    const prompt = `You are a multilingual restaurant task assistant.

You will receive a casual spoken instruction in ${languageLabel}.

Extract task info and return only a clean JSON object. DO NOT explain or format.

KNOWN STAFF: ${staffNames}

If time is missing, omit "due_at".
If staff is missing, omit "assigned_to_name".

ALWAYS return valid JSON in this format:
{
  "title": "Clean kitchen",
  "description": "optional",
  "assigned_to_name": "Yusuf",
  "due_at": "2025-05-11T17:00:00",
  "priority": "medium",
  "station": "store"
}

Some ${languageLabel} examples:
- "Yusuf'e bir sonraki siparişi ver" → assign_to_name: Yusuf
- "Mutfak temizlik" → title: "Mutfak temizliği"
- "Hatırlatma: masa siparişi" → title: "Masa siparişi hatırlatma"

User said (in ${languageLabel}): "${message}"
`;


    const aiRes = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "Only respond with valid JSON for the task. No explanation. No comments." },
        { role: "user", content: prompt },
      ],
    });

    const raw = aiRes.choices[0].message.content.trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(200).json({ status: "missing", reason: "bad_json" });
    }

    const title = parsed.title?.trim();
    const description = parsed.description?.trim() || "";
    const assignedName = parsed.assigned_to_name?.trim();
    const due_at = parsed.due_at?.trim();

    let assigned_to = null;
    if (assignedName) {
      const match = await pool.query(
        `SELECT id FROM staff WHERE restaurant_id = $1 WHERE LOWER(unaccent(name)) = LOWER(unaccent($1)) LIMIT 1`,
        [assignedName]
      );
      assigned_to = match.rows[0]?.id || null;
    }

    const hasName = !!assigned_to;
    const hasDue = !!due_at;

    if (!title || !hasName || !hasDue) {
      return res.status(200).json({
        status: "missing_fields",
        parsed: { title, description },
      });
    }

    const insert = await pool.query(
      `INSERT INTO tasks (
        title, description, assigned_to, created_by, due_at,
        priority, input_method, station, voice_response
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        title,
        description,
        assigned_to,
        created_by,
        due_at,
        parsed.priority || "medium",
        "voice",
        parsed.station || null,
        true,
      ]
    );

    const newTask = insert.rows[0];
    getIO(req)?.emit("task_created", newTask);

    return res.status(201).json({ status: "saved", task: newTask });
  } catch (err) {
    console.error("❌ Error in /voice-command:", err);
    res.status(500).json({ error: "Voice command failed" });
  }
});





// ✅ Create task (used in follow-ups)
router.post("/tasks", async (req, res) => {
  const {
    title,
    description,
    assigned_to_name,
    due_at,
    created_by,
    input_method,
    priority,
    station,
    voice_response,
  } = req.body;


  // 🔍 Debug incoming data
  console.log("📦 Incoming /tasks body:", req.body);

  if (!title || !created_by) {
    console.warn("⚠️ Missing required fields:", { title, created_by });
    return res.status(400).json({ error: "Missing required fields: title or created_by" });
  }

  let assigned_to = null;
  if (assigned_to_name?.trim()) {
    const result = await pool.query(
      `SELECT id FROM staff WHERE restaurant_id = $1 WHERE LOWER(unaccent(name)) = LOWER(unaccent($1)) LIMIT 1`,
      [assigned_to_name.trim()]
    );
    assigned_to = result.rows[0]?.id || null;
  }

  try {
    const insert = await pool.query(
      `INSERT INTO tasks (
        title, description, assigned_to, created_by, due_at,
        priority, input_method, station, voice_response
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        title,
        description || "",
        assigned_to,
        created_by,
        due_at || null,
        priority || "medium",
        input_method || "voice",
        station || null,
        voice_response || false,
      ]
    );

    const newTask = insert.rows[0];
    getIO(req)?.emit("task_created", newTask);
    res.status(201).json(newTask);
  } catch (err) {
    console.error("❌ Error saving task:", err);
    res.status(500).json({ error: "Failed to save task" });
  }
});

// ✅ Start task
router.patch("/tasks/:id/start", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE tasks SET started_at = NOW(), status = 'in_progress' WHERE id = $1 RETURNING *`,
      [id]
    );
    getIO(req)?.emit("task_updated", result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error starting task:", err);
    res.status(500).json({ error: "Failed to start task" });
  }
});

// ✅ Complete task
router.patch("/tasks/:id/complete", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE tasks SET completed_at = NOW(), status = 'completed' WHERE id = $1 RETURNING *`,
      [id]
    );
    getIO(req)?.emit("task_updated", result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error completing task:", err);
    res.status(500).json({ error: "Failed to complete task" });
  }
});

// ✅ Fetch tasks with filters
router.get("/tasks", async (req, res) => {
  const { assigned_to, status } = req.query;
  try {
    let query = 'SELECT * FROM tasks WHERE 1=1';
    const params = [];

    if (assigned_to) {
      params.push(assigned_to);
      query += ` AND assigned_to = $${params.length}`;
    }

    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }

    query += " ORDER BY created_at DESC";

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching tasks:", err);
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
});

// ✅ Update a task (used for inline edits or AI corrections)
router.put("/tasks/:id", async (req, res) => {
  const { id } = req.params;
  const {
    title,
    description,
    assigned_to,
    due_at,
    priority,
    station,
  } = req.body;

  if (!title) {
    return res.status(400).json({ error: "Task title is required." });
  }

  try {
    const update = await pool.query(
      `UPDATE tasks
       SET title = $1,
           description = $2,
           assigned_to = $3,
           due_at = $4,
           priority = $5,
           station = $6
       WHERE id = $7
       RETURNING *`,
      [title, description || "", assigned_to || null, due_at || null, priority || "medium", station || null, id]
    );

    const updatedTask = update.rows[0];
    getIO(req)?.emit("task_updated", updatedTask);
    res.json(updatedTask);
  } catch (err) {
    console.error("❌ Error updating task:", err);
    res.status(500).json({ error: "Failed to update task" });
  }
});

// ✅ Clear all tasks (use with caution)
router.delete("/tasks/clear", async (req, res) => {
  try {
    await pool.query("DELETE FROM tasks");
    getIO(req)?.emit("tasks_cleared");
    res.status(200).json({ message: "All tasks deleted." });
  } catch (err) {
    console.error("❌ Error clearing tasks:", err);
    res.status(500).json({ error: "Failed to clear tasks" });
  }
});

// ✅ Clear only completed tasks
router.delete("/tasks/clear-completed", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM tasks WHERE status = 'completed'");
    const count = result.rowCount;

    getIO(req)?.emit("tasks_cleared_completed");

    if (count === 0) {
      return res.status(200).json({ message: "No completed tasks to delete.", count: 0 });
    }

    res.status(200).json({ message: "Completed tasks deleted.", count });
  } catch (err) {
    console.error("❌ Error clearing completed tasks:", err);
    res.status(500).json({ error: "Failed to clear completed tasks" });
  }
});



module.exports = router;
