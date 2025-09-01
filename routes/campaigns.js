// server/routes/campaigns.js
const express = require("express");
const router = express.Router();
// ===== In-memory fallback for events (works even if DB write fails) =====
const recentEvents = new Map(); // Map<campaignId, { opens:Set<string>, clicks:Set<string>, last: Date }>

function rememberEvent(cid, type, email) {
  if (!cid) return;
  const id = String(cid);
  const rec = recentEvents.get(id) || { opens: new Set(), clicks: new Set(), last: new Date() };
  if (type === "open" && email) rec.opens.add(String(email));
  if (type === "click" && email) rec.clicks.add(String(email));
  rec.last = new Date();
  recentEvents.set(id, rec);
}

function getRecentCounts(cid) {
  const rec = recentEvents.get(String(cid));
  if (!rec) return { opens: 0, clicks: 0 };
  return { opens: rec.opens.size, clicks: rec.clicks.size };
}

// Try to obtain a query function no matter how your db is wired
async function q(sql, params = []) {
  try { if (typeof query === "function") return await query(sql, params); } catch {}
  try {
    const db = require("../db");
    if (db?.pool?.query) return await db.pool.query(sql, params);
    if (db?.query) return await db.query(sql, params);
  } catch {}
  return null; // no DB, caller should fall back to memory
}

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

