const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const authMiddleware = require("../middleware/authMiddleware");
const { generateUniqueRestaurantSlug } = require("../utils/restaurantSlug");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/* ----------------------------- REGISTER ----------------------------- */
router.post("/register", async (req, res) => {
  let client;
  let inTransaction = false;
  try {
    client = await pool.connect();
    const { full_name, email, password, business_name, subscription_plan } = req.body;

    if (!full_name || !email || !password || !business_name) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const normalizedEmail = normalizeEmail(email);
    const existing = await pool.query("SELECT id FROM users WHERE LOWER(TRIM(email)) = $1", [
      normalizedEmail,
    ]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ success: false, error: "Email already registered" });
    }

    const password_hash = await bcrypt.hash(password, 10);
    await client.query("BEGIN");
    inTransaction = true;

    // Create user
    const userRes = await client.query(
      `INSERT INTO users (email, full_name, password_hash, business_name, subscription_plan, role)
       VALUES ($1,$2,$3,$4,$5,'admin')
       RETURNING id`,
      [normalizedEmail, full_name, password_hash, business_name, subscription_plan || "free"]
    );
    const userId = userRes.rows[0].id;

    // Create restaurant
    const restaurantSlug = await generateUniqueRestaurantSlug(client, business_name);
    const restRes = await client.query(
      `INSERT INTO restaurants (name, slug, plan, billing_cycle, owner_id)
       VALUES ($1,$2,$3,'monthly',$4)
       RETURNING id`,
      [business_name, restaurantSlug, subscription_plan || "free", userId]
    );
    const restaurantId = restRes.rows[0].id;

    // Link user → restaurant
    await client.query(`UPDATE users SET restaurant_id=$1 WHERE id=$2`, [restaurantId, userId]);

    // Default settings
    await client.query(
      `INSERT INTO settings (restaurant_id, key, value)
       VALUES ($1,'users','{}'::jsonb)
       ON CONFLICT (restaurant_id, key) DO NOTHING`,
      [restaurantId]
    );

    // Optional: create subscription details row
    await client.query(
      `CREATE TABLE IF NOT EXISTS subscriptions (
         restaurant_id INTEGER PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
         card_number TEXT,
         expiry TEXT,
         cvv TEXT,
         billing_cycle TEXT DEFAULT 'monthly'
       )`
    );
    await client.query(
      `INSERT INTO subscriptions (restaurant_id, billing_cycle)
       VALUES ($1, 'monthly')
       ON CONFLICT (restaurant_id) DO NOTHING`,
      [restaurantId]
    );

    await client.query("COMMIT");
    inTransaction = false;
    res.json({ success: true, message: "Registration successful", restaurant_id: restaurantId });
  } catch (err) {
    if (client && inTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("❌ Registration rollback failed:", rollbackErr);
      }
    }
    console.error("❌ Registration error:", err);
    res.status(500).json({ success: false, error: "Registration failed" });
  } finally {
    if (client) client.release();
  }
});

/* ----------------------------- LOGIN ----------------------------- */
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const normalizedEmail = normalizeEmail(email);
    const userRes = await pool.query("SELECT * FROM users WHERE LOWER(TRIM(email))=$1", [
      normalizedEmail,
    ]);
    const user = userRes.rows[0];
    if (!user) return res.status(401).json({ success: false, error: "User not found" });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ success: false, error: "Wrong password" });

const token = jwt.sign(
  {
    id: user.id,
    name: user.full_name || user.name,
    role: user.role || "admin",
    restaurant_id: user.restaurant_id,  // ✅ required for middleware
  },
  process.env.JWT_SECRET || "beypro_secret_2025",
  { expiresIn: "7d" }
);




    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        role: user.role,
        restaurant_id: user.restaurant_id,
        business_name: user.business_name,
      },
    });
  } catch (err) {
    console.error("❌ Login failed:", err);
    res.status(500).json({ success: false, error: "Login failed" });
  }
});

