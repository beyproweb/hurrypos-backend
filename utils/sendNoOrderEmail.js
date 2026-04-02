const { sendEmail } = require("./notifications");
const { isTurkishLanguage, normalizeEmailLanguage } = require("./emailLanguage");

const RESEND_PROVIDER = process.env.RESEND_API_KEY ? "resend" : undefined;

async function sendNoOrderEmail(supplierName, supplierEmail, scheduledDate, options = {}) {
  if (!supplierEmail) {
    console.warn("📭 Skipped email not sent: No email address provided.");
    return;
  }

  const replyTo = options && options.replyTo ? String(options.replyTo) : "";
  const restaurantName =
    options && options.restaurantName ? String(options.restaurantName) : "";
  const language = normalizeEmailLanguage(options?.language || "en", "en");
  const useTurkish = isTurkishLanguage(language);

  const formattedDate = new Date(scheduledDate).toLocaleString(
    useTurkish ? "tr-TR" : "en-US",
    {
    hour12: false,
    timeZone: "Europe/Istanbul",
    }
  );

  const subject = useTurkish ? "📭 Bu Hafta Sipariş Yok" : "📭 No Order This Week";

  const restaurantLine =
    restaurantName || replyTo
      ? `<p><strong>${useTurkish ? "Restoran" : "Restaurant"}:</strong> ${restaurantName || "—"}${replyTo ? ` &nbsp;(<a href="mailto:${replyTo}">${replyTo}</a>)` : ""}</p>`
      : "";

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; font-size: 15px; color: #333;">
      <h2 style="color: #e63946;">${useTurkish ? "📭 Bu Hafta Sipariş Yok" : "📭 No Order This Week"}</h2>
      <p>${useTurkish ? "Merhaba" : "Hello"} <strong>${supplierName}</strong>,</p>
      ${restaurantLine}
      <p>
        ${
          useTurkish
            ? `Planlanan tarih için sipariş oluşturulmadı: <strong>${formattedDate}</strong>.`
            : `No order was generated for the scheduled date: <strong>${formattedDate}</strong>.`
        }
      </p>
      <p>
        ${
          useTurkish
            ? "Bunun nedeni, son 7 gün içinde tüm stok kalemlerinin kritik seviyenin üzerinde kalmasıdır."
            : "This is because all stock items remained above their critical levels in the past 7 days."
        }
      </p>
      <p style="margin-top: 1.5em;">
        ${
          useTurkish
            ? "Sürekli desteğiniz için teşekkür ederiz."
            : "Thank you for your continued support."
        }<br />
        <strong>HurryPOS</strong>
      </p>
    </div>
  `;

  try {
    await sendEmail(supplierEmail, subject, htmlBody, true, {
      replyTo: replyTo || undefined,
      fromName: "Beypro Orders",
      language,
      provider: RESEND_PROVIDER,
      throwOnError: true,
    });
    console.log(`📭 Skipped-order notice sent to ${supplierEmail}`);
  } catch (err) {
    console.error("❌ Failed to send skipped-order email:", err);
  }
}

module.exports = sendNoOrderEmail;
