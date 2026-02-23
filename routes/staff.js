const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { sendEmail, sendPushNotification } = require('../utils/notifications');
const { emitReportsRefresh } = require("../utils/realtime");
const bcrypt = require("bcrypt");
const authMiddleware = require("../middleware/authMiddleware");
const jwt = require("jsonwebtoken");

// Helper function to log requests
const logRequest = (route, method, data) => {
  console.log(`➡️ ${method} request to ${route}`);
  console.log(`🔍 Received data: ${JSON.stringify(data, null, 2)}`);
};

const normalizeIpAddress = (value) => {
  if (!value) return "";
  let candidate = String(value).trim();
  if (!candidate) return "";

  if (candidate.includes(",")) {
    candidate = candidate.split(",")[0].trim();
  }

  if (candidate.startsWith("::ffff:")) {
    return candidate.replace("::ffff:", "");
  }

  return candidate;
};

const extractClientIp = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }

  return (
    req.headers["x-real-ip"] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    req.ip ||
    ""
  );
};

const loadUserSettings = async (restaurantId) => {
  const result = await pool.query(
    `SELECT users FROM settings WHERE restaurant_id = $1 AND key = 'global' LIMIT 1`,
    [restaurantId]
  );
  return result.rows[0]?.users || {};
};

const loadRolePermissions = async (restaurantId, role) => {
  const roleKey = String(role || "").toLowerCase();
  let permissions = [];

  try {
    const settingsRes = await pool.query(
      `SELECT value FROM settings WHERE restaurant_id = $1 AND key = 'users' LIMIT 1`,
      [restaurantId]
    );
    let config = settingsRes.rows[0]?.value || null;
    if (typeof config === "string") {
      try {
        config = JSON.parse(config);
      } catch {
        config = null;
      }
    }
    if (config?.roles?.[roleKey]) {
      permissions = config.roles[roleKey];
    }
  } catch {}

  if (!permissions || permissions.length === 0) {
    try {
      const globalRes = await pool.query(
        `SELECT users FROM settings WHERE restaurant_id = $1 AND key = 'global' LIMIT 1`,
        [restaurantId]
      );
      const globalUsers = globalRes.rows[0]?.users || {};
      if (globalUsers?.roles?.[roleKey]) {
        permissions = globalUsers.roles[roleKey];
      }
    } catch {}
  }

  return Array.isArray(permissions) ? permissions : [];
};

const parseGeoValue = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const haversineMeters = (lat1, lng1, lat2, lng2) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 6371000 * c;
};

// ========== PUBLIC ROUTES (No Authentication Required) ==========

// Login endpoint - must be public
router.post('/login', async (req, res) => {
  const { email, password, pin } = req.body;
  console.log('🔑 Login Debug');
  console.log('📥 Request body:', { email: email ? '***' : undefined, password: password ? '***' : undefined, pin: pin ? `${pin} (type: ${typeof pin})` : undefined });
  
  try {
    // 1️⃣ PIN-ONLY LOGIN (for staff)
    if (pin && !email) {
      console.log(`🔢 PIN-only login attempt with PIN: ${pin} (type: ${typeof pin})`);
      
      // 🔒 TENANT SAFETY: Require restaurant_id to prevent cross-tenant PIN access
      const { restaurant_id } = req.body;
      if (!restaurant_id) {
        console.warn(`❌ PIN login blocked: No restaurant_id provided`);
        return res.status(400).json({
          success: false,
          error: 'Restaurant ID required for PIN login',
        });
      }
      
      const restaurantId = Number(restaurant_id);
      if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
        console.warn(`❌ PIN login blocked: Invalid restaurant_id: ${restaurant_id}`);
        return res.status(400).json({
          success: false,
          error: 'Invalid restaurant ID',
        });
      }
      
      console.log(`🏢 PIN login for restaurant: ${restaurantId}`);
      
      // Check if PIN is required in user settings
      const userSettings = await loadUserSettings(restaurantId);
      const pinRequired = userSettings.pinRequired !== false; // Default to true
      
      if (!pinRequired) {
        console.log(`🔓 PIN requirement is disabled for restaurant ${restaurantId}`);
        return res.status(401).json({
          success: false,
          error: 'PIN login is disabled. Please use email and password.',
        });
      }
      
      const staffRes = await pool.query(
        `SELECT id, name, email, role, pin, restaurant_id, status
         FROM staff
         WHERE pin = $1 AND restaurant_id = $2 AND status = 'active'
         LIMIT 1`,
        [String(pin), restaurantId]
      );

      console.log(`📊 Staff query result: ${staffRes.rowCount} rows found`);
      if (staffRes.rowCount > 0) {
        console.log(`🔍 Found staff: ${staffRes.rows[0].name}, PIN in DB: ${staffRes.rows[0].pin} (type: ${typeof staffRes.rows[0].pin})`);
      }

      const staff = staffRes.rows[0];
      if (staff) {
        console.log(`✅ Staff PIN login success: ${staff.name} (${staff.role})`);

        // 🧩 Fetch permissions for staff role
        // Default permissions for common roles
        const defaultPermissions = {
          admin: ['all'],
          manager: ['all'],
          cashier: ['tables', 'orders', 'payments', 'kitchen', 'products'],
          driver: ['delivery', 'orders', 'tables'],
          kitchen: ['kitchen', 'orders'],
          waiter: ['tables', 'orders'],
        };

        let permissions = [];
        permissions = await loadRolePermissions(staff.restaurant_id, staff.role);
        if (permissions.length) {
          console.log(`📋 Permissions from settings for ${staff.role}:`, permissions);
        }

        // If no permissions found in settings, use defaults
        if (!permissions || permissions.length === 0) {
          permissions = defaultPermissions[staff.role?.toLowerCase()] || ['tables'];
          console.log(`⚙️ Using default permissions for ${staff.role}:`, permissions);
        }

        console.log(`✅ Final permissions for ${staff.name}:`, permissions);

        // 🧾 Sign JWT
        const token = jwt.sign(
          { id: staff.id, role: staff.role, restaurant_id: staff.restaurant_id },
          process.env.JWT_SECRET || "beypro_secret_2025",
          { expiresIn: "7d" }
        );

        return res.json({
          success: true,
          type: "staff",
          staff: {
            id: staff.id,
            name: staff.name,
            email: staff.email,
            role: staff.role,
            restaurant_id: staff.restaurant_id,
            permissions,
          },
          token,
        });
      }

      // Invalid PIN
      console.warn(`❌ Invalid PIN: ${pin} - No matching staff found`);
      return res.status(401).json({
        success: false,
        error: 'Invalid PIN',
      });
    }

    // 2️⃣ EMAIL + PASSWORD LOGIN (for admins/users)
    const normalizedEmail = String(email || '').trim().toLowerCase();
    console.log(`➡️ Incoming email: ${email}`);
    console.log(`➡️ Normalized email: ${normalizedEmail}`);
    
    console.log('🛠️ Querying users table…');
    const userRes = await pool.query(
      `SELECT id, full_name, email, role, password_hash, restaurant_id
       FROM users
       WHERE LOWER(TRIM(email)) = $1`,
      [normalizedEmail]
    );

    const user = userRes.rows[0];
    if (user && await bcrypt.compare(password || '', user.password_hash)) {
      console.log(`✅ Admin login success: ${user.full_name}`);

      // 🔐 Fetch permissions for admin role
      let permissions = [];
      permissions = await loadRolePermissions(user.restaurant_id, user.role);

      // 🧾 Sign JWT
      const token = jwt.sign(
        { id: user.id, role: user.role, restaurant_id: user.restaurant_id },
        process.env.JWT_SECRET || "beypro_secret_2025",
        { expiresIn: "7d" }
      );

      return res.json({
        success: true,
        type: "user",
        user: {
          id: user.id,
          name: user.full_name,
          email: user.email,
          role: user.role,
          restaurant_id: user.restaurant_id,
          permissions,
        },
        token,
      });
    }

    // 3️⃣ Try STAFF with EMAIL + PIN/PASSWORD (legacy support)
    console.log('🛠️ Querying staff table with email…');
    const staffRes = await pool.query(
      `SELECT id, name, email, role, pin, restaurant_id, status
       FROM staff
       WHERE LOWER(TRIM(email)) = $1 AND status = 'active'`,
      [normalizedEmail]
    );

    const staff = staffRes.rows[0];
    if (staff && (staff.pin === pin || staff.pin === password)) {
      console.log(`✅ Staff login success: ${staff.name} (${staff.role})`);

      // 🧩 Fetch permissions for staff role
      let permissions = [];
      permissions = await loadRolePermissions(staff.restaurant_id, staff.role);

      // 🧾 Sign JWT
      const token = jwt.sign(
        { id: staff.id, role: staff.role, restaurant_id: staff.restaurant_id },
        process.env.JWT_SECRET || "beypro_secret_2025",
        { expiresIn: "7d" }
      );

      return res.json({
        success: true,
        type: "staff",
        staff: {
          id: staff.id,
          name: staff.name,
          email: staff.email,
          role: staff.role,
          restaurant_id: staff.restaurant_id,
          permissions,
        },
        token,
      });
    }

    // 3️⃣ No match found
    console.warn('❌ Invalid credentials');
    return res.status(401).json({
      success: false,
      error: 'Invalid credentials',
    });
  } catch (err) {
    console.error('🔥 Login error:', err.stack || err);
    return res.status(500).json({
      success: false,
      error: 'Server error during login',
    });
  }
});

