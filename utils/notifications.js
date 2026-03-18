const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

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

    const fromEmail = options.fromEmail || process.env.SMTP_USER;
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

    await transporter.sendMail(mailOptions);
    const toDisplay = Array.isArray(to) ? to.join(", ") : String(to || "");
    console.log(`✅ Email sent to: ${toDisplay}`);
  } catch (error) {
    console.error("❌ Error sending email:", error);
    if (options && options.throwOnError) throw error;
  }
};


module.exports = { sendEmail };
