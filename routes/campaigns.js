// server/routes/campaigns.js

const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const { sendCloudMessage } = require("../utils/whatsappCloud");
const { sendEmail } = require("../utils/notifications");
const { normalizeTrPhoneForApi } = require("../utils/phone");
/* =========================================================
   In-memory fallbacks so the UI still works if DB writes fail
   ========================================================= */
const recentEvents = new Map();        // Map<cid, {sent:Set, opens:Set, clicks:Set, last:Date}>
const recentCampaignMeta = new Map();  // Map<cid, {subject, message, sent_at:Date}>
router.use(authMiddleware);

function rememberCampaignMeta(cid, subject, message, sentAt = new Date()) {
  if (!cid) return;
  recentCampaignMeta.set(String(cid), {
    subject: String(subject || ""),
    message: String(message || ""),
    sent_at: sentAt,
  });
}

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
   DB helpers
   ========================================================= */
function tryGetDb() {
  try {
    return require("../db");
  } catch {
    return null;
  }
}

async function q(sql, params = []) {
  const db = tryGetDb();
  if (db?.pool?.query) return db.pool.query(sql, params);
  if (typeof db?.query === "function") return db.query(sql, params);
  // No DB configured — return null so routes can fall back to memory
  return null;
}

async function qStrict(sql, params = []) {
  const db = tryGetDb();
  if (db?.pool?.query) return db.pool.query(sql, params);
  if (typeof db?.query === "function") return db.query(sql, params);
  throw new Error("DB_NOT_CONFIGURED: ../db must export pool.query or query()");
}

async function ensureTables() {
  try {
    await qStrict(`CREATE TABLE IF NOT EXISTS campaigns (
      id BIGSERIAL PRIMARY KEY,
      restaurant_id BIGINT REFERENCES restaurants(id) ON DELETE CASCADE,
      name TEXT,
      subject TEXT,
      html TEXT,
      text TEXT,
      sent_count INTEGER DEFAULT 0,
      sent_at TIMESTAMP NULL
    )`);

    // 🔄 Legacy compatibility: add tenant column/index if old schema was missing it
    await qStrict(
      `ALTER TABLE campaigns
         ADD COLUMN IF NOT EXISTS restaurant_id BIGINT`
    );
    await qStrict(
      `CREATE INDEX IF NOT EXISTS idx_campaigns_restaurant_id
         ON campaigns(restaurant_id)`
    );

    await qStrict(`CREATE TABLE IF NOT EXISTS campaign_events (
      id BIGSERIAL PRIMARY KEY,
      campaign_id TEXT,
      customer_email TEXT,
      event_type TEXT,
      event_time TIMESTAMP DEFAULT NOW()
    )`);
    return true;
  } catch (err) {
    console.error("❌ ensureTables failed:", err);
    return false;
  }
}


/* =========================================================
   Soft deps + config
   ========================================================= */
function tryRequire(m) { try { return require(m); } catch { return null; } }
const cheerio = tryRequire("cheerio");       // optional

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

function styleContentBlocks(html = "") {
  return String(html || "")
    .replace(/<p>/gi, '<p style="margin:0 0 16px;">')
    .replace(
      /<ul>/gi,
      '<ul style="margin:0 0 16px;padding-left:20px;">'
    )
    .replace(
      /<ol>/gi,
      '<ol style="margin:0 0 16px;padding-left:20px;">'
    )
    .replace(/<li>/gi, '<li style="margin:0 0 8px;">');
}

