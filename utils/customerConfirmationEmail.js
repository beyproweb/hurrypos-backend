const { sendEmail } = require("./notifications");
const { loadLocalizationForRestaurant } = require("./localization");

const CONFIRMATION_TYPES = Object.freeze({
  CONCERT_TICKET: "concert_ticket",
  TABLE_RESERVATION: "table_reservation",
  PICKUP_ORDER: "pickup_order",
  DELIVERY_ORDER: "delivery_order",
});

const EMAIL_STATUS = Object.freeze({
  PENDING: "pending",
  SENT: "sent",
  FAILED: "failed",
  SKIPPED_NO_EMAIL: "skipped_no_email",
});

let ensureEmailLogTablePromise = null;

function asText(value, fallback = "") {
  const str = String(value ?? "").trim();
  return str || fallback;
}

function normalizeEmail(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "").replace(/\/api$/i, "");
}

function resolveRequestOrigin(req) {
  if (!req) return "";
  const forwardedProto = String(req.get?.("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const host = String(req.get?.("host") || "").trim();
  if (!host) return "";
  const isLocalHost =
    host.includes("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
  const protocol = forwardedProto || (isLocalHost ? "http" : "https");
  return `${protocol}://${host}`;
}

function resolvePublicWebBaseUrl(req) {
  const envBase = normalizePublicBaseUrl(
    process.env.PUBLIC_WEB_BASE_URL ||
      process.env.PUBLIC_POS_BASE_URL ||
      process.env.POS_APP_BASE_URL ||
      process.env.WEB_BASE_URL ||
      ""
  );
  if (envBase) return envBase;
  return resolveRequestOrigin(req);
}

function resolvePublicApiBaseUrl(req) {
  const envBase = normalizePublicBaseUrl(
    process.env.PUBLIC_API_BASE_URL ||
      process.env.PUBLIC_API_BASE ||
      process.env.API_BASE_URL ||
      ""
  );
  if (envBase) return envBase;
  return resolveRequestOrigin(req);
}

function toAbsoluteAssetUrl(src, req) {
  const value = String(src || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (!value.startsWith("/")) {
    if (value.startsWith("uploads/")) {
      return `${resolvePublicApiBaseUrl(req)}/${value}`;
    }
    return `${resolvePublicWebBaseUrl(req)}/${value}`;
  }
  if (value.startsWith("/uploads/")) return `${resolvePublicApiBaseUrl(req)}${value}`;
  return `${resolvePublicWebBaseUrl(req)}${value}`;
}

function parseMaybeJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    const text = asText(value, "");
    if (text) return text;
  }
  return "";
}

const LANGUAGE_LOCALE_MAP = Object.freeze({
  en: "en-US",
  tr: "tr-TR",
  de: "de-DE",
  fr: "fr-FR",
});

const EMAIL_I18N = Object.freeze({
  en: {
    our_restaurant: "our restaurant",
    greeting_named: "Hi {{name}},",
    greeting_generic: "Hi,",
    items: "Items",
    email_label: "Email",
    phone_label: "Phone",
    item_fallback: "Item",
    table_with_number: "Table {{number}}",
    pickup_at_restaurant: "Pickup at restaurant",
    concert_ticket_default: "Concert ticket",
    ticket_count: "{{count}} ticket(s)",
    order_number: "Order number",
    reservation_number: "Reservation number",
    date: "Date",
    reservation_date: "Reservation date",
    reservation_time: "Reservation time",
    guests: "Guests",
    table: "Table",
    delivery_address: "Delivery address",
    payment_method: "Payment method",
    pickup_type: "Pickup type",
    pickup_time: "Pickup time",
    total_amount: "Total amount",
    booking_number: "Booking number",
    concert: "Concert",
    event_date: "Event date",
    event_time: "Event time",
    ticket_type: "Ticket type",
    quantity: "Quantity",
    reserved_table: "Reserved table",
    concert_subject: "Your concert ticket is confirmed at {{restaurant}}",
    reservation_subject: "Your reservation is confirmed at {{restaurant}}",
    delivery_subject: "Thank you for your order - Delivery confirmed",
    pickup_subject: "Thank you for your order - Pickup confirmed",
    concert_headline: "Your concert ticket is confirmed",
    reservation_headline: "Your reservation is confirmed",
    delivery_headline: "Your order is confirmed for delivery",
    pickup_headline: "Your order is confirmed",
    concert_lead: "Thank you for your order. Your concert booking has been confirmed.",
    reservation_lead: "Thank you for your reservation. Your table booking is now confirmed.",
    delivery_lead:
      "Thank you for your order. We have confirmed it and started preparing it for delivery.",
    pickup_lead:
      "Thank you for your order. We have confirmed it and started preparing it for pickup.",
    reservation_closing:
      "Thank you for choosing {{restaurant}}. Your reservation is confirmed. We look forward to seeing you soon.",
    order_closing:
      "Thank you for choosing {{restaurant}}. Your order is confirmed. We look forward to seeing you soon.",
  },
  tr: {
    our_restaurant: "restoranımız",
    greeting_named: "Merhaba {{name}},",
    greeting_generic: "Merhaba,",
    items: "Ürünler",
    email_label: "E-posta",
    phone_label: "Telefon",
    item_fallback: "Ürün",
    table_with_number: "Masa {{number}}",
    pickup_at_restaurant: "Restorandan teslim",
    concert_ticket_default: "Konser bileti",
    ticket_count: "{{count}} bilet",
    order_number: "Sipariş numarası",
    reservation_number: "Rezervasyon numarası",
    date: "Tarih",
    reservation_date: "Rezervasyon tarihi",
    reservation_time: "Rezervasyon saati",
    guests: "Misafir",
    table: "Masa",
    delivery_address: "Teslimat adresi",
    payment_method: "Ödeme yöntemi",
    pickup_type: "Teslim alma türü",
    pickup_time: "Teslim alma saati",
    total_amount: "Toplam tutar",
    booking_number: "Rezervasyon numarası",
    concert: "Konser",
    event_date: "Etkinlik tarihi",
    event_time: "Etkinlik saati",
    ticket_type: "Bilet türü",
    quantity: "Adet",
    reserved_table: "Rezerve masa",
    concert_subject: "{{restaurant}} için konser biletiniz onaylandı",
    reservation_subject: "{{restaurant}} için rezervasyonunuz onaylandı",
    delivery_subject: "Siparişiniz için teşekkürler - Teslimat onaylandı",
    pickup_subject: "Siparişiniz için teşekkürler - Gel al onaylandı",
    concert_headline: "Konser biletiniz onaylandı",
    reservation_headline: "Rezervasyonunuz onaylandı",
    delivery_headline: "Siparişiniz teslimat için onaylandı",
    pickup_headline: "Siparişiniz onaylandı",
    concert_lead: "Siparişiniz için teşekkürler. Konser rezervasyonunuz onaylandı.",
    reservation_lead: "Rezervasyonunuz için teşekkürler. Masa rezervasyonunuz onaylandı.",
    delivery_lead: "Siparişiniz için teşekkürler. Siparişinizi onayladık ve teslimat için hazırlamaya başladık.",
    pickup_lead: "Siparişiniz için teşekkürler. Siparişinizi onayladık ve gel al için hazırlamaya başladık.",
    reservation_closing:
      "{{restaurant}} tercihiniz için teşekkürler. Rezervasyonunuz onaylandı. Sizi yakında görmek için sabırsızlanıyoruz.",
    order_closing:
      "{{restaurant}} tercihiniz için teşekkürler. Siparişiniz onaylandı. Sizi yakında görmek için sabırsızlanıyoruz.",
  },
  de: {
    our_restaurant: "unserem Restaurant",
    greeting_named: "Hallo {{name}},",
    greeting_generic: "Hallo,",
    items: "Artikel",
    email_label: "E-Mail",
    phone_label: "Telefon",
    item_fallback: "Artikel",
    table_with_number: "Tisch {{number}}",
    pickup_at_restaurant: "Abholung im Restaurant",
    concert_ticket_default: "Konzertticket",
    ticket_count: "{{count}} Ticket(s)",
    order_number: "Bestellnummer",
    reservation_number: "Reservierungsnummer",
    date: "Datum",
    reservation_date: "Reservierungsdatum",
    reservation_time: "Reservierungszeit",
    guests: "Gäste",
    table: "Tisch",
    delivery_address: "Lieferadresse",
    payment_method: "Zahlungsmethode",
    pickup_type: "Abholart",
    pickup_time: "Abholzeit",
    total_amount: "Gesamtbetrag",
    booking_number: "Buchungsnummer",
    concert: "Konzert",
    event_date: "Veranstaltungsdatum",
    event_time: "Veranstaltungszeit",
    ticket_type: "Tickettyp",
    quantity: "Menge",
    reserved_table: "Reservierter Tisch",
    concert_subject: "Ihr Konzertticket bei {{restaurant}} ist bestätigt",
    reservation_subject: "Ihre Reservierung bei {{restaurant}} ist bestätigt",
    delivery_subject: "Vielen Dank für Ihre Bestellung - Lieferung bestätigt",
    pickup_subject: "Vielen Dank für Ihre Bestellung - Abholung bestätigt",
    concert_headline: "Ihr Konzertticket ist bestätigt",
    reservation_headline: "Ihre Reservierung ist bestätigt",
    delivery_headline: "Ihre Bestellung wurde für die Lieferung bestätigt",
    pickup_headline: "Ihre Bestellung ist bestätigt",
    concert_lead: "Vielen Dank für Ihre Bestellung. Ihre Konzertbuchung wurde bestätigt.",
    reservation_lead: "Vielen Dank für Ihre Reservierung. Ihre Tischreservierung wurde bestätigt.",
    delivery_lead:
      "Vielen Dank für Ihre Bestellung. Wir haben sie bestätigt und bereiten sie für die Lieferung vor.",
    pickup_lead:
      "Vielen Dank für Ihre Bestellung. Wir haben sie bestätigt und bereiten sie zur Abholung vor.",
    reservation_closing:
      "Vielen Dank, dass Sie sich für {{restaurant}} entschieden haben. Ihre Reservierung ist bestätigt. Wir freuen uns auf Sie.",
    order_closing:
      "Vielen Dank, dass Sie sich für {{restaurant}} entschieden haben. Ihre Bestellung ist bestätigt. Wir freuen uns auf Sie.",
  },
  fr: {
    our_restaurant: "notre restaurant",
    greeting_named: "Bonjour {{name}},",
    greeting_generic: "Bonjour,",
    items: "Articles",
    email_label: "E-mail",
    phone_label: "Téléphone",
    item_fallback: "Article",
    table_with_number: "Table {{number}}",
    pickup_at_restaurant: "Retrait au restaurant",
    concert_ticket_default: "Billet de concert",
    ticket_count: "{{count}} billet(s)",
    order_number: "Numéro de commande",
    reservation_number: "Numéro de réservation",
    date: "Date",
    reservation_date: "Date de réservation",
    reservation_time: "Heure de réservation",
    guests: "Invités",
    table: "Table",
    delivery_address: "Adresse de livraison",
    payment_method: "Mode de paiement",
    pickup_type: "Type de retrait",
    pickup_time: "Heure de retrait",
    total_amount: "Montant total",
    booking_number: "Numéro de réservation",
    concert: "Concert",
    event_date: "Date de l'événement",
    event_time: "Heure de l'événement",
    ticket_type: "Type de billet",
    quantity: "Quantité",
    reserved_table: "Table réservée",
    concert_subject: "Votre billet de concert est confirmé chez {{restaurant}}",
    reservation_subject: "Votre réservation est confirmée chez {{restaurant}}",
    delivery_subject: "Merci pour votre commande - Livraison confirmée",
    pickup_subject: "Merci pour votre commande - Retrait confirmé",
    concert_headline: "Votre billet de concert est confirmé",
    reservation_headline: "Votre réservation est confirmée",
    delivery_headline: "Votre commande est confirmée pour la livraison",
    pickup_headline: "Votre commande est confirmée",
    concert_lead: "Merci pour votre commande. Votre réservation de concert a été confirmée.",
    reservation_lead: "Merci pour votre réservation. Votre réservation de table est confirmée.",
    delivery_lead:
      "Merci pour votre commande. Nous l'avons confirmée et avons commencé sa préparation pour la livraison.",
    pickup_lead:
      "Merci pour votre commande. Nous l'avons confirmée et avons commencé sa préparation pour le retrait.",
    reservation_closing:
      "Merci d'avoir choisi {{restaurant}}. Votre réservation est confirmée. Nous avons hâte de vous accueillir.",
    order_closing:
      "Merci d'avoir choisi {{restaurant}}. Votre commande est confirmée. Nous avons hâte de vous accueillir.",
  },
});

function normalizeLanguageCode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "en";
  const mapped =
    raw === "english"
      ? "en"
      : raw === "turkish"
        ? "tr"
        : raw === "german"
          ? "de"
          : raw === "french"
            ? "fr"
            : raw.split("-")[0];
  return EMAIL_I18N[mapped] ? mapped : "en";
}

function interpolate(template, params = {}) {
  const base = String(template ?? "");
  return base.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, token) => {
    const value = params[token];
    return value === undefined || value === null ? "" : String(value);
  });
}

