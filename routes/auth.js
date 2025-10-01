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
      "SELECT id, full_name AS name, email, password_hash AS password, restaurant_id, role FROM users WHERE email = $1 LIMIT 1",
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
        "SELECT id, name, email, password, restaurant_id, role FROM staff WHERE email = $1 LIMIT 1",
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

    // check password
    let passwordMatch = false;
    try {
      passwordMatch = await bcrypt.compare(password, user.password);
    } catch (e) {
      passwordMatch = user.password === password;
    }

    if (!passwordMatch) {
      console.warn("❌ Invalid password for:", email);
      return res.status(401).json({
        success: false,
        error: "Invalid password",
      });
    }

    // create token
    const token = jwt.sign(
      {
        id: user.id,
        name: user.name,
        role: user.role || "staff",
        restaurant_id: user.restaurant_id,
      },
      process.env.JWT_SECRET || "beyprosecret",
      { expiresIn: "7d" }
    );

    console.log(`✅ ${source} login success:`, user.email);

    res.json({
      success: true,
      message: "Login successful",
      source,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        restaurant_id: user.restaurant_id,
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
