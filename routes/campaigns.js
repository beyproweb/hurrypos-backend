const express = require('express');
const router = express.Router();
const { pool } = require('../db');
// (Optional) keep these only if used elsewhere in this file
// const { sendEmail } = require('../utils/notifications');
// const whatsappClient = require('../whatsappBot');

const nodemailer = require('nodemailer');
const cheerio = require('cheerio');

// ✅ Single source of truth for the public API origin used in tracking links.
//    Set PUBLIC_TRACKING_ORIGIN in prod (e.g., "https://api.beypro.com").
//    In dev, it falls back to the current request host.
const PUBLIC_TRACKING_ORIGIN = process.env.PUBLIC_TRACKING_ORIGIN || null;

// Reuse a single SMTP transporter (avoids reconnecting each send)
const transporter =
  global.__MAILER__ ||
  (global.__MAILER__ = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  }));

/** Resolve the absolute origin where tracking routes live */
function getTrackingOrigin(req) {
  const originFromReq = `${req.protocol}://${req.get('host')}`;
  return PUBLIC_TRACKING_ORIGIN || originFromReq;
}

/** Build open-pixel URL */
function buildOpenUrl(trackingOrigin, campaignId, email) {
  const u = new URL(`/api/campaigns/track/open/${campaignId}`, trackingOrigin);
  u.searchParams.set('email', email);
  return u.toString();
}

/** Build click-tracking URL wrapping a concrete target URL */
function buildClickUrl(trackingOrigin, campaignId, email, targetUrl) {
  const u = new URL(`/api/campaigns/track/click/${campaignId}`, trackingOrigin);
  u.searchParams.set('email', email);
  u.searchParams.set('url', targetUrl);
  return u.toString();
}

/** Rewrite all http(s) anchors to tracked links for a specific recipient and append pixel */
function rewriteAnchorsWithTracking(rawHtml, trackingOrigin, campaignId, email) {
  const $ = cheerio.load(rawHtml || '', { decodeEntities: false });

  $('a[href]').each((_, el) => {
    const $a = $(el);
    const href = ($a.attr('href') || '').trim();

    // Only wrap absolute http(s) links; skip mailto:, tel:, #, javascript:
    if (!/^https?:\/\//i.test(href)) return;

    const tracked = buildClickUrl(trackingOrigin, campaignId, email, href);
    $a.attr('href', tracked);
  });

  // Append a 1×1 pixel at end of body (or root if no <body>)
  const pixelUrl = buildOpenUrl(trackingOrigin, campaignId, email);
  const pixelTag = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none!important;opacity:0" />`;

  if ($('body').length) $('body').append(pixelTag);
  else $.root().append(pixelTag);

  return $.html();
}

// POST /api/campaigns/email
// Body: { subject, html, text?, recipients: string[], fromEmail?, fromName?, name? }
router.post('/email', async (req, res) => {
  try {
    const {
      subject,
      html,
      text,
      recipients,
      fromEmail,
      fromName,
      name,
    } = req.body || {};

    if (!subject || !html) {
      return res.status(400).json({ ok: false, error: 'subject and html are required' });
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ ok: false, error: 'recipients[] is required' });
    }

    // Basic SMTP sanity check (helps early diagnosis)
    const senderEmail = fromEmail || process.env.SMTP_FROM || process.env.SMTP_USER;
    if (!senderEmail) {
      return res.status(400).json({ ok: false, error: 'fromEmail or SMTP_FROM/SMTP_USER must be set' });
    }
    const sender = fromName ? `"${fromName}" <${senderEmail}>` : senderEmail;

    // Create campaign shell
    const campaignName = name || `Campaign ${new Date().toISOString().slice(0, 10)}`;
    const insertSql = `
      INSERT INTO campaigns (name, subject, html, text, sent_count, sent_at)
      VALUES ($1, $2, $3, $4, 0, NULL)
      RETURNING id, name, subject
    `;
    const insertVals = [campaignName, subject, html, text || null];
    const { rows } = await pool.query(insertSql, insertVals);
    const campaignId = rows[0].id;

    const trackingOrigin = getTrackingOrigin(req);

    // (Optional) dedupe recipients while preserving order
    const seen = new Set();
    const rcpts = recipients
      .map(r => String(r || '').trim())
      .filter(r => r && !seen.has(r) && (seen.add(r) || true));

    let sent = 0;
    const failures = [];

    // Send sequentially (swap to Promise.allSettled if your SMTP allows burst)
    for (const rcpt of rcpts) {
      try {
        const personalizedHtml = rewriteAnchorsWithTracking(
          html,
          trackingOrigin,
          campaignId,
          rcpt
        );

        await transporter.sendMail({
          from: sender,
          to: rcpt,
          subject,
          html: personalizedHtml,
          text: text || undefined,
        });

        // If you want explicit "sent" events per recipient, uncomment:
        // await pool.query(
        //   `INSERT INTO campaign_events (campaign_id, customer_email, event_type, event_time)
        //    VALUES ($1, $2, 'sent', NOW())`,
        //   [campaignId, rcpt]
        // );

        sent += 1;
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
      trackingOrigin,
    });
  } catch (err) {
    console.error('POST /api/campaigns/email error:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