function translateEmail(language, key, params = {}) {
  const lang = normalizeLanguageCode(language);
  const dict = EMAIL_I18N[lang] || EMAIL_I18N.en;
  const fallback = EMAIL_I18N.en[key] || key;
  return interpolate(dict[key] ?? fallback, params);
}

function localeForLanguage(language) {
  return LANGUAGE_LOCALE_MAP[normalizeLanguageCode(language)] || "en-US";
}

function formatDate(value, language = "en") {
  if (!value) return "";
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return asText(value);
  return new Intl.DateTimeFormat(localeForLanguage(language), {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(parsed);
}

function formatTime(value, language = "en") {
  if (!value) return "";
  const raw = asText(value);
  if (!raw) return "";
  const directTimeMatch = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (directTimeMatch) {
    const hh = String(directTimeMatch[1]).padStart(2, "0");
    const mm = directTimeMatch[2];
    return `${hh}:${mm}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return new Intl.DateTimeFormat(localeForLanguage(language), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

function formatMoney(value, language = "en") {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return new Intl.NumberFormat(localeForLanguage(language), {
    style: "currency",
    currency: "TRY",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function buildSubject(confirmationType, restaurantName, language = "en") {
  const safeName = asText(restaurantName, translateEmail(language, "our_restaurant"));
  switch (confirmationType) {
    case CONFIRMATION_TYPES.CONCERT_TICKET:
      return translateEmail(language, "concert_subject", { restaurant: safeName });
    case CONFIRMATION_TYPES.TABLE_RESERVATION:
      return translateEmail(language, "reservation_subject", { restaurant: safeName });
    case CONFIRMATION_TYPES.DELIVERY_ORDER:
      return translateEmail(language, "delivery_subject");
    case CONFIRMATION_TYPES.PICKUP_ORDER:
    default:
      return translateEmail(language, "pickup_subject");
  }
}

function buildHeadline(confirmationType, language = "en") {
  switch (confirmationType) {
    case CONFIRMATION_TYPES.CONCERT_TICKET:
      return translateEmail(language, "concert_headline");
    case CONFIRMATION_TYPES.TABLE_RESERVATION:
      return translateEmail(language, "reservation_headline");
    case CONFIRMATION_TYPES.DELIVERY_ORDER:
      return translateEmail(language, "delivery_headline");
    case CONFIRMATION_TYPES.PICKUP_ORDER:
    default:
      return translateEmail(language, "pickup_headline");
  }
}

function buildLeadMessage(confirmationType, language = "en") {
  switch (confirmationType) {
    case CONFIRMATION_TYPES.CONCERT_TICKET:
      return translateEmail(language, "concert_lead");
    case CONFIRMATION_TYPES.TABLE_RESERVATION:
      return translateEmail(language, "reservation_lead");
    case CONFIRMATION_TYPES.DELIVERY_ORDER:
      return translateEmail(language, "delivery_lead");
    case CONFIRMATION_TYPES.PICKUP_ORDER:
    default:
      return translateEmail(language, "pickup_lead");
  }
}

function buildClosingMessage(confirmationType, restaurantName, language = "en") {
  const safeRestaurant = asText(restaurantName, translateEmail(language, "our_restaurant"));
  if (confirmationType === CONFIRMATION_TYPES.TABLE_RESERVATION) {
    return translateEmail(language, "reservation_closing", { restaurant: safeRestaurant });
  }
  return translateEmail(language, "order_closing", { restaurant: safeRestaurant });
}

function buildHtmlTemplate({
  subject,
  confirmationType,
  restaurant,
  customerName,
  details,
  items,
  closingMessage,
  language = "en",
}) {
  const t = (key, params) => translateEmail(language, key, params);
  const brandColor = asText(restaurant.brandColor, "#0F766E");
  const logoHtml = restaurant.logoUrl
    ? `<img src="${escapeHtml(restaurant.logoUrl)}" alt="${escapeHtml(
        restaurant.name
      )}" style="max-height:56px;max-width:180px;display:block;margin:0 auto 14px auto;" />`
    : "";
  const headerBrandHtml =
    logoHtml ||
    `<div style="font-size:24px;font-weight:700;line-height:1.2;color:#FFFFFF;">${escapeHtml(
      restaurant.name
    )}</div>`;
  const detailRowsHtml = details
    .map(
      (row) =>
        `<tr>
          <td style="padding:8px 0;color:#6B7280;font-size:13px;vertical-align:top;">${escapeHtml(
            row.label
          )}</td>
          <td style="padding:8px 0;color:#111827;font-size:14px;font-weight:600;text-align:right;vertical-align:top;">${escapeHtml(
            row.value
          )}</td>
        </tr>`
    )
    .join("");
  const itemsHtml = items.length
    ? `<div style="margin-top:20px;">
        <div style="font-size:13px;color:#6B7280;letter-spacing:.02em;margin-bottom:8px;">${escapeHtml(
          t("items")
        )}</div>
        <ul style="margin:0;padding:0;list-style:none;border:1px solid #E5E7EB;border-radius:12px;overflow:hidden;">
          ${items
            .map(
              (line, idx) =>
                `<li style="padding:10px 12px;background:${idx % 2 === 0 ? "#FFFFFF" : "#F9FAFB"};font-size:14px;color:#111827;">${escapeHtml(
                  line
                )}</li>`
            )
            .join("")}
        </ul>
      </div>`
    : "";
  const footerParts = [
    restaurant.name,
    restaurant.contactEmail ? `${t("email_label")}: ${restaurant.contactEmail}` : "",
    restaurant.contactPhone ? `${t("phone_label")}: ${restaurant.contactPhone}` : "",
  ].filter(Boolean);

  return `<!doctype html>
<html lang="${escapeHtml(normalizeLanguageCode(language))}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F3F4F6;padding:20px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;margin:0 auto;">
            <tr>
              <td style="padding:0 14px;">
                <div style="background:#FFFFFF;border-radius:18px;border:1px solid #E5E7EB;overflow:hidden;box-shadow:0 10px 28px rgba(15,23,42,.08);">
                  <div style="padding:26px 22px 20px 22px;background:linear-gradient(130deg,${brandColor} 0%,#111827 100%);text-align:center;">
                    ${headerBrandHtml}
                  </div>
                  <div style="padding:24px 22px;">
                    <p style="margin:0 0 10px 0;font-size:15px;color:#374151;">${escapeHtml(
                      customerName
                        ? t("greeting_named", { name: customerName })
                        : t("greeting_generic")
                    )}</p>
                    <h1 style="margin:0 0 10px 0;font-size:24px;line-height:1.25;color:#111827;">${escapeHtml(
                      buildHeadline(confirmationType, language)
                    )}</h1>
                    <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#374151;">${escapeHtml(
                      buildLeadMessage(confirmationType, language)
                    )}</p>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #E5E7EB;border-bottom:1px solid #E5E7EB;padding:10px 0;">
                      ${detailRowsHtml}
                    </table>
                    ${itemsHtml}
                    <p style="margin:18px 0 0 0;font-size:15px;line-height:1.6;color:#374151;">${escapeHtml(
                      closingMessage
                    )}</p>
                  </div>
                </div>
                <div style="text-align:center;padding:12px 8px 2px 8px;font-size:12px;line-height:1.5;color:#6B7280;">
                  ${escapeHtml(footerParts.join(" • "))}
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildTextTemplate({
  confirmationType,
  restaurant,
  customerName,
  details,
  items,
  closingMessage,
  language = "en",
}) {
  const t = (key, params) => translateEmail(language, key, params);
  const greeting = customerName
    ? t("greeting_named", { name: customerName })
    : t("greeting_generic");
  const detailLines = details.map((row) => `- ${row.label}: ${row.value}`).join("\n");
  const itemLines = items.length
    ? `\n${t("items")}:\n${items.map((line) => `- ${line}`).join("\n")}\n`
    : "";

  return [
    greeting,
    "",
    buildHeadline(confirmationType, language),
    buildLeadMessage(confirmationType, language),
    "",
    detailLines,
    itemLines,
    closingMessage,
    "",
    `${restaurant.name}${restaurant.contactEmail ? ` | ${t("email_label")}: ${restaurant.contactEmail}` : ""}${
      restaurant.contactPhone ? ` | ${t("phone_label")}: ${restaurant.contactPhone}` : ""
    }`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function ensureCustomerConfirmationEmailLogTable(pool) {
  if (ensureEmailLogTablePromise) return ensureEmailLogTablePromise;
  ensureEmailLogTablePromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_confirmation_emails (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id INTEGER NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        confirmation_type TEXT NOT NULL,
        customer_email TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        subject TEXT,
        triggered_from TEXT,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_confirmation_emails_dedupe
      ON customer_confirmation_emails (restaurant_id, entity_type, entity_id, confirmation_type)
    `);
  })().catch((err) => {
    ensureEmailLogTablePromise = null;
    throw err;
  });
  return ensureEmailLogTablePromise;
}

