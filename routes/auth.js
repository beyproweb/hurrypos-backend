// routes/auth.js
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");

router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  console.log("🔑 Login Debug");
  console.log("➡️ Incoming email:", email);
  console.log("➡️ DB URL exists?", !!process.env.DATABASE_URL);
  console.log("➡️ JWT_SECRET exists?", !!process.env.JWT_SECRET);

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: "Email and password required",
    });
  }

  try {
    let user;
    let source = null;

    console.log("🛠️ Querying users table…");
    const userRes = await pool.query(
      `SELECT id, full_name, email, password_hash, role, restaurant_id
       FROM users
       WHERE email = $1`,
      [email]
    );

    if (userRes.rows.length > 0) {
      user = userRes.rows[0];
      source = "users";
      console.log("✅ Found user in users table:", user.email);
    }

    // fallback: staff table
    if (!user) {
      console.log("🛠️ Querying staff table…");
      const staffRes = await pool.query(
        `SELECT id, name, email, pin, restaurant_id, role
         FROM staff WHERE email = $1 LIMIT 1`,
        [email]
      );

      if (staffRes.rows.length > 0) {
        user = staffRes.rows[0];
        source = "staff";
        console.log("✅ Found user in staff table:", user.email);
      }
    }

    if (!user) {
      console.warn("❌ No user found for email:", email);
      return res.status(401).json({
        success: false,
        error: "User not found or invalid credentials",
      });
    }

    // check password or PIN
    let passwordMatch = false;
    try {
      passwordMatch =
        source === "staff"
          ? user.pin === password // compare PIN directly
          : await bcrypt.compare(password, user.password_hash);
    } catch (e) {
      passwordMatch = false;
    }

    if (!passwordMatch) {
      console.warn("❌ Invalid password for:", email);
      return res.status(401).json({
        success: false,
        error: "Invalid password",
      });
    }

    // create JWT token
    const token = jwt.sign(
      {
        id: user.id,
        name: user.name || user.full_name,
        role: user.role || "staff",
        restaurant_id: user.restaurant_id,
      },
      process.env.JWT_SECRET || "beyprosecret",
      { expiresIn: "7d" }
    );

    console.log(`✅ ${source} login success:`, user.email);

    // ✅ Fetch role permissions (MERGED from both users + global)
    let permissions = [];
    const roleKey = user.role?.toLowerCase();

    try {
      const result = await pool.query(
        `SELECT key, value, users
         FROM settings
         WHERE restaurant_id = $1
           AND key IN ('users', 'global')`,
        [user.restaurant_id]
      );

      let valueConfig = {};
      let usersConfig = {};

      for (const row of result.rows) {
        if (row.key === "users" && row.value) valueConfig = row.value;
        if (row.key === "global" && row.users) usersConfig = row.users;
      }

      // 🧩 Merge both configs safely
      const merged = {
        roles: {
          ...(usersConfig.roles || {}),
          ...(valueConfig.roles || {}), // value overwrites same roles
        },
      };

      if (merged.roles?.[roleKey]) {
        permissions = merged.roles[roleKey];
      } else if (merged.roles?.boss) {
        permissions = merged.roles.boss;
      } else if (roleKey === "boss" && merged.roles?.admin) {
        permissions = merged.roles.admin;
      }

      console.log("🔎 Merged Roles:", merged.roles);
      console.log(`✅ Final permissions for ${roleKey}:`, permissions);
    } catch (err) {
      console.error("⚠️ Error loading permissions:", err);
    }

    // ✅ Respond with token and normalized user data
    res.json({
      success: true,
      message: "Login successful",
      source,
      user: {
        id: user.id,
        name: user.name || user.full_name,
        email: user.email,
        role: user.role,
        restaurant_id: user.restaurant_id,
        permissions,
      },
      token,
    });
  } catch (err) {
    console.error("❌ Login error:", err.message, err.stack);
    res.status(500).json({
      success: false,
      error: "Internal server error during login",
    });
  }
});

module.exports = router;
