const nodemailer = require("nodemailer");
const axios = require("axios");

function truthyStr(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeRecipients(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => normalizeRecipients(entry));
  return String(value)
    .split(/[;,]/)
    .map((item) => item.trim())
    .map((item) => {
      const bracketMatch = item.match(/<\s*([^<>@\s]+@[^<>@\s]+)\s*>/);
      if (bracketMatch) return bracketMatch[1].trim();
      return item.replace(/^"|"$/g, "").trim();
    })
    .filter(Boolean);
}

function parseFromAddress(fromValue, fallbackName, fallbackEmail) {
  const raw = truthyStr(fromValue);
  const bracketMatch = raw.match(/^(.*)<\s*([^<>@\s]+@[^<>@\s]+)\s*>$/);
  if (bracketMatch) {
    const name = bracketMatch[1].trim().replace(/^"|"$/g, "") || fallbackName;
    const email = bracketMatch[2].trim();
    return {
      from: raw,
      fromName: name || fallbackName,
      fromEmail: email || fallbackEmail,
    };
  }
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) {
    return {
      from: raw,
      fromName: fallbackName,
      fromEmail: raw,
    };
  }
  return {
    from: `"${fallbackName}" <${fallbackEmail}>`,
    fromName: fallbackName,
    fromEmail: fallbackEmail,
  };
}

function truncateForLog(value, maxLength = 1200) {
  if (value === undefined || value === null) return value;
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (!raw) return raw;
  return raw.length <= maxLength ? raw : `${raw.slice(0, maxLength)}...<truncated>`;
}

function summarizeAxiosError(error) {
  if (!axios.isAxiosError(error)) {
    return {
      message: error?.message || String(error),
      code: error?.code || null,
    };
  }
  return {
    message: error.message,
    code: error.code || null,
    status: error.response?.status || null,
    statusText: error.response?.statusText || null,
    responseData: truncateForLog(error.response?.data),
  };
}

function resolveMailEnv() {
  const strategy = truthyStr(
    process.env.EMAIL_PROVIDER || process.env.EMAIL_STRATEGY || process.env.SMTP_STRATEGY || "auto"
  ).toLowerCase();

  const smtpUrl = truthyStr(process.env.SMTP_URL || process.env.EMAIL_URL || process.env.MAIL_URL);
  const service = truthyStr(process.env.SMTP_SERVICE || process.env.EMAIL_SERVICE || process.env.MAIL_SERVICE);
  const host = truthyStr(process.env.SMTP_HOST || process.env.EMAIL_HOST || process.env.MAIL_HOST);
  const port = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT || process.env.MAIL_PORT) || 587;
  const user = truthyStr(process.env.SMTP_USER || process.env.EMAIL_USER || process.env.MAIL_USER);
  const pass = truthyStr(process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.MAIL_PASS);
  const secureRaw = process.env.SMTP_SECURE ?? process.env.EMAIL_SECURE ?? process.env.MAIL_SECURE;
  const secure = parseBool(secureRaw, port === 465);

  return {
    isProduction: String(process.env.NODE_ENV || "").toLowerCase() === "production",
    allowSmtpInProduction: parseBool(process.env.ALLOW_SMTP_IN_PRODUCTION, false),
    strategy,

    smtpUrl,
    service,
    host,
    port,
    user,
    pass,
    secure,

    resendApiKey: truthyStr(process.env.RESEND_API_KEY),
    sendgridApiKey: truthyStr(process.env.SENDGRID_API_KEY),
    mailgunApiKey: truthyStr(process.env.MAILGUN_API_KEY),
    mailgunDomain: truthyStr(process.env.MAILGUN_DOMAIN),
    mailgunBaseUrl: truthyStr(process.env.MAILGUN_BASE_URL || "https://api.mailgun.net"),
    postmarkServerToken: truthyStr(process.env.POSTMARK_SERVER_TOKEN),
    postmarkMessageStream: truthyStr(process.env.POSTMARK_MESSAGE_STREAM),

    httpTimeoutMs: Number(process.env.EMAIL_HTTP_TIMEOUT_MS) || 15000,
  };
}