// ========== PROTECTED ROUTES (Authentication Required) ==========
// Apply authentication middleware to all routes below
router.use(authMiddleware);

// Add a new staff schedule
// ✅ Add or update a staff schedule (tenant-safe)
router.post('/schedule', async (req, res) => {
  const restaurantId = req.user.restaurant_id; // tenant scope
  const { staff_id, role, shift_start, shift_end, shift_date, salary, days } = req.body;

  logRequest('/api/staff/schedule', 'POST', req.body);

  try {
    // 🧩 Normalize 'days' into an array
    const daysArray = Array.isArray(days)
      ? days
      : (days || '').split(',').map(d => d.trim()).filter(Boolean);

    // 💾 Insert or update schedule by conflict (same staff & date)
    const result = await pool.query(
      `INSERT INTO staff_schedule (
         restaurant_id, staff_id, role, shift_start, shift_end, shift_date, salary, days
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[])
       ON CONFLICT (restaurant_id, staff_id, shift_date)
       DO UPDATE SET
         role = EXCLUDED.role,
         shift_start = EXCLUDED.shift_start,
         shift_end = EXCLUDED.shift_end,
         salary = EXCLUDED.salary,
         days = EXCLUDED.days
       RETURNING *`,
      [restaurantId, staff_id, role, shift_start, shift_end, shift_date, salary, daysArray]
    );

    res.json({
      status: 'success',
      message: 'Schedule added or updated successfully',
      schedule: result.rows[0],
    });
  } catch (err) {
    console.error('❌ Error saving schedule:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to save schedule',
    });
  }
});



