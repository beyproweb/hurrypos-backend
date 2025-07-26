const pool = require("./db");
const { sendEmail } = require("./utils/notifications");
const sendNoOrderEmail = require("./utils/sendNoOrderEmail");
require("dotenv").config();
const dayjs = require("dayjs");

console.log("⏰ Scheduled mailer started. Waiting for carts...");

const checkItemRecentlyCritical = async (stock_id) => {
  const res = await pool.query(
    `SELECT quantity, critical_quantity, last_auto_add_at FROM stock WHERE id = $1`,
    [stock_id]
  );

  if (res.rows.length === 0) return false;

  const { quantity, critical_quantity, last_auto_add_at } = res.rows[0];

  const isBelowCritical = parseFloat(quantity) < parseFloat(critical_quantity);
  const isRecentlyCritical =
    last_auto_add_at && dayjs(last_auto_add_at).isAfter(dayjs().subtract(7, "day"));

  return isBelowCritical && isRecentlyCritical;
};

const runScheduledMailer = async () => {
  try {
    console.log("🔍 Checking for scheduled carts...");

    const cartRes = await pool.query(`
      SELECT sc.id, sc.supplier_id, sc.scheduled_at, sc.repeat_type, sc.repeat_days,
             sc.auto_confirm, sc.confirmed, sc.archived,
             sp.name AS supplier_name, sp.email
      FROM supplier_carts sc
      INNER JOIN suppliers sp ON sc.supplier_id = sp.id
      WHERE sc.confirmed = true
        AND sc.archived = false
        AND sc.auto_confirm = true
        AND sc.scheduled_at IS NOT NULL
        AND sc.scheduled_at <= NOW()
      ORDER BY sc.scheduled_at ASC
      LIMIT 5
    `);

    for (const cart of cartRes.rows) {
      const itemsRes = await pool.query(
        `SELECT * FROM supplier_cart_items WHERE cart_id = $1`,
        [cart.id]
      );
      const items = itemsRes.rows;

      if (items.length === 0) {
        console.warn(`⚠️ Cart ${cart.id} has no items, skipping`);
        continue;
      }

      let hasCritical = false;
      for (const item of items) {
        const critical = await checkItemRecentlyCritical(item.stock_id);
        if (critical) {
          hasCritical = true;
          break;
        }
      }

      if (!hasCritical) {
        console.log(`⏭️ Skipping cart ${cart.id} (no recently critical items)`);

        // 📨 Notify supplier
        if (cart.email) {
          await sendNoOrderEmail(cart.supplier_name, cart.email, cart.scheduled_at);
          console.log(`📭 No-order email sent to: ${cart.email}`);
        }

        // 🗃️ Archive as skipped
        await pool.query(
          `UPDATE supplier_carts SET archived = true, skipped = true WHERE id = $1`,
          [cart.id]
        );

        // 🔁 Repeat for next scheduled cycle
        if (cart.repeat_type === "weekly" && cart.repeat_days.length > 0) {
          const nextScheduledAt = dayjs(cart.scheduled_at).add(7, "day").toDate();

          const newCartRes = await pool.query(
            `INSERT INTO supplier_carts
             (supplier_id, scheduled_at, repeat_type, repeat_days, auto_confirm, confirmed, archived, created_at)
             VALUES ($1, $2, $3, $4, $5, true, false, NOW())
             RETURNING id`,
            [cart.supplier_id, nextScheduledAt, cart.repeat_type, cart.repeat_days, cart.auto_confirm]
          );

          const newCartId = newCartRes.rows[0].id;
          for (const item of items) {
            await pool.query(
              `INSERT INTO supplier_cart_items (cart_id, stock_id, product_name, quantity, unit)
               VALUES ($1, $2, $3, $4, $5)`,
              [newCartId, item.stock_id, item.product_name, item.quantity, item.unit]
            );
          }

          console.log(`🔁 Re-created (skipped) cart ID: ${newCartId} for supplier ${cart.supplier_id}`);
        }

        continue; // 🔁 Skip actual order email
      }

      // 📨 Send real order email
      const htmlBody = `
        <h2>📦 New Supplier Order</h2>
        <p><strong>Supplier:</strong> ${cart.supplier_name}</p>
        <p><strong>Scheduled for:</strong> ${new Date(cart.scheduled_at).toLocaleString("tr-TR", { hour12: false })}</p>
        <h3>📝 Products:</h3>
        <ul>
          ${items.map(item => `<li>${item.product_name} — ${item.quantity} ${item.unit}</li>`).join("")}
        </ul>
        <p style="margin-top:1.5em;">Best regards,<br><strong>HurryPOS</strong></p>
      `;

      if (cart.email) {
        await sendEmail(cart.email, `📦 HurryPOS Scheduled Order`, htmlBody, true);
        console.log(`✅ Email sent to: ${cart.email}`);
      } else {
        console.warn(`⚠️ Cart ${cart.id} has no supplier email.`);
      }

      // 🗃️ Archive as sent (not skipped)
      await pool.query(
        `UPDATE supplier_carts SET archived = true, skipped = false WHERE id = $1`,
        [cart.id]
      );
      console.log(`📦 Archived cart ${cart.id}`);

      // 🔁 Repeat order for next week
      if (cart.repeat_type === "weekly" && cart.repeat_days.length > 0) {
        const nextScheduledAt = dayjs(cart.scheduled_at).add(7, "day").toDate();

        const newCartRes = await pool.query(
          `INSERT INTO supplier_carts
           (supplier_id, scheduled_at, repeat_type, repeat_days, auto_confirm, confirmed, archived, created_at)
           VALUES ($1, $2, $3, $4, $5, true, false, NOW())
           RETURNING id`,
          [cart.supplier_id, nextScheduledAt, cart.repeat_type, cart.repeat_days, cart.auto_confirm]
        );

        const newCartId = newCartRes.rows[0].id;
        for (const item of items) {
          await pool.query(
            `INSERT INTO supplier_cart_items (cart_id, stock_id, product_name, quantity, unit)
             VALUES ($1, $2, $3, $4, $5)`,
            [newCartId, item.stock_id, item.product_name, item.quantity, item.unit]
          );
        }

        console.log(`🔁 Re-created weekly cart ID: ${newCartId} for supplier ${cart.supplier_id}`);
      }
    }
  } catch (err) {
    console.error("❌ Scheduled mailer error:", err);
  }
};