async function claimEmailAttempt(client, payload) {
  const result = await client.query(
    `
    INSERT INTO customer_confirmation_emails (
      restaurant_id,
      entity_type,
      entity_id,
      confirmation_type,
      customer_email,
      status,
      triggered_from
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (restaurant_id, entity_type, entity_id, confirmation_type)
    DO UPDATE
       SET status = 'pending',
           customer_email = COALESCE(EXCLUDED.customer_email, customer_confirmation_emails.customer_email),
           triggered_from = COALESCE(EXCLUDED.triggered_from, customer_confirmation_emails.triggered_from),
           last_error = NULL
     WHERE customer_confirmation_emails.status <> 'sent'
    RETURNING id
    `,
    [
      payload.restaurantId,
      payload.entityType,
      payload.entityId,
      payload.confirmationType,
      payload.customerEmail || null,
      EMAIL_STATUS.PENDING,
      payload.triggeredFrom || null,
    ]
  );
  return result.rows?.[0]?.id ? Number(result.rows[0].id) : null;
}

async function markEmailAttempt(client, id, status, updates = {}) {
  if (!id) return;
  await client.query(
    `
    UPDATE customer_confirmation_emails
       SET status = $2,
           customer_email = COALESCE($3, customer_email),
           subject = COALESCE($4, subject),
           last_error = $5,
           sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END
     WHERE id = $1
    `,
    [id, status, updates.customerEmail || null, updates.subject || null, updates.lastError || null]
  );
}