function buildEmailTemplate({
  subject,
  contentHtml,
  primaryUrl,
  brandName,
  ctaText,
} = {}) {
  const safeBrand = escapeHtml(
    truthyStr(brandName) || "Beypro Marketing"
  );
  const safeSubject = escapeHtml(truthyStr(subject) || "Campaign Update");
  const styled = styleContentBlocks(contentHtml || "");
  const safeCta = escapeHtml(truthyStr(ctaText) || "View Offer");
  const qualifiedUrl =
    truthyStr(primaryUrl) && /^https?:\/\//i.test(primaryUrl)
      ? primaryUrl.trim()
      : "";
  const button =
    qualifiedUrl
      ? `
      <tr>
        <td align="center" style="padding:0 30px 40px;">
          <a href="${escapeHtml(qualifiedUrl)}"
             style="display:inline-block;padding:14px 26px;border-radius:999px;background:#ef4444;color:#ffffff;font-weight:600;text-decoration:none;font-family: 'Inter', Arial, sans-serif;">
            ${safeCta}
          </a>
        </td>
      </tr>`
      : "";

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${safeSubject}</title>
</head>
<body style="margin:0;background-color:#f8fafc;font-family:'Inter',Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:24px;box-shadow:0 20px 60px rgba(15,23,42,0.08);overflow:hidden;">
          <tr>
            <td style="background:linear-gradient(135deg,#f97316,#ef4444);padding:40px 32px;color:#ffffff;">
              <div style="font-size:14px;letter-spacing:0.1em;text-transform:uppercase;opacity:0.9;margin-bottom:8px;">${safeBrand}</div>
              <div style="font-size:28px;font-weight:800;line-height:1.2;">${safeSubject}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 32px 10px;color:#111827;font-size:16px;line-height:1.65;">
              <div>${styled}</div>
            </td>
          </tr>
          ${button}
          <tr>
            <td style="padding:0 32px 34px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;border-radius:18px;padding:18px 22px;">
                <tr>
                  <td style="font-size:13px;color:#475569;line-height:1.6;">
                    You're receiving this update because you’re part of our ${safeBrand} community.
                    <br/>We love helping you drive repeat visits and stronger loyalty.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 20px 28px;font-size:12px;color:#94a3b8;">
              © ${new Date().getUTCFullYear()} ${safeBrand}. All rights reserved.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  let plain = stripHtml(contentHtml || "");
  if (qualifiedUrl) {
    plain = `${plain ? `${plain}\n\n` : ""}CTA: ${qualifiedUrl}`;
  }

  return { html, text: plain.trim() };
}

function buildWhatsAppTemplate({ subject, message, primaryUrl, brandName } = {}) {
  const lines = [];
  if (truthyStr(subject)) lines.push(`*${subject.trim()}*`);
  if (truthyStr(brandName)) lines.push(`${brandName.trim()} presents:`);

  const body = String(message || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (body) {
    body.split(/\n{2,}/).forEach((paragraph) => {
      const clean = paragraph.replace(/\n+/g, " ").trim();
      if (clean) lines.push(clean);
    });
  }

  if (truthyStr(primaryUrl) && /^https?:\/\//i.test(primaryUrl)) {
    lines.push(`👉 ${primaryUrl.trim()}`);
  }

  if (truthyStr(brandName)) {
    lines.push("");
    lines.push(`— ${brandName.trim()}`);
  }

  return lines.filter(Boolean).join("\n");
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

function isLocalHostname(hostname = "") {
  const normalized = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0.0.0.0"
  );
}

function getSafeOrigin(req) {
  const candidates = [
    process.env.PUBLIC_TRACKING_ORIGIN,
    (() => {
      const forwardedHost = String(req.headers["x-forwarded-host"] || "")
        .split(",")[0]
        .trim();
      const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
        .split(",")[0]
        .trim()
        .toLowerCase();
      if (!forwardedHost) return "";
      const protocol = forwardedProto === "http" || forwardedProto === "https"
        ? forwardedProto
        : "https";
      return `${protocol}://${forwardedHost}`;
    })(),
    `${req.protocol}://${req.get("host") || ""}`,
    process.env.APP_URL,
    process.env.FRONTEND_URL,
    process.env.PUBLIC_APP_URL,
    "https://pos.beypro.com",
  ];

  for (const candidate of candidates) {
    let raw = String(candidate || "").trim();
    if (!raw) continue;
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

    try {
      const parsed = new URL(raw);
      if (isLocalHostname(parsed.hostname) && process.env.NODE_ENV === "production") {
        continue;
      }
      return raw.replace(/\/+$/, "");
    } catch {
      continue;
    }
  }

  return "https://pos.beypro.com";
}

function truthyStr(s) {
  return typeof s === "string" && s.trim().length > 0 ? s.trim() : "";
}

function normalizeRestaurantId(value) {
  if (value === undefined || value === null) {
    return { num: null, text: null };
  }
  const num = Number(value);
  if (Number.isFinite(num)) {
    return { num, text: String(num) };
  }
  const text = String(value).trim();
  return { num: null, text: text || null };
}

function buildRestaurantCondition(column, paramIndex, restaurantIdValue) {
  const { num, text } = normalizeRestaurantId(restaurantIdValue);
  if (num !== null) {
    return { clause: `${column} = $${paramIndex}`, param: num };
  }
  if (text) {
    return { clause: `CAST(${column} AS TEXT) = $${paramIndex}`, param: text };
  }
  return null;
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
async function fetchAllRecipientEmails(restaurantId) {
  const condition = buildRestaurantCondition("restaurant_id", 1, restaurantId);
  if (!condition) return [];

  const seen = new Map(); // Map<lowercase, original casing>
  const addRows = (rows = []) => {
    for (const row of rows) {
      const raw = row?.e;
      if (!raw) continue;
      const trimmed = String(raw).trim();
      if (
        !trimmed ||
        !trimmed.includes("@") ||
        /^null$/i.test(trimmed) ||
        /^undefined$/i.test(trimmed)
      ) {
        continue;
      }
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, trimmed);
      }
    }
  };

  const columns = [
    "email",
    "email_address",
    "mail",
    "customer_email",
    "contact_email",
  ];

  async function queryCustomers(includeRestaurantFilter) {
    for (const column of columns) {
      const sql = includeRestaurantFilter
        ? `
          SELECT DISTINCT ${column} AS e
          FROM customers
          WHERE ${condition.clause}
            AND ${column} IS NOT NULL
            AND ${column} <> ''
        `
        : `
          SELECT DISTINCT ${column} AS e
          FROM customers
          WHERE ${column} IS NOT NULL
            AND ${column} <> ''
        `;
      try {
        const res = includeRestaurantFilter
          ? await q(sql, [condition.param])
          : await q(sql);
        if (res?.rows?.length) addRows(res.rows);
      } catch {
        // Column may not exist on every install — skip silently
      }
    }
  }

  if (condition) {
    await queryCustomers(true);
  }
  if (seen.size === 0) {
    await queryCustomers(false);
  }

  if (seen.size === 0) {
    // Legacy fallback: some installs only store emails on orders table
    try {
      const params = [];
      let sql = `
        SELECT DISTINCT customer_email AS e
        FROM orders
        WHERE customer_email IS NOT NULL
          AND customer_email <> ''
      `;
      if (condition) {
        sql += ` AND ${condition.clause.replace("$1", `$${params.length + 1}`)}`;
        params.push(condition.param);
      }
      const res = await q(sql, params);
      if (res?.rows?.length) addRows(res.rows);
    } catch {
      /* ignore */
    }
  }

  return Array.from(seen.values());
}