const runScheduledPayroll = async () => {
  try {
    console.log("💸 Running auto payroll...");

    const now = dayjs();
    const today = now.format("YYYY-MM-DD");
    const timeNow = now.format("HH:mm");

    // Step 1: Fetch active payroll schedules
    const res = await pool.query(`
      SELECT s.id AS staff_id, s.salary_model, s.payment_type, s.hourly_rate, s.monthly_salary, s.weekly_salary,
             s.name, s.email, s.role,
             ssp.repeat_type, ssp.repeat_time
      FROM scheduled_staff_payroll ssp
      INNER JOIN staff s ON ssp.staff_id = s.id
      WHERE ssp.active = true
        AND ssp.repeat_time = $1
    `, [timeNow]);

    for (const row of res.rows) {
      const { staff_id, salary_model, payment_type, hourly_rate, weekly_salary, monthly_salary, name, email, role } = row;

      // Step 2: Skip if already paid for this scheduled day
      const paidCheck = await pool.query(`
  SELECT 1 FROM staff_payments
  WHERE staff_id = $1 AND payment_date = $2 AND auto = true AND amount > 0
`, [staff_id, today]);

if (paidCheck.rowCount > 0) {
  console.log(`⏭️ Staff ${staff_id} already auto-paid today`);
  continue;
}


      if (paidCheck.rowCount > 0) {
        console.log(`⏭️ Staff ${staff_id} already auto-paid today`);
        continue;
      }

      // Step 3: Get attendance
      const attendanceRes = await pool.query(`
        SELECT check_in_time, check_out_time
        FROM attendance
        WHERE staff_id = $1 AND check_out_time IS NOT NULL
          AND check_in_time >= NOW() - INTERVAL '30 days'
      `, [staff_id]);

      let totalMinutes = 0;
      for (const row of attendanceRes.rows) {
        const start = new Date(row.check_in_time);
        const end = new Date(row.check_out_time);
        totalMinutes += Math.round((end - start) / 60000);
      }

      // Step 4: Calculate salary
      let amount = 0;
      if (salary_model === 'hourly') {
        amount = (hourly_rate || 0) * (totalMinutes / 60);
      } else if (salary_model === 'fixed' && payment_type === 'weekly') {
        amount = weekly_salary;
      } else if (salary_model === 'fixed' && payment_type === 'monthly') {
        amount = monthly_salary;
      }

      if (!amount || amount <= 0) {
        console.log(`⚠️ No earned salary for staff ${staff_id}, skipping`);
        continue;
      }

      // Step 5: Insert auto-payment
      await pool.query(`
        INSERT INTO staff_payments (
          staff_id, amount, payment_method, note, auto, scheduled_date, payment_date
        )
        VALUES ($1, $2, 'cash', '[AUTO Payroll]', true, $3, $3)
      `, [staff_id, amount.toFixed(2), today]);

      console.log(`✅ Auto-paid staff ${staff_id} ₺${amount.toFixed(2)}`);

      // Step 6: Send email if email exists
      if (email) {
        const subject = `📄 Payroll Receipt - ${name}`;
        const html = `
          <h2>💼 Payroll Receipt</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Role:</strong> ${role}</p>
          <p><strong>Amount Paid:</strong> ₺${amount.toFixed(2)}</p>
          <p><strong>Method:</strong> cash</p>
          <p><strong>Date:</strong> ${today}</p>
          <p><strong>Note:</strong> [AUTO Payroll]</p>
          <p style="margin-top:2em;">Thank you for your dedication!<br><strong>Beypro</strong></p>
        `;

        await sendEmail(email, subject, html, true);
        console.log(`📧 Auto-payroll email sent to ${email}`);
      } else {
        console.warn(`⚠️ No email found for staff ${staff_id}`);
      }
    }
  } catch (err) {
    console.error('❌ Scheduled payroll error:', err.stack || err);
  }
};




setInterval(runScheduledMailer, 60000);
setInterval(runScheduledPayroll, 60000);

setTimeout(() => {}, 1 << 30);