async function loadRestaurantBranding(client, restaurantId, req) {
  const restaurantResult = await client.query(
    `
    SELECT
      r.id,
      r.name,
      r.logo_url,
      r.pos_location,
      u.email AS owner_email,
      u.phone AS owner_phone
    FROM restaurants r
    LEFT JOIN users u ON u.id = r.owner_id
    WHERE r.id = $1
    LIMIT 1
    `,
    [restaurantId]
  );
  const restaurantRow = restaurantResult.rows?.[0];
  if (!restaurantRow) return null;

  const settingsResult = await client.query(
    `
    SELECT qr_menu_customization, value
    FROM settings
    WHERE restaurant_id = $1
      AND key = 'qr-menu-customization'
    LIMIT 1
    `,
    [restaurantId]
  );
  const customization = parseMaybeJsonObject(
    settingsResult.rows?.[0]?.qr_menu_customization ?? settingsResult.rows?.[0]?.value ?? {}
  );

  const logoCandidate = pickFirstNonEmpty(
    customization.main_title_logo,
    customization.mainTitleLogo,
    customization.splash_logo,
    customization.logo,
    customization.logo_url,
    restaurantRow.logo_url
  );

  const brandColor = pickFirstNonEmpty(
    customization.accent_color,
    customization.primary_color,
    customization.qr_primary_color,
    "#0F766E"
  );

  return {
    name: pickFirstNonEmpty(customization.restaurant_name, restaurantRow.name, "Restaurant"),
    logoUrl: toAbsoluteAssetUrl(logoCandidate, req),
    brandColor,
    contactEmail: normalizeEmail(
      pickFirstNonEmpty(customization.contact_email, customization.email, restaurantRow.owner_email)
    ),
    contactPhone: pickFirstNonEmpty(customization.contact_phone, restaurantRow.owner_phone),
    address: pickFirstNonEmpty(restaurantRow.pos_location),
  };
}