// ✅ Fetch all active staff for the current tenant
router.get('/', async (req, res) => {
  const restaurantId = req.user.restaurant_id; // tenant scope from middleware
  console.log('📥 GET /staff called for restaurant_id:', restaurantId);
  
  try {
    const result = await pool.query(
      `SELECT id, name, role, phone, address, salary, email, created_at,
              payment_type, salary_model, hourly_rate, avatar
       FROM staff
       WHERE restaurant_id = $1 AND status = 'active'
       ORDER BY id`,
      [restaurantId]
    );
    console.log('✅ Staff fetched, count:', result.rows.length);
    console.log('📊 Staff data:', result.rows);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching staff:', err);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});






// Fetch all unique roles from the staff table
// ✅ Fetch all unique roles for the current tenant
router.get('/roles', async (req, res) => {
  const restaurantId = req.user.restaurant_id; // tenant scope
  logRequest('/api/staff/roles', 'GET', {});

  try {
    const result = await pool.query(
      `SELECT DISTINCT role
       FROM staff
       WHERE restaurant_id = $1
       ORDER BY role`,
      [restaurantId]
    );

    const roles = result.rows.map(row => row.role);
    console.log('✅ Fetched roles:', roles);

    res.json({ roles });
  } catch (err) {
    console.error('❌ Error fetching roles:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch roles' });
  }
});



// Staff Check-In/Check-Out Route
// ✅ Staff Check-In / Check-Out (tenant-safe)
router.post('/checkin', async (req, res) => {
  const restaurantId = req.user.restaurant_id; // tenant isolation
  const { staffId, deviceId, action } = req.body;

  logRequest('/api/staff/checkin', 'POST', req.body);

  try {
    // 🧩 Validate staff belongs to this tenant
    const staffCheck = await pool.query(
      `SELECT id FROM staff WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, staffId]
    );

    if (staffCheck.rowCount === 0) {
      console.warn(`❌ Staff ${staffId} not found for tenant ${restaurantId}`);
      return res.status(404).json({ status: 'error', message: 'Staff not found' });
    }

    // ✅ Require an active schedule for today (Istanbul time)
    const todayKey = new Date().toLocaleDateString("en-CA", {
      timeZone: "Europe/Istanbul",
    });
    const scheduleCheck = await pool.query(
      `SELECT 1 FROM staff_schedule
       WHERE restaurant_id = $1 AND staff_id = $2 AND shift_date = $3
       LIMIT 1`,
      [restaurantId, staffId, todayKey]
    );

    if (scheduleCheck.rowCount === 0) {
      return res.status(403).json({
        status: "error",
        message: "No schedule found for today. Check-in/out is not allowed.",
      });
    }

    const userSettings = await loadUserSettings(restaurantId);
    const rawWhitelist = Array.isArray(userSettings.allowedWifiIps)
      ? userSettings.allowedWifiIps
      : [];
    const normalizedWhitelist = rawWhitelist
      .map(normalizeIpAddress)
      .filter(Boolean);

    const hasWifiRestriction = normalizedWhitelist.length > 0;
    const clientIp = normalizeIpAddress(extractClientIp(req));
    const ipAllowed = !hasWifiRestriction || Boolean(clientIp && normalizedWhitelist.includes(clientIp));

    if (hasWifiRestriction && !clientIp) {
      console.warn(`🚫 Staff ${staffId} blocked: unable to determine IP for Wi-Fi restriction`);
      return res.status(403).json({
        status: 'error',
        error: 'Unable to determine your IP for the configured Wi-Fi restriction.',
      });
    }

    if (hasWifiRestriction && !ipAllowed) {
      console.warn(
        `🚫 Staff ${staffId} ${action} blocked: ${clientIp || 'unknown'} not in ${normalizedWhitelist.join(
          ", "
        )}`
      );
      return res.status(403).json({
        status: 'error',
        error: 'Staff check-in/out is restricted to the configured Wi-Fi IP address.',
      });
    }

    const wifiVerifiedFlag = hasWifiRestriction ? ipAllowed : true;

    const geoEnabled =
      userSettings?.staffCheckinGeoEnabled === true ||
      userSettings?.staff_checkin_geo_enabled === true;
    const radiusRaw =
      userSettings?.staffCheckinGeoRadiusMeters ??
      userSettings?.staff_checkin_geo_radius_meters ??
      150;
    const radiusMeters = Number.isFinite(Number(radiusRaw)) && Number(radiusRaw) > 0
      ? Number(radiusRaw)
      : 150;
    if (geoEnabled) {
      const lat =
        parseGeoValue(req.body?.geo_lat) ??
        parseGeoValue(req.body?.geoLat) ??
        parseGeoValue(req.body?.lat);
      const lng =
        parseGeoValue(req.body?.geo_lng) ??
        parseGeoValue(req.body?.geoLng) ??
        parseGeoValue(req.body?.lng);

      if (lat === null || lng === null) {
        return res.status(403).json({
          status: 'error',
          error: 'Location is required for staff check-in/out. Please enable location services.',
        });
      }

      const { rows: restaurantRows } = await pool.query(
        "SELECT pos_location_lat, pos_location_lng FROM restaurants WHERE id = $1 LIMIT 1",
        [restaurantId]
      );
      const restaurantLat = parseGeoValue(restaurantRows[0]?.pos_location_lat);
      const restaurantLng = parseGeoValue(restaurantRows[0]?.pos_location_lng);
      if (restaurantLat === null || restaurantLng === null) {
        return res.status(400).json({
          status: 'error',
          error: 'Restaurant location is not configured for staff check-in.',
        });
      }

      const distance = haversineMeters(lat, lng, restaurantLat, restaurantLng);
      if (distance > radiusMeters) {
        return res.status(403).json({
          status: 'error',
          error: `Staff check-in/out is only allowed within ${Math.round(radiusMeters)} meters of the restaurant.`,
        });
      }
    }

    // 🕓 Current Istanbul time
    const now = new Date().toLocaleString("en-US", { timeZone: "Europe/Istanbul" });
    const currentTime = new Date(now);
    console.log(`📅 Local time: ${currentTime}`);

    // ✅ CHECK-IN
    if (action === 'checkin') {
      // prevent duplicate active session
      const active = await pool.query(
        `SELECT id FROM attendance
         WHERE restaurant_id = $1 AND staff_id = $2 AND check_out_time IS NULL`,
        [restaurantId, staffId]
      );

      if (active.rowCount > 0) {
        return res.status(400).json({
          status: 'error',
          message: 'Already checked in — please check out first.',
        });
      }

      await pool.query(
        `INSERT INTO attendance (restaurant_id, staff_id, check_in_time, device_id, wifi_verified)
         VALUES ($1, $2, $3, $4, $5)`,
        [restaurantId, staffId, currentTime, deviceId, wifiVerifiedFlag]
      );

      console.log(`✅ Checked in staff ID ${staffId}`);
      return res.json({ status: 'success', message: 'Checked in successfully' });
    }

    // ✅ CHECK-OUT
    else if (action === 'checkout') {
      const sessionRes = await pool.query(
        `SELECT id, check_in_time
         FROM attendance
         WHERE restaurant_id = $1 AND staff_id = $2 AND check_out_time IS NULL
         ORDER BY check_in_time DESC
         LIMIT 1`,
        [restaurantId, staffId]
      );

      if (sessionRes.rowCount === 0) {
        return res.status(404).json({
          status: 'error',
          message: 'No active session found for checkout',
        });
      }

      const session = sessionRes.rows[0];
      const checkInTime = new Date(session.check_in_time);
      const checkOutTime = currentTime;
      const durationMinutes = Math.round((checkOutTime - checkInTime) / 60000);

      await pool.query(
        `UPDATE attendance
         SET check_out_time = $3, duration_minutes = $4
         WHERE restaurant_id = $1 AND id = $2`,
        [restaurantId, session.id, checkOutTime, durationMinutes]
      );

      console.log(`✅ Checked out staff ${staffId} (duration ${durationMinutes} mins)`);
      return res.json({
        status: 'success',
        message: 'Checked out successfully',
        durationMinutes,
      });
    }

    // 🚫 Invalid action
    else {
      return res.status(400).json({ status: 'error', message: 'Invalid action' });
    }
  } catch (err) {
    console.error('❌ Error during check-in/out:', err);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});


// Get Active Attendance History
// ✅ Fetch all active attendance records for the current tenant
router.get('/attendance', async (req, res) => {
  const restaurantId = req.user.restaurant_id; // tenant isolation
  logRequest('/api/staff/attendance', 'GET', { restaurantId });

  try {
    const result = await pool.query(
      `
      SELECT
        a.id,
        a.staff_id,
        s.name AS staff_name,
        s.role,
        a.check_in_time,
        a.check_out_time,
        a.duration_minutes,
        a.device_id,
        a.wifi_verified,
        a.status
      FROM attendance a
      JOIN staff s
        ON a.staff_id = s.id
       AND a.restaurant_id = s.restaurant_id
      WHERE a.restaurant_id = $1
        AND (a.status IS NULL OR a.status != 'archived')
      ORDER BY a.check_in_time DESC
      `,
      [restaurantId]
    );

    console.log(`✅ Attendance fetched: ${result.rowCount} records for tenant ${restaurantId}`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching attendance:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch attendance records',
    });
  }
});





// ✅ Update an existing staff member (tenant-safe, partial update)
router.put('/:id', async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { id } = req.params;
  const body = req.body;

  logRequest(`/api/staff/${id}`, 'PUT', body);

  const allowedFields = [
    "name", "role", "phone", "address", "salary", "email",
    "payment_type", "salary_model", "hourly_rate",
    "weekly_salary", "monthly_salary", "avatar", "pin"
  ];

  const fieldsToUpdate = Object.keys(body).filter(key => allowedFields.includes(key));
  if (fieldsToUpdate.length === 0) {
    return res.status(400).json({ status: 'error', message: 'No valid fields provided for update' });
  }

  const setClause = fieldsToUpdate.map((key, index) => `${key} = $${index + 3}`).join(', ');
  const values = [restaurantId, id, ...fieldsToUpdate.map(key => body[key])];

  try {
    const result = await pool.query(
      `UPDATE staff
       SET ${setClause}
       WHERE restaurant_id = $1 AND id = $2
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ status: 'error', message: 'Staff not found' });
    }

    console.log(`✅ Updated staff ID: ${id}`);
    res.json({
      status: 'success',
      message: 'Staff updated successfully',
      staff: result.rows[0]
    });
  } catch (err) {
    console.error('❌ Error updating staff:', err);
    res.status(500).json({ status: 'error', message: 'Error updating staff' });
  }
});

// Delete (soft delete) Staff
// ✅ Soft delete (archive) a staff member — tenant-safe
router.delete('/:id', async (req, res) => {
  const restaurantId = req.user.restaurant_id; // tenant scope
  const { id } = req.params;

  logRequest(`/api/staff/${id}`, 'DELETE', { id });

  try {
    const result = await pool.query(
      `UPDATE staff
       SET status = 'inactive'
       WHERE restaurant_id = $1 AND id = $2
       RETURNING *`,
      [restaurantId, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Staff not found or already inactive'
      });
    }

    console.log(`📂 Archived staff ID: ${id}`);
    res.json({
      status: 'success',
      message: 'Staff archived (inactive)',
      staff: result.rows[0]
    });
  } catch (err) {
    console.error('❌ Error archiving staff:', err);
    res.status(500).json({
      status: 'error',
      message: 'Error archiving staff'
    });
  }
});



const formatHours = (rawHours) => {
  const totalMinutes = Math.round(parseFloat(rawHours) * 60); // Convert hours to minutes
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
};