/* =========================================================
   POST /api/campaigns/email
   - robust input handling
   - guaranteed CTA if primary_url present
   - tracking pixel + per-recipient click rewrites
   - in-memory meta saved so subject/message show immediately
   ========================================================= */
// =========================================================
// POST /api/campaigns/email  (tenant-safe)
// =========================================================
router.post("/email", async (req, res) => {
  try {
    const restaurantIdRaw = req.user?.restaurant_id;
    if (restaurantIdRaw === undefined || restaurantIdRaw === null) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    const { num: restaurantIdNum, text: restaurantIdStr } = normalizeRestaurantId(restaurantIdRaw);
    if (!restaurantIdStr) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    const restaurantIdParam = restaurantIdNum ?? restaurantIdStr;

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

    const brandName =
      truthyStr(req.user?.restaurant_name) ||
      truthyStr(req.user?.name) ||
      "";
    const primaryUrl =
      truthyStr(primary_url) && /^https?:\/\//i.test(primary_url)
        ? primary_url.trim()
        : "";

    let contentHtml = "";
    let hasFullDocument = false;

    if (typeof html === "string" && html.trim()) {
      const trimmed = html.trim();
      if (/<!doctype/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) {
        hasFullDocument = true;
      }
      contentHtml = trimmed;
    }

    if (!contentHtml && body) {
      const looksHtml = body_is_html === true || isProbablyHtml(body);
      if (looksHtml) {
        const trimmedBody = String(body).trim();
        if (/<!doctype/i.test(trimmedBody) || /<html[\s>]/i.test(trimmedBody)) {
          hasFullDocument = true;
        }
        contentHtml = trimmedBody;
        text = text || stripHtml(trimmedBody);
      } else {
        contentHtml = autoLink(body);
        text = text || body;
      }
    }

    if (!contentHtml) {
      return res
        .status(400)
        .json({ ok: false, error: "html or body is required" });
    }

    let finalHtml = contentHtml;
    let plainMessage = truthyStr(text) ? String(text) : stripHtml(contentHtml);
    let usedTemplate = false;

    if (!hasFullDocument) {
      const templated = buildEmailTemplate({
        subject,
        contentHtml,
        primaryUrl,
        brandName,
        ctaText: cta_text,
      });
      finalHtml = templated.html;
      plainMessage = templated.text || plainMessage;
      if (!truthyStr(text)) text = templated.text;
      usedTemplate = true;
    }

    if (!usedTemplate && primaryUrl) {
      finalHtml = appendBeforeBodyEnd(
        finalHtml,
        buildCtaBlock(primaryUrl, cta_text || "Open")
      );
      plainMessage = `${plainMessage ? `${plainMessage}\n\n` : ""}CTA: ${primaryUrl}`;
    }

    html = finalHtml;
    const finalText = truthyStr(text) ? String(text) : plainMessage;
    text = finalText;

    if (!Array.isArray(recipients) || recipients.length === 0) {
      recipients = await fetchAllRecipientEmails(restaurantIdParam);
      if (recipients.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "no recipients",
          message: "No customer email addresses were found. Add emails under Customers to send a campaign.",
        });
      }
    }

    const seen = new Set();
    const rcpts = recipients
      .map((r) => String(r || "").trim())
      .filter((r) => r && !seen.has(r) && (seen.add(r) || true));

    const tablesOk = await ensureTables();

    let campaignId = Date.now().toString();
    let dbInsertOk = false;
    let insertedSentAt = new Date();

    try {
      const ins = await q(
        `INSERT INTO campaigns (restaurant_id, name, subject, html, text, sent_count, sent_at)
         VALUES ($1,$2,$3,$4,$5,0,NOW()) RETURNING id, sent_at`,
        [
          restaurantIdParam,
          name || `Campaign ${new Date().toISOString().slice(0, 10)}`,
          subject,
          html,
          finalText || null,
        ]
      );
      if (ins?.rows?.[0]?.id) {
        campaignId = String(ins.rows[0].id);
        dbInsertOk = true;
        if (ins.rows[0].sent_at) insertedSentAt = ins.rows[0].sent_at;
      }
    } catch (err) {
      // Keep: Useful for production debugging
      console.error("❌ DB insert failed (campaign):", err);
    }

    rememberCampaignMeta(campaignId, subject, plainMessage, insertedSentAt);

    const origin = getSafeOrigin(req);
    const senderEmail =
      fromEmail ||
      process.env.EMAIL_FROM ||
      process.env.SMTP_FROM ||
      process.env.SMTP_USER ||
      "no-reply@example.com";
    const from = fromName ? `"${fromName}" <${senderEmail}>` : senderEmail;

    if (process.env.NODE_ENV !== "production") {
      console.log(
        `📣 Email campaign triggered — restaurant=${restaurantIdStr}, subject="${subject}", recipients=${rcpts.length}`
      );
    }

    let sent = 0;
    const failures = [];

    for (const rcpt of rcpts) {
      try {
        const htmlTracked = rewritePerRecipient(html, origin, campaignId, rcpt);
        await sendEmail({
          from,
          to: rcpt,
          subject,
          html: htmlTracked,
          text: text || stripHtml(htmlTracked),
          throwOnError: true,
        });
        await q(
          `INSERT INTO campaign_events (campaign_id, customer_email, event_type)
           VALUES ($1,$2,'sent')`,
          [String(campaignId), String(rcpt)]
        );
        rememberEvent(campaignId, "sent", rcpt);
        sent += 1;
      } catch (e) {
        failures.push({ email: rcpt, error: e?.message || String(e) });
        // Keep: Useful for production debugging
        console.warn(`⚠️ Email send failed for ${rcpt}:`, e?.message || e);
      }
    }

    try {
      if (sent > 0) {
        await q(
          `UPDATE campaigns SET sent_count=$1, sent_at=COALESCE(sent_at, NOW()) WHERE id=$2`,
          [sent, campaignId]
        );
      }
    } catch (err) {
      // Keep: Useful for production debugging
      console.error("⚠️ Failed to update sent_count:", err);
    }

    if (process.env.NODE_ENV !== "production") {
      console.log(
        `📬 Email campaign ${campaignId} finished: sent=${sent}, failed=${failures.length}`
      );
    }

    return res.json({
      ok: true,
      campaignId,
      sent,
      failed: failures.length,
      failures,
      db: { tablesOk, dbInsertOk },
    });
  } catch (err) {
    // Keep: Useful for production debugging
    console.error("🔥 Campaign email route error:", err);
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      details: err?.message || String(err),
    });
  }
});


