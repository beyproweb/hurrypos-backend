const { sendEmail } = require("./notifications");

async function sendNoOrderEmail(supplierName, supplierEmail, scheduledDate) {
  if (!supplierEmail) {
    console.warn("📭 Skipped email not sent: No email address provided.");
    return;
  }

  const formattedDate = new Date(scheduledDate).toLocaleString("tr-TR", {
    hour12: false,
    timeZone: "Europe/Istanbul",
  });

  const subject = "📭 No Order This Week";

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; font-size: 15px; color: #333;">
      <h2 style="color: #e63946;">📭 No Order This Week</h2>
      <p>Hello <strong>${supplierName}</strong>,</p>
      <p>
        No order was generated for the scheduled date: <strong>${formattedDate}</strong>.
      </p>
      <p>
        This is because all stock items remained above their critical levels in the past 7 days.
      </p>
      <p style="margin-top: 1.5em;">
        Thank you for your continued support.<br />
        <strong>HurryPOS</strong>
      </p>
    </div>
  `;

  try {
    await sendEmail(supplierEmail, subject, htmlBody, true);
    console.log(`📭 Skipped-order notice sent to ${supplierEmail}`);
  } catch (err) {
    console.error("❌ Failed to send skipped-order email:", err);
  }
}

module.exports = sendNoOrderEmail;