// Update an existing staff schedule
router.put('/schedule/:id', async (req, res) => {
  const restaurantId = req.user.restaurant_id; // tenant scope
  const { id } = req.params;
  const { shift_start, shift_end, status, days, salary, salary_model, hourly_rate } = req.body;
  logRequest(`/api/staff/schedule/${id}`, 'PUT', req.body);

  try {
    // 🧩 Normalize 'days' into an array if needed
    const daysArray = Array.isArray(days)
      ? days
      : (days || '').split(',').map(d => d.trim()).filter(Boolean);

    const result = await pool.query(
      `UPDATE staff_schedule
       SET shift_start = $1,
           shift_end = $2,
           status = $3,
           days = $4::text[],
           salary = $5,
           salary_model = $6,
           hourly_rate = $7
       WHERE restaurant_id = $8 AND id = $9
       RETURNING *`,
      [shift_start, shift_end, status, daysArray, salary, salary_model, hourly_rate, restaurantId, id]
    );

    if (result.rowCount === 0) {
      console.warn(`⚠️ No schedule found with ID: ${id}`);
      return res.status(404).json({ status: 'error', message: 'Schedule not found' });
    }

    console.log(`✅ Updated schedule ID: ${id}`);
    res.json({ status: 'success', message: 'Schedule updated', schedule: result.rows[0] });
  } catch (err) {
    console.error('❌ Error updating schedule:', err);
    res.status(500).json({ status: 'error', message: 'Error updating schedule' });
  }
});


// Archive non-active staff from the attendance list
// ✅ Archive a specific attendance record (tenant-safe)
router.put('/attendance/archive/:id', async (req, res) => {
  const restaurantId = req.user.restaurant_id; // tenant isolation
  const { id } = req.params;
  const { status } = req.body; // expected 'archived' or other valid states

  logRequest(`/api/staff/attendance/archive/${id}`, 'PUT', { status });

  try {
    const result = await pool.query(
      `
      UPDATE attendance
      SET status = $3
      WHERE restaurant_id = $1 AND id = $2
      RETURNING *
      `,
      [restaurantId, id, status || 'archived']
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Attendance record not found or already archived',
      });
    }

    console.log(`📦 Archived attendance ID ${id} for tenant ${restaurantId}`);
    res.json({
      status: 'success',
      message: 'Attendance archived successfully',
      record: result.rows[0],
    });
  } catch (err) {
    console.error('❌ Error archiving attendance:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to archive attendance',
    });
  }
});


// Add a new staff member
// ✅ Add a new staff member (tenant-safe)
router.post('/', async (req, res) => {
  const restaurantId = req.user.restaurant_id; // tenant isolation
  const {
    name,
    role,
    phone,
    address,
    salary,
    email,
    salary_model,
    hourly_rate,
    weekly_salary,
    monthly_salary,
    payment_type,
    pin,
    avatar
  } = req.body;

  logRequest('/api/staff', 'POST', req.body);

  // 🔎 Validate required fields
  if (
    !name || !role || !phone || !address || !salary ||
    !email || !payment_type || !salary_model || !pin
  ) {
    return res.status(400).json({
      status: 'error',
      message: 'All fields (including PIN) are required'
    });
  }

  try {
    // 💾 Insert new staff (ID auto-generated by database)
    const result = await pool.query(
      `INSERT INTO staff (
        restaurant_id, name, role, phone, address, salary,
        email, payment_type, salary_model,
        hourly_rate, weekly_salary, monthly_salary, pin, avatar, status
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12, $13, $14, 'active'
      )
      RETURNING *`,
      [
        restaurantId,
        name,
        role,
        phone,
        address,
        salary,
        email,
        payment_type,
        salary_model,
        salary_model === 'hourly' ? hourly_rate : null,
        salary_model === 'fixed' && payment_type === 'weekly' ? weekly_salary : null,
        salary_model === 'fixed' && payment_type === 'monthly' ? monthly_salary : null,
        pin,
        avatar || null
      ]
    );

    console.log('✅ Staff added:', result.rows[0]);
    res.json({
      status: 'success',
      message: 'Staff added successfully',
      staff: result.rows[0]
    });
  } catch (err) {
    console.error('❌ Server error while adding staff:', err);
    res.status(500).json({
      status: 'error',
      message: 'Server error: ' + err.message
    });
  }
});




// Fetch all staff schedules
// ✅ Fetch all staff schedules for the current tenant
router.get('/schedule', async (req, res) => {
  const restaurantId = req.user.restaurant_id; // tenant scope
  logRequest('/api/staff/schedule', 'GET', {});

  try {
    const result = await pool.query(
      `SELECT
         ss.id,
         ss.staff_id,
         s.name AS staff_name,
         ss.role,
         TO_CHAR(ss.shift_start, 'HH24:MI') AS shift_start,
         TO_CHAR(ss.shift_end, 'HH24:MI') AS shift_end,
         ss.status,
         ss.shift_date,
         ss.salary,
         ss.days
       FROM staff_schedule ss
       JOIN staff s
         ON ss.staff_id = s.id
        AND ss.restaurant_id = s.restaurant_id
       WHERE ss.restaurant_id = $1
       ORDER BY ss.id`,
      [restaurantId]
    );

    // 🔧 Ensure days always returned as array
    const schedules = result.rows.map(row => ({
      ...row,
      days: Array.isArray(row.days)
        ? row.days
        : (row.days ? row.days.split(',').map(d => d.trim()) : []),
    }));

    console.log('✅ Fetched staff schedules:', schedules.length);
    res.json(schedules);
  } catch (err) {
    console.error('❌ Error fetching staff schedules:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch staff schedules' });
  }
});



// Get a single staff schedule by ID
router.get('/schedule/:id', async (req, res) => {
  const { id } = req.params;
  logRequest(`/api/staff/schedule/${id}`, 'GET', {});
  try {
    const result = await pool.query(`
      SELECT
        ss.id, s.id AS staff_id, s.name AS staff_name,
        ss.role, ss.shift_start, ss.shift_end, ss.status, ss.days, ss.salary,
        s.salary_model, s.hourly_rate
      FROM staff_schedule ss
      JOIN staff s ON ss.staff_id = s.id
      WHERE ss.id = $1;
    `, [id]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Error fetching staff schedule:', err);
    res.status(500).json({ message: 'Failed to fetch staff schedule' });
  }
});

// Delete a staff schedule
// ✅ Delete a specific staff schedule (tenant-safe)
router.delete('/schedule/:id', async (req, res) => {
  const restaurantId = req.user.restaurant_id; // tenant scope
  const { id } = req.params;

  logRequest(`/api/staff/schedule/${id}`, 'DELETE', { id });

  try {
    const result = await pool.query(
      `DELETE FROM staff_schedule
       WHERE restaurant_id = $1 AND id = $2
       RETURNING *`,
      [restaurantId, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Schedule not found or already deleted',
      });
    }

    console.log(`🗑️ Deleted schedule ID: ${id}`);
    res.json({
      status: 'success',
      message: 'Schedule deleted successfully',
      schedule: result.rows[0],
    });
  } catch (err) {
    console.error('❌ Error deleting schedule:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to delete schedule',
    });
  }
});


// Delete all schedules for a staff
router.delete('/:staffId/schedule', async (req, res) => {
  const { staffId } = req.params;
  try {
    await pool.query('DELETE FROM staff_schedule WHERE staff_id = $1', [staffId]);
    console.log(`🗑️ Deleted all schedules for staff ID: ${staffId}`);
    res.json({ status: 'success', message: 'All schedules deleted for this staff' });
  } catch (err) {
    console.error('❌ Error deleting all schedules:', err);
    res.status(500).json({ status: 'error', message: 'Failed to delete all schedules' });
  }
});


/* =====================================================================
   NEW ENDPOINT: Send Shift Details
   This endpoint receives the full shift details sent from the React app
   and processes them (e.g., logs them, stores them in a dedicated table,
   sends notifications, etc.).
========================================================================= */