function normalizeItems(itemRows, { language = "en", t = null } = {}) {
  const translate = typeof t === "function" ? t : (key, params) => translateEmail(language, key, params);
  return (Array.isArray(itemRows) ? itemRows : [])
    .map((row) => {
      const quantity = Math.max(1, Number(row.quantity || 1));
      const lineName = pickFirstNonEmpty(
        row.order_item_name,
        row.external_product_name,
        row.product_name,
        translate("item_fallback")
      );
      const price = Number(row.price || 0);
      const lineTotal = price * quantity;
      return `${quantity} x ${lineName}${
        Number.isFinite(lineTotal) ? ` (${formatMoney(lineTotal, language)})` : ""
      }`;
    })
    .filter(Boolean);
}

async function resolveCustomerEmail(client, { restaurantId, phone, explicitEmail }) {
  const normalizedExplicit = normalizeEmail(explicitEmail);
  if (normalizedExplicit) return normalizedExplicit;
  const cleanPhone = asText(phone, "");
  if (!cleanPhone) return "";
  const result = await client.query(
    `
    SELECT email
    FROM customers
    WHERE restaurant_id = $1
      AND phone = $2
    LIMIT 1
    `,
    [restaurantId, cleanPhone]
  );
  return normalizeEmail(result.rows?.[0]?.email);
}