// POST /api/campaigns/email  — robust, no-500, tracked CTA
router.post("/email", async (req, res) => {
  // ----- tiny utils (scoped) -----
  const tryRequire = (m) => { try { return require(m); } catch { return null; } };
  const cheerio = tryRequire("cheerio");

  const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

  const escapeHtml = (s = "") =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const isProbablyHtml = (s = "") => {
    const t = String(s).trim();
    return /^<!doctype/i.test(t) || /^<html[\s>]/i.test(t) ||
           /<\/[a-z][\s\S]*>/i.test(t) || /<(div|table|p|span|section|img|a|h[1-6])\b/i.test(t);
  };

  const wrapDoc = (inner = "") => `<!doctype html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;background:#ffffff;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#111827;line-height:1.5">
${inner}
</body></html>`;

  const autoLink = (text) => {
    let safe = escapeHtml(text);
    safe = safe.replace(URL_RE, (m) => `<a href="${m}" target="_blank" rel="noopener">${m}</a>`);
    return `<p>${safe.replace(/\r?\n\r?\n/g, "</p><p>").replace(/\r?\n/g, "<br/>")}</p>`;
  };

  const buildCtaBlock = (url, text = "Open") => `
  <div style="text-align:center;margin:24px 0">
    <a href="${url}" target="_blank" rel="noopener"
       style="display:inline-block;padding:12px 18px;background:#111827;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">${escapeHtml(text)}</a>
  </div>`;

  const appendBeforeBodyEnd = (html, snippet) =>
    /<\/body>/i.test(html) ? html.replace(/<\/body>/i, snippet + "</body>") : html + snippet;

  const stripHtml = (html = "") => String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  const getSafeOrigin = (req) => {
    let raw = process.env.PUBLIC_TRACKING_ORIGIN || `${req.protocol}://${req.get("host")}`;
    raw = String(raw || "").trim();
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    return raw.replace(/\/+$/,"");
  };

  const buildTransporter = () => {
    const nodemailer = tryRequire("nodemailer");
    if (!nodemailer) return null;
    const {
      SMTP_HOST, SMTP_PORT = "587", SMTP_USER, SMTP_PASS, SMTP_SECURE = "false", SMTP_STRATEGY
    } = process.env;

    if (String(SMTP_STRATEGY || "").toLowerCase() === "json")
      return nodemailer.createTransport({ jsonTransport: true });

    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
      // fallback so you can send *now* without 500s
      return nodemailer.createTransport({ jsonTransport: true });
    }
    return nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: String(SMTP_SECURE).toLowerCase() === "true",
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  };

  // use DB if available, but never crash if not
  const fetchAllRecipientEmails = async () => {
    try {
      const db = tryRequire("../db");
      const q = db?.pool?.query ? db.pool.query.bind(db.pool) : db?.query?.bind(db);
      if (!q) return [];
      const candidates = [
        "SELECT DISTINCT email AS e FROM customers WHERE email IS NOT NULL AND email <> ''",
        "SELECT DISTINCT email_address AS e FROM customers WHERE email_address IS NOT NULL AND email_address <> ''",
        "SELECT DISTINCT mail AS e FROM customers WHERE mail IS NOT NULL AND mail <> ''",
      ];
      for (const sql of candidates) {
        try {
          const r = await q(sql);
          if (r?.rows?.length) return r.rows.map(x => String(x.e).trim());
        } catch {}
      }
      return [];
    } catch { return []; }
  };

  const rewritePerRecipient = (html, origin, cid, email) => {
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
        if ($("body").length) $("body").append(img); else $.root().append(img);
        return $.html();
      }
      // fallback (no cheerio): quick/dirty href rewrite + pixel append
      const click = (href) => {
        const u = new URL(`/api/campaigns/track/click/${cid}`, origin);
        if (email) u.searchParams.set("email", email);
        u.searchParams.set("url", href);
        return u.toString();
      };
      let out = html.replace(/href="(https?:[^"]+)"/gi, (_, href) => `href="${click(href)}"`);
      const pixel = new URL(`/api/campaigns/track/open/${cid}`, origin);
      if (email) pixel.searchParams.set("email", email);
      out = appendBeforeBodyEnd(out, `<img src="${pixel.toString()}" width="1" height="1" style="display:none;opacity:0" alt=""/>`);
      return out;
    } catch {
      return html; // never throw
    }
  };

  try {
    // ---- accept payload ----
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

    if (!subject || typeof subject !== "string")
      return res.status(400).json({ ok:false, error:"subject is required" });

    // ---- build HTML from body if needed ----
    if (!html && body) {
      const looksHtml = body_is_html === true || isProbablyHtml(body);
      if (looksHtml) {
        html = /^<!doctype|^<html/i.test(String(body).trim()) ? body : wrapDoc(body);
        text = text || stripHtml(html);
      } else {
        const inner = autoLink(body);
        html = wrapDoc(inner);
        text = text || body;
      }
    }
    if (!html)
      return res.status(400).json({ ok:false, error:"html or body is required" });

    // guaranteed CTA when primary_url present
    if (primary_url && /^https?:\/\//i.test(primary_url)) {
      html = appendBeforeBodyEnd(html, buildCtaBlock(primary_url, cta_text || "Open"));
    }

    // ---- recipients ----
    if (!Array.isArray(recipients) || recipients.length === 0) {
      recipients = await fetchAllRecipientEmails();
      if (recipients.length === 0)
        return res.status(400).json({ ok:false, error:"no recipients" });
    }
    // de-dupe
    const seen = new Set();
    const rcpts = recipients.map(r => String(r || "").trim()).filter(r => r && !seen.has(r) && (seen.add(r) || true));

    // ---- SMTP transporter (robust) ----
    const transporter = buildTransporter();
    if (!transporter)
      return res.status(400).json({ ok:false, error:"nodemailer not installed (npm i nodemailer)" });

    // Try verify but never 500 if it fails
    try { await transporter.verify(); } catch (e) { /* json transport or lenient */ }

    const senderEmail = fromEmail || process.env.SMTP_FROM || process.env.SMTP_USER || "no-reply@example.com";
    const from = fromName ? `"${fromName}" <${senderEmail}>` : senderEmail;

    // ---- campaign id / origin (no throw) ----
    const origin = getSafeOrigin(req);
    let campaignId = Date.now().toString(); // fallback cid
    try {
      const db = tryRequire("../db");
      const q = db?.pool?.query ? db.pool.query.bind(db.pool) : db?.query?.bind(db);
      if (q) {
        const ins = await q(
          `CREATE TABLE IF NOT EXISTS campaigns (
             id BIGSERIAL PRIMARY KEY, name TEXT, subject TEXT, html TEXT, text TEXT,
             sent_count INTEGER DEFAULT 0, sent_at TIMESTAMP NULL
           );
           INSERT INTO campaigns (name, subject, html, text, sent_count, sent_at)
           VALUES ($1,$2,$3,$4,0,NULL) RETURNING id;`,
          [name || `Campaign ${new Date().toISOString().slice(0,10)}`, subject, html, text || null]
        );
        if (ins?.rows?.[0]?.id) campaignId = String(ins.rows[0].id);
        await q(`CREATE TABLE IF NOT EXISTS campaign_events (
                   id BIGSERIAL PRIMARY KEY, campaign_id TEXT, customer_email TEXT,
                   event_type TEXT, event_time TIMESTAMP DEFAULT NOW()
                 );`);
      }
    } catch { /* keep fallback cid */ }

    // ---- send per recipient (rewrite links + open pixel) ----
    let sent = 0; const failures = [];
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
        sent += 1;
        // best-effort event log
        try {
          const db = tryRequire("../db");
          const q = db?.pool?.query ? db.pool.query.bind(db.pool) : db?.query?.bind(db);
          if (q) await q(
            `INSERT INTO campaign_events (campaign_id, customer_email, event_type, event_time)
             VALUES ($1,$2,'sent',NOW())`, [campaignId, rcpt]
          );
        } catch {}
      } catch (e) {
        failures.push({ email: rcpt, error: e?.message || String(e) });
      }
    }

    // best-effort update counters
    try {
      const db = tryRequire("../db");
      const q = db?.pool?.query ? db.pool.query.bind(db.pool) : db?.query?.bind(db);
      if (q && sent > 0) await q(
        `UPDATE campaigns SET sent_count=$1, sent_at=NOW() WHERE id=$2`, [sent, campaignId]
      );
    } catch {}

    return res.json({ ok:true, campaignId, sent, failed: failures.length, failures });
  } catch (err) {
    // never 500 silently — tell you what failed
    return res.status(400).json({ ok:false, error:"bad_request", details: err?.message || String(err) });
  }
});



