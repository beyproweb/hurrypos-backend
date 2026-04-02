require("dotenv").config();

const { pool } = require("./db");
const { sendEmail } = require("./utils/notifications");
const sendNoOrderEmail = require("./utils/sendNoOrderEmail");
const { loadLocalizationForRestaurant } = require("./utils/localization");
const { getCurrencyMeta } = require("./utils/currency");
const { isTurkishLanguage, resolveRestaurantEmailLanguage } = require("./utils/emailLanguage");
const dayjs = require("dayjs");

const RESEND_PROVIDER = process.env.RESEND_API_KEY ? "resend" : undefined;

console.log("⏰ Scheduled mailer started. Waiting for carts...");

const restaurantContactCache = new Map();
const restaurantLanguageCache = new Map();
async function getRestaurantContact(restaurantId) {
  const key = String(restaurantId);
  if (restaurantContactCache.has(key)) return restaurantContactCache.get(key);

  const contact = { email: null, restaurantName: null, ownerName: null };

  try {
    const res = await pool.query(
      `
      SELECT
        r.name AS restaurant_name,
        u.email AS owner_email,
        u.full_name AS owner_name
      FROM restaurants r
      LEFT JOIN users u ON u.id = r.owner_id
      WHERE r.id = $1
      LIMIT 1
      `,
      [restaurantId]
    );

    const row = res.rows?.[0];
    if (row) {
      contact.restaurantName = row.restaurant_name || null;
      contact.ownerName = row.owner_name || null;
      contact.email = row.owner_email || null;
    }

    if (!contact.email) {
      const fallback = await pool.query(
        `
        SELECT email, full_name AS owner_name
        FROM users
        WHERE restaurant_id = $1
          AND email IS NOT NULL
          AND TRIM(email) <> ''
        ORDER BY (role = 'admin') DESC, id ASC
        LIMIT 1
        `,
        [restaurantId]
      );
      const fb = fallback.rows?.[0];
      if (fb) {
        contact.email = fb.email || contact.email;
        contact.ownerName = fb.owner_name || contact.ownerName;
      }
    }
  } catch (err) {
    console.warn("⚠️ Failed to load restaurant contact:", err?.message || err);
  }

  restaurantContactCache.set(key, contact);
  return contact;
}

async function getRestaurantEmailLanguage(restaurantId) {
  const key = String(restaurantId || "");
  if (restaurantLanguageCache.has(key)) {
    return restaurantLanguageCache.get(key);
  }
  const language = await resolveRestaurantEmailLanguage(restaurantId, { fallback: "en" });
  restaurantLanguageCache.set(key, language);
  return language;
}

function computeNextScheduledAt(currentScheduledAt, repeatType) {
  const now = dayjs();
  let next = dayjs(currentScheduledAt);
  if (!next.isValid()) next = now;

  const type = String(repeatType || "").toLowerCase().trim() || "weekly";
  const step = (date) => {
    if (type === "daily") return date.add(1, "day");
    if (type === "monthly") return date.add(1, "month");
    return date.add(7, "day"); // weekly/default
  };

  let guard = 0;
  while (!next.isAfter(now) && guard < 60) {
    next = step(next);
    guard += 1;
  }

  return next.toDate();
}

