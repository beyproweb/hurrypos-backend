const express = require("express");
const router = express.Router();
const { pool } = require("../db");

const nodemailer = require("nodemailer");
const cheerio = require("cheerio");

const PUBLIC_TRACKING_ORIGIN = process.env.PUBLIC_TRACKING_ORIGIN || null;

// Reuse one SMTP connection
const transporter =
  global.__MAILER__ ||
  (global.__MAILER__ = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  }));

// ---------- helpers ----------
function getTrackingOrigin(req) {
  const originFromReq = `${req.protocol}://${req.get("host")}`;
  return PUBLIC_TRACKING_ORIGIN || originFromReq;
}
function buildOpenUrl(origin, cid, email) {
  const u = new URL(`/api/campaigns/track/open/${cid}`, origin);
  u.searchParams.set("email", email);
  return u.toString();
}
function buildClickUrl(origin, cid, email, targetUrl) {
  const u = new URL(`/api/campaigns/track/click/${cid}`, origin);
  u.searchParams.set("email", email);
  u.searchParams.set("url", targetUrl);
  return u.toString();
}
function rewriteAnchorsWithTracking(rawHtml, origin, cid, email) {
  const $ = cheerio.load(rawHtml || "", { decodeEntities: false });
  $("a[href]").each((_, el) => {
    const $a = $(el);
    const href = ($a.attr("href") || "").trim();
    if (!/^https?:\/\//i.test(href)) return; // keep mailto/tel/#/javascript:
    $a.attr("href", buildClickUrl(origin, cid, email, href));
  });
  const pixel = `<img src="${buildOpenUrl(origin, cid, email)}" width="1" height="1" alt="" style="display:none!important;opacity:0" />`;
  if ($("body").length) $("body").append(pixel);
  else $.root().append(pixel);
  return $.html();
}
function escapeHtml(s = "") {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
async function fetchAllRecipientEmails() {
  // Try common column names; stop at first that works/returns rows.
  const candidates = [
    "SELECT DISTINCT email AS e FROM customers WHERE email IS NOT NULL AND email <> ''",
    "SELECT DISTINCT email_address AS e FROM customers WHERE email_address IS NOT NULL AND email_address <> ''",
    "SELECT DISTINCT mail AS e FROM customers WHERE mail IS NOT NULL AND mail <> ''",
  ];
  for (const sql of candidates) {
    try {
      const res = await pool.query(sql);
      if (res?.rows?.length) return res.rows.map((r) => String(r.e).trim());
    } catch (_) {
      // ignore and try next
    }
  }
  return [];
}
function stripHtml(html = "") {
  return String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// ---------- API ----------

// POST /api/campaigns/email
// Accepts your current payload { subject, body } and optional { recipients[], html, text, fromEmail, fromName, name }
router.post("/email", async (req, res) => {
  try {
    let { subject, body, html, text, recipients, fromEmail, fromName, name } =
      req.body || {};

    if (!subject) {
      return res.status(400).json({ ok: false, error: "subject is required" });
    }

    // If frontend sent simple `body`, convert to safe HTML
    if (!html && body) {
      const safe = escapeHtml(String(body));
      html = `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;padding:12px;">
        <div>${safe.replace(/\n/g, "<br/>")}</div>
      </body></html>`;
      text = text || body;
    }
    if (!html) {
      return res.status(400).json({
        ok: false,
        error: "html or body is required",
      });
    }

    // If no recipients provided, send to all customers with an email
    if (!Array.isArray(recipients) || recipients.length === 0) {
      recipients = await fetchAllRecipientEmails();
      if (recipients.length === 0) {
        return res
          .status(400)
          .json({ ok: false, error: "No recipients found (customers.email empty)" });
      }
    }

    const senderEmail = fromEmail || process.env.SMTP_FROM || process.env.SMTP_USER;
    if (!senderEmail) {
      return res
        .status(400)
        .json({ ok: false, error: "fromEmail or SMTP_FROM/SMTP_USER must be set" });
    }
    const sender = fromName ? `"${fromName}" <${senderEmail}>` : senderEmail;

    // Insert campaign shell
    const campaignName = name || `Campaign ${new Date().toISOString().slice(0, 10)}`;
    const ins = await pool.query(
      `INSERT INTO campaigns (name, subject, html, text, sent_count, sent_at)
       VALUES ($1,$2,$3,$4,0,NULL)
       RETURNING id, name, subject`,
      [campaignName, subject, html, text || null]
    );
    const campaignId = ins.rows[0].id;

    const origin = getTrackingOrigin(req);

    // De-dupe
    const seen = new Set();
    const rcpts = recipients
      .map((r) => String(r || "").trim())
      .filter((r) => r && !seen.has(r) && (seen.add(r) || true));

    let sent = 0;
    const failures = [];

    for (const rcpt of rcpts) {
      try {
        const personalizedHtml = rewriteAnchorsWithTracking(html, origin, campaignId, rcpt);
        await transporter.sendMail({
          from: sender,
          to: rcpt,
          subject,
          html: personalizedHtml,
          text: text || stripHtml(html),
        });
        sent += 1;
        // Optional: record "sent" event; ignore if table missing.
        try {
          await pool.query(
            `INSERT INTO campaign_events (campaign_id, customer_email, event_type, event_time)
             VALUES ($1,$2,'sent',NOW())`,
            [campaignId, rcpt]
          );
        } catch (_) {}
      } catch (e) {
        failures.push({ email: rcpt, error: e?.message || String(e) });
      }
    }

    if (sent > 0) {
      await pool.query(
        `UPDATE campaigns SET sent_count = $1, sent_at = NOW() WHERE id = $2`,
        [sent, campaignId]
      );
    }

    return res.json({
      ok: true,
      campaignId,
      name: campaignName,
      subject,
      sent,
      failed: failures.length,
      failures,
      trackingOrigin: origin,
    });
  } catch (err) {
    console.error("POST /api/campaigns/email error:", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// GET /api/campaigns/stats/last  -> keeps your UI happy (returns 0% if no data)
router.get("/stats/last", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, subject, html, text, sent_count, sent_at
         FROM campaigns
        WHERE sent_at IS NOT NULL
        ORDER BY sent_at DESC
        LIMIT 1`
    );
    if (r.rows.length === 0) {
      return res.json({
        ok: true,
        subject: "",
        message: "",
        openRate: 0,
        clickRate: 0,
        sent_at: null,
      });
    }
    const c = r.rows[0];
    let opens = 0,
      uniqueOpens = 0,
      clicks = 0,
      uniqueClicks = 0;

    try {
      const e = await pool.query(
        `SELECT event_type, COUNT(*) AS n, COUNT(DISTINCT customer_email) AS u
           FROM campaign_events
          WHERE campaign_id = $1
            AND event_type IN ('open','click')
          GROUP BY event_type`,
        [c.id]
      );
      for (const row of e.rows) {
        if (row.event_type === "open") {
          opens = Number(row.n || 0);
          uniqueOpens = Number(row.u || 0);
        } else if (row.event_type === "click") {
          clicks = Number(row.n || 0);
          uniqueClicks = Number(row.u || 0);
        }
      }
    } catch (_) {
      // events table may not exist; keep zeros
    }

    const sent = Number(c.sent_count || 0) || 0;
    const openRate = sent ? Math.round((uniqueOpens / sent) * 1000) / 10 : 0;
    const clickRate = sent ? Math.round((uniqueClicks / sent) * 1000) / 10 : 0;

    return res.json({
      ok: true,
      subject: c.subject || "",
      message: c.text || stripHtml(c.html || ""),
      openRate,
      clickRate,
      sent_at: c.sent_at,
    });
  } catch (err) {
    console.error("GET /api/campaigns/stats/last error:", err);
    return res.json({
      ok: true,
      subject: "",
      message: "",
      openRate: 0,
      clickRate: 0,
      sent_at: null,
    });
  }
});

// OPTIONAL trackers (safe to ignore if you don’t need stats yet)
const ONE_BY_ONE_GIF = Buffer.from(
  "47494638396101000100800000ffffff00000021f90401000001002c00000000010001000002024401003b",
  "hex"
);

// 1×1 open pixel
router.get("/track/open/:campaignId", async (req, res) => {
  const { campaignId } = req.params;
  const email = String(req.query.email || "").slice(0, 256);
  try {
    await pool
      .query(
        `INSERT INTO campaign_events (campaign_id, customer_email, event_type, event_time)
         VALUES ($1,$2,'open',NOW())`
      , [campaignId, email]);
  } catch (_) {}
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store");
  return res.send(ONE_BY_ONE_GIF);
});

// click redirect
router.get("/track/click/:campaignId", async (req, res) => {
  const { campaignId } = req.params;
  const email = String(req.query.email || "").slice(0, 256);
  const target = String(req.query.url || "");
  try {
    await pool
      .query(
        `INSERT INTO campaign_events (campaign_id, customer_email, event_type, event_time)
         VALUES ($1,$2,'click',NOW())`
      , [campaignId, email]);
  } catch (_) {}
  if (!/^https?:\/\//i.test(target)) return res.status(400).send("bad url");
  return res.redirect(target);
});

module.exports = router;