async function sendCustomerConfirmationEmail({
  pool,
  entityType,
  entityId,
  restaurantId,
  confirmationType,
  explicitCustomerEmail,
  triggeredFrom,
  req,
  dataLoader,
}) {
  try {
    await ensureCustomerConfirmationEmailLogTable(pool);
  } catch (err) {
    console.error("❌ Failed to initialize customer confirmation email log table:", err);
    return { sent: false, error: "email_log_init_failed" };
  }
  const client = await pool.connect();
  let attemptId = null;
  try {
    attemptId = await claimEmailAttempt(client, {
      restaurantId,
      entityType,
      entityId,
      confirmationType,
      customerEmail: explicitCustomerEmail,
      triggeredFrom,
    });

    if (!attemptId) {
      console.log(
        `ℹ️ Customer confirmation email skipped (already processed): restaurant=${restaurantId} entity=${entityType}:${entityId} type=${confirmationType}`
      );
      return { sent: false, skipped: "duplicate" };
    }

    let language = "en";
    try {
      const localization = await loadLocalizationForRestaurant(restaurantId);
      language = normalizeLanguageCode(localization?.language);
    } catch (localizationErr) {
      console.warn("⚠️ Failed to load localization for customer confirmation email:", localizationErr?.message || localizationErr);
    }

    const t = (key, params) => translateEmail(language, key, params);
    const loadedData = await dataLoader(client, { language, t });
    if (!loadedData) {
      await markEmailAttempt(client, attemptId, EMAIL_STATUS.FAILED, {
        lastError: "missing_email_context",
      });
      console.warn(
        `⚠️ Customer confirmation email context missing: restaurant=${restaurantId} entity=${entityType}:${entityId}`
      );
      return { sent: false, skipped: "missing_context" };
    }

    const customerEmail = await resolveCustomerEmail(client, {
      restaurantId,
      phone: loadedData.customerPhone,
      explicitEmail: explicitCustomerEmail || loadedData.customerEmail,
    });

    if (!customerEmail) {
      await markEmailAttempt(client, attemptId, EMAIL_STATUS.SKIPPED_NO_EMAIL, {
        lastError: "missing_customer_email",
      });
      console.log(
        `ℹ️ Customer confirmation email skipped (no email): restaurant=${restaurantId} entity=${entityType}:${entityId}`
      );
      return { sent: false, skipped: "missing_email" };
    }

    const restaurantBranding = await loadRestaurantBranding(client, restaurantId, req);
    if (!restaurantBranding) {
      await markEmailAttempt(client, attemptId, EMAIL_STATUS.FAILED, {
        customerEmail,
        lastError: "restaurant_not_found",
      });
      return { sent: false, skipped: "restaurant_not_found" };
    }

    const subject = buildSubject(confirmationType, restaurantBranding.name, language);
    const details = Array.isArray(loadedData.details) ? loadedData.details.filter(Boolean) : [];
    const items = Array.isArray(loadedData.items) ? loadedData.items.filter(Boolean) : [];
    const closingMessage = buildClosingMessage(confirmationType, restaurantBranding.name, language);

    const html = buildHtmlTemplate({
      subject,
      confirmationType,
      restaurant: restaurantBranding,
      customerName: loadedData.customerName,
      details,
      items,
      closingMessage,
      language,
    });
    const text = buildTextTemplate({
      confirmationType,
      restaurant: restaurantBranding,
      customerName: loadedData.customerName,
      details,
      items,
      closingMessage,
      language,
    });

    await sendEmail({
      to: customerEmail,
      subject,
      html,
      text,
      fromName: restaurantBranding.name,
      replyTo: restaurantBranding.contactEmail || undefined,
      throwOnError: true,
    });

    await markEmailAttempt(client, attemptId, EMAIL_STATUS.SENT, {
      customerEmail,
      subject,
      lastError: null,
    });
    console.log(
      `✅ Customer confirmation email sent: restaurant=${restaurantId} entity=${entityType}:${entityId} type=${confirmationType} to=${customerEmail}`
    );
    return { sent: true };
  } catch (err) {
    if (attemptId) {
      try {
        await markEmailAttempt(client, attemptId, EMAIL_STATUS.FAILED, {
          customerEmail: explicitCustomerEmail || null,
          lastError: err?.message || "send_failed",
        });
      } catch (markErr) {
        console.warn("⚠️ Failed to mark customer confirmation email failure:", markErr?.message || markErr);
      }
    }
    console.error(
      `❌ Customer confirmation email failed: restaurant=${restaurantId} entity=${entityType}:${entityId} type=${confirmationType}`,
      err
    );
    return { sent: false, error: err?.message || "send_failed" };
  } finally {
    client.release();
  }
}