/* ----------------------------- GET /me ----------------------------- */
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const restaurantId = req.user.restaurant_id;
    const roleKey = String(req.user.role || "").toLowerCase();
    const shouldPreferStaff =
      req.user.auth_source === "staff" ||
      ["staff", "driver", "cashier", "waiter", "kitchen", "kurye"].includes(roleKey);

    if (shouldPreferStaff) {
      const staffResult = await pool.query(
        `SELECT
            st.id,
            st.name,
            st.email,
            st.phone,
            st.restaurant_id,
            r.name AS restaurant_name,
            r.plan,
            r.billing_cycle,
            r.pos_location,
            r.usage_type,
            sub.card_number,
            sub.expiry,
            sub.cvv,
            sub.billing_cycle AS sub_billing_cycle,
            sub.efatura,
            sub.invoice_title,
            sub.tax_office,
            sub.invoice_type
         FROM staff st
         LEFT JOIN restaurants r ON r.id = st.restaurant_id
         LEFT JOIN subscriptions sub ON sub.restaurant_id = r.id
         WHERE st.id = $1
           AND st.restaurant_id = $2
           AND st.status = 'active'
         LIMIT 1`,
        [userId, restaurantId]
      );

      if (staffResult.rows.length > 0) {
        const staff = staffResult.rows[0];
        return res.json({
          user: {
            id: staff.id,
            full_name: staff.name,
            email: staff.email,
            business_name: staff.restaurant_name || "",
            restaurant_id: staff.restaurant_id,
            restaurant_name: staff.restaurant_name || "",
            role: req.user.role || "staff",
            auth_source: req.user.auth_source || "staff",
            active_plan: staff.plan || "",
            phone: staff.phone || "",
            pos_location: staff.pos_location || "",
            usage_type: staff.usage_type || "",
            card_number: staff.card_number || "",
            expiry: staff.expiry || "",
            cvv: staff.cvv || "",
            billing_cycle: staff.sub_billing_cycle || staff.billing_cycle || "monthly",
            efatura: staff.efatura || false,
            invoice_title: staff.invoice_title || "",
            tax_office: staff.tax_office || "",
            invoice_type: staff.invoice_type || "",
          },
        });
      }
    }

    const result = await pool.query(
      `SELECT
          u.id,
          u.full_name,
          u.email,
          u.business_name,
          u.subscription_plan AS active_plan,
          u.phone,
          r.id AS restaurant_id,
          r.name AS restaurant_name,
          r.plan,
          r.billing_cycle,
          r.pos_location,
          r.usage_type,
          s.card_number,
          s.expiry,
          s.cvv,
          s.billing_cycle AS sub_billing_cycle,
          s.efatura,
          s.invoice_title,
          s.tax_office,
          s.invoice_type
       FROM users u
       LEFT JOIN restaurants r ON r.id = u.restaurant_id
       LEFT JOIN subscriptions s ON s.restaurant_id = r.id
       WHERE u.id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];

    res.json({
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        business_name: user.business_name,
        restaurant_id: user.restaurant_id,
        restaurant_name: user.restaurant_name || "",
        role: req.user.role || "",
        auth_source: req.user.auth_source || "users",
        active_plan: user.active_plan,
        phone: user.phone || "",
        pos_location: user.pos_location || "",
        usage_type: user.usage_type || "",
        card_number: user.card_number || "",
        expiry: user.expiry || "",
        cvv: user.cvv || "",
        billing_cycle: user.sub_billing_cycle || user.billing_cycle || "monthly",
        efatura: user.efatura || false,
        invoice_title: user.invoice_title || "",
        tax_office: user.tax_office || "",
        invoice_type: user.invoice_type || "",
      },
    });
  } catch (err) {
    console.error("❌ GET /me error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


/* ----------------------------- PUT /me ----------------------------- */
router.put("/me", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const {
    fullName,
    email,
    businessName,
    billingCycle: billingCycleRaw,
    activePlan,
    password,
    cardNumber,
    expiry,
    cvv,
    phone,
    posLocation,
    posLocationLat,
    posLocationLng,
    usageType,
    efatura,
    invoiceTitle,
    taxOffice,
    invoiceType,
  } = req.body;

  const billingCycle =
    typeof billingCycleRaw === "string"
      ? billingCycleRaw.trim().toLowerCase()
      : typeof req.body?.billing_cycle === "string"
        ? req.body.billing_cycle.trim().toLowerCase()
        : null;
  const normalizedBillingCycle =
    billingCycle === "yearly" || billingCycle === "monthly" ? billingCycle : null;

  try {
    const userRes = await pool.query("SELECT * FROM users WHERE id=$1", [userId]);
    if (userRes.rowCount === 0)
      return res.status(404).json({ success: false, error: "User not found" });

    const existing = userRes.rows[0];
    let passwordHash = existing.password_hash;
    if (password && password.trim().length > 0) {
      const salt = await bcrypt.genSalt(10);
      passwordHash = await bcrypt.hash(password, salt);
    }

    // ✅ Ensure subscriptions table has new columns
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        restaurant_id INTEGER PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
        card_number TEXT,
        expiry TEXT,
        cvv TEXT,
        billing_cycle TEXT DEFAULT 'monthly',
        efatura BOOLEAN DEFAULT false,
        invoice_title TEXT,
        tax_office TEXT,
        invoice_type TEXT
      );
    `);

    // ✅ Update USERS table (phone, name, password, plan)
    await pool.query(
      `UPDATE users
       SET full_name=$1,
           email=$2,
           password_hash=$3,
           business_name=$4,
           subscription_plan=$5,
           phone=$6
       WHERE id=$7`,
      [
        fullName || existing.full_name,
        email || existing.email,
        passwordHash,
        businessName || existing.business_name,
        activePlan || existing.subscription_plan,
        phone || existing.phone,
        userId,
      ]
    );

    // ✅ Update RESTAURANT table (pos_location, pos_location_lat, pos_location_lng, usage_type, billing_cycle, plan)
    await pool.query(
      `UPDATE restaurants
         SET name=$1,
             billing_cycle=$2,
             plan=$3,
             pos_location=$4,
             pos_location_lat=$5,
             pos_location_lng=$6,
             usage_type=$7
       WHERE id=$8`,
      [
        businessName || existing.business_name,
        normalizedBillingCycle || "monthly",
        activePlan || existing.subscription_plan,
        posLocation || null,
        posLocationLat || null,
        posLocationLng || null,
        usageType || null,
        existing.restaurant_id,
      ]
    );

    // ✅ Upsert into SUBSCRIPTIONS table (card + eFatura)
    await pool.query(
      `INSERT INTO subscriptions (
         restaurant_id, card_number, expiry, cvv, billing_cycle,
         efatura, invoice_title, tax_office, invoice_type
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (restaurant_id)
       DO UPDATE SET
         card_number=EXCLUDED.card_number,
         expiry=EXCLUDED.expiry,
         cvv=EXCLUDED.cvv,
         billing_cycle=EXCLUDED.billing_cycle,
         efatura=EXCLUDED.efatura,
         invoice_title=EXCLUDED.invoice_title,
         tax_office=EXCLUDED.tax_office,
         invoice_type=EXCLUDED.invoice_type`,
      [
        existing.restaurant_id,
        cardNumber || null,
        expiry || null,
        cvv || null,
        normalizedBillingCycle || "monthly",
        efatura || false,
        invoiceTitle || null,
        taxOffice || null,
        invoiceType || null,
      ]
    );

    const updated = await pool.query(
      `SELECT u.id, u.full_name, u.email, u.business_name, u.phone,
              r.name AS restaurant_name, COALESCE(s.billing_cycle, r.billing_cycle, 'monthly') AS billing_cycle, r.plan,
              r.pos_location, r.usage_type,
              s.efatura, s.invoice_title, s.tax_office, s.invoice_type
       FROM users u
       LEFT JOIN restaurants r ON r.id=u.restaurant_id
       LEFT JOIN subscriptions s ON s.restaurant_id=r.id
       WHERE u.id=$1`,
      [userId]
    );

    res.json({
      success: true,
      message: "Profile updated",
      user: updated.rows[0],
    });
  } catch (err) {
    console.error("PUT /me error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});


module.exports = router;
