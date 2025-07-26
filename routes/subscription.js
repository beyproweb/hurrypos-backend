
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
router.post("/register", async (req, res) => {
  const { email, password, fullName, businessName, subscriptionPlan } = req.body;

  if (!email || !password || !fullName) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }

  try {
    // Check if user already exists
    const userCheck = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (userCheck.rows.length > 0) {
      return res.status(409).json({ success: false, error: "User already exists" });
    }

    // Hash the password
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert new user
    await pool.query(
      `INSERT INTO users (email, full_name, password_hash, business_name, subscription_plan)
       VALUES ($1, $2, $3, $4, $5)`,
      [email, fullName, passwordHash, businessName, subscriptionPlan]
    );

    return res.json({ success: true, message: "User registered" });
  } catch (err) {
    console.error("❌ Registration error:", err);
    return res.status(500).json({ success: false, error: "Registration failed" });
  }
});

router.use("/uploads", express.static(path.join(__dirname, 'uploads'))); // ✅ serve files

// Upload route
router.post("/upload", upload.single('image'), (req, res) => {
  const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url: fileUrl });
});

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

    // Fetch latest subscription info for this user
    const subRes = await pool.query(
      `SELECT active_plan FROM subscription_applications WHERE email = $1 ORDER BY subscribed_at DESC LIMIT 1`,
      [email]
    );
    const plan = subRes.rows[0]?.active_plan;
const activePlan = plan && plan !== 'null' && plan !== '' ? plan : null;

    res.json({
  success: true,
  user: {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    businessName: user.business_name,
    subscriptionPlan: activePlan,
    role: user.role, // <--- ADD THIS LINE!
  },
    });
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});


router.get("/me", async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: "Missing email" });

  // Try USERS table first
  const userResult = await pool.query(
    `SELECT id, email, full_name, subscription_plan, role FROM users WHERE email = $1`,
    [email]
  );
  if (userResult.rowCount > 0) {
    // ...existing user logic...
    const user = userResult.rows[0];
    // Fetch permissions from settings.users JSONB
    const settingsRes = await pool.query(`SELECT users FROM settings LIMIT 1`);
    let perms = [];
    if (settingsRes.rowCount > 0 && settingsRes.rows[0].users) {
      perms = settingsRes.rows[0].users.roles?.[user.role] || [];
    }
    user.permissions = perms;
    return res.json({ user });
  }

  // Try STAFF table!
  const staffResult = await pool.query(
    `SELECT id, name, email, role FROM staff WHERE email = $1`,
    [email]
  );
  if (staffResult.rowCount > 0) {
    const staff = staffResult.rows[0];
    // Fetch permissions from settings.users JSONB
    const settingsRes = await pool.query(`SELECT users FROM settings LIMIT 1`);
    let perms = [];
    if (settingsRes.rowCount > 0 && settingsRes.rows[0].users) {
      perms = settingsRes.rows[0].users.roles?.[staff.role] || [];
    }
    staff.permissions = perms;
    return res.json({ staff });
  }

  // Not found
  return res.status(404).json({ error: "User or staff not found" });
});



module.exports = router;