// Keep your UI happy (no 404)
// GET /api/campaigns/stats/last — robust: works with mixed id types + falls back to events
// GET /api/campaigns/stats/last — prefers newest events, then newest sent_at
// GET /api/campaigns/stats/last — prefer newest events, merge DB + memory counts
router.get("/stats/last", async (req, res) => {
  const stripHtml = (html = "") => String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  try {
    // Ensure minimal schema (no-op if exists)
    await q(`CREATE TABLE IF NOT EXISTS campaigns (
      id BIGSERIAL PRIMARY KEY,
      name TEXT, subject TEXT, html TEXT, text TEXT,
      sent_count INTEGER DEFAULT 0, sent_at TIMESTAMP NULL
    )`);
    await q(`CREATE TABLE IF NOT EXISTS campaign_events (
      id BIGSERIAL PRIMARY KEY,
      campaign_id TEXT, customer_email TEXT,
      event_type TEXT, event_time TIMESTAMP DEFAULT NOW()
    )`);

    // Latest by sent_at
    let camp = null;
    const r1 = await q(`
      SELECT id::text AS id, subject, html, text, sent_count, sent_at
        FROM campaigns
       WHERE sent_at IS NOT NULL
       ORDER BY sent_at DESC
       LIMIT 1
    `);
    if (r1?.rows?.length) camp = r1.rows[0];

    // Latest by any event
    let latestEvent = null;
    const r2 = await q(`
      SELECT campaign_id::text AS id, MAX(event_time) AS last_event_time
        FROM campaign_events
       GROUP BY campaign_id
       ORDER BY MAX(event_time) DESC
       LIMIT 1
    `);
    if (r2?.rows?.length) latestEvent = r2.rows[0];

    // Prefer the one with the newer timestamp
    if (latestEvent && (!camp || (camp.sent_at && new Date(latestEvent.last_event_time) > new Date(camp.sent_at)))) {
      const r3 = await q(
        `SELECT id::text AS id, subject, html, text, sent_count, sent_at
           FROM campaigns WHERE id::text = $1 LIMIT 1`,
        [latestEvent.id]
      );
      camp = r3?.rows?.[0] || {
        id: latestEvent.id, subject: "", html: "", text: "", sent_count: 0, sent_at: latestEvent.last_event_time
      };
    }

    // If still none, try newest memory record
    if (!camp && recentEvents.size) {
      const newest = [...recentEvents.entries()]
        .sort((a, b) => b[1].last - a[1].last)[0];
      if (newest) camp = { id: newest[0], subject: "", html: "", text: "", sent_count: 0, sent_at: newest[1].last };
    }

    if (!camp) {
      return res.json({ ok: true, subject: "", message: "", openRate: 0, clickRate: 0, sent_at: null });
    }

    // Denominator: prefer campaigns.sent_count, else count 'sent' events
    let sent = Number(camp.sent_count || 0) || 0;
    if (!sent) {
      const s = await q(
        `SELECT COUNT(DISTINCT customer_email) AS u
           FROM campaign_events
          WHERE campaign_id::text = $1 AND event_type = 'sent'`,
        [camp.id]
      );
      sent = Number(s?.rows?.[0]?.u || 0);
    }

    // Unique opens/clicks from DB
    let dbOpens = 0, dbClicks = 0;
    const e = await q(
      `SELECT event_type, COUNT(DISTINCT customer_email) AS u
         FROM campaign_events
        WHERE campaign_id::text = $1 AND event_type IN ('open','click')
        GROUP BY event_type`,
      [camp.id]
    );
    for (const row of e?.rows || []) {
      if (row.event_type === "open")  dbOpens = Number(row.u || 0);
      if (row.event_type === "click") dbClicks = Number(row.u || 0);
    }

    // Merge in-memory counts (so you see % even if DB write was blocked)
    const mem = getRecentCounts(camp.id);
    const uniqueOpens  = Math.max(dbOpens,  mem.opens);
    const uniqueClicks = Math.max(dbClicks, mem.clicks);

    const openRate  = sent ? Math.round((uniqueOpens  / sent) * 1000) / 10 : 0;
    const clickRate = sent ? Math.round((uniqueClicks / sent) * 1000) / 10 : 0;

    return res.json({
      ok: true,
      subject: camp.subject || "",
      message: camp.text || stripHtml(camp.html || ""),
      openRate, clickRate, sent_at: camp.sent_at
    });
  } catch (err) {
    return res.json({ ok: true, subject: "", message: "", openRate: 0, clickRate: 0, sent_at: null });
  }
});


