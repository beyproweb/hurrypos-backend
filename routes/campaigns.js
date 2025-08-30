// server/routes/campaigns.js
const express = require("express");
const router = express.Router();

// Try to support either { pool } or direct client export from ../db
let query = async () => ({ rows: [] });
try {
  const db = require("../db");
  if (db?.pool?.query) query = db.pool.query.bind(db.pool);
  else if (typeof db?.query === "function") query = db.query.bind(db);
} catch (_) {}

// deps
const nodemailer = require("nodemailer");
const cheerio = require("cheerio");

// ---- CONFIG ----
const PUBLIC_TRACKING_ORIGIN =
  process.env.PUBLIC_TRACKING_ORIGIN || "https://hurrypos-backend.onrender.com";

// Build a transporter *safely*. If SMTP is missing, we don't crash.
function buildTransporter() {
  const {
    SMTP_HOST,
    SMTP_PORT = "587",
    SMTP_USER,
    SMTP_PASS,
    SMTP_SECURE = "false",
    SMTP_STRATEGY,
  } = process.env;

  // Optional override: set SMTP_STRATEGY=json to fake-send (debug)
  if (String(SMTP_STRATEGY || "").toLowerCase() === "json") {
    return nodemailer.createTransport({ jsonTransport: true });
  }

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    // Don’t crash the server; force a clear 400 later
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: String(SMTP_SECURE).toLowerCase() === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

// --- tiny utils ---
function jsonError(res, code, message, extra = {}) {
  return res.status(code).json({ ok: false, error: message, ...extra });
}
function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function stripHtml(html = "") {
  return String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function trackOpenUrl(origin, cid, email) {
  const u = new URL(`/api/campaigns/track/open/${cid}`, origin);
  if (email) u.searchParams.set("email", email);
  return u.toString();
}
function trackClickUrl(origin, cid, email, url) {
  const u = new URL(`/api/campaigns/track/click/${cid}`, origin);
  if (email) u.searchParams.set("email", email);
  u.searchParams.set("url", url);
  return u.toString();
}
function injectTracking(html, origin, campaignId, email) {
  const $ = cheerio.load(html || "", { decodeEntities: false });
  $("a[href]").each((_, el) => {
    const $a = $(el);
    const href = ($a.attr("href") || "").trim();
    if (!/^https?:\/\//i.test(href)) return;
    $a.attr("href", trackClickUrl(origin, campaignId, email, href));
  });
  const pixel = `<img src="${trackOpenUrl(
    origin,
    campaignId,
    email
  )}" width="1" height="1" style="display:none;opacity:0" alt="" />`;
  if ($("body").length) $("body").append(pixel);
  else $.root().append(pixel);
  return $.html();
}

// Try to fetch recipients from customers.* if not provided
async function fetchAllRecipientEmails() {
  const candidates = [
    "SELECT DISTINCT email AS e FROM customers WHERE email IS NOT NULL AND email <> ''",
    "SELECT DISTINCT email_address AS e FROM customers WHERE email_address IS NOT NULL AND email_address <> ''",
    "SELECT DISTINCT mail AS e FROM customers WHERE mail IS NOT NULL AND mail <> ''",
  ];
  for (const sql of candidates) {
    try {
      const r = await query(sql);
      if (r?.rows?.length) return r.rows.map((x) => String(x.e).trim());
    } catch (_) {}
  }
  return [];
}

/**
 * POST /api/campaigns/email
 * Accepts your current payload: { subject, body }
 * Optional: { html, text, recipients[], fromEmail, fromName, name }
 */
router.post("/email", async (req, res) => {
  try {
    let {
      subject,
      body,
      html,
      text,
      recipients,
      fromEmail,
      fromName,
      name,
    } = req.body || {};

    if (!subject || typeof subject !== "string") {
      return jsonError(res, 400, "subject is required");
    }

    if (!html && body) {
      const safe = escapeHtml(String(body));
      html = `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;padding:12px;">
        <div>${safe.replace(/\n/g, "<br/>")}</div>
      </body></html>`;
      text = text || body;
    }
    if (!html) {
      return jsonError(res, 400, "html or body is required");
    }

    // recipients
    if (!Array.isArray(recipients) || recipients.length === 0) {
      recipients = await fetchAllRecipientEmails();
      if (recipients.length === 0) {
        return jsonError(
          res,
          400,
          "no recipients",
          { hint: "Pass recipients[] or ensure customers table has emails" }
        );
      }
    }

    // Transporter
    const transporter = buildTransporter();
    if (!transporter) {
      return jsonError(res, 400, "SMTP not configured", {
        required: ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"],
        tip: "For quick dry-run set SMTP_STRATEGY=json",
      });
    }

    // Verify connection (gives clear 400 instead of 500)
    try {
      await transporter.verify();
    } catch (e) {
      return jsonError(res, 400, "SMTP verify failed", { details: e.message });
    }

    const senderEmail =
      fromEmail || process.env.SMTP_FROM || process.env.SMTP_USER;
    const from =
      fromName && senderEmail ? `"${fromName}" <${senderEmail}>` : senderEmail;

    if (!from) {
      return jsonError(res, 400, "fromEmail or SMTP_FROM/SMTP_USER must be set");
    }

    // Ensure tables (best-effort; won’t 500 if DB missing)
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS campaigns (
          id BIGSERIAL PRIMARY KEY,
          name TEXT,
          subject TEXT,
          html TEXT,
          text TEXT,
          sent_count INTEGER DEFAULT 0,
          sent_at TIMESTAMP NULL
        );
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS campaign_events (
          id BIGSERIAL PRIMARY KEY,
          campaign_id BIGINT,
          customer_email TEXT,
          event_type TEXT,
          event_time TIMESTAMP DEFAULT NOW()
        );
      `);
    } catch (_) {}

    // Insert campaign shell (best-effort)
    let campaignId = null;
    const campaignName =
      name || `Campaign ${new Date().toISOString().slice(0, 10)}`;
    try {
      const ins = await query(
        `INSERT INTO campaigns (name, subject, html, text, sent_count, sent_at)
         VALUES ($1,$2,$3,$4,0,NULL)
         RETURNING id`,
        [campaignName, subject, html, text || null]
      );
      campaignId = ins?.rows?.[0]?.id || null;
    } catch (_) {}

    // de-dupe recipients
    const seen = new Set();
    const rcpts = recipients
      .map((r) => String(r || "").trim())
      .filter((r) => r && !seen.has(r) && (seen.add(r) || true));

    const origin = PUBLIC_TRACKING_ORIGIN;
    let sent = 0;
    const failures = [];

    for (const rcpt of rcpts) {
      try {
        const htmlTracked = campaignId
          ? injectTracking(html, origin, campaignId, rcpt)
          : html;

        await transporter.sendMail({
          from,
          to: rcpt,
          subject,
          html: htmlTracked,
          text: text || stripHtml(html),
        });

        sent += 1;
        try {
          if (campaignId) {
            await query(
              `INSERT INTO campaign_events (campaign_id, customer_email, event_type, event_time)
               VALUES ($1,$2,'sent',NOW())`,
              [campaignId, rcpt]
            );
          }
        } catch (_) {}
      } catch (e) {
        failures.push({ email: rcpt, error: e?.message || String(e) });
      }
    }

    try {
      if (campaignId && sent > 0) {
        await query(
          `UPDATE campaigns SET sent_count = $1, sent_at = NOW() WHERE id = $2`,
          [sent, campaignId]
        );
      }
    } catch (_) {}

    return res.json({
      ok: true,
      campaignId,
      name: campaignName,
      subject,
      sent,
      failed: failures.length,
      failures,
    });
  } catch (err) {
    // Return the real error to the client so you see why it failed
    return jsonError(res, 500, "internal_error", { details: err.message });
  }
});

// Keep your UI happy (no 404)
router.get("/stats/last", async (req, res) => {
  try {
    const r = await query(
      `SELECT id, subject, html, text, sent_count, sent_at
         FROM campaigns
        WHERE sent_at IS NOT NULL
        ORDER BY sent_at DESC
        LIMIT 1`
    );
    if (!r?.rows?.length) {
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

    let uOpen = 0,
      uClick = 0;
    try {
      const e = await query(
        `SELECT event_type, COUNT(DISTINCT customer_email) AS u
           FROM campaign_events
          WHERE campaign_id = $1 AND event_type IN ('open','click')
          GROUP BY event_type`,
        [c.id]
      );
      for (const row of e.rows || []) {
        if (row.event_type === "open") uOpen = Number(row.u || 0);
        else if (row.event_type === "click") uClick = Number(row.u || 0);
      }
    } catch (_) {}

    const sent = Number(c.sent_count || 0);
    const openRate = sent ? Math.round((uOpen / sent) * 1000) / 10 : 0;
    const clickRate = sent ? Math.round((uClick / sent) * 1000) / 10 : 0;

    return res.json({
      ok: true,
      subject: c.subject || "",
      message: c.text || stripHtml(c.html || ""),
      openRate,
      clickRate,
      sent_at: c.sent_at,
    });
  } catch (_) {
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

// trackers (optional)
const ONE_BY_ONE_GIF = Buffer.from(
  "47494638396101000100800000ffffff00000021f90401000001002c00000000010001000002024401003b",
  "hex"
);
router.get("/track/open/:campaignId", async (req, res) => {
  const { campaignId } = req.params;
  const email = String(req.query.email || "").slice(0, 256);
  try {
    await query(
      `INSERT INTO campaign_events (campaign_id, customer_email, event_type, event_time)
       VALUES ($1,$2,'open',NOW())`,
      [campaignId, email]
    );
  } catch (_) {}
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store");
  return res.send(ONE_BY_ONE_GIF);
});
router.get("/track/click/:campaignId", async (req, res) => {
  const { campaignId } = req.params;
  const email = String(req.query.email || "").slice(0, 256);
  const url = String(req.query.url || "");
  try {
    await query(
      `INSERT INTO campaign_events (campaign_id, customer_email, event_type, event_time)
       VALUES ($1,$2,'click',NOW())`,
      [campaignId, email]
    );
  } catch (_) {}
  if (!/^https?:\/\//i.test(url)) return res.status(400).send("bad url");
  return res.redirect(url);
});

module.exports = router;