function hasSmtpConfig(config) {
  if (config.smtpUrl) return true;
  if (config.service && config.user && config.pass) return true;
  if (config.host && config.user && config.pass) return true;
  if (config.user && config.pass) return true; // provider fallback for gmail/outlook host shortcuts
  return false;
}

function resolveDeliveryStrategy(config) {
  const explicit = config.strategy;
  const hasResend = Boolean(config.resendApiKey);
  const hasSendgrid = Boolean(config.sendgridApiKey);
  const hasMailgun = Boolean(config.mailgunApiKey && config.mailgunDomain);
  const hasPostmark = Boolean(config.postmarkServerToken);

  if (explicit && explicit !== "auto") {
    if (!["resend", "sendgrid", "mailgun", "postmark", "smtp", "json"].includes(explicit)) {
      throw new Error(
        `Unknown EMAIL_PROVIDER/EMAIL_STRATEGY '${explicit}'. Use auto,resend,sendgrid,mailgun,postmark,smtp,json.`
      );
    }
    if (explicit === "smtp" && config.isProduction && !config.allowSmtpInProduction) {
      throw new Error(
        "SMTP is disabled in production. Configure EMAIL_PROVIDER with an HTTP email API, or set ALLOW_SMTP_IN_PRODUCTION=true only as an emergency fallback."
      );
    }
    if (explicit === "resend" && !hasResend) throw new Error("EMAIL_PROVIDER=resend requires RESEND_API_KEY.");
    if (explicit === "sendgrid" && !hasSendgrid) {
      throw new Error("EMAIL_PROVIDER=sendgrid requires SENDGRID_API_KEY.");
    }
    if (explicit === "mailgun" && !hasMailgun) {
      throw new Error("EMAIL_PROVIDER=mailgun requires MAILGUN_API_KEY and MAILGUN_DOMAIN.");
    }
    if (explicit === "postmark" && !hasPostmark) {
      throw new Error("EMAIL_PROVIDER=postmark requires POSTMARK_SERVER_TOKEN.");
    }
    if (explicit === "smtp" && !hasSmtpConfig(config)) {
      throw new Error("EMAIL_PROVIDER=smtp requires SMTP credentials.");
    }
    return explicit;
  }

  if (config.isProduction) {
    if (hasResend) return "resend";
    if (hasSendgrid) return "sendgrid";
    if (hasMailgun) return "mailgun";
    if (hasPostmark) return "postmark";
    if (config.allowSmtpInProduction && hasSmtpConfig(config)) return "smtp";
    throw new Error(
      "No HTTP email provider configured for production. Set one of RESEND_API_KEY, SENDGRID_API_KEY, MAILGUN_API_KEY+MAILGUN_DOMAIN, or POSTMARK_SERVER_TOKEN."
    );
  }

  if (hasSmtpConfig(config)) return "smtp";
  if (hasResend) return "resend";
  if (hasSendgrid) return "sendgrid";
  if (hasMailgun) return "mailgun";
  if (hasPostmark) return "postmark";
  return "json";
}

let transporter = null;
let transporterKey = "";

