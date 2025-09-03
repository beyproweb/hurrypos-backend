// server/routes/campaigns.js
const express = require("express");
const router = express.Router();

/* =========================================================
   In-memory fallback so stats work even if DB writes fail
   ========================================================= */
const recentEvents = new Map(); // Map<cid, {sent:Set, opens:Set, clicks:Set, last:Date}>
function rememberEvent(cid, type, email) {
  if (!cid) return;
  const id = String(cid);
  const rec =
    recentEvents.get(id) ||
    { sent: new Set(), opens: new Set(), clicks: new Set(), last: new Date() };
  if (type === "sent" && email) rec.sent.add(String(email));
  if (type === "open" && email) rec.opens.add(String(email));
  if (type === "click" && email) rec.clicks.add(String(email));
  rec.last = new Date();
  recentEvents.set(id, rec);
}
function getRecentCounts(cid) {
  const r = recentEvents.get(String(cid));
  return r
    ? { sent: r.sent.size, opens: r.opens.size, clicks: r.clicks.size }
    : { sent: 0, opens: 0, clicks: 0 };
}

/* =========================================================
   DB helper (supports ../db exporting { pool } or query())
   ========================================================= */
async function q(sql, params = []) {
  try {
    const db = require("../db");
    if (db?.pool?.query) return await db.pool.query(sql, params);
    if (typeof db?.query === "function") return await db.query(sql, params);
  } catch (_) {}
  return null;
}

/* =========================================================
   Soft deps + config
   ========================================================= */
function tryRequire(m) {
  try {
    return require(m);
  } catch {
    return null;
  }
}
const nodemailer = tryRequire("nodemailer"); // may be null
const cheerio = tryRequire("cheerio"); // may be null

const PUBLIC_TRACKING_ORIGIN =
  process.env.PUBLIC_TRACKING_ORIGIN || "https://hurrypos-backend.onrender.com";

/* =========================================================
   Tiny utils
   ========================================================= */
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
  return (
    /^<!doctype/i.test(t) ||
    /^<html[\s>]/i.test(t) ||
    /<\/[a-z][\s\S]*>/i.test(t) ||
    /<(div|table|p|span|section|img|a|h[1-6])\b/i.test(t)
  );
}
function wrapDoc(inner = "") {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
</head>
<body style="margin:0;background:#ffffff;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#111827;line-height:1.5">
${inner}
</body>
</html>`;
}
function autoLink(text) {
  let safe = escapeHtml(text || "");
  safe = safe.replace(
    URL_RE,
    (m) => `<a href="${m}" target="_blank" rel="noopener">${m}</a>`
  );
  return `<p>${safe
    .replace(/\r?\n\r?\n/g, "</p><p>")
    .replace(/\r?\n/g, "<br/>")}</p>`;
}
function buildCtaBlock(url, text = "Open") {
  return `
  <div style="text-align:center;margin:24px 0">
    <a href="${url}" target="_blank" rel="noopener"
       style="display:inline-block;padding:12px 18px;background:#111827;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">${escapeHtml(
         text
       )}</a>
  </div>`;
}
function appendBeforeBodyEnd(html, snippet) {
  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, snippet + "</body>")
    : html + snippet;
}
function getSafeOrigin(req) {
  let raw =
    process.env.PUBLIC_TRACKING_ORIGIN ||
    `${req.protocol}://${req.get("host")}`;
  raw = String(raw || "").trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  return raw.replace(/\/+$/, "");
}

/* =========================================================
   Transporter (never crashes; JSON transport fallback)
   ========================================================= */