/* =========================================================
   Stats: last campaign (by sent_at or by any event)
   (merges memory fallback for subject/message)
   ========================================================= */
router.get("/stats/last", async (req, res) => {
  const restCondition = buildRestaurantCondition("restaurant_id", 1, req.user?.restaurant_id);
  if (!restCondition)
    return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    await ensureTables();

    let camp = null;
    const r1 = await q(
      `SELECT id::text id, name, subject, html, text, sent_count, sent_at
       FROM campaigns
       WHERE sent_at IS NOT NULL AND ${restCondition.clause}
       ORDER BY sent_at DESC
       LIMIT 1`,
      [restCondition.param]
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
          `SELECT id::text id, name, subject, html, text, sent_count, sent_at
           FROM campaigns WHERE id::text=$1 LIMIT 1`,
          [ev.id]
        );
        camp =
          r3?.rows?.[0] || {
            id: ev.id,
            name: "",
            subject: "",
            html: "",
            text: "",
            sent_count: 0,
            sent_at: ev.t,
          };
      }
    }

    // fallback to memory (with meta)
    if (!camp && recentEvents.size) {
      const [id, rec] = [...recentEvents.entries()].sort(
        (a, b) => b[1].last - a[1].last
      )[0];
      const meta = recentCampaignMeta.get(String(id)) || {};
      camp = {
        id,
        name: "",
        subject: meta.subject || "",
        html: "",
        text: meta.message || "",
        sent_count: rec.sent.size || 0,
        sent_at: meta.sent_at || rec.last,
      };
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

    // Robust subject/message (prefer DB, then memory, then name/html)
    const meta = recentCampaignMeta.get(String(camp.id)) || {};
    const subject =
      truthyStr(camp.subject) ||
      truthyStr(meta.subject) ||
      truthyStr(camp.name) ||
      "";

    const message =
      truthyStr(camp.text) ||
      truthyStr(stripHtml(camp.html || "")) ||
      truthyStr(meta.message) ||
      "";

    return res.json({
      ok: true,
      subject,
      message,
      openRate,
      clickRate,
      sent_at: camp.sent_at,
    });
   } catch (err) {
    // Keep: Useful for production debugging
    console.error("❌ stats/last error:", err);
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
   Stats: by exact campaign id (with memory meta fallback)
   ========================================================= */
router.get("/stats/by/:campaignId", async (req, res) => {
  const restCondition = buildRestaurantCondition("restaurant_id", 2, req.user?.restaurant_id);
  if (!restCondition)
    return res.status(401).json({ ok: false, error: "Unauthorized" });

  const id = String(req.params.campaignId || "");
  try {
    await ensureTables();
  } catch {}

  try {
    const r = await q(
      `SELECT id::text AS id, name, subject, html, text, sent_count, sent_at
       FROM campaigns
       WHERE id::text=$1 AND ${restCondition.clause}
       LIMIT 1`,
      [id, restCondition.param]
    );
    const camp =
      r?.rows?.[0] || {
        id,
        name: "",
        subject: "",
        html: "",
        text: "",
        sent_count: 0,
        sent_at: null,
      };

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
    if (!sent) sent = getRecentCounts(id).sent || 0;

    const e = await q(
      `SELECT event_type, COUNT(DISTINCT customer_email) AS u
       FROM campaign_events
       WHERE campaign_id::text=$1 AND event_type IN ('open','click')
       GROUP BY event_type`,
      [id]
    );
    let uo = 0,
      uc = 0;
    for (const row of e?.rows || []) {
      if (row.event_type === "open") uo = Number(row.u || 0);
      else if (row.event_type === "click") uc = Number(row.u || 0);
    }
    const mem = getRecentCounts(id);
    const openRate = sent
      ? Math.round((Math.max(uo, mem.opens) / sent) * 1000) / 10
      : 0;
    const clickRate = sent
      ? Math.round((Math.max(uc, mem.clicks) / sent) * 1000) / 10
      : 0;

    const meta = recentCampaignMeta.get(String(camp.id)) || {};
    const subject =
      truthyStr(camp.subject) ||
      truthyStr(meta.subject) ||
      truthyStr(camp.name) ||
      "";

    const message =
      truthyStr(camp.text) ||
      truthyStr(stripHtml(camp.html || "")) ||
      truthyStr(meta.message) ||
      "";

    return res.json({
      ok: true,
      subject,
      message,
      openRate,
      clickRate,
      sent_at: camp.sent_at,
    });
  } catch {
    const mem = getRecentCounts(id);
    const meta = recentCampaignMeta.get(id) || {};
    const sent = mem.sent || 0;
    const openRate = sent ? Math.round((mem.opens / sent) * 1000) / 10 : 0;
    const clickRate = sent ? Math.round((mem.clicks / sent) * 1000) / 10 : 0;
    return res.json({
      ok: true,
      subject: truthyStr(meta.subject),
      message: truthyStr(meta.message),
      openRate,
      clickRate,
      sent_at: meta.sent_at || null,
    });
  }
});
// =========================================================
// GET /api/campaigns/list  — Tenant-safe recent campaigns
// =========================================================
router.get("/list", async (req, res) => {
  const restCondition = buildRestaurantCondition("c.restaurant_id", 1, req.user?.restaurant_id);
  if (!restCondition)
    return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    await ensureTables();
  } catch {}

  let rows = [];
  try {
    const r = await q(
      `SELECT
         c.id::text AS id,
         c.name,
         c.subject,
         c.text,
         c.html,
         c.sent_count,
         c.sent_at,
         COALESCE(NULLIF(c.sent_count, 0),
           (SELECT COUNT(DISTINCT ce.customer_email)
              FROM campaign_events ce
              WHERE ce.campaign_id::text = c.id::text AND ce.event_type='sent')
         ) AS sent_denom,
         (SELECT COUNT(DISTINCT ce.customer_email)
            FROM campaign_events ce
            WHERE ce.campaign_id::text = c.id::text AND ce.event_type='open') AS u_open,
         (SELECT COUNT(DISTINCT ce.customer_email)
            FROM campaign_events ce
            WHERE ce.campaign_id::text = c.id::text AND ce.event_type='click') AS u_click,
       (SELECT MAX(event_time)
           FROM campaign_events ce
           WHERE ce.campaign_id::text = c.id::text) AS last_event
       FROM campaigns c
       WHERE ${restCondition.clause}
       ORDER BY
         COALESCE(c.sent_at,
           (SELECT MAX(event_time)
              FROM campaign_events ce
              WHERE ce.campaign_id::text = c.id::text)) DESC NULLS LAST,
         c.id DESC
       LIMIT 20`,
      [restCondition.param]
    );
    rows = r?.rows || [];
  } catch (err) {
    // Keep: Useful for production debugging
    console.error("⚠️ campaigns/list DB query failed:", err);
  }

  // 🔹 Merge in-memory fallback campaigns
  const memRows = [];
  for (const [cid, meta] of recentCampaignMeta.entries()) {
    const ev = recentEvents.get(cid);
    if (!ev) continue;
    memRows.push({
      id: cid,
      name: "",
      subject: meta.subject || "",
      text: meta.message || "",
      html: "",
      sent_count: ev.sent.size,
      sent_at: meta.sent_at || ev.last,
      u_open: ev.opens.size,
      u_click: ev.clicks.size,
    });
  }

  // 🔹 Combine DB + memory (avoid duplicates)
  const map = new Map();
  for (const c of [...rows, ...memRows]) map.set(String(c.id), c);
  const detectChannel = (entry) => {
    if (truthyStr(entry.html)) return "Email";
    if (truthyStr(entry.text)) return "WhatsApp";
    if (truthyStr(entry.subject) || truthyStr(entry.name)) return "Email";
    return "Email";
  };
  const merged = Array.from(map.values())
    .sort((a, b) => new Date(b.sent_at || 0) - new Date(a.sent_at || 0))
    .slice(0, 20)
    .map((c) => ({
      id: String(c.id),
      subject: c.subject || "",
      message: c.text || "",
      sent_at: c.sent_at,
      channel: detectChannel(c),
      openRate: c.sent_denom
        ? Math.round(((c.u_open || 0) / c.sent_denom) * 1000) / 10
        : 0,
      clickRate: c.sent_denom
        ? Math.round(((c.u_click || 0) / c.sent_denom) * 1000) / 10
        : 0,
    }));

  return res.json({ ok: true, campaigns: merged });
});


