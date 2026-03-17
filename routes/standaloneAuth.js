const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { generateUniqueRestaurantSlug } = require("../utils/restaurantSlug");
const { normalizeModules, requireModule, requireAnyModule, attachAllowedModules } = require("../middleware/moduleGuard");
const authMiddleware = require("../middleware/authMiddleware");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function loadRestaurant(restaurantId) {
  const { rows } = await pool.query(
    "SELECT id, name, slug, plan, allowed_modules FROM restaurants WHERE id = $1 LIMIT 1",
    [restaurantId]
  );
  return rows[0] || null;
}

function signStandaloneToken({ id, name, role, restaurant_id, allowed_modules }) {
  return jwt.sign(
    { id, name, role, restaurant_id, allowed_modules },
    process.env.JWT_SECRET || "beypro_secret_2025",
    { expiresIn: "7d" }
  );
}

router.post("/register", async (req, res) => {
  let client;
  let inTransaction = false;
  try {
    const { full_name, email, password, business_name, planKey, plan, moduleKey } = req.body || {};
    if (!full_name || !email || !password || !business_name) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    client = await pool.connect();

    const planKeyRaw = planKey || plan || moduleKey || "qr_kitchen";
    const normalizedPlan = String(planKeyRaw || "").trim().toLowerCase();
    const allowedPlan = normalizedPlan === "staff" ? "staff" : "qr_kitchen";
    const allowedModules = [allowedPlan];

    const normalizedEmail = normalizeEmail(email);
    const existing = await client.query(
      "SELECT id, full_name, email, password_hash, role, restaurant_id FROM users WHERE LOWER(TRIM(email)) = $1",
      [normalizedEmail]
    );

    if (existing.rowCount > 0) {
      const user = existing.rows[0];
      if (user.restaurant_id) {
        const restaurant = await loadRestaurant(user.restaurant_id);
        const allowed = normalizeModules(restaurant?.allowed_modules);
        if (Array.isArray(allowed) && (allowed.includes("qr_kitchen") || allowed.includes("staff"))) {
          const token = signStandaloneToken({
            id: user.id,
            name: user.full_name,
            role: user.role || "admin",
            restaurant_id: user.restaurant_id,
            allowed_modules: allowed,
          });
          return res.json({
            token,
            user,
            restaurant,
            allowed_modules: allowed,
          });
        }
        return res.status(409).json({ error: "Email already registered" });
      }
      return res.status(409).json({ error: "Email already registered" });
    }

    const password_hash = await bcrypt.hash(password, 10);
    await client.query("BEGIN");
    inTransaction = true;

    const userRes = await client.query(
      `INSERT INTO users (email, full_name, password_hash, business_name, subscription_plan, role)
       VALUES ($1,$2,$3,$4,$5,'admin')
       RETURNING id, full_name, email, role`,
      [normalizedEmail, full_name, password_hash, business_name, allowedPlan]
    );
    const user = userRes.rows[0];

    const restaurantSlug = await generateUniqueRestaurantSlug(client, business_name);
    const restRes = await client.query(
      `INSERT INTO restaurants (name, slug, plan, billing_cycle, owner_id, allowed_modules)
       VALUES ($1,$2,$3,'monthly',$4,$5::jsonb)
       RETURNING id, name, slug, plan, allowed_modules`,
      [business_name, restaurantSlug, "free", user.id, JSON.stringify(allowedModules)]
    );
    const restaurant = restRes.rows[0];

    await client.query(`UPDATE users SET restaurant_id=$1 WHERE id=$2`, [
      restaurant.id,
      user.id,
    ]);

    await client.query(
      `INSERT INTO settings (restaurant_id, key, value)
       VALUES ($1,'users','{}'::jsonb)
       ON CONFLICT (restaurant_id, key) DO NOTHING`,
      [restaurant.id]
    );

    await client.query("COMMIT");
    inTransaction = false;

    const allowed = normalizeModules(restaurant.allowed_modules) || allowedModules;
    const token = signStandaloneToken({
      id: user.id,
      name: user.full_name,
      role: user.role || "admin",
      restaurant_id: restaurant.id,
      allowed_modules: allowed,
    });

    return res.json({
      token,
      user: { ...user, restaurant_id: restaurant.id },
      restaurant,
      allowed_modules: allowed,
    });
  } catch (err) {
    if (client && inTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("❌ Standalone registration rollback failed:", rollbackErr);
      }
    }
    console.error("❌ Standalone registration failed:", err);
    return res.status(500).json({ error: "Registration failed" });
  } finally {
    if (client) {
      try {
        client.release();
      } catch (releaseErr) {
        console.error("❌ Standalone registration client release failed:", releaseErr);
      }
    }
  }
});

router.post("/login", async (req, res) => {
  const { email, password, planKey, plan, moduleKey } = req.body || {};
  const planKeyRaw = planKey || plan || moduleKey || null;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  try {
    const normalizedEmail = normalizeEmail(email);
    const userRes = await pool.query(
      "SELECT id, full_name, email, password_hash, role, restaurant_id FROM users WHERE LOWER(TRIM(email)) = $1",
      [normalizedEmail]
    );
    const user = userRes.rows[0];
    if (!user) return res.status(401).json({ error: "User not found" });

    const match = await bcrypt.compare(password, user.password_hash || "");
    if (!match) return res.status(401).json({ error: "Invalid password" });

    const restaurant = await loadRestaurant(user.restaurant_id);
    const allowed = normalizeModules(restaurant?.allowed_modules);
    const needsPlan = planKeyRaw ? String(planKeyRaw).trim().toLowerCase() : null;
    const allowedSet = Array.isArray(allowed) ? allowed : [];
    const hasQr = allowedSet.includes("qr_kitchen");
    const hasStaff = allowedSet.includes("staff");
    const hasRequired = needsPlan ? allowedSet.includes(needsPlan) : hasQr || hasStaff;
    if (!hasRequired) {
      return res.status(403).json({ error: "MODULE_NOT_ALLOWED" });
    }

    const token = signStandaloneToken({
      id: user.id,
      name: user.full_name,
      role: user.role || "admin",
      restaurant_id: user.restaurant_id,
      allowed_modules: allowedSet,
    });

    return res.json({
      token,
      user,
      restaurant,
      allowed_modules: allowedSet,
    });
  } catch (err) {
    console.error("❌ Standalone login failed:", err);
    return res.status(500).json({ error: "Login failed" });
  }
});

router.get("/me", authMiddleware, requireAnyModule(["qr_kitchen", "staff"]), async (req, res) => {
  try {
    const userId = req.user?.id;
    const restaurantId = req.user?.restaurant_id;
    if (!userId || !restaurantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { rows } = await pool.query(
      `SELECT id, full_name, email, role, restaurant_id
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );
    const user = rows[0] || null;
    const restaurant = await loadRestaurant(restaurantId);
    const allowed = await attachAllowedModules(req);

    return res.json({
      user,
      restaurant,
      allowed_modules: Array.isArray(allowed) ? allowed : normalizeModules(restaurant?.allowed_modules),
    });
  } catch (err) {
    console.error("❌ Standalone /me failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