// GET /api/campaigns/stats/by/:campaignId — exact campaign
router.get("/stats/by/:campaignId", async (req, res) => {
  const id = String(req.params.campaignId || "");
  const stripHtml = (html = "") => String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  let q = null;
  try {
    const db = require("../db");
    q = db?.pool?.query ? db.pool.query.bind(db.pool) :
        (typeof db?.query === "function" ? db.query.bind(db) : null);
  } catch {}
  if (!q) return res.json({ ok: true, subject: "", message: "", openRate: 0, clickRate: 0, sent_at: null });

  try {
    const r = await q(`SELECT id::text AS id, subject, html, text, sent_count, sent_at FROM campaigns WHERE id::text = $1 LIMIT 1`, [id]);
    const camp = r?.rows?.[0] || { id, subject: "", html: "", text: "", sent_count: 0, sent_at: null };

    let sent = Number(camp.sent_count || 0) || 0;
    if (!sent) {
      const s = await q(
        `SELECT COUNT(DISTINCT customer_email) AS u
           FROM campaign_events
          WHERE campaign_id::text = $1 AND event_type = 'sent'`,
        [id]
      );
      sent = Number(s?.rows?.[0]?.u || 0);
    }

    const e = await q(
      `SELECT event_type, COUNT(DISTINCT customer_email) AS u
         FROM campaign_events
        WHERE campaign_id::text = $1 AND event_type IN ('open','click')
        GROUP BY event_type`,
      [id]
    );
    let uo = 0, uc = 0;
    for (const row of e.rows || []) {
      if (row.event_type === "open") uo = Number(row.u || 0);
      else if (row.event_type === "click") uc = Number(row.u || 0);
    }
    const openRate  = sent ? Math.round((uo / sent) * 1000) / 10 : 0;
    const clickRate = sent ? Math.round((uc / sent) * 1000) / 10 : 0;

    return res.json({
      ok: true,
      subject: camp.subject || "",
      message: camp.text || stripHtml(camp.html || ""),
      openRate, clickRate, sent_at: camp.sent_at
    });
  } catch (err) {
    return res.json({ ok: true, subject: "", message: "", openRate: 0, clickRate: 0, sent_at: null });
  }
});