// Format time correctly before saving or processing
const formatTimeForDB = (time) => {
  if (time.includes('T')) {
    return new Date(time).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  return time;
};


// Helper function to calculate minutes difference between two times
const calculateMinutesDifference = (start, end) => {
  const [startHours, startMinutes] = start.split(':').map(Number);
  const [endHours, endMinutes] = end.split(':').map(Number);
  return (endHours * 60 + endMinutes) - (startHours * 60 + startMinutes);
};

// Updated function to create the email template
const createEmailTemplate = (period, schedules) => {
  // Define an array to enforce day order
  const dayOrder = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // Map to store scheduled hours for each day
  const scheduleMap = new Map(dayOrder.map((day) => [day, 'Free']));
  let totalMinutes = 0;

  // Populate scheduleMap and calculate total hours
  schedules.forEach((schedule) => {
    const [day, times] = schedule.split(': ');
    const shiftTimes = times.split(', ');

    shiftTimes.forEach((time) => {
      // Remove seconds and format time correctly
      const formattedTime = time.replace(/:\d{2}(?=\s|$)/g, '');
      const [start, end] = formattedTime.split(' - ');

      // Calculate shift duration in minutes
      const shiftMinutes = calculateMinutesDifference(start, end);
      totalMinutes += shiftMinutes;

      // Append time to the existing day in the map
      const existingTime = scheduleMap.get(day);
      if (existingTime === 'Free') {
        scheduleMap.set(day, formattedTime);
      } else {
        scheduleMap.set(day, `${existingTime}, ${formattedTime}`);
      }
    });
  });

  // Calculate total hours and minutes from the total minutes
  const totalHours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  const formattedTotal = `${totalHours}h ${remainingMinutes}m`;

  // Generate table rows for each day in order
  const scheduleRows = dayOrder
    .map((day) => {
      const time = scheduleMap.get(day);
      return `
        <tr>
          <td style="padding: 12px; border: 1px solid #ddd; font-weight: bold; font-size: 18px;">${day}</td>
          <td style="padding: 12px; border: 1px solid #ddd; font-size: 18px;">${time}</td>
        </tr>
      `;
    })
    .join('');

  // Construct the HTML template
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <style>
      body {
        font-family: Arial, sans-serif;
        background-color: #f4f4f4;
        margin: 0;
        padding: 0;
      }
      .container {
        width: 100%;
        max-width: 600px;
        margin: 20px auto;
        background-color: #fff;
        border-radius: 8px;
        box-shadow: 0 4px 8px rgba(0,0,0,0.1);
        overflow: hidden;
      }
      .header {
        background-color: #007bff;
        color: #fff;
        padding: 25px;
        text-align: center;
        font-size: 24px;
      }
      .content {
        padding: 25px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        padding: 12px;
        text-align: left;
        font-size: 18px;
      }
      th {
        background-color: #007bff;
        color: white;
        font-size: 20px;
      }
      .footer {
        background-color: #007bff;
        color: #fff;
        text-align: center;
        padding: 20px;
        margin-top: 20px;
        font-size: 18px;
      }
      p {
        font-size: 18px;
      }
      .total-hours {
        margin-top: 20px;
        font-weight: bold;
        color: #007bff;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h2>HurryPOS - ${period.charAt(0).toUpperCase() + period.slice(1)} Shift Schedule</h2>
      </div>
      <div class="content">
        <p>Hello,</p>
        <p>Here is your ${period} shift schedule:</p>
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            ${scheduleRows}
            <tr>
              <td colspan="2" class="total-hours">Total Hours: ${formattedTotal}</td>
            </tr>
          </tbody>
        </table>
        <p style="margin-top: 20px;">Please make sure to be on time.</p>
      </div>
      <div class="footer">
        <p>Best Regards,<br>HurryPOS Team</p>
      </div>
    </div>
  </body>
  </html>
  `;
};


// ✅ Send shift schedules to selected staff (tenant-safe)
router.post('/send-schedule', async (req, res) => {
  const restaurantId = req.user.restaurant_id; // tenant scope
  const { period, recipients } = req.body;

  logRequest('/api/staff/send-schedule', 'POST', req.body);

  try {
    // 🧩 Validate input
    if (!recipients || recipients.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'No recipients provided',
      });
    }

    // 📦 Fetch all shifts for the provided staff IDs (within same tenant)
    const shiftDetails = await pool.query(
      `SELECT
         s.email,
         ss.role,
         ss.days,
         ss.shift_start,
         ss.shift_end
       FROM staff_schedule ss
       JOIN staff s
         ON ss.staff_id = s.id
        AND ss.restaurant_id = s.restaurant_id
       WHERE ss.restaurant_id = $1
         AND s.id = ANY($2::int[])
       ORDER BY s.id, ss.days, ss.shift_start`,
      [restaurantId, recipients]
    );

    if (shiftDetails.rowCount === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'No shift details found for selected recipients',
      });
    }

    // 🧠 Group shifts by email, then by day
    const emailMap = new Map();
    shiftDetails.rows.forEach(({ email, days, shift_start, shift_end }) => {
      if (!emailMap.has(email)) emailMap.set(email, {});
      if (!emailMap.get(email)[days]) emailMap.get(email)[days] = [];
      emailMap.get(email)[days].push(`${shift_start} - ${shift_end}`);
    });

    // 📨 Send email to each staff
    for (const [email, daySchedules] of emailMap) {
      const schedules = Object.keys(daySchedules).map(
        (day) => `${day}: ${daySchedules[day].join(', ')}`
      );

      const emailBody = createEmailTemplate(period, schedules);
      const subject = `Your ${period} shift schedule`;

      await sendEmail(email, subject, emailBody, true);
      console.log(`📧 Email sent to: ${email}`);
    }

    res.json({
      status: 'success',
      message: 'Shift schedules sent successfully',
    });
  } catch (err) {
    console.error('❌ Error sending shift schedule:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to send shift schedule',
    });
  }
});




// ----------------- SCHEDULE -----------------
router.get('/:staffId/schedule', async (req, res) => {
  const { staffId } = req.params;
  const { start, end } = req.query;

  try {
    let query = `SELECT * FROM staff_schedule WHERE staff_id = $1`;
    const params = [staffId];

    if (start && end) {
      query += ` AND shift_date BETWEEN $2 AND $3`;
      params.push(start, end);
    }

    query += ` ORDER BY shift_date`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Schedule fetch error:', err);
    res.status(500).json({ status: 'error', message: 'Schedule fetch failed' });
  }
});


// ----------------- ATTENDANCE -----------------
router.get('/:staffId/attendance', async (req, res) => {
  const { staffId } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT *,
        (check_in_time AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Istanbul') AS local_check_in_time,
        (check_out_time AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Istanbul') AS local_check_out_time,
        (check_in_time AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Istanbul')::date AS local_date
      FROM attendance
      WHERE staff_id = $1
      ORDER BY check_in_time DESC
      `,
      [staffId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Attendance fetch error:', err);
    res.status(500).json({ status: 'error', message: 'Attendance fetch failed' });
  }
});




// ----------------- PAYROLL (Current Week) -----------------
router.get('/:staffId/payroll', async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { staffId } = req.params;
  let { startDate, endDate } = req.query;

  try {
    const normalizeDate = (value) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return null;
      return date.toISOString().split('T')[0];
    };

    if (!startDate || !endDate) {
      const now = new Date();
      const day = now.getDay();
      const diffToMonday = day === 0 ? -6 : 1 - day;
      const monday = new Date(now);
      monday.setHours(0, 0, 0, 0);
      monday.setDate(now.getDate() + diffToMonday);

      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      sunday.setHours(23, 59, 59, 999);

      startDate = monday.toISOString().split('T')[0];
      endDate = sunday.toISOString().split('T')[0];
    } else {
      startDate = normalizeDate(startDate);
      endDate = normalizeDate(endDate);
    }

    const staffRes = await pool.query(
      `SELECT salary, hourly_rate, salary_model, payment_type, weekly_salary, monthly_salary
       FROM staff
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, staffId]
    );
    if (staffRes.rowCount === 0) return res.status(404).json({ error: "Staff not found" });
    const staff = staffRes.rows[0];

    const [scheduleResult, attendanceResult, paymentsResult] = await Promise.all([
      pool.query(
        `SELECT shift_start, shift_end, shift_date
         FROM staff_schedule
         WHERE restaurant_id = $1 AND staff_id = $2
           AND shift_date BETWEEN $3 AND $4
         ORDER BY shift_date ASC`,
        [restaurantId, staffId, startDate, endDate]
      ),
      pool.query(
        `SELECT check_in_time, check_out_time, duration_minutes
         FROM attendance
         WHERE restaurant_id = $1 AND staff_id = $2
           AND check_in_time::date BETWEEN $3 AND $4`,
        [restaurantId, staffId, startDate, endDate]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount),0)::numeric AS total_paid
         FROM staff_payments
         WHERE restaurant_id=$1 AND staff_id=$2`,
        [restaurantId, staffId]
      )
    ]);

    const scheduleRows = scheduleResult.rows;
    const attendanceRows = attendanceResult.rows;
    const totalPaid = Number(paymentsResult.rows[0].total_paid || 0);

    const toDateKey = (value) => {
      if (!value) return null;
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString().split('T')[0];
    };

    const shiftMinutes = (dateKey, startStr, endStr) => {
      if (!dateKey || !startStr || !endStr) return 0;
      const start = new Date(`${dateKey}T${startStr}`);
      const end = new Date(`${dateKey}T${endStr}`);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
      let diff = Math.round((end - start) / 60000);
      if (diff <= 0) diff += 1440;
      return Math.max(diff, 0);
    };

    const scheduleByDate = {};
    let totalScheduledMinutes = 0;
    scheduleRows.forEach((shift) => {
      const dateKey = toDateKey(shift.shift_date);
      if (!dateKey) return;
      const minutes = shiftMinutes(
        dateKey,
        String(shift.shift_start || "").slice(0, 8),
        String(shift.shift_end || "").slice(0, 8)
      );
      totalScheduledMinutes += minutes;
      if (!scheduleByDate[dateKey]) {
        scheduleByDate[dateKey] = { shifts: [], minutes: 0 };
      }
      scheduleByDate[dateKey].shifts.push(shift);
      scheduleByDate[dateKey].minutes += minutes;
    });

    const baseEntry = (dateKey) => {
      const dateObj = new Date(dateKey);
      return {
        day: Number.isNaN(dateObj.getTime())
          ? dateKey
          : dateObj.toLocaleDateString('en-US', { weekday: 'long' }),
        date: dateKey,
        schedule: null,
        sessions: [],
        totalMinutes: 0,
        latency: [],
        earlyCheckout: [],
      };
    };

    const weeklyCheckMap = {};
    let totalActualMinutes = 0;
    let lateCheckinMinutes = 0;
    let totalEarlyCheckoutMinutes = 0;

    attendanceRows.forEach((row) => {
      const dateKey = toDateKey(row.check_in_time);
      if (!dateKey) return;
      if (!weeklyCheckMap[dateKey]) {
        weeklyCheckMap[dateKey] = baseEntry(dateKey);
      }
      const entry = weeklyCheckMap[dateKey];
      entry.sessions.push(row);

      let duration = Number(row.duration_minutes);
      if (!Number.isFinite(duration) && row.check_in_time && row.check_out_time) {
        const start = new Date(row.check_in_time);
        const end = new Date(row.check_out_time);
        if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
          duration = Math.max(Math.round((end - start) / 60000), 0);
        }
      }
      if (Number.isFinite(duration)) {
        entry.totalMinutes += duration;
        totalActualMinutes += duration;
      }

      const scheduleForDay = scheduleByDate[dateKey];
      if (scheduleForDay && scheduleForDay.shifts.length > 0) {
        const shift = scheduleForDay.shifts[0];
        const startStr = String(shift.shift_start || '').slice(0, 8) || '00:00:00';
        const endStr = String(shift.shift_end || '').slice(0, 8) || '00:00:00';
        const scheduledStart = new Date(`${dateKey}T${startStr}`);
        const scheduledEnd = new Date(`${dateKey}T${endStr}`);
        const actualStart = new Date(row.check_in_time);
        const actualEnd = row.check_out_time ? new Date(row.check_out_time) : null;

        if (!Number.isNaN(scheduledStart.getTime()) && !Number.isNaN(actualStart.getTime())) {
          const diff = Math.floor((actualStart - scheduledStart) / 60000);
          if (diff > 0) {
            lateCheckinMinutes += diff;
            entry.latency.push(`${Math.floor(diff / 60)}h ${diff % 60}min late`);
          } else if (diff < 0) {
            const early = Math.abs(diff);
            entry.latency.push(`${Math.floor(early / 60)}h ${early % 60}min early`);
          } else {
            entry.latency.push('On time');
          }
        } else {
          entry.latency.push('No schedule');
        }

        if (
          actualEnd &&
          !Number.isNaN(scheduledEnd.getTime()) &&
          !Number.isNaN(actualEnd.getTime())
        ) {
          const earlyMinutes = Math.floor((scheduledEnd - actualEnd) / 60000);
          if (earlyMinutes > 0) {
            totalEarlyCheckoutMinutes += earlyMinutes;
            entry.earlyCheckout.push(`${earlyMinutes} min early leave`);
          } else {
            entry.earlyCheckout.push(null);
          }
        } else {
          entry.earlyCheckout.push(null);
        }
      } else {
        entry.latency.push('No schedule');
        entry.earlyCheckout.push(null);
      }
    });

    const todayKey = new Date().toISOString().split('T')[0];
    let absentMinutes = 0;
    Object.entries(scheduleByDate).forEach(([dateKey, data]) => {
      if (!weeklyCheckMap[dateKey]) {
        weeklyCheckMap[dateKey] = baseEntry(dateKey);
      }
      const entry = weeklyCheckMap[dateKey];
      const scheduleLabel = data.shifts
        .map((shift) => {
          const start = String(shift.shift_start || '').slice(0, 5);
          const end = String(shift.shift_end || '').slice(0, 5);
          if (!start || !end) return null;
          return `${start}-${end}`;
        })
        .filter(Boolean)
        .join(', ');
      entry.schedule = scheduleLabel || entry.schedule || 'No schedule';
      if (entry.sessions.length === 0) {
        if (dateKey <= todayKey) {
          entry.latency = ['Absent'];
          absentMinutes += data.minutes;
        } else {
          entry.latency = ['Scheduled'];
        }
      }
      if (entry.earlyCheckout.length === 0) {
        entry.earlyCheckout.push(null);
      }
    });

    const getDateRange = (startStr, endStr) => {
      const result = [];
      const start = new Date(startStr);
      const end = new Date(endStr);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return result;
      let cursor = new Date(start);
      while (cursor <= end) {
        result.push(new Date(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
      return result;
    };

    const formatDuration = (minutes) => {
      const safeMinutes = Math.max(Math.round(Number(minutes) || 0), 0);
      const hours = Math.floor(safeMinutes / 60);
      const mins = safeMinutes % 60;
      return `${hours}h ${mins}min`;
    };

    const weeklyCheck = getDateRange(startDate, endDate).map((dateObj) => {
      const dateKey = dateObj.toISOString().split('T')[0];
      const entry = weeklyCheckMap[dateKey];
      if (!entry) {
        return {
          day: dateObj.toLocaleDateString('en-US', { weekday: 'long' }),
          date: dateKey,
          totalTime: '0h 0min',
          schedule: 'No schedule',
          sessions: [],
          latency: ['No schedule'],
          earlyCheckout: [null],
        };
      }
      return {
        day: entry.day,
        date: entry.date,
        totalTime: formatDuration(entry.totalMinutes),
        schedule: entry.schedule || 'No schedule',
        sessions: entry.sessions,
        latency: entry.latency.length > 0 ? entry.latency : ['No schedule'],
        earlyCheckout: entry.earlyCheckout.length > 0 ? entry.earlyCheckout : [null],
      };
    });

    const weeklyHours = totalScheduledMinutes / 60;
    const totalHours = totalActualMinutes / 60;
    const timeDifferenceMinutes = Math.round(totalActualMinutes - totalScheduledMinutes);
    const formatDifference = (value) => {
      if (!value) return '0h 0min';
      const abs = Math.abs(value);
      const hours = Math.floor(abs / 60);
      const mins = abs % 60;
      const prefix = value > 0 ? '+' : '-';
      return `${prefix}${hours}h ${mins}min`;
    };

	    // ✅ Determine salary based on model
	    let totalSalaryDue = 0;
	    if (staff.salary_model === "hourly") {
	      totalSalaryDue = (Number(staff.hourly_rate) || 0) * totalHours;
	    } else if (staff.payment_type === "daily") {
	      // 8 hours per day baseline
	      totalSalaryDue = (Number(staff.salary) || 0) * (totalHours / 8);
	    } else if (staff.payment_type === "weekly") {
	      totalSalaryDue = Number(staff.weekly_salary || staff.salary || 0) || 0;
	    } else if (staff.payment_type === "monthly") {
	      totalSalaryDue = Number(staff.monthly_salary || staff.salary || 0) || 0;
	    }

    const salaryDifference = Number(totalSalaryDue) - totalPaid;
    const salaryDue = salaryDifference > 0 ? salaryDifference : 0;
    const latencySummary = {
      checkinLateMinutes: lateCheckinMinutes,
      absentMinutes,
      earlyCheckout: totalEarlyCheckoutMinutes,
      totalMinutes: lateCheckinMinutes + absentMinutes + totalEarlyCheckoutMinutes,
    };

    res.json({
      payroll: {
        totalHours: totalHours.toFixed(2),
        totalMinutes: totalActualMinutes,
	        totalMinutesThisWeek: totalActualMinutes,
	        salaryPaid: totalPaid,
	        totalSalaryDue: Number((Number(totalSalaryDue) || 0).toFixed(2)),
	        salaryDue: Number(salaryDue.toFixed(2)),
	        attendanceCount: attendanceRows.length,
	        weeklyHours: Number(weeklyHours.toFixed(2)),
        earlyCheckoutMinutes: totalEarlyCheckoutMinutes,
        timeDifferenceMinutes,
        timeDifferenceFormatted: formatDifference(timeDifferenceMinutes),
        overtimePendingApproval: timeDifferenceMinutes > 0,
        weeklyCheck,
        latency: latencySummary,
      },
    });
  } catch (err) {
    console.error("❌ Payroll error:", err);
    res.status(500).json({ error: "Failed to fetch payroll" });
  }
});


