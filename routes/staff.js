const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { sendEmail, sendPushNotification } = require('../utils/notifications');
const bcrypt = require("bcrypt");

// Helper function to log requests
const logRequest = (route, method, data) => {
  console.log(`➡️ ${method} request to ${route}`);
  console.log(`🔍 Received data: ${JSON.stringify(data, null, 2)}`);
};

// Add a new staff schedule
router.post('/schedule', async (req, res) => {
  const { staff_id, role, shift_start, shift_end, shift_date, salary, days } = req.body;
  logRequest('/api/staff/schedule', 'POST', req.body);

  try {
    // Validate and format shift_date.
    const istanbulMidnight = new Date(`${shift_date}T00:00:00+03:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(shift_date)) {
  return res.status(400).json({ status: 'error', message: 'Invalid shift date format (expected YYYY-MM-DD)' });
}
const formattedShiftDate = shift_date; // no conversion needed for DATE type


    // Ensure days is an array.
    const daysArray = Array.isArray(days) ? days : (days || '').split(',').map(d => d.trim());

    const result = await pool.query(
      `INSERT INTO staff_schedule (staff_id, role, shift_start, shift_end, shift_date, salary, days)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[])
       ON CONFLICT (staff_id, shift_date)
       DO UPDATE SET role = EXCLUDED.role,
                     shift_start = EXCLUDED.shift_start,
                     shift_end = EXCLUDED.shift_end,
                     salary = EXCLUDED.salary,
                     days = EXCLUDED.days
       RETURNING *`,
      [staff_id, role, shift_start, shift_end, formattedShiftDate, salary, daysArray]
    );
    res.json({
      status: 'success',
      message: 'Schedule added/updated successfully',
      schedule: {
        ...result.rows[0],
        days: Array.isArray(result.rows[0].days)
          ? result.rows[0].days
          : (result.rows[0].days || '').split(',').map(d => d.trim())
      }
    });
  } catch (err) {
    console.error('❌ Error saving schedule:', err);
    res.status(500).json({ status: 'error', message: 'Failed to save schedule' });
  }
});

// Fetch all staff members
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, role, phone, address, salary, email, created_at,
              payment_type, salary_model, hourly_rate, avatar
       FROM staff
       ORDER BY id`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching staff:', err);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});


// Fetch all unique roles from the staff table
router.get('/roles', async (req, res) => {
  logRequest('/api/staff/roles', 'GET', {});
  try {
    const result = await pool.query('SELECT DISTINCT role FROM staff ORDER BY role');
    const roles = result.rows.map((row) => row.role);
    console.log('✅ Fetched roles:', roles);
    res.json({ roles });
  } catch (err) {
    console.error('❌ Error fetching roles:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch roles' });
  }
});


// Staff Check-In/Check-Out Route
router.post('/checkin', async (req, res) => {
  const { staffId, deviceId, wifiVerified, action } = req.body;
  logRequest('/api/staff/checkin', 'POST', req.body);

  try {
    // Validate if staff exists
    const staffCheck = await pool.query('SELECT id FROM staff WHERE id = $1', [staffId]);
    if (staffCheck.rowCount === 0) {
      console.error(`❌ Staff ID ${staffId} not found`);
      return res.status(404).json({ status: 'error', message: 'Staff ID not found' });
    }

    // Current time in Istanbul
    const currentTime = new Date().toLocaleString("en-US", { timeZone: "Europe/Istanbul" });
    console.log(`📅 Current time: ${currentTime}`);

    // ✅ CHECK-IN
    if (action === 'checkin') {
      const activeSession = await pool.query(
        'SELECT * FROM attendance WHERE staff_id = $1 AND check_out_time IS NULL',
        [staffId]
      );

      if (activeSession.rowCount > 0) {
        console.warn(`⚠️ Staff ID ${staffId} already checked in`);
        return res.status(400).json({
          status: 'error',
          message: 'Already checked in. Please check out before checking in again.',
        });
      }

      await pool.query(
        `INSERT INTO attendance (staff_id, check_in_time, device_id, wifi_verified)
         VALUES ($1, $2, $3, $4)`,
        [staffId, currentTime, deviceId, wifiVerified]
      );
      console.log(`✅ Checked in staff ID: ${staffId}`);
      return res.json({ status: 'success', message: 'Checked in successfully' });

    // ✅ CHECK-OUT with duration_minutes
    } else if (action === 'checkout') {
      const sessionRes = await pool.query(
        `SELECT id, check_in_time FROM attendance
         WHERE staff_id = $1 AND check_out_time IS NULL
         ORDER BY check_in_time DESC
         LIMIT 1`,
        [staffId]
      );

      if (sessionRes.rowCount === 0) {
        console.warn(`⚠️ No active check-in found for staff ID ${staffId} during checkout`);
        return res.status(404).json({
          status: 'error',
          message: 'No active check-in found for checkout',
        });
      }

      const session = sessionRes.rows[0];
      const checkIn = new Date(session.check_in_time);
      const checkOut = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Istanbul" }));
      const durationMinutes = Math.round((checkOut - checkIn) / 60000);

      await pool.query(
        `UPDATE attendance
         SET check_out_time = $1, duration_minutes = $2
         WHERE id = $3`,
        [checkOut, durationMinutes, session.id]
      );

      console.log(`✅ Checked out staff ID: ${staffId}, Duration: ${durationMinutes} mins`);
      return res.json({ status: 'success', message: 'Checked out successfully' });

    // Invalid action
    } else {
      console.error('❌ Invalid action');
      return res.status(400).json({ status: 'error', message: 'Invalid action' });
    }
  } catch (err) {
    console.error('❌ Error during check-in/out:', err);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
});


// Get Active Attendance History
router.get('/attendance', async (req, res) => {
  logRequest('/api/staff/attendance', 'GET', {});
  try {
    const result = await pool.query(`
      SELECT a.id, s.name, a.check_in_time, a.check_out_time, a.device_id, a.status
      FROM attendance a
      JOIN staff s ON a.staff_id = s.id
      WHERE a.status IS DISTINCT FROM 'archived'
      ORDER BY a.check_in_time DESC;
    `);
    console.log('✅ Active Attendance records:', result.rows);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching attendance:', err);
    res.status(500).json({ status: 'error', message: 'Error fetching attendance' });
  }
});

// PUT /api/staff/:id
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const {
    name,
    role,
    phone,
    address,
    salary,
    email,
    payment_type,
    salary_model,
    hourly_rate,
    weekly_salary,
    monthly_salary,
    avatar //
  } = req.body;

  logRequest(`/api/staff/${id}`, 'PUT', req.body);

  const fields = [];
  const values = [];
  let idx = 1;

  const pushField = (key, value) => {
    fields.push(`${key} = $${idx++}`);
    values.push(value);
  };

  // Add fields only if provided
  if (name !== undefined) pushField("name", name);
  if (role !== undefined) pushField("role", role);
  if (phone !== undefined) pushField("phone", phone);
  if (address !== undefined) pushField("address", address);
  if (email !== undefined) pushField("email", email);
  if (payment_type !== undefined) pushField("payment_type", payment_type);
  if (salary_model !== undefined) pushField("salary_model", salary_model);
  if (salary !== undefined) pushField("salary", salary);
  if (hourly_rate !== undefined) pushField("hourly_rate", hourly_rate);
  if (weekly_salary !== undefined) pushField("weekly_salary", weekly_salary);
  if (monthly_salary !== undefined) pushField("monthly_salary", monthly_salary);
  if (avatar !== undefined) pushField("avatar", avatar); // ✅ add this line

  // If nothing to update
  if (fields.length === 0) {
    return res.status(400).json({ status: 'error', message: 'No valid fields provided for update' });
  }

  // Conditional validation (only when salary_model is supplied)
  if (salary_model === 'hourly' && (hourly_rate === undefined || hourly_rate === "")) {
    return res.status(400).json({ status: 'error', message: 'Hourly rate is required for hourly salary model' });
  }

  if (salary_model === 'fixed' && (salary === undefined || salary === "")) {
    return res.status(400).json({ status: 'error', message: 'Salary is required for fixed salary model' });
  }

  try {
    const result = await pool.query(
      `UPDATE staff SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      [...values, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ status: 'error', message: 'Staff not found' });
    }

    console.log(`✅ Updated staff ID: ${id}`);
    res.json({ status: 'success', message: 'Staff updated successfully', staff: result.rows[0] });
  } catch (err) {
    console.error('❌ Error updating staff:', err);
    res.status(500).json({ status: 'error', message: 'Error updating staff' });
  }
});




// Delete Staff
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  logRequest(`/api/staff/${id}`, 'DELETE', { id });

  try {
    await pool.query('DELETE FROM staff WHERE id = $1', [id]);
    console.log(`✅ Deleted staff ID: ${id}`);
    res.json({ status: 'success', message: 'Staff deleted' });
  } catch (err) {
    console.error('❌ Error deleting staff:', err);
    res.status(500).json({ status: 'error', message: 'Error deleting staff' });
  }
});

const formatHours = (rawHours) => {
  const totalMinutes = Math.round(parseFloat(rawHours) * 60); // Convert hours to minutes
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
};

// Get staff profile by ID
router.get('/profile/:staffId', async (req, res) => {
  const { staffId } = req.params;
  console.log("📩 Incoming staff payment request:", req.body);

  try {
    const result = await pool.query(
      `SELECT
        id,
        name,
        role,
        phone,
        address,
        salary,
        email,
        created_at,
        payment_type,
        salary_model,
        hourly_rate,
        weekly_salary,
        monthly_salary
      FROM staff
      WHERE id = $1`,
      [staffId]
    );

    if (result.rowCount === 0) {
      console.log(`❌ Staff ID ${staffId} not found`);
      return res.status(404).json({ status: 'error', message: 'Staff not found' });
    }

    const profile = result.rows[0];
    console.log('✅ Fetched staff profile:', profile);
    res.json(profile);
  } catch (err) {
    console.error('❌ Error fetching staff profile:', err);
    res.status(500).json({ status: 'error', message: 'Error fetching profile' });
  }
});


// Update an existing staff schedule
router.put('/schedule/:id', async (req, res) => {
  const { id } = req.params;
  const { shift_start, shift_end, status, days, salary, salary_model, hourly_rate } = req.body;
  logRequest(`/api/staff/schedule/${id}`, 'PUT', req.body);

  try {
    const result = await pool.query(
      `UPDATE staff_schedule
       SET shift_start = $1,
           shift_end = $2,
           status = $3,
           days = $4,
           salary = $5,
           salary_model = $6,
           hourly_rate = $7
       WHERE id = $8
       RETURNING *`,
      [shift_start, shift_end, status, days, salary, salary_model, hourly_rate, id]
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
router.put('/attendance/archive/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query('UPDATE attendance SET status = $1 WHERE id = $2', ['archived', id]);
    console.log(`📂 Successfully archived attendance record with ID: ${id}`);
    return res.json({ status: 'success', message: 'Staff archived from the list' });
  } catch (err) {
    console.error('❌ Error archiving attendance record:', err);
    return res.status(500).json({ status: 'error', message: 'Failed to archive staff' });
  }
});

// Add a new staff member
router.post('/', async (req, res) => {
  const {
    id,
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
    payment_type
  } = req.body;

  logRequest('/api/staff', 'POST', req.body);

  if (!id || !name || !role || !phone || !address || !salary || !email || !payment_type || !salary_model) {
    console.error('❌ Missing fields');
    return res.status(400).json({ status: 'error', message: 'All fields are required' });
  }

  try {
    const existingStaff = await pool.query('SELECT * FROM staff WHERE id = $1', [id]);
    if (existingStaff.rowCount > 0) {
      console.error(`❌ Staff ID ${id} already exists`);
      return res.status(409).json({ status: 'error', message: 'Staff ID already exists' });
    }

    const result = await pool.query(
      `INSERT INTO staff (
        id, name, role, phone, address, salary,
        email, payment_type, salary_model,
        hourly_rate, weekly_salary, monthly_salary
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        id,
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
      ]
    );

    console.log('✅ Staff added:', result.rows[0]);
    res.json({ status: 'success', message: 'Staff added successfully', staff: result.rows[0] });
  } catch (err) {
    console.error('❌ Server error while adding staff:', err);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});


// Edit Staff
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const {
    name,
    role,
    phone,
    address,
    salary,
    email,
    payment_type,
    salary_model,
    hourly_rate,
    weekly_salary,
    monthly_salary,
    avatar // ✅ Include avatar
  } = req.body;

  logRequest(`/api/staff/${id}`, 'PUT', req.body);

  // Validation
  if (!name || !role || !phone || !address || !salary || !email || !salary_model) {
    console.error('❌ Missing fields');
    return res.status(400).json({ status: 'error', message: 'All fields are required' });
  }

  try {
    const fields = [];
    const values = [];
    let idx = 1;

    const pushField = (key, value) => {
      fields.push(`${key} = $${idx++}`);
      values.push(value);
    };

    pushField("name", name);
    pushField("role", role);
    pushField("phone", phone);
    pushField("address", address);
    pushField("salary", salary);
    pushField("email", email);
    pushField("payment_type", payment_type);
    pushField("salary_model", salary_model);
    pushField("hourly_rate", salary_model === 'hourly' ? hourly_rate : null);
    pushField("weekly_salary", salary_model === 'fixed' && payment_type === 'weekly' ? weekly_salary : null);
    pushField("monthly_salary", salary_model === 'fixed' && payment_type === 'monthly' ? monthly_salary : null);

    if (avatar !== undefined) pushField("avatar", avatar); // ✅ optional field

    const query = `UPDATE staff SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`;
    values.push(id);

    const result = await pool.query(query, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ status: 'error', message: 'Staff not found' });
    }

    console.log(`✅ Updated staff ID: ${id}`);
    res.json({ status: 'success', message: 'Staff updated successfully', staff: result.rows[0] });
  } catch (err) {
    console.error('❌ Error updating staff:', err);
    res.status(500).json({ status: 'error', message: 'Error updating staff' });
  }
});