const checkItemRecentlyCritical = async (restaurantId, stock_id) => {
  const res = await pool.query(
    `SELECT quantity, critical_quantity, last_auto_add_at
     FROM stock
     WHERE restaurant_id=$1 AND id=$2`,
    [restaurantId, stock_id]
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

    // fetch all tenant carts that should be processed
    const cartRes = await pool.query(`
      SELECT sc.id, sc.restaurant_id, sc.supplier_id, sc.scheduled_at,
             sc.repeat_type, sc.repeat_days, sc.auto_confirm, sc.confirmed, sc.archived,
             sp.name AS supplier_name, sp.email
      FROM supplier_carts sc
      INNER JOIN suppliers sp ON sc.supplier_id = sp.id AND sp.restaurant_id=sc.restaurant_id
      WHERE sc.confirmed = true
        AND sc.archived = false
        AND sc.auto_confirm = true
        AND sc.scheduled_at IS NOT NULL
        AND sc.scheduled_at <= NOW()
      ORDER BY sc.scheduled_at ASC
      LIMIT 20
    `);

    for (const cart of cartRes.rows) {
      const { restaurant_id } = cart;
      const restaurantContact = await getRestaurantContact(restaurant_id);
      const emailLanguage = await getRestaurantEmailLanguage(restaurant_id);
      const useTurkish = isTurkishLanguage(emailLanguage);
      const replyTo = restaurantContact?.email || undefined;

      const itemsRes = await pool.query(
        `SELECT * FROM supplier_cart_items
         WHERE restaurant_id=$1 AND cart_id=$2`,
        [restaurant_id, cart.id]
      );
      const items = itemsRes.rows;

      const hasAnyItems = Array.isArray(items) && items.length > 0;

      if (!hasAnyItems) {
        console.log(`⏭️ Cart ${cart.id} has no items (no-order week)`);

        if (cart.email) {
          await sendNoOrderEmail(cart.supplier_name, cart.email, cart.scheduled_at, {
            replyTo,
            restaurantName: restaurantContact?.restaurantName || null,
            language: emailLanguage,
          });
          console.log(`📭 No-order email sent to: ${cart.email}`);
        } else {
          console.warn(`⚠️ Cart ${cart.id} has no supplier email.`);
        }
      } else {
        const restaurantContactLine = replyTo
          ? `<p><strong>${useTurkish ? "Restoran iletisim" : "Restaurant contact"}:</strong> <a href="mailto:${replyTo}">${replyTo}</a></p>`
          : "";
        const formattedScheduleDate = new Date(cart.scheduled_at).toLocaleString(
          useTurkish ? "tr-TR" : "en-US",
          { hour12: false }
        );
        const htmlBody = `
          <h2>${useTurkish ? "📦 Yeni Tedarikci Siparisi" : "📦 New Supplier Order"}</h2>
          ${restaurantContactLine}
          <p><strong>${useTurkish ? "Tedarikci" : "Supplier"}:</strong> ${cart.supplier_name}</p>
          <p><strong>${useTurkish ? "Planlanan tarih" : "Scheduled for"}:</strong> ${formattedScheduleDate}</p>
          <h3>${useTurkish ? "📝 Urunler" : "📝 Products"}:</h3>
          <ul>
            ${items
              .map(
                (item) =>
                  `<li>${item.product_name} — ${item.quantity} ${item.unit}</li>`
              )
              .join("")}
          </ul>
          <p style="margin-top:1.5em;">${
            useTurkish ? "Iyi calismalar" : "Best regards"
          },<br><strong>Beypro</strong></p>
        `;

        if (cart.email) {
          await sendEmail(
            cart.email,
            useTurkish ? "📦 Beypro Planli Siparis" : "📦 Beypro Scheduled Order",
            htmlBody,
            true,
            {
            replyTo,
            fromName: "Beypro Orders",
            language: emailLanguage,
            provider: RESEND_PROVIDER,
            throwOnError: true,
            }
          );
          console.log(`✅ Email sent to: ${cart.email}`);
        } else {
          console.warn(`⚠️ Cart ${cart.id} has no supplier email.`);
        }

        // Reset auto-add flags for all items (same as manual send endpoint)
        for (const item of items) {
          if (!item.stock_id) continue;
          await pool.query(
            `UPDATE stock
             SET auto_added_to_cart=FALSE, last_auto_add_at=NULL
             WHERE restaurant_id=$1 AND id=$2`,
            [restaurant_id, item.stock_id]
          );
        }
      }

      // Clear items so next cycle starts empty
      await pool.query(
        `DELETE FROM supplier_cart_items
         WHERE restaurant_id=$1 AND cart_id=$2`,
        [restaurant_id, cart.id]
      );

      // Keep the cart active but move schedule forward, so auto-send stays enabled in UI.
      const nextScheduledAt = computeNextScheduledAt(cart.scheduled_at, cart.repeat_type);
      await pool.query(
        `UPDATE supplier_carts
         SET scheduled_at = $3,
             skipped = $4,
             archived = false,
             confirmed = true
         WHERE restaurant_id=$1 AND id=$2`,
        [restaurant_id, cart.id, nextScheduledAt, !hasAnyItems]
      );
      console.log(`📆 Rescheduled cart ${cart.id} -> ${nextScheduledAt.toISOString()}`);
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

    const res = await pool.query(`
      SELECT s.id AS staff_id, s.salary_model, s.payment_type, s.hourly_rate,
             s.monthly_salary, s.weekly_salary, s.name, s.email, s.role,
             s.restaurant_id,
             ssp.repeat_type, ssp.repeat_time
      FROM scheduled_staff_payroll ssp
      INNER JOIN staff s ON ssp.staff_id = s.id
      WHERE ssp.active = true
        AND ssp.repeat_time = $1
    `, [timeNow]);

    for (const row of res.rows) {
      const { staff_id, salary_model, payment_type, hourly_rate, weekly_salary, monthly_salary, name, email, role, restaurant_id } = row;

      const paidCheck = await pool.query(`
        SELECT 1 FROM staff_payments
        WHERE staff_id = $1 AND payment_date = $2 AND auto = true AND amount > 0
      `, [staff_id, today]);

      if (paidCheck.rowCount > 0) {
        console.log(`⏭️ Staff ${staff_id} already auto-paid today`);
        continue;
      }

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

      let amount = 0;
      if (salary_model === "hourly") {
        amount = (hourly_rate || 0) * (totalMinutes / 60);
      } else if (salary_model === "fixed" && payment_type === "weekly") {
        amount = weekly_salary;
      } else if (salary_model === "fixed" && payment_type === "monthly") {
        amount = monthly_salary;
      }

      if (!amount || amount <= 0) {
        console.log(`⚠️ No earned salary for staff ${staff_id}, skipping`);
        continue;
      }

      await pool.query(`
        INSERT INTO staff_payments (
          staff_id, amount, payment_method, note, auto, scheduled_date, payment_date, restaurant_id
        )
        VALUES ($1, $2, 'cash', '[AUTO Payroll]', true, $3, $3, $4)
      `, [staff_id, amount.toFixed(2), today, restaurant_id]);

      let symbol = "₺";
      try {
        const localization = await loadLocalizationForRestaurant(restaurant_id);
        const meta = getCurrencyMeta(localization?.currency);
        symbol = meta.symbol || symbol;
      } catch (err) {
        console.warn(
          "⚠️ Failed to resolve currency for payroll:",
          err?.message || err
        );
      }

      console.log(`✅ Auto-paid staff ${staff_id} ${symbol}${amount.toFixed(2)}`);

      if (email) {
        const emailLanguage = await getRestaurantEmailLanguage(restaurant_id);
        const useTurkish = isTurkishLanguage(emailLanguage);
        const subject = useTurkish
          ? `📄 Maas Bordrosu - ${name}`
          : `📄 Payroll Receipt - ${name}`;
        const html = `
          <h2>${useTurkish ? "💼 Maas Bordrosu" : "💼 Payroll Receipt"}</h2>
          <p><strong>${useTurkish ? "Ad Soyad" : "Name"}:</strong> ${name}</p>
          <p><strong>${useTurkish ? "Rol" : "Role"}:</strong> ${role}</p>
          <p><strong>${useTurkish ? "Odenen Tutar" : "Amount Paid"}:</strong> ${symbol}${amount.toFixed(2)}</p>
          <p><strong>${useTurkish ? "Yontem" : "Method"}:</strong> cash</p>
          <p><strong>${useTurkish ? "Tarih" : "Date"}:</strong> ${today}</p>
          <p><strong>${useTurkish ? "Not" : "Note"}:</strong> [AUTO Payroll]</p>
          <p style="margin-top:2em;">${
            useTurkish ? "Emeginiz icin tesekkur ederiz!" : "Thank you for your dedication!"
          }<br><strong>Beypro</strong></p>
        `;

        const restaurantContact = await getRestaurantContact(restaurant_id);
        await sendEmail(email, subject, html, true, {
          replyTo: restaurantContact?.email || undefined,
          fromName: "Beypro Payroll",
          language: emailLanguage,
        });
        console.log(`📧 Auto-payroll email sent to ${email}`);
      } else {
        console.warn(`⚠️ No email found for staff ${staff_id}`);
      }
    }
  } catch (err) {
    console.error("❌ Scheduled payroll error:", err.stack || err);
  }
};

// Run every minute
setInterval(runScheduledMailer, 60000);
setInterval(runScheduledPayroll, 60000);

// keep process alive
setTimeout(() => {}, 1 << 30);