// ----------------- PAYMENTS -----------------
// staff.js
router.get('/:staffId/payments', async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { staffId } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT
        payment_date,
        amount,
        note,
        payment_method,
        auto,
        scheduled_date,
        repeat_type,
        repeat_time
      FROM staff_payments
      WHERE restaurant_id = $1
        AND staff_id = $2
      ORDER BY COALESCE(payment_date, scheduled_date) DESC, created_at DESC
      `,
      [restaurantId, staffId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Payment history error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch payment history' });
  }
});


// ✅ Weekly payment summary for a specific staff (tenant-safe)
router.get('/:staffId/payments/weekly', async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { staffId } = req.params;
  let { start, end } = req.query;

  start = start || '2000-01-01';
  end = end || new Date().toISOString().split('T')[0];

  try {
    const result = await pool.query(
      `
      SELECT
        DATE_TRUNC('week', payment_date) AS week_start,
        SUM(amount)::numeric AS total_paid
      FROM staff_payments
      WHERE restaurant_id = $1
        AND staff_id = $2
        AND payment_date BETWEEN $3 AND $4
      GROUP BY week_start
      ORDER BY week_start DESC
      `,
      [restaurantId, staffId, start, end]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Weekly payment summary error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch weekly summary' });
  }
});

// ✅ Add a new payment (tenant-safe)
router.post('/:staffId/payments', async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { staffId } = req.params;
  let {
    amount,
    date,
    note = "",
    payment_method = "cash",
    auto = false,
    scheduled_date,
    repeat_type = "none",
    repeat_time,
  } = req.body;

  console.log("📥 Payment request payload:", req.body);

  try {
    // 🚫 Step 1: Check for active auto schedule (tenant-safe)
    const autoCheck = await pool.query(
      `SELECT active, repeat_type, repeat_time
       FROM scheduled_staff_payroll
       WHERE restaurant_id = $1 AND staff_id = $2 AND active = true
       LIMIT 1`,
      [restaurantId, staffId]
    );

    if (autoCheck.rowCount > 0 && !auto) {
      // ⚠️ There is already an active auto payroll for this staff
      console.warn(`⚠️ Manual payment blocked — active auto schedule for staff ${staffId}`);
      return res.status(409).json({
        status: "error",
        message: "Manual payment blocked: Auto payroll schedule already active for this staff.",
      });
    }

    // ✅ Step 2: Normalize fields
    if (!auto || repeat_type === "none") {
      repeat_type = null;
      repeat_time = null;
    }

    amount = parseFloat(amount);
    if (amount === undefined || isNaN(amount)) {
      return res.status(400).json({ status: "error", message: "Invalid or missing amount" });
    }
    if (!auto && amount === 0) {
      return res.status(400).json({ status: "error", message: "Invalid or missing amount" });
    }

    if (auto) {
      if (!scheduled_date) {
        return res.status(400).json({ status: "error", message: "scheduled_date is required for auto payments" });
      }
      if (!repeat_type || repeat_type === "none" || !repeat_time) {
        return res.status(400).json({ status: "error", message: "repeat_type and repeat_time are required for auto payments" });
      }
    }

    // ✅ Step 3: Insert payment
    await pool.query(
      `
      INSERT INTO staff_payments (
        restaurant_id, staff_id, amount, note, payment_method, auto,
        scheduled_date, payment_date, repeat_type, repeat_time
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7,
              $8, $9, $10)
      `,
      [
        restaurantId,
        staffId,
        amount,
        note,
        payment_method,
        auto,
        scheduled_date || null,
        auto ? scheduled_date || null : date || new Date().toISOString().slice(0, 10),
        repeat_type,
        repeat_time,
      ]
    );

    console.log(`✅ Payment saved for staff ${staffId}: ${amount} (${payment_method})`);
    try {
      emitReportsRefresh(req.app.get("io"), restaurantId, {
        source: "staff_payment",
        staffId,
        amount,
        payment_method,
      });
    } catch (_) {}

    // 🔁 Step 4: Create or update auto payroll if applicable
    if (auto && repeat_type && repeat_time) {
      await pool.query(
        `
        INSERT INTO scheduled_staff_payroll (restaurant_id, staff_id, repeat_type, repeat_time, active)
        VALUES ($1, $2, $3, $4, true)
        ON CONFLICT (restaurant_id, staff_id) DO UPDATE
        SET repeat_type = EXCLUDED.repeat_type,
            repeat_time = EXCLUDED.repeat_time,
            active = true
        `,
        [restaurantId, staffId, repeat_type, repeat_time]
      );

      console.log(`📅 Auto payroll scheduled for staff ${staffId} (${repeat_type} @ ${repeat_time})`);
    }

    // 📧 Step 5: Send email only if manual and no auto
    const staffRes = await pool.query(
      `SELECT name, email, role FROM staff WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, staffId]
    );

    if (staffRes.rowCount > 0) {
      const { name, email, role } = staffRes.rows[0];

      if (email && !auto) {
        const subject = `📄 Payroll Receipt - ${name}`;
        const html = `
          <h2>💼 Payroll Receipt</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Role:</strong> ${role}</p>
          <p><strong>Amount Paid:</strong> ${amount.toFixed(2)}</p>
          <p><strong>Method:</strong> ${payment_method}</p>
          <p><strong>Date:</strong> ${date || new Date().toISOString().slice(0, 10)}</p>
          ${note ? `<p><strong>Note:</strong> ${note}</p>` : ""}
          <p style="margin-top:2em;">Thank you for your dedication!<br><strong>Beypro</strong></p>
        `;
        await sendEmail(email, subject, html, true);
        console.log(`📧 Payroll email sent to ${email}`);
      } else if (auto) {
        console.log(`ℹ️ Auto payment for staff ${staffId} — email skipped intentionally`);
      }
    }

    res.json({ status: "success", message: "Payment saved successfully" });
  } catch (err) {
    console.error("❌ Payment insert error:", err.stack || err);
    res.status(500).json({ status: "error", message: "Failed to save payment" });
  }
});
// ✅ Disable or toggle auto payroll (tenant-safe)
router.put('/:staffId/payments/auto/toggle', async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { staffId } = req.params;
  const { active } = req.body; // expected true/false

  try {
    const result = await pool.query(
      `
      UPDATE scheduled_staff_payroll
      SET active = $3, updated_at = NOW()
      WHERE restaurant_id = $1 AND staff_id = $2
      RETURNING *
      `,
      [restaurantId, staffId, active]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        status: "error",
        message: "No active auto payroll found for this staff",
      });
    }

    console.log(
      `⚙️ Auto payroll for staff ${staffId} toggled → ${active ? "active" : "inactive"}`
    );
    res.json({
      status: "success",
      message: `Auto payroll ${active ? "activated" : "disabled"} successfully`,
      schedule: result.rows[0],
    });
  } catch (err) {
    console.error("❌ Toggle auto payroll error:", err);
    res
      .status(500)
      .json({ status: "error", message: "Failed to toggle auto payroll" });
  }
});

