// server/routes/campaigns.js
const express = require("express");
const router = express.Router();
const nodemailer = require("nodemailer");
const cheerio = require("cheerio");

// ✅ Single, non-duplicated definition. Optionally set in your host env.
// e.g. "https://api.beypro.com" (no trailing slash)
const PUBLIC_TRACKING_ORIGIN = process.env.PUBLIC_TRACKING_ORIGIN || null;

/**
 * Utility: consistent JSON error responses
 */
function jsonError(res, code, message, extra = {}) {
  return res.status(code).json({ ok: false, error: message, ...extra });
}

/**
 * Build transporter from environment
 * Required env (typical SMTP):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 * Optional:
 *   SMTP_SECURE ("true"|"false"), FROM_EMAIL, FROM_NAME
 */
function makeTransporter() {
  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    SMTP_SECURE,
  } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    throw new Error(
      "SMTP credentials missing. Please set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS."
    );
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: String(SMTP_SECURE || "false").toLowerCase() === "true",
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

/**
 * Injects a 1x1 tracking pixel if PUBLIC_TRACKING_ORIGIN is set.
 * Adds at end of <body>. If no body, appends to HTML.
 */
function maybeInjectOpenPixel(html, campaignId, recipient) {
  if (!PUBLIC_TRACKING_ORIGIN) return html;

  const $ = cheerio.load(html || "<html><body></body></html>", null, false);

  const pixelUrl = `${PUBLIC_TRACKING_ORIGIN}/track/open.gif?cid=${encodeURIComponent(
    campaignId || "unknown"
  )}&r=${encodeURIComponent(recipient || "")}`;

  const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none;opacity:0" alt="" />`;

  if ($("body").length) {
    $("body").append(pixel);
  } else {
    $.root().append(pixel);
  }

  return $.html();
}

/**
 * POST /api/campaigns/email
 * Body:
 * {
 *   "subject": "Hello",
 *   "html": "<h1>Hi</h1>",
 *   "recipients": ["a@b.com","c@d.com"],
 *   "fromEmail": "no-reply@beypro.com",        // optional (falls back to env FROM_EMAIL)
 *   "fromName": "Beypro Campaigns",            // optional (falls back to env FROM_NAME)
 *   "campaignId": "summer-2025"                // optional (used for tracking pixel)
 * }
 */
router.post("/email", async (req, res) => {
  try {
    const { subject, html, recipients, fromEmail, fromName, campaignId } =
      req.body || {};

    if (!subject || typeof subject !== "string") {
      return jsonError(res, 400, "Missing or invalid 'subject'.");
    }
    if (!html || typeof html !== "string") {
      return jsonError(res, 400, "Missing or invalid 'html'.");
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return jsonError(res, 400, "Provide at least one recipient in 'recipients'.");
    }

    const FROM_EMAIL = fromEmail || process.env.FROM_EMAIL;
    const FROM_NAME = fromName || process.env.FROM_NAME || "Beypro";
    if (!FROM_EMAIL) {
      return jsonError(res, 400, "No 'fromEmail' provided and FROM_EMAIL env not set.");
    }

    const transporter = makeTransporter();

    const results = [];
    for (const rcpt of recipients) {
      const htmlWithPixel = maybeInjectOpenPixel(html, campaignId, rcpt);

      const info = await transporter.sendMail({
        from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
        to: rcpt,
        subject,
        html: htmlWithPixel,
      });

      results.push({
        to: rcpt,
        messageId: info.messageId || null,
        accepted: info.accepted || [],
        rejected: info.rejected || [],
        response: info.response || null,
      });
    }

    return res.status(200).json({ ok: true, sent: results.length, results });
  } catch (err) {
    // Always return JSON so the frontend never tries to parse HTML
    return jsonError(res, 500, err.message || "Unknown server error");
  }
});

module.exports = router;