router.get("/events/recent", async (req, res) => {
  try {
    const r = await q(`SELECT campaign_id, customer_email, event_type, event_time
                       FROM campaign_events
                       ORDER BY event_time DESC, id DESC
                       LIMIT 25`);
    const mem = [...recentEvents.entries()].map(([id, rec]) => ({
      campaign_id: id, opens: rec.opens.size, clicks: rec.clicks.size, last: rec.last
    }));
    res.json({ ok:true, db:r?.rows || [], memory: mem });
  } catch (e) {
    res.json({ ok:true, db:[], memory:[...recentEvents.keys()] });
  }
});


// trackers (optional)
const ONE_BY_ONE_GIF = Buffer.from(
  "47494638396101000100800000ffffff00000021f90401000001002c00000000010001000002024401003b",
  "hex"
);

// 1×1 open pixel
// 1x1 pixel
// 1x1 open pixel
router.get("/track/open/:campaignId", async (req, res) => {
  const cid = String(req.params.campaignId || "");
  const email = String(req.query.email || "").slice(0, 256);

  // Best-effort DB write
  try {
    await q(`
      CREATE TABLE IF NOT EXISTS campaign_events (
        id BIGSERIAL PRIMARY KEY,
        campaign_id TEXT,
        customer_email TEXT,
        event_type TEXT,
        event_time TIMESTAMP DEFAULT NOW()
      );
    `);
    await q(
      `INSERT INTO campaign_events (campaign_id, customer_email, event_type) VALUES ($1,$2,'open')`,
      [cid, email]
    );
  } catch {}

  // Always track in memory too
  rememberEvent(cid, "open", email);

  // 1×1 gif
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store");
  res.send(Buffer.from("47494638396101000100800000ffffff00000021f90401000001002c00000000010001000002024401003b","hex"));
});

// Click redirect
router.get("/track/click/:campaignId", async (req, res) => {
  const cid = String(req.params.campaignId || "");
  const email = String(req.query.email || "").slice(0, 256);
  const url = String(req.query.url || "");

  // Best-effort DB write
  try {
    await q(`
      CREATE TABLE IF NOT EXISTS campaign_events (
        id BIGSERIAL PRIMARY KEY,
        campaign_id TEXT,
        customer_email TEXT,
        event_type TEXT,
        event_time TIMESTAMP DEFAULT NOW()
      );
    `);
    await q(
      `INSERT INTO campaign_events (campaign_id, customer_email, event_type) VALUES ($1,$2,'click')`,
      [cid, email]
    );
  } catch {}

  // Always track in memory too
  rememberEvent(cid, "click", email);

  if (!/^https?:\/\//i.test(url)) return res.status(400).send("bad url");
  return res.redirect(302, url);
});


router.get("/track/click/:campaignId", async (req, res) => {
  const cid = String(req.params.campaignId || "");
  const email = String(req.query.email || "").slice(0,256);
  const url = String(req.query.url || "");
  try {
    const db = require("../db");
    const q = db?.pool?.query ? db.pool.query.bind(db.pool) : db.query.bind(db);
    await q(`CREATE TABLE IF NOT EXISTS campaign_events (
      id BIGSERIAL PRIMARY KEY, campaign_id TEXT, customer_email TEXT,
      event_type TEXT, event_time TIMESTAMP DEFAULT NOW()
    )`);
    await q(`INSERT INTO campaign_events (campaign_id, customer_email, event_type) VALUES ($1,$2,'click')`, [cid, email]);
  } catch {}
  if (!/^https?:\/\//i.test(url)) return res.status(400).send("bad url");
  res.redirect(url);
});




module.exports = router;