router.delete('/:staffId/payments', async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { staffId } = req.params;
  const { startDate, endDate } = req.body || {};

  const staffIdNumber = Number(staffId);
  if (!Number.isInteger(staffIdNumber)) {
    return res
      .status(400)
      .json({ status: 'error', message: 'Invalid staff identifier' });
  }
  if (
    startDate &&
    endDate &&
    new Date(startDate).getTime() > new Date(endDate).getTime()
  ) {
    return res
      .status(400)
      .json({ status: 'error', message: 'Start date must precede end date' });
  }

  try {
    const clauses = ['restaurant_id = $1', 'staff_id = $2'];
    const params = [restaurantId, staffIdNumber];
    let index = 3;
    const rangeExpr = 'COALESCE(payment_date, scheduled_date, created_at)::date';

    if (startDate) {
      clauses.push(`${rangeExpr} >= $${index}`);
      params.push(startDate);
      index += 1;
    }
    if (endDate) {
      clauses.push(`${rangeExpr} <= $${index}`);
      params.push(endDate);
      index += 1;
    }

    const result = await pool.query(
      `
      DELETE FROM staff_payments
      WHERE ${clauses.join(' AND ')}
      RETURNING id
      `,
      params
    );

    res.json({
      status: 'success',
      deleted: result.rowCount,
    });
  } catch (err) {
    console.error('❌ Clear payment history error:', err);
    res
      .status(500)
      .json({ status: 'error', message: 'Failed to clear payment history' });
  }
});