// =========================================================
// GET /api/campaigns/events/recent  — Tenant-safe
// =========================================================
router.get("/events/recent", async (req, res) => {
  const restCondition = buildRestaurantCondition("c.restaurant_id", 1, req.user?.restaurant_id);
  if (!restCondition)
    return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    // ✅ Fetch only campaigns belonging to this restaurant
    const r = await q(
      `SELECT ce.campaign_id, ce.customer_email, ce.event_type, ce.event_time
       FROM campaign_events ce
       INNER JOIN campaigns c ON c.id::text = ce.campaign_id::text
       WHERE ${restCondition.clause}
       ORDER BY ce.event_time DESC, ce.id DESC
       LIMIT 25`,
      [restCondition.param]
    );

    // ✅ Filter in-memory events (recentEvents) for this restaurant
    const mem = [];
    for (const [id, rec] of recentEvents.entries()) {
      try {
        const c = await q(
          `SELECT 1 FROM campaigns WHERE id::text=$1 AND ${restCondition.clause.replace("$1", "$2")} LIMIT 1`,
          [id, restCondition.param]
        );
        if (c?.rows?.length) {
          mem.push({
            campaign_id: id,
            opens: rec.opens.size,
            clicks: rec.clicks.size,
            last: rec.last,
          });
        }
      } catch {
        // ignore if db unavailable
      }
    }

    res.json({ ok: true, db: r?.rows || [], memory: mem });
  } catch (e) {
    // Keep: Useful for production debugging
    console.error("❌ events/recent error:", e);
    res.json({ ok: true, db: [], memory: [] });
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
    await ensureTables();
    await q(
      `INSERT INTO campaign_events (campaign_id, customer_email, event_type)
       VALUES ($1,$2,'open')`,
      [cid, email]
    );
  } catch {}

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
    await ensureTables();
    await q(
      `INSERT INTO campaign_events (campaign_id, customer_email, event_type)
       VALUES ($1,$2,'click')`,
      [cid, email]
    );
  } catch {}

  rememberEvent(cid, "click", email);

  if (!/^https?:\/\//i.test(url)) return res.status(400).send("bad url");
  return res.redirect(302, url);
});