// Fetch all staff schedules
router.get('/schedule', async (req, res) => {
  logRequest('/api/staff/schedule', 'GET', {});
  try {
    const result = await pool.query(`
      SELECT ss.id, ss.staff_id, s.name AS staff_name, ss.role,
             TO_CHAR(ss.shift_start, 'HH24:MI') AS shift_start,
             TO_CHAR(ss.shift_end, 'HH24:MI') AS shift_end,
             ss.status, ss.shift_date, ss.salary,
             ARRAY_TO_STRING(ss.days, ',') AS days
      FROM staff_schedule ss
      JOIN staff s ON ss.staff_id = s.id
      ORDER BY ss.id;
    `);
    console.log('✅ Fetched staff schedules:', result.rows);
    res.json(result.rows.map(row => ({
      ...row,
      days: row.days ? row.days.split(',') : [] // Ensure days are always an array
    })));
  } catch (err) {
    console.error('❌ Error fetching staff schedules:', err);
    res.status(500).json({ message: 'Failed to fetch staff schedules' });
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
router.delete('/schedule/:id', async (req, res) => {
  const { id } = req.params;
  logRequest(`/api/staff/schedule/${id}`, 'DELETE', { id });

  try {
    const result = await pool.query('DELETE FROM staff_schedule WHERE id = $1 RETURNING *;', [id]);
    res.json({ status: 'success', message: 'Schedule deleted', schedule: result.rows[0] });
  } catch (err) {
    console.error('❌ Error deleting schedule:', err);
    res.status(500).json({ message: 'Failed to delete schedule' });
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


router.post('/send-schedule', async (req, res) => {
  const { period, recipients } = req.body;

  try {
    if (!recipients || recipients.length === 0) {
      return res.status(400).json({ status: 'error', message: 'No recipients provided' });
    }

    // Fetch all shift details for each recipient and group by day and time
    const shiftDetails = await pool.query(`
      SELECT s.email, ss.role, ss.days, ss.shift_start, ss.shift_end
      FROM staff_schedule ss
      JOIN staff s ON ss.staff_id = s.id
      WHERE s.id = ANY($1::int[])
      ORDER BY s.id, ss.days, ss.shift_start;
    `, [recipients]);

    if (shiftDetails.rowCount === 0) {
      return res.status(404).json({ status: 'error', message: 'No shift details found for the selected recipients' });
    }

    // Group shifts by email and organize days with multiple shifts correctly
    const emailMap = new Map();

    shiftDetails.rows.forEach((shift) => {
      const { email, role, days, shift_start, shift_end } = shift;
      const formattedTime = `${shift_start} - ${shift_end}`;
      const scheduleLine = `${days}: ${formattedTime}`;

      if (!emailMap.has(email)) {
        emailMap.set(email, {});
      }

      // Group by day to avoid repetition and correctly handle multiple shifts per day
      if (!emailMap.get(email)[days]) {
        emailMap.get(email)[days] = [];
      }
      emailMap.get(email)[days].push(formattedTime);
    });

    // Send email to each staff with their combined schedule
    for (const [email, daySchedules] of emailMap) {
      // Combine multiple shifts for the same day
      const schedules = Object.keys(daySchedules).map((day) => {
        const times = daySchedules[day].join(', ');
        return `${day}: ${times}`;
      });

      const emailBody = createEmailTemplate(period, schedules);
      const emailSubject = `Your ${period} shift schedule`;

      await sendEmail(email, emailSubject, emailBody, true); // Pass `true` for HTML format
      console.log(`✅ Email sent to: ${email}`);
    }

    res.json({ status: 'success', message: 'Shift schedule sent successfully' });
  } catch (err) {
    console.error('❌ Error sending email:', err);
    res.status(500).json({ status: 'error', message: 'Failed to send shift schedule' });
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
  const { staffId } = req.params;
  let { startDate, endDate } = req.query;

  function getWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  }


  try {
    if (!startDate || !endDate) {
      const now = new Date();
      const day = now.getDay();
      const diffToMonday = day === 0 ? -6 : 1 - day;
      const monday = new Date(now);
      monday.setDate(now.getDate() + diffToMonday);
      monday.setHours(0, 0, 0, 0);

      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      sunday.setHours(23, 59, 59, 999);

      startDate = monday.toISOString().split('T')[0];
      endDate = sunday.toISOString().split('T')[0];
    }

    const staffRes = await pool.query(
      `SELECT salary, hourly_rate, salary_model, payment_type, weekly_salary, monthly_salary FROM staff WHERE id = $1`,
      [staffId]
    );
    const staff = staffRes.rows[0];

    const [scheduleResult, attendanceResult, paymentsResult] = await Promise.all([
      pool.query(`
        SELECT shift_start, shift_end, shift_date
        FROM staff_schedule
        WHERE staff_id = $1 AND shift_date BETWEEN $2 AND $3
      `, [staffId, startDate, endDate]),
      pool.query(`
        SELECT check_in_time, check_out_time, duration_minutes
        FROM attendance
        WHERE staff_id = $1 AND check_in_time::date BETWEEN $2 AND $3
      `, [staffId, startDate, endDate]),
      pool.query(`
        SELECT COALESCE(SUM(amount), 0) AS total_paid
        FROM staff_payments
        WHERE staff_id = $1
      `, [staffId])
    ]);



    const scheduleRes = scheduleResult.rows;
    const attendanceRes = attendanceResult.rows;
    const salaryPaid = parseFloat(paymentsResult.rows[0].total_paid || 0);

    const attendedDates = new Set(
      attendanceRes
        .filter(row => row.check_out_time)
        .map(row => new Date(row.check_in_time).toISOString().split('T')[0])
    );

    const workedWeeks = new Set();
    const workedMonths = new Set();
    scheduleRes.forEach(row => {
      const dateStr = new Date(row.shift_date).toISOString().split('T')[0];
      if (attendedDates.has(dateStr)) {
        const d = new Date(row.shift_date);
        const weekKey = `${d.getFullYear()}-W${getWeekNumber(d)}`;
        const monthKey = `${d.getFullYear()}-${d.getMonth() + 1}`;
        workedWeeks.add(weekKey);
        workedMonths.add(monthKey);
      }
    });

    let totalSalaryDue = 0;
    let totalActual = 0;
    let payroll = {};

   let totalEarlyCheckoutMinutes = 0;
let totalLateMinutes = 0;
let totalAbsentMinutes = 0;

if (staff.salary_model === 'hourly') {
  let totalEffectiveMinutes = 0;


  scheduleRes.forEach(shift => {
    const dateStr = new Date(shift.shift_date).toISOString().split('T')[0];
    const matchingAttendance = attendanceRes.find(row => {
      const attDate = new Date(row.check_in_time).toISOString().split('T')[0];
      return attDate === dateStr;
    });

    const [sh, sm] = shift.shift_start.split(':').map(Number);
    const [eh, em] = shift.shift_end.split(':').map(Number);
    const scheduledStart = new Date(shift.shift_date);
    scheduledStart.setHours(sh, sm, 0, 0);
    const scheduledEnd = new Date(shift.shift_date);
    scheduledEnd.setHours(eh, em, 0, 0);
    const scheduledDuration = (scheduledEnd - scheduledStart) / 60000;



    if (!matchingAttendance || !matchingAttendance.check_out_time) return;

    const checkIn = new Date(matchingAttendance.check_in_time);
    const checkOut = new Date(matchingAttendance.check_out_time);

    const lateMinutes = Math.max(0, Math.floor((checkIn - scheduledStart) / 60000));
    console.log('🕵️‍♂️ Early Checkout Calculation:', {
  shiftDate: dateStr,
  scheduledEnd: scheduledEnd.toISOString(),
  actualCheckout: checkOut.toISOString(),
  earlyMinutes: Math.max(0, Math.floor((scheduledEnd - checkOut) / 60000))
});


    const earlyMinutes = Math.max(0, Math.floor((scheduledEnd - checkOut) / 60000));
    totalEarlyCheckoutMinutes += earlyMinutes; // ✅ Add to total

    const effectiveMinutes = Math.max(scheduledDuration - lateMinutes - earlyMinutes, 0);
    totalEffectiveMinutes += effectiveMinutes;
  });




  totalActual = totalEffectiveMinutes;
  totalSalaryDue = staff.hourly_rate * (totalEffectiveMinutes / 60);

  payroll.latency = {
  lateCheckin: totalLateMinutes,
  absent: totalAbsentMinutes,
  earlyCheckout: totalEarlyCheckoutMinutes,
  total: totalLateMinutes + totalAbsentMinutes + totalEarlyCheckoutMinutes
};

 // ✅ Include in response
}

 else if (staff.salary_model === 'fixed' && staff.payment_type === 'weekly') {
      totalSalaryDue = staff.weekly_salary * workedWeeks.size;
    } else if (staff.salary_model === 'fixed' && staff.payment_type === 'monthly') {
      totalSalaryDue = staff.monthly_salary * workedMonths.size;
    }



        // ✅ Calculate total scheduled minutes this week
const calcScheduledMinutes = (start, end) => {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let minutes = (eh * 60 + em) - (sh * 60 + sm);
  return minutes < 0 ? minutes + 1440 : minutes;
};

let totalScheduledMinutes = 0;
scheduleRes.forEach(row => {
  if (row.shift_start && row.shift_end) {
    totalScheduledMinutes += calcScheduledMinutes(row.shift_start, row.shift_end);
  }
});

const weeklyHours = parseFloat((totalScheduledMinutes / 60).toFixed(2));

// 🔹 Calculate time overage/underwork for approval
const timeDifferenceMinutes = totalActual - totalScheduledMinutes;
const timeDifferenceFormatted = `${timeDifferenceMinutes >= 0 ? '+' : '-'}${Math.floor(Math.abs(timeDifferenceMinutes) / 60)}h ${Math.abs(timeDifferenceMinutes) % 60}min`;
const overtimePendingApproval = timeDifferenceMinutes > 0;


const salaryDiff = totalSalaryDue - salaryPaid;
const salaryDue = Math.max(salaryDiff, 0);
const overpaidAmount = salaryDiff < 0 ? Math.abs(salaryDiff) : 0;


// ✅ Weekly Check / Latency / Attendance Breakdown
const toDateKey = (d) => new Date(d).toISOString().split('T')[0];
const weeklyCheckMap = {};
let lateMinutesTotal = 0;

attendanceRes.forEach((row) => {
  if (!row.check_out_time) return;
  const checkInDate = new Date(row.check_in_time);
  const dateStr = toDateKey(checkInDate);
  if (!weeklyCheckMap[dateStr]) {
    weeklyCheckMap[dateStr] = {
      day: checkInDate.toLocaleDateString('en-US', { weekday: 'long' }),
      date: dateStr,
      sessions: [],
      totalMinutes: 0,
      latency: [],
      schedule: null
    };
  }

  const matchingShift = scheduleRes.find(s => toDateKey(s.shift_date) === dateStr);
  if (matchingShift) {
    weeklyCheckMap[dateStr].schedule = `${matchingShift.shift_start} - ${matchingShift.shift_end}`;
    const [h, m] = matchingShift.shift_start.split(':').map(Number);
    const scheduledStart = new Date(matchingShift.shift_date);
    scheduledStart.setHours(h, m, 0, 0);
    const actualStart = new Date(row.check_in_time);
    const diff = Math.floor((actualStart - scheduledStart) / 60000);
    let badge = 'on time';
    if (diff > 0) {
      badge = `${Math.floor(diff / 60)}h ${diff % 60}min late`;
      lateMinutesTotal += diff;
    } else if (diff < 0) {
      const early = Math.abs(diff);
      badge = `${Math.floor(early / 60)}h ${early % 60}min early`;
    }
    weeklyCheckMap[dateStr].latency.push(badge);
  }

  if (!weeklyCheckMap[dateStr].earlyCheckout) {
  weeklyCheckMap[dateStr].earlyCheckout = [];
}

if (matchingShift && row.check_out_time) {
  const [endHour, endMin] = matchingShift.shift_end.split(':').map(Number);
  const scheduledEnd = new Date(matchingShift.shift_date);
  scheduledEnd.setHours(endHour, endMin, 0, 0);

  const actualEnd = new Date(row.check_out_time);
  const earlyMinutes = Math.floor((scheduledEnd - actualEnd) / 60000);

  if (earlyMinutes > 0) {
    weeklyCheckMap[dateStr].earlyCheckout.push(`${earlyMinutes} min early leave`);
  } else {
    weeklyCheckMap[dateStr].earlyCheckout.push(null);
  }
} else {
  weeklyCheckMap[dateStr].earlyCheckout.push(null);
}


  weeklyCheckMap[dateStr].sessions.push(row);
  weeklyCheckMap[dateStr].totalMinutes += row.duration_minutes || 0;
});

scheduleRes.forEach((shift) => {
  const shiftDate = new Date(shift.shift_date);
  const dateStr = shiftDate.toISOString().split('T')[0];
  if (!weeklyCheckMap[dateStr]) {
    weeklyCheckMap[dateStr] = {
      day: shiftDate.toLocaleDateString('en-US', { weekday: 'long' }),
      date: dateStr,
      sessions: [],
      totalMinutes: 0,
      latency: ['Absent'],
      schedule: `${shift.shift_start} - ${shift.shift_end}`
    };
  } else {
    const entry = weeklyCheckMap[dateStr];
    if (entry.sessions.length === 0) entry.latency = ['Absent'];
    if (!entry.schedule) entry.schedule = `${shift.shift_start} - ${shift.shift_end}`;
  }
});

const now = new Date();
let absentLatency = 0;
Object.values(weeklyCheckMap).forEach((entry) => {
  const shiftDate = new Date(entry.date);
  if (shiftDate > now) return;
  if (entry.latency.includes('Absent') && entry.schedule) {
    const [start, end] = entry.schedule.split(' - ');
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    let duration = (eh * 60 + em) - (sh * 60 + sm);
    if (duration < 0) duration += 1440;
    absentLatency += duration;
  }
});

const latency = lateMinutesTotal + absentLatency;

const getDateRange = (startStr, endStr) => {
  const arr = [];
  const start = new Date(startStr);
  const end = new Date(endStr);
  let current = new Date(start);
  while (current <= end) {
    arr.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  return arr;
};

const dateRange = getDateRange(startDate, endDate);
const weeklyCheck = dateRange.map((dateObj) => {
  const date = dateObj.toISOString().split('T')[0];
  const entry = weeklyCheckMap[date];
  return {
  day: dateObj.toLocaleDateString('en-US', { weekday: 'long' }),
  date,
  totalTime: entry ? `${Math.floor(entry.totalMinutes / 60)}h ${entry.totalMinutes % 60}min` : '0h 0min',
  schedule: entry?.schedule ?? 'No schedule',
  sessions: entry?.sessions || [],
  latency: entry?.latency || ['No schedule'],
  earlyCheckout: entry?.earlyCheckout || [] // ✅ Add this line
};

});


const checkInDates = new Set(
  attendanceRes.filter(row => row.check_out_time).map(row => toDateKey(row.check_in_time))
);

const totalShifts = scheduleRes.length;
let shiftsAttended = 0;
scheduleRes.forEach(row => {
  const shiftDate = toDateKey(row.shift_date);
  if (checkInDates.has(shiftDate)) shiftsAttended++;
});




const earlyCheckoutMinutes = totalEarlyCheckoutMinutes;



    res.json({
      status: 'success',
      payroll: {
        timeDifferenceMinutes,
        timeDifferenceFormatted,
        overtimePendingApproval,
        totalMinutesThisWeek: totalActual,
        weeklyCheck,
        shifts: {
          total: totalShifts,
          attended: shiftsAttended,
          percentage: Math.round((shiftsAttended / totalShifts) * 100) || 0
        },
        latency: {
          checkinLateMinutes: lateMinutesTotal,
          absentMinutes: absentLatency,
          earlyCheckout: totalEarlyCheckoutMinutes,
          totalMinutes: latency
        },
        earnedThisWeek: staff.salary_model === 'hourly'
  ? parseFloat((staff.hourly_rate * (totalActual / 60)).toFixed(2))
  : totalSalaryDue,

        weeklyHours,
        earlyCheckoutMinutes,
        salaryModel: staff.salary_model === 'hourly' ? 'hourly' : staff.payment_type === 'weekly' ? 'weekly' : 'monthly',
        payment_type: staff.payment_type,
        hourlyRate: staff.hourly_rate,
        weeklySalary: staff.weekly_salary,
        monthlySalary: staff.monthly_salary,
        salaryPaid,
        salaryDue: parseFloat(salaryDue.toFixed(2)),
        overpaidAmount: parseFloat(overpaidAmount.toFixed(2)),
        totalSalaryDue: parseFloat(totalSalaryDue.toFixed(2)),
        totalWeeks: workedWeeks.size,
        totalMonths: workedMonths.size
      }
    });
  } catch (err) {
    console.error('❌ Payroll error:', err);
    res.status(500).json({ status: 'error', message: 'Payroll fetch failed' });
  }
});


// ----------------- PAYMENTS -----------------
router.get('/:staffId/payments', async (req, res) => {
  const { staffId } = req.params;
  try {
    const result = await pool.query(
      `SELECT payment_date, amount, note FROM staff_payments WHERE staff_id = $1 ORDER BY payment_date DESC`,
      [staffId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Payment history error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch payment history' });
  }
});

router.get('/:staffId/payments/weekly', async (req, res) => {
  const { staffId } = req.params;
  let { start, end } = req.query;

  start = start || '2000-01-01';
  end = end || new Date().toISOString().split('T')[0];

  try {
    const result = await pool.query(`
      SELECT DATE_TRUNC('week', payment_date) AS week_start,
             SUM(amount)::numeric AS total_paid
      FROM staff_payments
      WHERE staff_id = $1
        AND payment_date BETWEEN $2 AND $3
      GROUP BY week_start
      ORDER BY week_start DESC
    `, [staffId, start, end]);

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Weekly payment summary error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch weekly summary' });
  }
});

router.post('/:staffId/payments', async (req, res) => {
  const { staffId } = req.params;
  let {
    amount,
    date,
    note = '',
    payment_method = 'cash',
    auto = false,
    scheduled_date,
    repeat_type = 'none',
    repeat_time
  } = req.body;

  console.log('📥 Payment request payload:', req.body);

  // ✅ Normalize repeat fields
  if (!auto || repeat_type === 'none') {
    repeat_type = null;
    repeat_time = null;
  }

  // ✅ Parse and validate amount
  amount = parseFloat(amount);
  if ((amount === undefined || isNaN(amount)) || (amount === 0 && !auto)) {
    return res.status(400).json({ status: 'error', message: 'Invalid or missing amount' });
  }

  try {
    // 💾 Insert payment
    await pool.query(
      `INSERT INTO staff_payments (
         staff_id, amount, note, payment_method, auto, scheduled_date,
         payment_date, repeat_type, repeat_time
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        staffId,
        amount,
        note,
        payment_method,
        auto,
        scheduled_date || null,
        auto ? scheduled_date || null : date || new Date().toISOString().slice(0, 10),
        repeat_type,
        repeat_time
      ]
    );

    console.log(`✅ Payment saved for staff ${staffId}: ₺${amount} (${payment_method})`);

    // 🔁 Save auto payroll plan if enabled
    if (auto && repeat_type && repeat_time) {
      await pool.query(`
        INSERT INTO scheduled_staff_payroll (staff_id, repeat_type, repeat_time, active)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (staff_id) DO UPDATE
        SET repeat_type = EXCLUDED.repeat_type,
            repeat_time = EXCLUDED.repeat_time,
            active = true
      `, [staffId, repeat_type, repeat_time]);

      console.log(`📅 Auto payroll scheduled for staff ${staffId} (${repeat_type} @ ${repeat_time})`);
    }

    // 📧 Fetch staff details for receipt
    const staffRes = await pool.query(
      `SELECT name, email, role FROM staff WHERE id = $1`,
      [staffId]
    );

    if (staffRes.rowCount > 0) {
      const { name, email, role } = staffRes.rows[0];

      if (email && !auto) {
  const subject = `📄 Payroll Receipt - ${name}`;
        const html = `
          <h2>💼 Payroll Receipt</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Role:</strong> ${role}</p>
          <p><strong>Amount Paid:</strong> ₺${amount.toFixed(2)}</p>
          <p><strong>Method:</strong> ${payment_method}</p>
          <p><strong>Date:</strong> ${date || new Date().toISOString().slice(0, 10)}</p>
          ${note ? `<p><strong>Note:</strong> ${note}</p>` : ''}
          <p style="margin-top:2em;">Thank you for your dedication!<br><strong>Beypro</strong></p>
        `;

         await sendEmail(email, subject, html, true);
  console.log(`📧 Payroll email sent to ${email}`);
} else {
        console.warn(`⚠️ No email found for staff ${staffId}`);
      }
    }

    res.json({ status: 'success', message: 'Payment saved successfully' });
  } catch (err) {
    console.error('❌ Payment insert error:', err.stack || err);
    res.status(500).json({ status: 'error', message: 'Failed to save payment' });
  }
});






// Get all drivers
router.get('/drivers', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, phone FROM staff WHERE role = 'Kurye' OR role = 'driver'`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching drivers:', err);
    res.status(500).json({ error: 'Failed to fetch drivers' });
  }
});


router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    // 1. Try USERS table (owners/admins)
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    if (user) {
      if (!user.password_hash) {
        return res.status(500).json({ success: false, error: "Password hash missing" });
      }
      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (isMatch) {
        // Load permissions for user role (if any)
        let userPerms = [];
        try {
          const settingsRes = await pool.query(
            `SELECT value FROM settings WHERE section = 'users'`
          );
          if (settingsRes.rowCount > 0) {
            const settings = JSON.parse(settingsRes.rows[0].value);
            userPerms = settings.roles?.[user.role] || [];
          }
        } catch (err) {
          console.error('Failed to fetch user permissions:', err);
        }
        return res.json({
          success: true,
          user: {
            id: user.id,
            fullName: user.full_name,
            email: user.email,
            businessName: user.business_name,
            subscriptionPlan: user.subscription_plan || null,
            role: user.role,
            type: 'user',
            permissions: userPerms,
          }
        });
      }
    }

    // 2. Try STAFF table (cashier, kitchen, etc)
    const staffResult = await pool.query("SELECT * FROM staff WHERE email = $1", [email]);
const staff = staffResult.rows[0];
if (staff) {
  if (staff.pin === password) {
    // PATCH: fetch role permissions from users column, not section
    let rolePerms = [];
    try {
      const settingsRes = await pool.query(`SELECT users FROM settings LIMIT 1`);
      if (settingsRes.rowCount > 0 && settingsRes.rows[0].users) {
        const settings = settingsRes.rows[0].users;
        rolePerms = settings.roles?.[staff.role] || [];
      }
    } catch (err) {
      console.error('Failed to fetch staff permissions:', err);
    }
    return res.json({
      success: true,
      staff: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        type: 'staff',
        permissions: rolePerms,
      }
    });
  }
}


    // If not found in either
    return res.status(401).json({ success: false, error: "User or staff not found or incorrect credentials" });

  } catch (err) {
    console.error("❌ Hybrid login error:", err);
    return res.status(500).json({ success: false, error: "Server error: " + err.message });
  }
});






module.exports = router;
