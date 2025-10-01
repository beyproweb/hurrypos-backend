const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ----------------- REGISTER -----------------
router.post("/register", async (req, res) => {
  const client = await pool.connect();
  try {
    const { full_name, email, password, business_name, subscription_plan } = req.body;

    if (!full_name || !email || !password || !business_name) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ success: false, error: "Email already registered" });
    }

    const password_hash = await bcrypt.hash(password, 10);
    await client.query("BEGIN");

    // 1️⃣ Create the user (role: admin)
    const userRes = await client.query(
      `
      INSERT INTO users (email, full_name, password_hash, business_name, subscription_plan, role)
      VALUES ($1, $2, $3, $4, $5, 'admin')
      RETURNING id
      `,
      [email, full_name, password_hash, business_name, subscription_plan || "free"]
    );
    const userId = userRes.rows[0].id;

    // 2️⃣ Create the restaurant
    const restaurantRes = await client.query(
      `
      INSERT INTO restaurants (name, plan, billing_cycle, owner_id)
      VALUES ($1, $2, 'monthly', $3)
      RETURNING id
      `,
      [business_name, subscription_plan || "free", userId]
    );
    const restaurantId = restaurantRes.rows[0].id;

    // 3️⃣ Link the user to their restaurant
    await client.query(
      `UPDATE users SET restaurant_id = $1 WHERE id = $2`,
      [restaurantId, userId]
    );

    // 4️⃣ Optional: create default settings safely
    await client.query(
      `
      INSERT INTO settings (restaurant_id, users, notifications, appearance, key, value)
      VALUES ($1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'global', '{}'::jsonb)
      ON CONFLICT (restaurant_id, key) DO NOTHING
      `,
      [restaurantId]
    );

    await client.query("COMMIT");

    res.json({ success: true, message: "Registration successful", restaurant_id: restaurantId });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Registration error:", err);
    res.status(500).json({ success: false, error: "Registration failed" });
  } finally {
    client.release();
  }
});

// ----------------- LOGIN -----------------
// ----------------- LOGIN -----------------
router.post("/login", async (req, res) => {
  console.log("🟢 /api/login hit:", req.body);

  const { email, password } = req.body;
  try {
    const userRes = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = userRes.rows[0];

    if (!user) return res.status(401).json({ success: false, error: "User not found" });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ success: false, error: "Wrong password" });

    // ✅ Safe fetch of settings (won't crash if missing)
    const settingsRes = await pool.query(
      `SELECT users FROM settings WHERE restaurant_id = $1 LIMIT 1`,
      [user.restaurant_id]
    );

    let rolesJson = {};
    if (settingsRes.rowCount > 0 && settingsRes.rows[0].users) {
      rolesJson = settingsRes.rows[0].users;
    }

    // ✅ Normalize role to lowercase
    const roleKey = (user.role || "admin").toLowerCase();

    // ✅ Resolve permissions
    let permissions = rolesJson.roles?.[roleKey] || [];

    // ✅ Ensure admin is always superuser
    if (roleKey === "admin") {
      permissions = ["all"];
    }

    // ✅ Generate JWT (include tenant)
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: roleKey,
        restaurant_id: user.restaurant_id,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // ✅ Always return normalized role + guaranteed permissions
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        role: roleKey,
        restaurant_id: user.restaurant_id,
        business_name: user.business_name,
        permissions,
      },
    });
  } catch (err) {
    console.error("❌ Login failed:", err);
    res.status(500).json({ success: false, error: "Login failed" });
  }
});

// ----------------- ME (verify token) -----------------
// ----------------- ME (verify token) -----------------
router.get("/me", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch user record
    const userRes = await pool.query(
      `SELECT id, full_name, email, role, restaurant_id, business_name
       FROM users
       WHERE id = $1`,
      [decoded.id]
    );

    if (userRes.rowCount === 0) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const user = userRes.rows[0];
    const roleKey = (user.role || "admin").toLowerCase();

    // Fetch roles/permissions config from settings
    let rolesJson = {};
    const settingsRes = await pool.query(
      `SELECT users FROM settings WHERE restaurant_id = $1 LIMIT 1`,
      [user.restaurant_id]
    );
    if (settingsRes.rowCount > 0 && settingsRes.rows[0].users) {
      rolesJson = settingsRes.rows[0].users;
    }

    // Resolve permissions
    let permissions = rolesJson.roles?.[roleKey] || [];

    // ✅ Ensure admin is always superuser
    if (roleKey === "admin") {
      permissions = ["all"];
    }

    res.json({
      success: true,
      user: {
        ...user,
        role: roleKey,
        permissions,
      },
    });
  } catch (err) {
    console.error("❌ /me route error:", err);
    res.status(401).json({ success: false, error: "Invalid token" });
  }
});


module.exports = router;