/* =========================================================
   🔎 DB DEBUG ENDPOINTS — use these to verify DB health
   ========================================================= */
router.get("/debug/db", async (_req, res) => {
  const db = tryGetDb();
  const info = {
    hasDbModule: !!db,
    hasPoolQuery: !!db?.pool?.query,
    hasQueryFn: typeof db?.query === "function",
  };
  try {
    const ok = await ensureTables();
    info.tablesOk = ok;
  } catch {
    info.tablesOk = false;
  }

  try {
    const v = await qStrict("select version()", []);
    info.version = v?.rows?.[0]?.version || null;
  } catch (e) {
    info.version = null;
    info.error = String(e.message || e);
  }

  try {
    const c = await q(`SELECT COUNT(*) AS n FROM campaigns`);
    info.campaignsCount = Number(c?.rows?.[0]?.n || 0);
  } catch {
    info.campaignsCount = null;
  }

  try {
    const last = await q(
      `SELECT id::text id, subject, sent_at FROM campaigns ORDER BY sent_at DESC NULLS LAST, id DESC LIMIT 3`
    );
    info.lastRows = last?.rows || [];
  } catch {
    info.lastRows = [];
  }

  return res.json({ ok: true, info });
});

// Writes & reads one roundtrip (then deletes)
router.post("/debug/roundtrip", async (_req, res) => {
  try {
    await ensureTables();
    const ins = await qStrict(
      `INSERT INTO campaigns (name, subject, html, text, sent_count, sent_at)
       VALUES ('DEBUG','_rt_subject_', '', '', 0, NOW())
       RETURNING id, sent_at`
    );
    const id = ins.rows[0].id;
    const got = await qStrict(
      `SELECT id::text id, subject, sent_at FROM campaigns WHERE id=$1`,
      [id]
    );
    await qStrict(`DELETE FROM campaigns WHERE id=$1`, [id]);
    return res.json({ ok: true, inserted: ins.rows[0], fetched: got.rows[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// =========================================================
// 🟢 TENANT-SAFE WHATSApp CAMPAIGNS (DB-PERSISTENT)
// =========================================================
router.post("/whatsapp", authMiddleware, async (req, res) => {
  try {
    const { num: restaurantIdNum, text: restaurantIdStr } = normalizeRestaurantId(req.user?.restaurant_id);
    if (!restaurantIdStr)
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    const restaurantIdParam = restaurantIdNum ?? restaurantIdStr;

    const { body, phones, name, subject, primary_url: waPrimaryUrl } = req.body || {};
    if (!body || !phones?.length) {
      return res.status(400).json({ ok: false, error: "Missing message or phones" });
    }

    await ensureTables();

    const brandName =
      truthyStr(req.user?.restaurant_name) ||
      truthyStr(req.user?.name) ||
      "";
    const campaignSubject =
      truthyStr(subject) || "WhatsApp Campaign";
    const primaryUrl =
      truthyStr(waPrimaryUrl) && /^https?:\/\//i.test(waPrimaryUrl)
        ? waPrimaryUrl.trim()
        : "";
    const marketingBody = buildWhatsAppTemplate({
      subject: campaignSubject,
      message: body,
      primaryUrl,
      brandName,
    });

    // 🔹 Insert WhatsApp campaign record
    let campaignId = Date.now().toString();
    let insertedAt = new Date();
    try {
      const ins = await q(
        `INSERT INTO campaigns (restaurant_id, name, subject, text, sent_count, sent_at)
         VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id, sent_at`,
        [
          restaurantIdParam,
          name || "WhatsApp Campaign",
          campaignSubject,
          marketingBody,
          0
        ]
      );
      if (ins?.rows?.[0]?.id) {
        campaignId = String(ins.rows[0].id);
        insertedAt = ins.rows[0].sent_at || insertedAt;
      }
    } catch (err) {
      // Keep: Useful for production debugging
      console.error("❌ Failed to insert WhatsApp campaign:", err);
    }

    rememberCampaignMeta(campaignId, campaignSubject, marketingBody, insertedAt);

    // 🔹 Send messages via WhatsApp Cloud
    const results = [];
    let successCount = 0;
    let failureCount = 0;

    for (const phone of phones) {
      const normalized = normalizeTrPhoneForApi(phone);
      if (!normalized) {
        failureCount += 1;
        results.push({
          phone: String(phone || ""),
          status: "failed",
          error: "Invalid phone format",
        });
        continue;
      }

      try {
        const r = await sendCloudMessage(normalized, marketingBody);
        results.push({ phone: normalized, status: r.status || "ok" });
        successCount += 1;

        // Save send event per recipient
        try {
          await q(
            `INSERT INTO campaign_events (campaign_id, customer_email, event_type)
             VALUES ($1,$2,'sent')`,
            [campaignId, normalized]
          );
          rememberEvent(campaignId, "sent", normalized);
        } catch (err) {
          // Keep: Useful for production debugging
          console.warn("⚠️ Failed to insert campaign_event for", normalized, err);
        }
      } catch (err) {
        failureCount += 1;
        const errMsg = err?.response?.data?.error?.message || err?.message || String(err);
        // Keep: Useful for production debugging
        console.warn(`⚠️ WhatsApp send failed for ${normalized}:`, errMsg);
        results.push({ phone: normalized, status: "failed", error: errMsg });
      }
    }

    // Update sent_count only with successful deliveries
    try {
      if (successCount > 0) {
        await q(
          `UPDATE campaigns SET sent_count=$1, sent_at=NOW() WHERE id=$2`,
          [successCount, campaignId]
        );
      }
    } catch (err) {
      // Keep: Useful for production debugging
      console.warn("⚠️ Failed to update WhatsApp campaign sent_count:", err);
    }

    const ok = failureCount === 0;
    return res.status(ok ? 200 : 207).json({
      ok,
      campaignId,
      sent: successCount,
      failed: failureCount,
      results,
    });
  } catch (err) {
    // Keep: Useful for production debugging
    console.error("❌ WhatsApp campaign send error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// 📱 Get QR for tenant's WhatsApp client
router.get("/whatsapp/qr", authMiddleware, async (req, res) => {
  const { text: restaurantIdStr } = normalizeRestaurantId(req.user?.restaurant_id);
  if (!restaurantIdStr) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const { getWhatsAppClient } = require("../utils/whatsappClient");
   const client = await getWhatsAppClient(restaurantIdStr);

    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });
    if (client.isReady) return res.json({ ok: true, status: "ready" });

    // When QR event fires, cache it temporarily
    if (!client._lastQr) {
      client.on("qr", qr => {
        client._lastQr = qr;
      });
    }

    // If QR already cached, return it
    if (client._lastQr) {
      return res.json({ ok: true, qr: client._lastQr });
    } else {
      return res.json({ ok: true, status: "waiting" });
    }
  } catch (err) {
    // Keep: Useful for production debugging
    console.error("❌ QR fetch error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


/* =========================================================
   DELETE /api/campaigns/clear-all — tenant-safe clear route
   ========================================================= */
router.delete("/clear-all", authMiddleware, async (req, res) => {
  const restCondition = buildRestaurantCondition("restaurant_id", 1, req.user?.restaurant_id);
  if (!restCondition)
    return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    await ensureTables();

    // Delete campaign events first (FK-safe)
    await q(`DELETE FROM campaign_events WHERE campaign_id IN (
      SELECT id::text FROM campaigns WHERE ${restCondition.clause}
    )`, [restCondition.param]);

    // Delete campaigns for this restaurant
    const del = await q(
      `DELETE FROM campaigns WHERE ${restCondition.clause} RETURNING id`,
      [restCondition.param]
    );

    // Clear in-memory cache for this tenant
    for (const id of (del?.rows || []).map(r => String(r.id))) {
      recentEvents.delete(id);
      recentCampaignMeta.delete(id);
    }

    return res.json({
      ok: true,
      deleted: del?.rows?.length || 0,
      message: "All campaigns cleared successfully.",
    });
  } catch (err) {
    // Keep: Useful for production debugging
    console.error("❌ Failed to clear campaigns:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