function buildTransporter() {
  if (!nodemailer) return null; // tell caller to install nodemailer if needed
  const {
    SMTP_HOST,
    SMTP_PORT = "587",
    SMTP_USER,
    SMTP_PASS,
    SMTP_SECURE = "false",
    SMTP_STRATEGY,
  } = process.env;

  // Explicit debug mode
  if (String(SMTP_STRATEGY || "").toLowerCase() === "json") {
    return nodemailer.createTransport({ jsonTransport: true });
  }

  // If SMTP creds are missing, fallback to JSON transport so you can test end-to-end without 500
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return nodemailer.createTransport({ jsonTransport: true });
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: String(SMTP_SECURE).toLowerCase() === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

/* =========================================================
   Link rewrite per recipient (uses cheerio if available)
   ========================================================= */
function rewritePerRecipient(html, origin, cid, email) {
  try {
    if (cheerio) {
      const $ = cheerio.load(html || "", { decodeEntities: false });
      $("a[href]").each((_, el) => {
        const $a = $(el);
        const href = ($a.attr("href") || "").trim();
        if (!/^https?:\/\//i.test(href)) return;
        const u = new URL(`/api/campaigns/track/click/${cid}`, origin);
        if (email) u.searchParams.set("email", email);
        u.searchParams.set("url", href);
        $a.attr("href", u.toString());
      });
      const pixel = new URL(`/api/campaigns/track/open/${cid}`, origin);
      if (email) pixel.searchParams.set("email", email);
      const img = `<img src="${pixel.toString()}" width="1" height="1" style="display:none;opacity:0" alt=""/>`;
      if ($("body").length) $("body").append(img);
      else $.root().append(img);
      return $.html();
    }

    // regex fallback if cheerio not installed
    const wrapClick = (href) => {
      const u = new URL(`/api/campaigns/track/click/${cid}`, origin);
      if (email) u.searchParams.set("email", email);
      u.searchParams.set("url", href);
      return u.toString();
    };
    let out = String(html || "").replace(
      /href="(https?:[^"]+)"/gi,
      (_, href) => `href="${wrapClick(href)}"`
    );
    const px = new URL(`/api/campaigns/track/open/${cid}`, origin);
    if (email) px.searchParams.set("email", email);
    out = appendBeforeBodyEnd(
      out,
      `<img src="${px.toString()}" width="1" height="1" style="display:none;opacity:0" alt=""/>`
    );
    return out;
  } catch {
    return html; // never throw
  }
}

/* =========================================================
   Recipients from DB (various schemas)
   ========================================================= */
async function fetchAllRecipientEmails() {
  const candidates = [
    "SELECT DISTINCT email AS e FROM customers WHERE email IS NOT NULL AND email <> ''",
    "SELECT DISTINCT email_address AS e FROM customers WHERE email_address IS NOT NULL AND email_address <> ''",
    "SELECT DISTINCT mail AS e FROM customers WHERE mail IS NOT NULL AND mail <> ''",
  ];
  for (const sql of candidates) {
    try {
      const r = await q(sql);
      if (r?.rows?.length) return r.rows.map((x) => String(x.e).trim());
    } catch (_) {}
  }
  return [];
}

// GET /api/campaigns/list - last 20 campaigns
router.get("/list", async (req, res) => {
  try {
    const r = await q(
      `SELECT id::text id, subject, text, html, sent_count, sent_at
       FROM campaigns
       WHERE sent_at IS NOT NULL
       ORDER BY sent_at DESC
       LIMIT 20`
    );
    const campaigns = (r?.rows || []).map(c => ({
      id: c.id,
      subject: c.subject || "",
      message: c.text || stripHtml(c.html || ""),
      sent_at: c.sent_at,
      sent_count: c.sent_count || 0,
    }));
    res.json({ ok: true, campaigns });
  } catch (e) {
    res.json({ ok: false, error: e?.message || "failed to fetch" });
  }
});