async function sendOrderCustomerConfirmationEmail({
  pool,
  restaurantId,
  orderId,
  confirmationType,
  explicitCustomerEmail = "",
  triggeredFrom = "orders",
  req = null,
}) {
  return sendCustomerConfirmationEmail({
    pool,
    entityType: "order",
    entityId: orderId,
    restaurantId,
    confirmationType,
    explicitCustomerEmail,
    triggeredFrom,
    req,
    dataLoader: async (client, { language = "en", t = (key, params) => translateEmail(language, key, params) }) => {
      const orderResult = await client.query(
        `
        SELECT
          id,
          order_number,
          total,
          created_at,
          pickup_time,
          order_type,
          customer_name,
          customer_phone,
          customer_address,
          payment_method,
          reservation_date,
          reservation_time,
          reservation_clients,
          reservation_notes,
          table_number
        FROM orders
        WHERE restaurant_id = $1
          AND id = $2
        LIMIT 1
        `,
        [restaurantId, orderId]
      );
      const order = orderResult.rows?.[0];
      if (!order) return null;

      const itemResult = await client.query(
        `
        SELECT
          oi.name AS order_item_name,
          oi.external_product_name,
          p.name AS product_name,
          oi.quantity,
          oi.price
        FROM order_items oi
        LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = $1
        ORDER BY oi.id ASC
        `,
        [orderId]
      );

      const details = [];
      const numberLabel =
        confirmationType === CONFIRMATION_TYPES.TABLE_RESERVATION
          ? t("reservation_number")
          : t("order_number");
      details.push({
        label: numberLabel,
        value: asText(order.order_number, "") || `#${order.id}`,
      });
      details.push({ label: t("date"), value: formatDate(order.created_at, language) || "-" });

      if (confirmationType === CONFIRMATION_TYPES.TABLE_RESERVATION) {
        details.push({ label: t("reservation_date"), value: formatDate(order.reservation_date, language) || "-" });
        details.push({ label: t("reservation_time"), value: formatTime(order.reservation_time, language) || "-" });
        if (Number(order.reservation_clients) > 0) {
          details.push({ label: t("guests"), value: String(Number(order.reservation_clients)) });
        }
        if (Number(order.table_number) > 0) {
          details.push({
            label: t("table"),
            value: t("table_with_number", { number: Number(order.table_number) }),
          });
        }
      } else if (confirmationType === CONFIRMATION_TYPES.DELIVERY_ORDER) {
        if (order.customer_address) {
          details.push({ label: t("delivery_address"), value: asText(order.customer_address) });
        }
        if (asText(order.payment_method, "")) {
          details.push({ label: t("payment_method"), value: asText(order.payment_method) });
        }
      } else {
        details.push({ label: t("pickup_type"), value: t("pickup_at_restaurant") });
        if (order.pickup_time) {
          details.push({
            label: t("pickup_time"),
            value: formatTime(order.pickup_time, language) || asText(order.pickup_time),
          });
        }
        if (asText(order.payment_method, "")) {
          details.push({ label: t("payment_method"), value: asText(order.payment_method) });
        }
      }

      if (Number.isFinite(Number(order.total))) {
        details.push({
          label: t("total_amount"),
          value: formatMoney(order.total, language) || String(order.total),
        });
      }

      return {
        customerName: asText(order.customer_name, ""),
        customerPhone: asText(order.customer_phone, ""),
        customerEmail: "",
        details,
        items: normalizeItems(itemResult.rows, { language, t }),
      };
    },
  });
}

