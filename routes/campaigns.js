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

// POST /api/campaigns/email  — Beypro landing style + click/open tracking
router.post("/email", async (req, res) => {
  // ---------- helpers ----------
  const cheerio = require("cheerio");
  const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

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
  function isProbablyHtml(s = "") {
    const t = String(s).trim();
    return /^<!doctype/i.test(t) || /^<html[\s>]/i.test(t) ||
           /<\/[a-z][\s\S]*>/i.test(t) || /<(div|table|p|span|section|img|a|h[1-6])\b/i.test(t);
  }
  function extractUrls(text) {
    const m = String(text).match(URL_RE) || [];
    const uniq = Array.from(new Set(m));
    return uniq.filter(u => /^https?:\/\//i.test(u));
  }
  function autoLink(text) {
    let safe = escapeHtml(text);
    safe = safe.replace(URL_RE, (m) => `<a href="${m}" target="_blank" rel="noopener">${m}</a>`);
    return safe.replace(/\r?\n\r?\n/g, "</p><p>").replace(/\r?\n/g, "<br/>");
  }

  // Colors tuned to your Beypro look (purple/indigo + orange headline)
  const COLORS = {
    brandName: req.body?.brand_name || "Beypro",
    blue:  "#5B6CFF",
    purple:"#6D28D9",
    orange:"#F97316",
    text:  "#111827",
    muted: "#6B7280",
    card:  "#FFFFFF",
    bg:    "#F8FAFC",
    border:"#E5E7EB",
    // CTA gradient (orange → indigo)
    gradLeft:  "#FF6A00",
    gradRight: "#5B6CFF",
  };

  function wrapDoc(inner) {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title></title>
</head>
<body style="margin:0;padding:24px;background:${COLORS.bg};font-family:Arial,Helvetica,sans-serif;">
  ${inner}
</body>
</html>`;
  }

  function beyproLanding({ subject, bodyHtml, orderUrl, reviewUrl, ctaText="Order / Review" }) {
    const nowYear = new Date().getFullYear();
    const ctaBtn = orderUrl ? `
      <div style="text-align:center;margin:24px 0 8px 0">
        <a href="${orderUrl}" target="_blank" rel="noopener"
           style="display:inline-block;padding:12px 20px;border-radius:12px;
                  background:${COLORS.blue};
                  background:linear-gradient(90deg, ${COLORS.gradLeft}, ${COLORS.gradRight});
                  color:#fff;text-decoration:none;font-weight:700;">
          ${escapeHtml(ctaText)}
        </a>
      </div>` : "";

    const footerLinks = [orderUrl ? `<a href="${orderUrl}" style="color:${COLORS.blue};text-decoration:underline" target="_blank" rel="noopener">Order</a>` : null,
                         reviewUrl ? `<a href="${reviewUrl}" style="color:${COLORS.blue};text-decoration:underline" target="_blank" rel="noopener">Review</a>` : null]
                         .filter(Boolean).join(" / ");

    const card = `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
             style="max-width:700px;margin:0 auto;border:1px solid ${COLORS.border};
                    border-radius:16px;background:${COLORS.card};">
        <tr>
          <td style="padding:28px 28px 16px 28px;text-align:center">
            <div style="font-size:28px;font-weight:800;color:${COLORS.blue};margin:0 0 8px 0">${escapeHtml(COLORS.brandName)}</div>
            <div style="font-size:20px;font-weight:800;color:${COLORS.orange};margin:0 0 10px 0">${escapeHtml(subject)}</div>
            <div style="color:${COLORS.muted};font-size:14px;margin-bottom:18px">Don't miss our special offer! 🚀</div>
            <div style="color:${COLORS.text};font-size:16px;line-height:1.6;text-align:center;margin-bottom:8px">
              ${bodyHtml}
            </div>
            ${ctaBtn}
            <div style="height:1px;background:${COLORS.border};margin:24px 0"></div>
            <div style="font-size:12px;color:${COLORS.muted};text-align:center">
              © ${nowYear} ${escapeHtml(COLORS.brandName)}${footerLinks ? " · " + footerLinks : ""}
              <br/>If you do not wish to receive this message, please let us know.
            </div>
          </td>
        </tr>
      </table>`;
    return wrapDoc(card);
  }

  // tracking helpers (use your existing injectTracking if present)
  function buildClickUrl(origin, cid, email, targetUrl) {
    const u = new URL(`/api/campaigns/track/click/${cid}`, origin);
    if (email) u.searchParams.set("email", email);
    u.searchParams.set("url", targetUrl);
    return u.toString();
  }
  function trackOpenUrl(origin, cid, email) {
    const u = new URL(`/api/campaigns/track/open/${cid}`, origin);
    if (email) u.searchParams.set("email", email);
    return u.toString();
  }
  function injectTrackingLocal(html, origin, campaignId, email) {
    const $ = cheerio.load(html || "", { decodeEntities: false });
    $("a[href]").each((_, el) => {
      const $a = $(el);
      const href = ($a.attr("href") || "").trim();
      if (!/^https?:\/\//i.test(href)) return;
      $a.attr("href", buildClickUrl(origin, campaignId, email, href));
    });
    const pixel = `<img src="${trackOpenUrl(origin, campaignId, email)}" width="1" height="1" alt="" style="display:none;opacity:0" />`;
    if ($("body").length) $("body").append(pixel);
    else $.root().append(pixel);
    return $.html();
  }
  const doInjectTracking =
    typeof injectTracking === "function" ? injectTracking : injectTrackingLocal;

  // ---------- handler ----------
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
      body_is_html,
      cta_text,
      order_url,
      review_url,
      primary_url,   // optional alias for order_url
    } = req.body || {};

    if (!subject || typeof subject !== "string") {
      return res.status(400).json({ ok:false, error:"subject is required" });
    }

    // compose HTML
    if (!html && body) {
      const looksHtml = body_is_html === true || isProbablyHtml(body);
      if (looksHtml) {
        html = /^<!doctype|^<html/i.test(String(body).trim()) ? body : wrapDoc(body);
        text = text || stripHtml(html);
      } else {
        const urls = extractUrls(body);
        const orderUrl = order_url || primary_url || urls[0] || null;
        const reviewUrl = review_url || urls[1] || null;
        const bodyHtml = autoLink(body);
        html = beyproLanding({
          subject,
          bodyHtml: `<p style="margin:0 0 8px 0">${bodyHtml}</p>`,
          orderUrl,
          reviewUrl,
          ctaText: cta_text || "Order / Review",
        });
        text = text || body;
      }
    }
    // If a primary_url is provided, guarantee a CTA is present
const primary = (req.body?.primary_url || "").trim();
if (primary && /^https?:\/\//i.test(primary)) {
  html = appendCta(html, primary, (req.body?.cta_text || "Open"));
}

    if (!html) {
      return res.status(400).json({ ok:false, error:"html or body is required" });
    }

    // recipients fallback
    if (!Array.isArray(recipients) || recipients.length === 0) {
      recipients = await fetchAllRecipientEmails();
      if (recipients.length === 0) {
        return res.status(400).json({ ok:false, error:"no recipients" });
      }
    }

    // SMTP
    const transporter = buildTransporter();
    if (!transporter) {
      return res.status(400).json({ ok:false, error:"SMTP not configured" });
    }
    try { await transporter.verify(); }
    catch (e) { return res.status(400).json({ ok:false, error:"SMTP verify failed", details:e.message }); }

    // From
    const senderEmail = fromEmail || process.env.SMTP_FROM || process.env.SMTP_USER;
    if (!senderEmail) return res.status(400).json({ ok:false, error:"fromEmail or SMTP_FROM/SMTP_USER must be set" });
    const from = fromName ? `"${fromName}" <${senderEmail}>` : senderEmail;

    // create campaign shell (best-effort)
    let campaignId = null;
    const campaignName = name || `Campaign ${new Date().toISOString().slice(0,10)}`;
    try {
      const ins = await query(
        `INSERT INTO campaigns (name, subject, html, text, sent_count, sent_at)
         VALUES ($1,$2,$3,$4,0,NULL)
         RETURNING id`,
        [campaignName, subject, html, text || null]
      );
      campaignId = ins?.rows?.[0]?.id || null;
    } catch (_) {}

    // send
    const origin = process.env.PUBLIC_TRACKING_ORIGIN || `${req.protocol}://${req.get("host")}`;
    const dedup = new Set();
    const rcpts = recipients.map(r => String(r || "").trim()).filter(r => r && !dedup.has(r) && (dedup.add(r) || true));
    let sent = 0; const failures = [];

    for (const rcpt of rcpts) {
      try {
        const htmlTracked = campaignId ? doInjectTracking(html, origin, campaignId, rcpt) : html;
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
               VALUES ($1,$2,'sent',NOW())`, [campaignId, rcpt]
            );
          }
        } catch (_) {}
      } catch (e) {
        failures.push({ email: rcpt, error: e?.message || String(e) });
      }
    }

    try {
      if (campaignId && sent > 0) {
        await query(`UPDATE campaigns SET sent_count=$1, sent_at=NOW() WHERE id=$2`, [sent, campaignId]);
      }
    } catch (_) {}

    return res.json({ ok:true, campaignId, name:campaignName, subject, sent, failed:failures.length, failures });
  } catch (err) {
    return res.status(500).json({ ok:false, error:"internal_error", details: err.message });
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
