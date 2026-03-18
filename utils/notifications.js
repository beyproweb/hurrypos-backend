const nodemailer = require('nodemailer');

function truthyStr(value) {
  const normalized = String(value || "").trim();
  return normalized ? normalized : "";
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function resolveMailEnv() {
  const strategy = truthyStr(process.env.SMTP_STRATEGY).toLowerCase();
  const smtpUrl = truthyStr(process.env.SMTP_URL || process.env.EMAIL_URL || process.env.MAIL_URL);
  const service = truthyStr(process.env.SMTP_SERVICE || process.env.EMAIL_SERVICE || process.env.MAIL_SERVICE);
  const host = truthyStr(process.env.SMTP_HOST || process.env.EMAIL_HOST || process.env.MAIL_HOST);
  const port = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT || process.env.MAIL_PORT) || 587;
  const user = truthyStr(process.env.SMTP_USER || process.env.EMAIL_USER || process.env.MAIL_USER);
  const pass = truthyStr(process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.MAIL_PASS);
  const secureRaw = process.env.SMTP_SECURE ?? process.env.EMAIL_SECURE ?? process.env.MAIL_SECURE;
  const secure = parseBool(secureRaw, port === 465);

  return {
    strategy,
    smtpUrl,
    service,
    host,
    port,
    user,
    pass,
    secure,
  };
}

let transporter = null;
let transporterKey = "";

function buildTransporter() {
  const config = resolveMailEnv();
  const key = JSON.stringify({
    strategy: config.strategy,
    smtpUrl: config.smtpUrl,
    service: config.service,
    host: config.host,
    port: config.port,
    secure: config.secure,
    user: config.user,
    hasPass: Boolean(config.pass),
  });

  if (transporter && transporterKey === key) return transporter;

  if (config.strategy === "json") {
    transporter = nodemailer.createTransport({ jsonTransport: true });
    transporterKey = key;
    return transporter;
  }

  if (config.smtpUrl) {
    transporter = nodemailer.createTransport(config.smtpUrl);
    transporterKey = key;
    return transporter;
  }

  if (config.service && config.user && config.pass) {
    transporter = nodemailer.createTransport({
      service: config.service,
      auth: { user: config.user, pass: config.pass },
    });
    transporterKey = key;
    return transporter;
  }

  let host = config.host;
  let port = config.port;
  let secure = config.secure;

  // Convenience fallback when only SMTP_USER/PASS are set.
  if (!host && config.user) {
    if (/gmail\.com$/i.test(config.user)) {
      host = "smtp.gmail.com";
      if (!process.env.SMTP_PORT) port = 465;
      if (process.env.SMTP_SECURE === undefined) secure = true;
    } else if (/@(outlook|hotmail|live)\./i.test(config.user)) {
      host = "smtp-mail.outlook.com";
      if (!process.env.SMTP_PORT) port = 587;
      if (process.env.SMTP_SECURE === undefined) secure = false;
    }
  }

  if (!host || !config.user || !config.pass) {
    transporter = null;
    transporterKey = key;
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });
  transporterKey = key;
  return transporter;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Backward-compatible API:
 * - sendEmail(to, subject, body, isHtml?, options?)
 * - sendEmail(context, to, subject, body, isHtml?, options?)  // legacy mismatch in scheduleMailer
 * - sendEmail({ to, subject, html/text/body, replyTo, fromName, fromEmail, from, cc, bcc })
 */
const sendEmail = async (...args) => {
  let options = {};
  try {
    let to;
    let subject;
    let body;
    let isHtml = false;
    let htmlBody = null;
    let textBody = null;
    options = {};

    if (args.length === 1 && isPlainObject(args[0])) {
      const input = args[0];
      to = input.to;
      subject = input.subject;
      htmlBody = typeof input.html === "string" ? input.html : null;
      textBody = typeof input.text === "string" ? input.text : null;
      body = input.body;
      if (htmlBody !== null) {
        isHtml = true;
      } else if (textBody !== null) {
        isHtml = false;
      } else {
        isHtml = !!input.isHtml;
      }
      options = { ...input };
      delete options.to;
      delete options.subject;
      delete options.html;
      delete options.text;
      delete options.body;
      delete options.isHtml;
    } else if (isPlainObject(args[0]) && typeof args[1] === "string") {
      // tolerate old accidental call style: sendEmail({ restaurant_id }, to, subject, body, isHtml)
      to = args[1];
      subject = args[2];
      body = args[3];
      isHtml = !!args[4];
      options = isPlainObject(args[5]) ? args[5] : {};
    } else {
      to = args[0];
      subject = args[1];
      body = args[2];
      isHtml = !!args[3];
      options = isPlainObject(args[4]) ? args[4] : {};
    }

    const activeTransporter = buildTransporter();
    if (!activeTransporter) {
      throw new Error(
        "SMTP is not configured. Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS or SMTP_URL."
      );
    }

    const fromEmail =
      options.fromEmail ||
      process.env.SMTP_FROM ||
      process.env.EMAIL_FROM ||
      process.env.MAIL_FROM ||
      process.env.SMTP_USER ||
      process.env.EMAIL_USER ||
      process.env.MAIL_USER ||
      "no-reply@beypro.local";
    const fromName = options.fromName || "Beypro Notifications";
    const from = options.from || `"${fromName}" <${fromEmail}>`;

    const mailOptions = {
      from,
      to,
      subject,
    };

    if (htmlBody !== null || textBody !== null) {
      if (htmlBody !== null) mailOptions.html = htmlBody;
      if (textBody !== null) mailOptions.text = textBody;
      if (htmlBody === null && textBody === null && typeof body === "string") {
        mailOptions[isHtml ? "html" : "text"] = body;
      }
    } else {
      mailOptions[isHtml ? "html" : "text"] = body;
    }

    if (options.replyTo) mailOptions.replyTo = options.replyTo;
    if (options.cc) mailOptions.cc = options.cc;
    if (options.bcc) mailOptions.bcc = options.bcc;

    await activeTransporter.sendMail(mailOptions);
    const toDisplay = Array.isArray(to) ? to.join(", ") : String(to || "");
    console.log(`✅ Email sent to: ${toDisplay}`);
  } catch (error) {
    console.error("❌ Error sending email:", error);
    if (options && options.throwOnError) throw error;
  }
};


module.exports = { sendEmail };
