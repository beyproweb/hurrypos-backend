const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { sendEmail } = require('../utils/notifications');
const whatsappClient = require('../whatsappBot');

// Helper to format phone (WhatsApp wants full international, e.g. '905*********')
function formatPhone(phone) {
    let n = phone.replace(/\D/g, '');
    if (n.startsWith('0')) n = '90' + n.slice(1); // Turkish
    if (!n.startsWith('90')) n = '90' + n;
    return n + '@c.us';
}

// Helper for Turkish polite greeting
function getGreeting(name) {
  if (!name) return "Merhaba";
  const first = name.split(" ")[0];
  // Crude but practical Turkish name gender check
  const endsWith = first.slice(-1).toLowerCase();
  let suffix = "Bey";
  if (endsWith === "e" || endsWith === "a" || endsWith === "i" || endsWith === "u" || endsWith === "ü") {
    suffix = "Hanım";
  }
  return `Merhaba ${first} ${suffix}`;
}

router.post('/whatsapp', async (req, res) => {
  const { body, phones } = req.body;
  if (!body) return res.status(400).json({ error: "Message body required" });

  try {
    let customers;
    if (Array.isArray(phones) && phones.length > 0) {
      const sql = `SELECT phone, name FROM customers WHERE phone = ANY($1)`;
      const { rows } = await pool.query(sql, [phones]);
      customers = rows;
    } else {
      const { rows } = await pool.query(`SELECT phone, name FROM customers WHERE phone IS NOT NULL`);
      customers = rows;
    }

    let sent = 0, failed = [];
    for (const customer of customers) {
      const chatId = formatPhone(customer.phone);
      const greeting = getGreeting(customer.name);
      const personalizedMessage = `${greeting},\n\n${body}`;
      try {
        await whatsappClient.sendMessage(chatId, personalizedMessage);
        sent++;
      } catch (err) {
        failed.push(customer.phone);
        console.error("❌ WhatsApp send fail:", customer.phone, err.message);
      }
    }

    res.json({ success: true, sent, failed });
  } catch (err) {
    console.error("❌ Error sending WhatsApp campaign:", err);
    res.status(500).json({ error: "Failed to send WhatsApp campaign" });
  }
});

// Inside routes/campaigns.js

router.get('/track/open/:cid', async (req, res) => {
  const { cid } = req.params;
  const email = req.query.email;
  await pool.query(`
    INSERT INTO campaign_events (campaign_id, customer_email, event_type, event_time)
    VALUES ($1, $2, 'open', NOW())
  `, [cid, email]);

  const img = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==',
    'base64'
  );
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': img.length
  });
  res.end(img);
});


// Click tracking + redirect
router.get('/track/click/:cid', async (req, res) => {
  const { cid } = req.params;
  const email = req.query.email;
  const url = req.query.url || 'https://beypro.com';

  console.log("➡️ Click tracking called:", { cid, email, url });

  try {
    await pool.query(`
      INSERT INTO campaign_events (campaign_id, customer_email, event_type, event_time)
      VALUES ($1, $2, 'click', NOW())
    `, [cid, email]);

    console.log("✅ Insert successful, redirecting...");
    res.redirect(url);
  } catch (err) {
    console.error("🔥 DB insert error in click tracking:", err);
    res.status(500).json({ error: err.message });
  }
});



router.get('/stats/last', async (req, res) => {
  // Get last campaign
  const { rows: [last] } = await pool.query(`
    SELECT id, subject, message, sent_at, sent_count
    FROM campaigns
    ORDER BY sent_at DESC
    LIMIT 1
  `);
  if (!last) return res.json({});

  const { rows: openRows } = await pool.query(`
    SELECT COUNT(DISTINCT customer_email) as opens
    FROM campaign_events WHERE campaign_id=$1 AND event_type='open'
  `, [last.id]);
  const { rows: clickRows } = await pool.query(`
    SELECT COUNT(DISTINCT customer_email) as clicks
    FROM campaign_events WHERE campaign_id=$1 AND event_type='click'
  `, [last.id]);

  // Calculate rates
  let openRate = 0, clickRate = 0;
  if (last.sent_count > 0) {
    openRate = Math.round((openRows[0].opens / last.sent_count) * 100);
    clickRate = Math.round((clickRows[0].clicks / last.sent_count) * 100);
  }

  res.json({
    ...last,
    openRate,
    clickRate
  });
});