/* =========================================================
   POST /api/campaigns/email
   - robust input handling
   - guaranteed CTA if primary_url present
   - tracking pixel + per-recipient click rewrites
   - never 500s (returns 400 with details on bad inputs)
   ========================================================= */
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
      body_is_html,
      primary_url,
      cta_text,
    } = req.body || {};

    if (!subject || typeof subject !== "string") {
      return res.status(400).json({ ok: false, error: "subject is required" });
    }

    // Build HTML from body if needed
    if (!html && body) {
      const looksHtml = body_is_html === true || isProbablyHtml(body);
      if (looksHtml) {
        html = /^<!doctype|^<html/i.test(String(body).trim())
          ? body
          : wrapDoc(body);
        text = text || stripHtml(html);
      } else {
        const inner = autoLink(body);
        html = wrapDoc(inner);
        text = text || body;
      }
    }
    if (!html) {
      return res
        .status(400)
        .json({ ok: false, error: "html or body is required" });
    }

    // Guaranteed CTA when primary_url is provided
    if (primary_url && /^https?:\/\//i.test(primary_url)) {
      html = appendBeforeBodyEnd(html, buildCtaBlock(primary_url, cta_text || "Open"));
    }

    // Recipients
    if (!Array.isArray(recipients) || recipients.length === 0) {
      recipients = await fetchAllRecipientEmails();
      if (recipients.length === 0) {
        return res.status(400).json({ ok: false, error: "no recipients" });
      }
    }
    // De-dupe
    const seen = new Set();
    const rcpts = recipients
      .map((r) => String(r || "").trim())
      .filter((r) => r && !seen.has(r) && (seen.add(r) || true));

    // Transporter
    const transporter = buildTransporter();
    if (!transporter) {
      return res
        .status(400)
        .json({ ok: false, error: "nodemailer not installed (npm i nodemailer)" });
    }
    try {
      await transporter.verify();
    } catch {
      // ignore (json transport or lenient SMTP)
    }

    // Ensure tables exist (best effort)
    try {
      await q(`CREATE TABLE IF NOT EXISTS campaigns (
        id BIGSERIAL PRIMARY KEY,
        name TEXT,
        subject TEXT,
        html TEXT,
        text TEXT,
        sent_count INTEGER DEFAULT 0,
        sent_at TIMESTAMP NULL
      )`);
      await q(`CREATE TABLE IF NOT EXISTS campaign_events (
        id BIGSERIAL PRIMARY KEY,
        campaign_id TEXT,
        customer_email TEXT,
        event_type TEXT,
        event_time TIMESTAMP DEFAULT NOW()
      )`);
    } catch (_) {}

    // Insert campaign row
    let campaignId = Date.now().toString();
    try {
      const ins = await q(
        `INSERT INTO campaigns (name, subject, html, text, sent_count, sent_at)
         VALUES ($1,$2,$3,$4,0,NULL) RETURNING id`,
        [name || `Campaign ${new Date().toISOString().slice(0, 10)}`, subject, html, text || null]
      );
      if (ins?.rows?.[0]?.id) campaignId = String(ins.rows[0].id);
    } catch (_) {}

    // Send per recipient
    const origin = getSafeOrigin(req);
    const senderEmail =
      fromEmail ||
      process.env.SMTP_FROM ||
      process.env.SMTP_USER ||
      "no-reply@example.com";
    const from = fromName ? `"${fromName}" <${senderEmail}>` : senderEmail;

    let sent = 0;
    const failures = [];

    for (const rcpt of rcpts) {
      try {
        const htmlTracked = rewritePerRecipient(html, origin, campaignId, rcpt);

        await transporter.sendMail({
          from,
          to: rcpt,
          subject,
          html: htmlTracked,
          text: text || stripHtml(htmlTracked),
        });

        // DB: log 'sent'
        try {
          await q(
            `INSERT INTO campaign_events (campaign_id, customer_email, event_type)
             VALUES ($1,$2,'sent')`,
            [String(campaignId), String(rcpt)]
          );
        } catch (_) {}

        // Memory denominator
        rememberEvent(campaignId, "sent", rcpt);
        sent += 1;
      } catch (e) {
        failures.push({ email: rcpt, error: e?.message || String(e) });
      }
    }

    // Update counters (best effort)
    try {
      if (sent > 0) {
        await q(
          `UPDATE campaigns SET sent_count=$1, sent_at=NOW() WHERE id=$2`,
          [sent, campaignId]
        );
      }
    } catch (_) {}

    return res.json({
      ok: true,
      campaignId,
      sent,
      failed: failures.length,
      failures,
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      details: err?.message || String(err),
    });
  }
});

/* =========================================================
   Stats: last campaign (by sent_at or by any event)
   ========================================================= */