async function sendConcertCustomerConfirmationEmail({
  pool,
  restaurantId,
  bookingId,
  explicitCustomerEmail = "",
  triggeredFrom = "concerts",
  req = null,
}) {
  return sendCustomerConfirmationEmail({
    pool,
    entityType: "concert_booking",
    entityId: bookingId,
    restaurantId,
    confirmationType: CONFIRMATION_TYPES.CONCERT_TICKET,
    explicitCustomerEmail,
    triggeredFrom,
    req,
    dataLoader: async (client, { language = "en", t = (key, params) => translateEmail(language, key, params) }) => {
      const bookingResult = await client.query(
        `
        SELECT
          cb.id,
          cb.quantity,
          cb.total_amount,
          cb.customer_name,
          cb.customer_phone,
          cb.reserved_table_number,
          cb.guests_count,
          cb.payment_status,
          cb.booking_type,
          cb.confirmed_at,
          cb.reservation_order_id,
          tt.name AS ticket_type_name,
          ce.event_title,
          ce.artist_name,
          ce.event_date,
          ce.event_time,
          o.order_number
        FROM concert_bookings cb
        LEFT JOIN concert_ticket_types tt ON tt.id = cb.ticket_type_id
        LEFT JOIN concert_events ce ON ce.id = cb.event_id
        LEFT JOIN orders o ON o.id = cb.reservation_order_id
        WHERE cb.restaurant_id = $1
          AND cb.id = $2
        LIMIT 1
        `,
        [restaurantId, bookingId]
      );
      const booking = bookingResult.rows?.[0];
      if (!booking) return null;

      const details = [
        { label: t("booking_number"), value: `#${booking.id}` },
        { label: t("date"), value: formatDate(booking.confirmed_at || new Date(), language) || "-" },
      ];

      const eventLabel = [asText(booking.event_title), asText(booking.artist_name)].filter(Boolean).join(" - ");
      if (eventLabel) details.push({ label: t("concert"), value: eventLabel });
      if (booking.event_date) details.push({ label: t("event_date"), value: formatDate(booking.event_date, language) });
      if (booking.event_time) details.push({ label: t("event_time"), value: formatTime(booking.event_time, language) });
      if (booking.ticket_type_name) details.push({ label: t("ticket_type"), value: asText(booking.ticket_type_name) });
      if (Number(booking.quantity) > 0) details.push({ label: t("quantity"), value: String(Number(booking.quantity)) });
      if (Number.isFinite(Number(booking.total_amount))) {
        details.push({
          label: t("total_amount"),
          value: formatMoney(booking.total_amount, language) || String(booking.total_amount),
        });
      }
      if (Number(booking.reserved_table_number) > 0) {
        details.push({
          label: t("reserved_table"),
          value: t("table_with_number", { number: Number(booking.reserved_table_number) }),
        });
      }
      if (Number(booking.guests_count) > 0) {
        details.push({ label: t("guests"), value: String(Number(booking.guests_count)) });
      }
      if (booking.order_number || booking.reservation_order_id) {
        details.push({
          label: t("order_number"),
          value: asText(booking.order_number, "") || `#${booking.reservation_order_id}`,
        });
      }

      const itemLine = [
        asText(booking.ticket_type_name, t("concert_ticket_default")),
        Number(booking.quantity) > 0 ? t("ticket_count", { count: Number(booking.quantity) }) : "",
      ]
        .filter(Boolean)
        .join(" • ");

      return {
        customerName: asText(booking.customer_name, ""),
        customerPhone: asText(booking.customer_phone, ""),
        customerEmail: "",
        details,
        items: itemLine ? [itemLine] : [],
      };
    },
  });
}

module.exports = {
  CONFIRMATION_TYPES,
  sendOrderCustomerConfirmationEmail,
  sendConcertCustomerConfirmationEmail,
};
