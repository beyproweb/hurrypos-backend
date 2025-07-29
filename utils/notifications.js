const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Send email utility function
const sendEmail = async (to, subject, body, isHtml = false) => {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const mailOptions = {
      from: process.env.SMTP_USER,
      to,
      subject,
      [isHtml ? 'html' : 'text']: body,
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to: ${to}`);
  } catch (error) {
    console.error('❌ Error sending email:', error);
  }
};

module.exports = { sendEmail };