// POST /api/campaigns/email
router.post('/email', async (req, res) => {
  const { subject, body } = req.body;
  if (!body) return res.status(400).json({ error: "Message body required" });

  try {
    // Get all customer emails
    const { rows: customers } = await pool.query(
      `SELECT email, name FROM customers WHERE email IS NOT NULL`
    );
    if (!customers.length)
      return res.status(400).json({ error: "No customers with email found." });

    // Insert campaign and get its ID BEFORE sending emails
    const { rows: [campaign] } = await pool.query(
      `INSERT INTO campaigns (subject, message, sent_at, sent_count)
       VALUES ($1, $2, NOW(), $3) RETURNING id`,
      [subject, body, customers.length]
    );
    const campaignId = campaign.id; // NOW this is defined!

    let sentCount = 0;
    for (const customer of customers) {
      const email = customer.email;

      // Dynamic tracking links for this campaign & customer
      const trackingPixel = `<img src="https://www.beypro.com/api/campaigns/track/open/${campaignId}?email=${encodeURIComponent(email)}" width="1" height="1" style="display:none;" alt=""/>`;
      const trackingLink = `https://www.beypro.com/api/campaigns/track/click/${campaignId}?email=${encodeURIComponent(email)}&url=https://beypro.com`;

      // HTML Email Block
      const emailHtml = `
<!DOCTYPE html>
<html lang="en" style="margin:0;padding:0;">
  <head>
    <meta charset="UTF-8" />
    <title>${subject || 'Kampanya'}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <style>
      body { margin: 0; padding: 0; background: #f7f7ff; font-family: 'Segoe UI', Arial, sans-serif; color: #222;}
      .container { max-width: 540px; margin: 40px auto; background: #fff; border-radius: 18px; box-shadow: 0 3px 16px 0 rgba(80, 38, 13, 0.08); padding: 32px 24px 28px 24px; text-align: center; border: 1px solid #f2e6da; }
      .logo { font-size: 30px; color: #4F46E5; font-weight: bold; letter-spacing: 1px; margin-bottom: 10px;}
      .headline { font-size: 25px; color: #ea580c; font-weight: 800; margin: 16px 0 10px 0;}
      .subtitle { color: #666; font-size: 17px; margin-bottom: 20px;}
      .main-content { font-size: 18px; margin-bottom: 30px; color: #222; line-height: 1.6;}
      .cta-btn { display: inline-block; background: linear-gradient(90deg,#ea580c,#4F46E5 80%); color: #fff !important; font-weight: bold; font-size: 17px; padding: 12px 38px; border-radius: 11px; text-decoration: none; margin-bottom: 20px; box-shadow: 0 2px 8px #d6d6ff44; letter-spacing: 0.5px; transition: background 0.2s;}
      .cta-btn:hover { background: linear-gradient(90deg,#4F46E5 10%, #ea580c 100%);}
      .footer { margin-top: 30px; font-size: 14px; color: #999; border-top: 1px solid #eee; padding-top: 14px;}
      @media (max-width:600px){
        .container { padding: 18px 6vw 22px 6vw; }
        .headline { font-size: 22px; }
        .main-content { font-size: 16px; }
        .cta-btn { font-size: 15px; padding: 11px 20px;}
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="logo">Beypro</div>
      <div class="headline">${subject || ''}</div>
      <div class="subtitle">Özel teklifimizi kaçırmayın! 🚀</div>
      <div class="main-content">
        ${body}
      </div>
      <a class="cta-btn" href="${trackingLink}">Sipariş Ver / İncele</a>
      <div class="footer">
        © 2025 Beypro ·
        <a href="${trackingLink}">Sipariş Ver / İncele</a>
        <br>
        Bu mesajı almak istemiyorsanız bize bildirin.
      </div>
    </div>
    ${trackingPixel}
  </body>
</html>
      `;

      await sendEmail(
        email,
        subject || 'Promotion from Beypro',
        emailHtml,
        true
      );
      sentCount++;
    }

    res.json({ success: true, sent: sentCount });
  } catch (err) {
    console.error("❌ Error sending campaign:", err);
    res.status(500).json({ error: "Failed to send campaign" });
  }
});



module.exports = router;