function buildTransporter(config, strategy) {
  const key = JSON.stringify({
    strategy,
    smtpUrl: config.smtpUrl,
    service: config.service,
    host: config.host,
    port: config.port,
    secure: config.secure,
    user: config.user,
    hasPass: Boolean(config.pass),
  });

  if (transporter && transporterKey === key) return transporter;

  if (strategy === "json") {
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

function listToSendgridAddresses(list) {
  return normalizeRecipients(list).map((email) => ({ email }));
}

async function sendWithResend(config, message) {
  const payload = {
    from: message.from,
    to: message.to,
    subject: message.subject,
  };
  if (message.html) payload.html = message.html;
  if (message.text) payload.text = message.text;
  if (message.replyTo) payload.reply_to = message.replyTo;
  if (message.cc.length) payload.cc = message.cc;
  if (message.bcc.length) payload.bcc = message.bcc;

  const response = await axios.post("https://api.resend.com/emails", payload, {
    timeout: config.httpTimeoutMs,
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
  });

  return {
    status: response.status,
    data: response.data,
  };
}

async function sendWithSendgrid(config, message) {
  const payload = {
    personalizations: [
      {
        to: listToSendgridAddresses(message.to),
        subject: message.subject,
      },
    ],
    from: {
      email: message.fromEmail,
      name: message.fromName,
    },
    content: [],
  };
  if (message.cc.length) payload.personalizations[0].cc = listToSendgridAddresses(message.cc);
  if (message.bcc.length) payload.personalizations[0].bcc = listToSendgridAddresses(message.bcc);
  if (message.replyTo) payload.reply_to = { email: message.replyTo };
  if (message.text) payload.content.push({ type: "text/plain", value: message.text });
  if (message.html) payload.content.push({ type: "text/html", value: message.html });
  if (!payload.content.length) payload.content.push({ type: "text/plain", value: "" });

  const response = await axios.post("https://api.sendgrid.com/v3/mail/send", payload, {
    timeout: config.httpTimeoutMs,
    headers: {
      Authorization: `Bearer ${config.sendgridApiKey}`,
      "Content-Type": "application/json",
    },
  });

  return {
    status: response.status,
    requestId: response.headers?.["x-message-id"] || response.headers?.["x-request-id"] || null,
  };
}

async function sendWithMailgun(config, message) {
  const params = new URLSearchParams();
  params.append("from", message.from);
  message.to.forEach((email) => params.append("to", email));
  if (message.cc.length) message.cc.forEach((email) => params.append("cc", email));
  if (message.bcc.length) message.bcc.forEach((email) => params.append("bcc", email));
  params.append("subject", message.subject);
  if (message.text) params.append("text", message.text);
  if (message.html) params.append("html", message.html);
  if (message.replyTo) params.append("h:Reply-To", message.replyTo);
  if (!message.text && !message.html) params.append("text", "");

  const endpoint = `${config.mailgunBaseUrl.replace(/\/+$/, "")}/v3/${encodeURIComponent(config.mailgunDomain)}/messages`;
  const response = await axios.post(endpoint, params.toString(), {
    timeout: config.httpTimeoutMs,
    auth: {
      username: "api",
      password: config.mailgunApiKey,
    },
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  return {
    status: response.status,
    data: response.data,
  };
}

async function sendWithPostmark(config, message) {
  const payload = {
    From: message.from,
    To: message.to.join(", "),
    Subject: message.subject,
  };
  if (message.text) payload.TextBody = message.text;
  if (message.html) payload.HtmlBody = message.html;
  if (!message.text && !message.html) payload.TextBody = "";
  if (message.replyTo) payload.ReplyTo = message.replyTo;
  if (message.cc.length) payload.Cc = message.cc.join(", ");
  if (message.bcc.length) payload.Bcc = message.bcc.join(", ");
  if (config.postmarkMessageStream) payload.MessageStream = config.postmarkMessageStream;

  const response = await axios.post("https://api.postmarkapp.com/email", payload, {
    timeout: config.httpTimeoutMs,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": config.postmarkServerToken,
    },
  });

  return {
    status: response.status,
    data: response.data,
  };
}

async function sendWithSmtpOrJson(config, strategy, message) {
  const activeTransporter = buildTransporter(config, strategy);
  if (!activeTransporter) {
    throw new Error("SMTP transport is not configured. Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS or SMTP_URL.");
  }

  const info = await activeTransporter.sendMail({
    from: message.from,
    to: message.to,
    subject: message.subject,
    ...(message.html ? { html: message.html } : {}),
    ...(message.text ? { text: message.text } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(message.cc.length ? { cc: message.cc } : {}),
    ...(message.bcc.length ? { bcc: message.bcc } : {}),
  });

  return {
    messageId: info?.messageId || null,
    accepted: info?.accepted || [],
    rejected: info?.rejected || [],
    response: info?.response || null,
  };
}

function parseSendEmailArgs(args) {
  let to;
  let subject;
  let body;
  let isHtml = false;
  let htmlBody = null;
  let textBody = null;
  let options = {};

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

  return {
    to,
    subject: String(subject || ""),
    body,
    isHtml,
    htmlBody,
    textBody,
    options,
  };
}

function normalizeLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "en";
  if (raw === "turkish") return "tr";
  if (raw === "english") return "en";
  if (raw === "german") return "de";
  if (raw === "french") return "fr";
  return raw.split("-")[0] || "en";
}

/**
 * Backward-compatible API:
 * - sendEmail(to, subject, body, isHtml?, options?)
 * - sendEmail(context, to, subject, body, isHtml?, options?)  // legacy mismatch in scheduleMailer
 * - sendEmail({ to, subject, html/text/body, replyTo, fromName, fromEmail, from, cc, bcc })
 */
const sendEmail = async (...args) => {
  const parsed = parseSendEmailArgs(args);
  const language = normalizeLanguage(parsed.options.language || "en");
  let strategy = "unknown";
  const recipientsTo = normalizeRecipients(parsed.to);
  const recipientsCc = normalizeRecipients(parsed.options.cc);
  const recipientsBcc = normalizeRecipients(parsed.options.bcc);
  const replyTo = normalizeRecipients(parsed.options.replyTo)[0] || "";

  try {
    if (!recipientsTo.length) throw new Error("Email recipient is missing.");

    const config = resolveMailEnv();
    const requestedStrategy = String(
      parsed.options.provider || parsed.options.strategy || ""
    )
      .trim()
      .toLowerCase();
    if (requestedStrategy) {
      config.strategy = requestedStrategy;
    }
    strategy = config.strategy || "auto";
    strategy = resolveDeliveryStrategy(config);

    const fallbackFromEmail =
      parsed.options.fromEmail ||
      process.env.EMAIL_FROM ||
      process.env.MAIL_FROM ||
      process.env.SMTP_FROM ||
      process.env.RESEND_FROM ||
      process.env.SMTP_USER ||
      "no-reply@beypro.local";
    const fallbackFromName = parsed.options.fromName || "Beypro Notifications";
    const fromInput = parsed.options.from || `"${fallbackFromName}" <${fallbackFromEmail}>`;
    const fromParsed = parseFromAddress(fromInput, fallbackFromName, fallbackFromEmail);

    let html = null;
    let text = null;
    if (parsed.htmlBody !== null || parsed.textBody !== null) {
      if (parsed.htmlBody !== null) html = parsed.htmlBody;
      if (parsed.textBody !== null) text = parsed.textBody;
    } else if (parsed.body !== undefined && parsed.body !== null) {
      if (parsed.isHtml) html = String(parsed.body);
      else text = String(parsed.body);
    }

    const message = {
      from: fromParsed.from,
      fromName: fromParsed.fromName,
      fromEmail: fromParsed.fromEmail,
      to: recipientsTo,
      cc: recipientsCc,
      bcc: recipientsBcc,
      replyTo,
      subject: parsed.subject,
      html,
      text,
    };

    console.log("[email] send attempt", {
      provider: strategy,
      language,
      to: recipientsTo,
      ccCount: recipientsCc.length,
      bccCount: recipientsBcc.length,
      subject: parsed.subject,
      hasHtml: Boolean(html),
      hasText: Boolean(text),
    });

    let result = null;
    if (strategy === "resend") result = await sendWithResend(config, message);
    else if (strategy === "sendgrid") result = await sendWithSendgrid(config, message);
    else if (strategy === "mailgun") result = await sendWithMailgun(config, message);
    else if (strategy === "postmark") result = await sendWithPostmark(config, message);
    else result = await sendWithSmtpOrJson(config, strategy, message);

    console.log("[email] send success", {
      provider: strategy,
      language,
      to: recipientsTo,
      subject: parsed.subject,
      result: {
        ...result,
        data: truncateForLog(result?.data),
      },
    });
    return {
      ok: true,
      provider: strategy,
      language,
      to: recipientsTo,
      subject: parsed.subject,
      result,
    };
  } catch (error) {
    const details = summarizeAxiosError(error);
    console.error("[email] send failed", {
      provider: strategy,
      language,
      to: recipientsTo,
      subject: parsed.subject,
      error: details,
    });
    if (parsed.options && parsed.options.throwOnError) throw error;
    return {
      ok: false,
      provider: strategy,
      language,
      to: recipientsTo,
      subject: parsed.subject,
      error: details,
    };
  }
};

module.exports = { sendEmail };
