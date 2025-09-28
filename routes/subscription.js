
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const path = require("path");
const multer = require('multer');
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // or wherever your upload folder is
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const extension = file.originalname.split('.').pop();
    cb(null, `${file.fieldname}-${uniqueSuffix}.${extension}`);
  }
});
const upload = multer({ storage });
const bcrypt = require("bcrypt");

function requireAuth(req, res, next) {
  // Example for express-session
  if (req.session && req.session.userId) {
    next();
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
}

// POST /api/subscribe
router.post("/subscribe", async (req, res) => {
  const {
    fullName,
    email,
    phone,
    businessName,
    taxId,
    posLocation,
    usageType,
    efatura,
    invoiceTitle,
    taxOffice,
    invoiceType,
    activePlan,
    billingCycle,
    avatar,
  } = req.body;

  if (!fullName || !email || !phone || !activePlan || !billingCycle) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
   await pool.query(
  `INSERT INTO subscription_applications
   (full_name, email, phone, business_name, tax_id, pos_location, usage_type,
    efatura, invoice_title, tax_office, invoice_type, active_plan, billing_cycle, avatar)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
   ON CONFLICT (email)
   DO UPDATE SET
     full_name = EXCLUDED.full_name,
     phone = EXCLUDED.phone,
     business_name = EXCLUDED.business_name,
     tax_id = EXCLUDED.tax_id,
     pos_location = EXCLUDED.pos_location,
     usage_type = EXCLUDED.usage_type,
     efatura = EXCLUDED.efatura,
     invoice_title = EXCLUDED.invoice_title,
     tax_office = EXCLUDED.tax_office,
     invoice_type = EXCLUDED.invoice_type,
     active_plan = EXCLUDED.active_plan,
     billing_cycle = EXCLUDED.billing_cycle,
     subscribed_at = now();`,
  [
    fullName,
    email,
    phone,
    businessName,
    taxId,
    posLocation,
    usageType,
    efatura || false,
    invoiceTitle,
    taxOffice,
    invoiceType,
    activePlan,
    billingCycle,
  ]
);



    res.json({ success: true, message: "Subscription saved" });
  } catch (err) {
    console.error("❌ DB error:", err);
    res.status(500).json({ error: "Failed to save subscription" });
  }
});


// POST /api/register
// routes/subscription.js (excerpt)

router.post("/register", async (req, res) => {
  const { email, password, fullName, businessName, plan } = req.body;

  if (!email || !password || !fullName || !plan) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Check if user already exists
    const userCheck = await client.query("SELECT id FROM users WHERE email = $1", [email]);
    if (userCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, error: "User already exists" });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert user
    const userRes = await client.query(
      `INSERT INTO users (email, full_name, password_hash, business_name, subscription_plan)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [email, fullName, passwordHash, businessName, plan]
    );
    const userId = userRes.rows[0].id;

    // Insert restaurant
    const restRes = await client.query(
      `INSERT INTO restaurants (name, plan, billing_cycle, owner_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [businessName || `${fullName}'s Restaurant`, plan, "monthly", userId]
    );
    const restaurantId = restRes.rows[0].id;

    // Update user with restaurant_id
    await client.query(
      `UPDATE users SET restaurant_id = $1 WHERE id = $2`,
      [restaurantId, userId]
    );

    // ✅ Insert default settings with admin role + all permissions
    const defaultRoles = {
      roles: {
        admin: [
          "dashboard",
          "products",
          "kitchen",
          "suppliers",
          "stock",
          "production",
          "tables",
          "reports",
          "staff",
          "task",
          "delivery",
          "settings",
          "settings-notifications",
          "expenses",
          "ingredient-prices",
          "cash-register-history",
          "integrations",
        ],
      },
    };

    await client.query(
      `INSERT INTO settings (restaurant_id, users, notifications, appearance)
       VALUES ($1, $2::jsonb, '{}'::jsonb, '{}'::jsonb)`,
      [restaurantId, JSON.stringify(defaultRoles)]
    );

    // ✅ Insert a legacy global row for compatibility (key/value)
    await client.query(
      `INSERT INTO settings (restaurant_id, key, value)
       VALUES ($1, 'global', '{}'::jsonb)
       ON CONFLICT (restaurant_id, key) DO NOTHING`,
      [restaurantId]
    );

    await client.query("COMMIT");
    res.json({ success: true, message: "Restaurant registered", restaurantId });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Registration error:", err);
    res.status(500).json({ success: false, error: "Registration failed" });
  } finally {
    client.release();
  }
});


router.use("/uploads", express.static(path.join(__dirname, 'uploads'))); // ✅ serve files

// Upload route
router.post("/upload", upload.single('image'), (req, res) => {
  const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url: fileUrl });
});

// POST /api/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ success: false, error: "User not found" });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: "Incorrect password" });
    }

    // Fetch latest subscription info
    const subRes = await pool.query(
      `SELECT active_plan FROM subscription_applications WHERE email = $1 ORDER BY subscribed_at DESC LIMIT 1`,
      [email]
    );
    const plan = subRes.rows[0]?.active_plan;
    const activePlan = plan && plan !== "null" && plan !== "" ? plan : null;

    // 🔑 Resolve permissions for this role
    const settingsRes = await pool.query(`SELECT users FROM settings LIMIT 1`);
    let perms = [];
    if (settingsRes.rowCount > 0 && settingsRes.rows[0].users) {
      perms = settingsRes.rows[0].users.roles?.[user.role] || [];
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        businessName: user.business_name,
        subscriptionPlan: activePlan,
        role: user.role,
        permissions: perms, // ✅ always attach resolved permissions
      },
    });
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});


// inside subscription.js
// inside subscription.js
router.get("/me", async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: "Missing email" });

  try {
    // 🔹 USERS table (Owner/Admin)
    const userResult = await pool.query(
      `SELECT id, email, full_name, subscription_plan, role, business_name
       FROM users WHERE email = $1`,
      [email]
    );

    if (userResult.rowCount > 0) {
      const user = userResult.rows[0];
      const role = (user.role || "").toLowerCase(); // normalize role

      // Fetch permissions from settings.users JSONB
      const settingsRes = await pool.query(`SELECT users FROM settings LIMIT 1`);
      let perms = [];
      if (settingsRes.rowCount > 0 && settingsRes.rows[0].users) {
        perms = settingsRes.rows[0].users.roles?.[role] || [];
      }

      return res.json({
        user: {
          id: user.id,
          fullName: user.full_name,
          email: user.email,
          businessName: user.business_name,
          subscriptionPlan: user.subscription_plan,
          role, // normalized
          type: "user",
          permissions: perms,
        },
      });
    }

    // 🔹 STAFF table
    const staffResult = await pool.query(
      `SELECT id, name, email, role FROM staff WHERE email = $1`,
      [email]
    );

    if (staffResult.rowCount > 0) {
      const staff = staffResult.rows[0];
      const role = (staff.role || "").toLowerCase(); // normalize role

      // Fetch permissions from settings.users JSONB
      const settingsRes = await pool.query(`SELECT users FROM settings LIMIT 1`);
      let perms = [];
      if (settingsRes.rowCount > 0 && settingsRes.rows[0].users) {
        perms = settingsRes.rows[0].users.roles?.[role] || [];
      }

      return res.json({
        staff: {
          id: staff.id,
          name: staff.name,
          email: staff.email,
          role, // normalized
          type: "staff",
          permissions: perms,
        },
      });
    }

    return res.status(404).json({ error: "User or staff not found" });
  } catch (err) {
    console.error("❌ /me error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});




module.exports = router;
