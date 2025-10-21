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

const sendEmail = async (to, subject, body, isHtml = false) => {
  try {
    const mailOptions = {
      from: `"Beypro Notifications" <${process.env.SMTP_USER}>`,
      to,
      subject,
      [isHtml ? "html" : "text"]: body,
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to: ${to}`);
  } catch (error) {
    console.error("❌ Error sending email:", error);
  }
};


module.exports = { sendEmail };