router.get("/stats/last", async (req, res) => {
  try {
    // Ensure tables (best effort)
    try {
      await q(`CREATE TABLE IF NOT EXISTS campaigns (
        id BIGSERIAL PRIMARY KEY, name TEXT, subject TEXT, html TEXT, text TEXT,
        sent_count INTEGER DEFAULT 0, sent_at TIMESTAMP NULL
      )`);
      await q(`CREATE TABLE IF NOT EXISTS campaign_events (
        id BIGSERIAL PRIMARY KEY, campaign_id TEXT, customer_email TEXT,
        event_type TEXT, event_time TIMESTAMP DEFAULT NOW()
      )`);
    } catch (_) {}

    // newest by sent_at
    let camp = null;
    const r1 = await q(
      `SELECT id::text id, subject, html, text, sent_count, sent_at
       FROM campaigns
       WHERE sent_at IS NOT NULL
       ORDER BY sent_at DESC
       LIMIT 1`
    );
    if (r1?.rows?.length) camp = r1.rows[0];

    // newest by any event
    const r2 = await q(
      `SELECT campaign_id::text id, MAX(event_time) t
       FROM campaign_events
       GROUP BY campaign_id
       ORDER BY MAX(event_time) DESC
       LIMIT 1`
    );
    if (r2?.rows?.length) {
      const ev = r2.rows[0];
      if (!camp || (camp.sent_at && new Date(ev.t) > new Date(camp.sent_at))) {
        const r3 = await q(
          `SELECT id::text id, subject, html, text, sent_count, sent_at
           FROM campaigns WHERE id::text=$1 LIMIT 1`,
          [ev.id]
        );
        camp =
          r3?.rows?.[0] || {
            id: ev.id,
            subject: "",
            html: "",
            text: "",
            sent_count: 0,
            sent_at: ev.t,
          };
      }
    }

    // fallback to memory
    if (!camp && recentEvents.size) {
      const [id, rec] = [...recentEvents.entries()].sort(
        (a, b) => b[1].last - a[1].last
      )[0];
      camp = { id, subject: "", html: "", text: "", sent_count: 0, sent_at: rec.last };
    }
    if (!camp) {
      return res.json({
        ok: true,
        subject: "",
        message: "",
        openRate: 0,
        clickRate: 0,
        sent_at: null,
      });
    }

    // denominator
    let sent = Number(camp.sent_count || 0) || 0;
    if (!sent) {
      const s = await q(
        `SELECT COUNT(DISTINCT customer_email) u
         FROM campaign_events
         WHERE campaign_id::text=$1 AND event_type='sent'`,
        [camp.id]
      );
      sent = Number(s?.rows?.[0]?.u || 0);
    }
    if (!sent) {
      const mem = getRecentCounts(camp.id);
      sent = mem.sent || 0;
    }

    // numerators
    let dbO = 0,
      dbC = 0;
    const e = await q(
      `SELECT event_type, COUNT(DISTINCT customer_email) u
       FROM campaign_events
       WHERE campaign_id::text=$1 AND event_type IN ('open','click')
       GROUP BY event_type`,
      [camp.id]
    );
    for (const row of e?.rows || []) {
      if (row.event_type === "open") dbO = Number(row.u || 0);
      if (row.event_type === "click") dbC = Number(row.u || 0);
    }
    const mem = getRecentCounts(camp.id);
    const uOpen = Math.max(dbO, mem.opens);
    const uClick = Math.max(dbC, mem.clicks);

    const openRate = sent ? Math.round((uOpen / sent) * 1000) / 10 : 0;
    const clickRate = sent ? Math.round((uClick / sent) * 1000) / 10 : 0;

    return res.json({
      ok: true,
      subject: camp.subject || "",
      message: camp.text || stripHtml(camp.html || ""),
      openRate,
      clickRate,
      sent_at: camp.sent_at,
    });
  } catch {
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

/* =========================================================
   Stats: by exact campaign id
   ========================================================= */
router.get("/stats/by/:campaignId", async (req, res) => {
  const id = String(req.params.campaignId || "");
  let rows = [];
  try {
    const r = await q(
      `SELECT id::text AS id, subject, html, text, sent_count, sent_at
       FROM campaigns WHERE id::text=$1 LIMIT 1`,
      [id]
    );
    const camp =
      r?.rows?.[0] || { id, subject: "", html: "", text: "", sent_count: 0, sent_at: null };

    let sent = Number(camp.sent_count || 0) || 0;
    if (!sent) {
      const s = await q(
        `SELECT COUNT(DISTINCT customer_email) AS u
         FROM campaign_events
         WHERE campaign_id::text=$1 AND event_type='sent'`,
        [id]
      );
      sent = Number(s?.rows?.[0]?.u || 0);
    }

    const e = await q(
      `SELECT event_type, COUNT(DISTINCT customer_email) AS u
       FROM campaign_events
       WHERE campaign_id::text=$1 AND event_type IN ('open','click')
       GROUP BY event_type`,
      [id]
    );
    rows = e?.rows || [];
    let uo = 0,
      uc = 0;
    for (const row of rows) {
      if (row.event_type === "open") uo = Number(row.u || 0);
      else if (row.event_type === "click") uc = Number(row.u || 0);
    }
    const openRate = sent ? Math.round((uo / sent) * 1000) / 10 : 0;
    const clickRate = sent ? Math.round((uc / sent) * 1000) / 10 : 0;

    return res.json({
      ok: true,
      subject: camp.subject || "",
      message: camp.text || stripHtml(camp.html || ""),
      openRate,
      clickRate,
      sent_at: camp.sent_at,
    });
  } catch {
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

/* =========================================================
   Recent events (debug)
   ========================================================= */
router.get("/events/recent", async (_req, res) => {
  try {
    const r = await q(
      `SELECT campaign_id, customer_email, event_type, event_time
       FROM campaign_events
       ORDER BY event_time DESC, id DESC
       LIMIT 25`
    );
    const mem = [...recentEvents.entries()].map(([id, rec]) => ({
      campaign_id: id,
      opens: rec.opens.size,
      clicks: rec.clicks.size,
      last: rec.last,
    }));
    res.json({ ok: true, db: r?.rows || [], memory: mem });
  } catch (e) {
    res.json({ ok: true, db: [], memory: [...recentEvents.keys()] });
  }
});

/* =========================================================
   Tracking (single, canonical implementations)
   ========================================================= */
const ONE_BY_ONE_GIF = Buffer.from(
  "47494638396101000100800000ffffff00000021f90401000001002c00000000010001000002024401003b",
  "hex"
);

// OPEN pixel
router.get("/track/open/:cid", async (req, res) => {
  const cid = String(req.params.cid || "");
  const email = String(req.query.email || "").slice(0, 256);

  try {
    await q(`CREATE TABLE IF NOT EXISTS campaign_events (
      id BIGSERIAL PRIMARY KEY,
      campaign_id TEXT,
      customer_email TEXT,
      event_type TEXT,
      event_time TIMESTAMP DEFAULT NOW()
    )`);
    await q(
      `INSERT INTO campaign_events (campaign_id, customer_email, event_type)
       VALUES ($1,$2,'open')`,
      [cid, email]
    );
  } catch (_) {}

  rememberEvent(cid, "open", email);

  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store");
  res.send(ONE_BY_ONE_GIF);
});

// CLICK redirect
router.get("/track/click/:cid", async (req, res) => {
  const cid = String(req.params.cid || "");
  const email = String(req.query.email || "").slice(0, 256);
  const url = String(req.query.url || "");

  try {
    await q(`CREATE TABLE IF NOT EXISTS campaign_events (
      id BIGSERIAL PRIMARY KEY,
      campaign_id TEXT,
      customer_email TEXT,
      event_type TEXT,
      event_time TIMESTAMP DEFAULT NOW()
    )`);
    await q(
      `INSERT INTO campaign_events (campaign_id, customer_email, event_type)
       VALUES ($1,$2,'click')`,
      [cid, email]
    );
  } catch (_) {}

  rememberEvent(cid, "click", email);

  if (!/^https?:\/\//i.test(url)) return res.status(400).send("bad url");
  return res.redirect(302, url);
});



module.exports = router;