// ✅ Fetch auto payment schedule (tenant-safe)
router.get('/:staffId/payments/auto', async (req, res) => {
  const restaurantId = req.user.restaurant_id;
  const { staffId } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT
        ssp.repeat_type,
        ssp.repeat_time,
        ssp.active,
        ssp.created_at,
        ssp.updated_at,
        latest.amount,
        latest.payment_date,
        latest.scheduled_date,
        latest.payment_method,
        latest.note
      FROM scheduled_staff_payroll ssp
      LEFT JOIN LATERAL (
        SELECT
          amount,
          payment_date,
          scheduled_date,
          payment_method,
          note
        FROM staff_payments
        WHERE restaurant_id = $1
          AND staff_id = $2
          AND auto = true
        ORDER BY COALESCE(payment_date, scheduled_date) DESC NULLS LAST
        LIMIT 1
      ) AS latest ON TRUE
      WHERE ssp.restaurant_id = $1 AND ssp.staff_id = $2
      `,
      [restaurantId, staffId]
    );

    if (result.rowCount > 0) {
      const row = result.rows[0];
      return res.json({
        repeat_type: row.repeat_type,
        repeat_time: row.repeat_time,
        active: row.active,
        created_at: row.created_at,
        updated_at: row.updated_at,
        amount: row.amount,
        scheduled_date: row.scheduled_date,
        last_payment_date: row.payment_date,
        payment_method: row.payment_method,
        note: row.note,
      });
    }

    // Fallback: no schedule row yet, but return latest auto payment if exists
    const latestOnly = await pool.query(
      `
      SELECT
        amount,
        payment_date,
        scheduled_date,
        payment_method,
        note
      FROM staff_payments
      WHERE restaurant_id = $1
        AND staff_id = $2
        AND auto = true
      ORDER BY COALESCE(payment_date, scheduled_date) DESC NULLS LAST
      LIMIT 1
      `,
      [restaurantId, staffId]
    );

    if (latestOnly.rowCount === 0) {
      return res.json({
        active: false,
        repeat_type: null,
        repeat_time: null,
      });
    }

    const latest = latestOnly.rows[0];
    res.json({
      active: false,
      repeat_type: null,
      repeat_time: null,
      amount: latest.amount,
      scheduled_date: latest.scheduled_date,
      last_payment_date: latest.payment_date,
      payment_method: latest.payment_method,
      note: latest.note,
    });
  } catch (err) {
    console.error("❌ Auto payment fetch error:", err);
    res.status(500).json({ status: "error", message: "Failed to fetch auto payment" });
  }
});


// Get all drivers
// ✅ Fetch all driver staff for the current tenant
router.get('/drivers', async (req, res) => {
  const restaurantId = req.user.restaurant_id; // tenant isolation
  logRequest('/api/staff/drivers', 'GET', { restaurantId });

  try {
    const result = await pool.query(
      `
      SELECT
        id,
        name,
        phone,
        role,
        email,
        status,
        avatar
      FROM staff
      WHERE restaurant_id = $1
        AND LOWER(role) IN ('driver', 'kurye')
        AND status = 'active'
      ORDER BY name ASC
      `,
      [restaurantId]
    );

    console.log(`🚗 Drivers fetched: ${result.rowCount} for tenant ${restaurantId}`);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching drivers:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch driver list',
    });
  }
});



// ✅ Update staff role
// ✅ Update staff role (tenant-safe)
router.put('/:id/role', async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    const restaurantId = req.user?.restaurant_id;

    console.log("🧩 Update role request:", { id, role, restaurantId });

    if (!restaurantId) {
      return res.status(401).json({ status: 'error', message: 'Missing restaurant context' });
    }
    if (!role) {
      return res.status(400).json({ status: 'error', message: 'Role is required' });
    }

    const result = await pool.query(
      `UPDATE staff
         SET role = $1
       WHERE restaurant_id = $2
         AND id = $3
       RETURNING id, name, email, role, restaurant_id`,
      [role.toLowerCase(), restaurantId, id]
    );

    if (result.rowCount === 0) {
      console.warn(`⚠️ No staff found for ID ${id} in restaurant ${restaurantId}`);
      return res.status(404).json({ status: 'error', message: 'Staff not found' });
    }

    console.log(`✅ Role updated for staff ${id} → ${role.toLowerCase()} (tenant ${restaurantId})`);
    res.json({ status: 'success', staff: result.rows[0] });
  } catch (err) {
    console.error('🔥 Error updating staff role:', err.stack || err);
    res.status(500).json({ status: 'error', message: 'Failed to update staff role' });
  }
});

module.exports = router;
