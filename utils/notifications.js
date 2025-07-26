const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail', // or use 'smtp.mailtrap.io' for testing
  auth: {
    user: process.env.EMAIL_USER, // Your email
    pass: process.env.EMAIL_PASS, // Your email password or app password
  },
});

// Send email utility function
const sendEmail = async (to, subject, body, isHtml = false) => {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to,
      subject,
      [isHtml ? 'html' : 'text']: body, // Automatically decide between HTML or plain text
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to: ${to}`);
  } catch (error) {
    console.error('❌ Error sending email:', error);
  }
};

module.exports = { sendEmail };
