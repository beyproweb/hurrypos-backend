const { sendEmail } = require("./notifications");
const { loadLocalizationForRestaurant } = require("./localization");
const { ensureBookingQrSchema } = require("./bookingQrAsync");

const CONFIRMATION_TYPES = Object.freeze({
  CONCERT_TICKET: "concert_ticket",
  CONCERT_TICKET_CANCELLED: "concert_ticket_cancelled",
  TABLE_RESERVATION: "table_reservation",
  TABLE_RESERVATION_CANCELLED: "table_reservation_cancelled",
  PICKUP_ORDER: "pickup_order",
  DELIVERY_ORDER: "delivery_order",
  DELIVERY_ORDER_DELIVERED: "delivery_order_delivered",
  DELIVERY_ORDER_CANCELLED: "delivery_order_cancelled",
});

const OWNER_NOTIFICATION_TYPES = Object.freeze({
  CONCERT_RESERVATION_CREATED: "concert_reservation_created",
  TABLE_RESERVATION_CREATED: "table_reservation_created",
  DELIVERY_ORDER_CREATED: "delivery_order_created",
});

const EMAIL_STATUS = Object.freeze({
  PENDING: "pending",
  SENT: "sent",
  FAILED: "failed",
  SKIPPED_NO_EMAIL: "skipped_no_email",
});

const RESEND_PROVIDER = process.env.RESEND_API_KEY ? "resend" : undefined;

let ensureEmailLogTablePromise = null;
let ensureOwnerNotificationEmailLogTablePromise = null;
const OWNER_NOTIFICATION_LOG_PREFIX = "[owner-reservation-email]";

function logOwnerNotification(event, payload = {}) {
  console.log(`${OWNER_NOTIFICATION_LOG_PREFIX} ${event}`, payload);
}

function warnOwnerNotification(event, payload = {}) {
  console.warn(`${OWNER_NOTIFICATION_LOG_PREFIX} ${event}`, payload);
}

function errorOwnerNotification(event, payload = {}) {
  console.error(`${OWNER_NOTIFICATION_LOG_PREFIX} ${event}`, payload);
}

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

function getFallbackPublicApiBaseUrl() {
  return normalizePublicBaseUrl(
    process.env.PUBLIC_API_BASE_URL ||
      process.env.PUBLIC_API_BASE ||
      process.env.API_BASE_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      process.env.URL ||
      "https://hurrypos-backend.onrender.com"
  );
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
  const envBase = getFallbackPublicApiBaseUrl();
  if (envBase) return envBase;
  const requestOrigin = resolveRequestOrigin(req);
  if (
    requestOrigin &&
    !/localhost|127\.0\.0\.1|\[::1\]/i.test(requestOrigin)
  ) {
    return requestOrigin;
  }
  return getFallbackPublicApiBaseUrl();
}

function normalizeExternalQrUrl(qrUrl) {
  const normalized = asText(qrUrl);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    if (/localhost|127\.0\.0\.1|\[::1\]/i.test(url.hostname)) {
      const fallbackBase = getFallbackPublicApiBaseUrl();
      if (!fallbackBase) return normalized;
      return new URL(`${url.pathname}${url.search}${url.hash}`, fallbackBase).toString();
    }
    return url.toString();
  } catch {
    return normalized;
  }
}

function buildEmailQrImageUrl(qrUrl) {
  const normalized = normalizeExternalQrUrl(qrUrl);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.pathname = url.pathname.replace(/\/qr\/([^/?#]+)$/i, "/qr-image/$1");
    url.searchParams.delete("format");
    return url.toString();
  } catch {
    return normalized.replace(/\/qr\/([^/?#]+)(\?.*)?$/i, "/qr-image/$1");
  }
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
    customer_name: "Customer name",
    customer_phone: "Customer phone",
    customer_email: "Customer email",
    cancellation_reason: "Cancellation reason",
    notes: "Notes",
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
    concert_pending_subject: "Your concert booking was received at {{restaurant}}",
    concert_cancelled_subject: "Your concert booking was cancelled at {{restaurant}}",
    reservation_subject: "Your reservation is confirmed at {{restaurant}}",
    reservation_cancelled_subject: "Your reservation was cancelled at {{restaurant}}",
    delivery_subject: "Thank you for your order - Delivery confirmed",
    delivery_delivered_subject: "Your delivery order from {{restaurant}} has arrived",
    delivery_cancelled_subject: "Your delivery order from {{restaurant}} was cancelled",
    pickup_subject: "Thank you for your order - Pickup confirmed",
    concert_headline: "Your concert ticket is confirmed",
    concert_pending_headline: "Your concert booking was received",
    concert_cancelled_headline: "Your concert booking was cancelled",
    reservation_headline: "Your reservation is confirmed",
    reservation_cancelled_headline: "Your reservation was cancelled",
    delivery_headline: "Your order is confirmed for delivery",
    delivery_delivered_headline: "Your delivery order has been delivered",
    delivery_cancelled_headline: "Your delivery order was cancelled",
    pickup_headline: "Your order is confirmed",
    concert_lead: "Thank you for your order. Your concert booking has been confirmed.",
    concert_pending_lead:
      "Thank you for your order. We received your concert booking and attached your QR code for later check-in.",
    concert_cancelled_lead: "Your concert booking has been cancelled.",
    reservation_lead: "Thank you for your reservation. Your table booking is now confirmed.",
    reservation_cancelled_lead: "Your table reservation has been cancelled.",
    delivery_lead:
      "Thank you for your order. We have confirmed it and started preparing it for delivery.",
    delivery_delivered_lead:
      "Your delivery order has arrived. We hope you enjoy your meal.",
    delivery_cancelled_lead:
      "Your delivery order has been cancelled.",
    pickup_lead:
      "Thank you for your order. We have confirmed it and started preparing it for pickup.",
    owner_greeting_generic: "Hello,",
    owner_concert_subject: "New concert reservation for {{restaurant}}",
    owner_reservation_subject: "New table reservation for {{restaurant}}",
    owner_delivery_subject: "New delivery order for {{restaurant}}",
    owner_concert_headline: "New concert reservation received",
    owner_reservation_headline: "New table reservation received",
    owner_delivery_headline: "New delivery order received",
    owner_concert_lead: "A customer has created a new concert reservation.",
    owner_reservation_lead: "A customer has created a new table reservation.",
    owner_delivery_lead: "A customer has placed a new delivery order.",
    owner_view_booking: "View booking",
    owner_view_order: "View order",
    reservation_closing:
      "Thank you for choosing {{restaurant}}. Your reservation is confirmed. We look forward to seeing you soon.",
    reservation_cancelled_closing:
      "Your reservation has been cancelled. If this was unexpected, please contact {{restaurant}}.",
    order_closing:
      "Thank you for choosing {{restaurant}}. Your order is confirmed. We look forward to seeing you soon.",
    concert_pending_closing:
      "We will notify you again if your booking status changes. If this was unexpected, please contact {{restaurant}}.",
    delivery_delivered_closing:
      "Your order has been delivered. If anything is missing, please contact {{restaurant}}.",
    delivery_cancelled_closing:
      "Your delivery order has been cancelled. If this was unexpected, please contact {{restaurant}}.",
    concert_cancelled_closing:
      "Your concert booking has been cancelled. If this was unexpected, please contact {{restaurant}}.",
  },
  tr: {
    our_restaurant: "restoranımız",
    greeting_named: "Merhaba {{name}},",
    greeting_generic: "Merhaba,",
    items: "Ürünler",
    email_label: "E-posta",
    phone_label: "Telefon",
    customer_name: "Müşteri adı",
    customer_phone: "Müşteri telefonu",
    customer_email: "Müşteri e-postası",
    cancellation_reason: "İptal nedeni",
    notes: "Notlar",
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
    concert_pending_subject: "{{restaurant}} için konser rezervasyonunuz alındı",
    concert_cancelled_subject: "{{restaurant}} için konser rezervasyonunuz iptal edildi",
    reservation_subject: "{{restaurant}} için rezervasyonunuz onaylandı",
    reservation_cancelled_subject: "{{restaurant}} için rezervasyonunuz iptal edildi",
    delivery_subject: "Siparişiniz için teşekkürler - Teslimat onaylandı",
    delivery_delivered_subject: "{{restaurant}} teslimat siparişiniz ulaştı",
    delivery_cancelled_subject: "{{restaurant}} teslimat siparişiniz iptal edildi",
    pickup_subject: "Siparişiniz için teşekkürler - Gel al onaylandı",
    concert_headline: "Konser biletiniz onaylandı",
    concert_pending_headline: "Konser rezervasyonunuz alındı",
    concert_cancelled_headline: "Konser rezervasyonunuz iptal edildi",
    reservation_headline: "Rezervasyonunuz onaylandı",
    reservation_cancelled_headline: "Rezervasyonunuz iptal edildi",
    delivery_headline: "Siparişiniz teslimat için onaylandı",
    delivery_delivered_headline: "Teslimat siparişiniz teslim edildi",
    delivery_cancelled_headline: "Teslimat siparişiniz iptal edildi",
    pickup_headline: "Siparişiniz onaylandı",
    concert_lead: "Siparişiniz için teşekkürler. Konser rezervasyonunuz onaylandı.",
    concert_pending_lead:
      "Siparişiniz için teşekkürler. Konser rezervasyonunuzu aldık ve sonraki check-in işlemleri için QR kodunuzu ekledik.",
    concert_cancelled_lead: "Konser rezervasyonunuz iptal edildi.",
    reservation_lead: "Rezervasyonunuz için teşekkürler. Masa rezervasyonunuz onaylandı.",
    reservation_cancelled_lead: "Masa rezervasyonunuz iptal edildi.",
    delivery_lead: "Siparişiniz için teşekkürler. Siparişinizi onayladık ve teslimat için hazırlamaya başladık.",
    delivery_delivered_lead: "Teslimat siparişiniz ulaştı. Afiyet olsun.",
    delivery_cancelled_lead: "Teslimat siparişiniz iptal edildi.",
    pickup_lead: "Siparişiniz için teşekkürler. Siparişinizi onayladık ve gel al için hazırlamaya başladık.",
    owner_greeting_generic: "Merhaba,",
    owner_concert_subject: "{{restaurant}} için yeni konser rezervasyonu",
    owner_reservation_subject: "{{restaurant}} için yeni masa rezervasyonu",
    owner_delivery_subject: "{{restaurant}} için yeni teslimat siparişi",
    owner_concert_headline: "Yeni konser rezervasyonu alındı",
    owner_reservation_headline: "Yeni masa rezervasyonu alındı",
    owner_delivery_headline: "Yeni teslimat siparişi alındı",
    owner_concert_lead: "Bir müşteri yeni bir konser rezervasyonu oluşturdu.",
    owner_reservation_lead: "Bir müşteri yeni bir masa rezervasyonu oluşturdu.",
    owner_delivery_lead: "Bir müşteri yeni bir teslimat siparişi verdi.",
    owner_view_booking: "Rezervasyonu goruntule",
    owner_view_order: "Siparisi goruntule",
    reservation_closing:
      "{{restaurant}} tercihiniz için teşekkürler. Rezervasyonunuz onaylandı. Sizi yakında görmek için sabırsızlanıyoruz.",
    reservation_cancelled_closing:
      "Rezervasyonunuz iptal edildi. Beklenmedik bir durum ise lütfen {{restaurant}} ile iletişime geçin.",
    order_closing:
      "{{restaurant}} tercihiniz için teşekkürler. Siparişiniz onaylandı. Sizi yakında görmek için sabırsızlanıyoruz.",
    concert_pending_closing:
      "Rezervasyon durumunuz değişirse size tekrar haber vereceğiz. Beklenmedik bir durum ise lütfen {{restaurant}} ile iletişime geçin.",
    delivery_delivered_closing:
      "Siparişiniz teslim edildi. Eksik bir şey varsa lütfen {{restaurant}} ile iletişime geçin.",
    delivery_cancelled_closing:
      "Teslimat siparişiniz iptal edildi. Beklenmedik bir durum ise lütfen {{restaurant}} ile iletişime geçin.",
    concert_cancelled_closing:
      "Konser rezervasyonunuz iptal edildi. Beklenmedik bir durum ise lütfen {{restaurant}} ile iletişime geçin.",
  },
  de: {
    our_restaurant: "unserem Restaurant",
    greeting_named: "Hallo {{name}},",
    greeting_generic: "Hallo,",
    items: "Artikel",
    email_label: "E-Mail",
    phone_label: "Telefon",
    customer_name: "Kundenname",
    customer_phone: "Kundentelefon",
    customer_email: "Kunden-E-Mail",
    cancellation_reason: "Stornierungsgrund",
    notes: "Notizen",
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
    concert_pending_subject: "Ihre Konzertbuchung bei {{restaurant}} ist eingegangen",
    concert_cancelled_subject: "Ihre Konzertbuchung bei {{restaurant}} wurde storniert",
    reservation_subject: "Ihre Reservierung bei {{restaurant}} ist bestätigt",
    reservation_cancelled_subject: "Ihre Reservierung bei {{restaurant}} wurde storniert",
    delivery_subject: "Vielen Dank für Ihre Bestellung - Lieferung bestätigt",
    delivery_delivered_subject: "Ihre Lieferbestellung von {{restaurant}} ist angekommen",
    delivery_cancelled_subject: "Ihre Lieferbestellung von {{restaurant}} wurde storniert",
    pickup_subject: "Vielen Dank für Ihre Bestellung - Abholung bestätigt",
    concert_headline: "Ihr Konzertticket ist bestätigt",
    concert_pending_headline: "Ihre Konzertbuchung ist eingegangen",
    concert_cancelled_headline: "Ihre Konzertbuchung wurde storniert",
    reservation_headline: "Ihre Reservierung ist bestätigt",
    reservation_cancelled_headline: "Ihre Reservierung wurde storniert",
    delivery_headline: "Ihre Bestellung wurde für die Lieferung bestätigt",
    delivery_delivered_headline: "Ihre Lieferbestellung wurde zugestellt",
    delivery_cancelled_headline: "Ihre Lieferbestellung wurde storniert",
    pickup_headline: "Ihre Bestellung ist bestätigt",
    concert_lead: "Vielen Dank für Ihre Bestellung. Ihre Konzertbuchung wurde bestätigt.",
    concert_pending_lead:
      "Vielen Dank für Ihre Bestellung. Wir haben Ihre Konzertbuchung erhalten und Ihren QR-Code für den späteren Check-in beigefügt.",
    concert_cancelled_lead: "Ihre Konzertbuchung wurde storniert.",
    reservation_lead: "Vielen Dank für Ihre Reservierung. Ihre Tischreservierung wurde bestätigt.",
    reservation_cancelled_lead: "Ihre Tischreservierung wurde storniert.",
    delivery_lead:
      "Vielen Dank für Ihre Bestellung. Wir haben sie bestätigt und bereiten sie für die Lieferung vor.",
    delivery_delivered_lead:
      "Ihre Lieferbestellung ist angekommen. Wir wünschen guten Appetit.",
    delivery_cancelled_lead:
      "Ihre Lieferbestellung wurde storniert.",
    pickup_lead:
      "Vielen Dank für Ihre Bestellung. Wir haben sie bestätigt und bereiten sie zur Abholung vor.",
    owner_greeting_generic: "Hallo,",
    owner_concert_subject: "Neue Konzertreservierung für {{restaurant}}",
    owner_reservation_subject: "Neue Tischreservierung für {{restaurant}}",
    owner_delivery_subject: "Neue Lieferbestellung für {{restaurant}}",
    owner_concert_headline: "Neue Konzertreservierung eingegangen",
    owner_reservation_headline: "Neue Tischreservierung eingegangen",
    owner_delivery_headline: "Neue Lieferbestellung eingegangen",
    owner_concert_lead: "Ein Kunde hat eine neue Konzertreservierung erstellt.",
    owner_reservation_lead: "Ein Kunde hat eine neue Tischreservierung erstellt.",
    owner_delivery_lead: "Ein Kunde hat eine neue Lieferbestellung aufgegeben.",
    owner_view_booking: "Buchung ansehen",
    owner_view_order: "Bestellung ansehen",
    reservation_closing:
      "Vielen Dank, dass Sie sich für {{restaurant}} entschieden haben. Ihre Reservierung ist bestätigt. Wir freuen uns auf Sie.",
    reservation_cancelled_closing:
      "Ihre Reservierung wurde storniert. Falls dies unerwartet ist, kontaktieren Sie bitte {{restaurant}}.",
    order_closing:
      "Vielen Dank, dass Sie sich für {{restaurant}} entschieden haben. Ihre Bestellung ist bestätigt. Wir freuen uns auf Sie.",
    concert_pending_closing:
      "Wir informieren Sie erneut, falls sich Ihr Buchungsstatus ändert. Falls dies unerwartet ist, kontaktieren Sie bitte {{restaurant}}.",
    delivery_delivered_closing:
      "Ihre Bestellung wurde zugestellt. Falls etwas fehlt, kontaktieren Sie bitte {{restaurant}}.",
    delivery_cancelled_closing:
      "Ihre Lieferbestellung wurde storniert. Falls dies unerwartet ist, kontaktieren Sie bitte {{restaurant}}.",
    concert_cancelled_closing:
      "Ihre Konzertbuchung wurde storniert. Falls dies unerwartet ist, kontaktieren Sie bitte {{restaurant}}.",
  },
  fr: {
    our_restaurant: "notre restaurant",
    greeting_named: "Bonjour {{name}},",
    greeting_generic: "Bonjour,",
    items: "Articles",
    email_label: "E-mail",
    phone_label: "Téléphone",
    customer_name: "Nom du client",
    customer_phone: "Téléphone du client",
    customer_email: "E-mail du client",
    cancellation_reason: "Motif d'annulation",
    notes: "Notes",
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
    concert_pending_subject: "Votre réservation de concert a été reçue chez {{restaurant}}",
    concert_cancelled_subject: "Votre réservation de concert a été annulée chez {{restaurant}}",
    reservation_subject: "Votre réservation est confirmée chez {{restaurant}}",
    reservation_cancelled_subject: "Votre réservation a été annulée chez {{restaurant}}",
    delivery_subject: "Merci pour votre commande - Livraison confirmée",
    delivery_delivered_subject: "Votre commande en livraison de {{restaurant}} est arrivée",
    delivery_cancelled_subject: "Votre commande en livraison de {{restaurant}} a été annulée",
    pickup_subject: "Merci pour votre commande - Retrait confirmé",
    concert_headline: "Votre billet de concert est confirmé",
    concert_pending_headline: "Votre réservation de concert a été reçue",
    concert_cancelled_headline: "Votre réservation de concert a été annulée",
    reservation_headline: "Votre réservation est confirmée",
    reservation_cancelled_headline: "Votre réservation a été annulée",
    delivery_headline: "Votre commande est confirmée pour la livraison",
    delivery_delivered_headline: "Votre commande en livraison a été livrée",
    delivery_cancelled_headline: "Votre commande en livraison a été annulée",
    pickup_headline: "Votre commande est confirmée",
    concert_lead: "Merci pour votre commande. Votre réservation de concert a été confirmée.",
    concert_pending_lead:
      "Merci pour votre commande. Nous avons bien reçu votre réservation de concert et joint votre QR code pour le check-in ultérieur.",
    concert_cancelled_lead: "Votre réservation de concert a été annulée.",
    reservation_lead: "Merci pour votre réservation. Votre réservation de table est confirmée.",
    reservation_cancelled_lead: "Votre réservation de table a été annulée.",
    delivery_lead:
      "Merci pour votre commande. Nous l'avons confirmée et avons commencé sa préparation pour la livraison.",
    delivery_delivered_lead:
      "Votre commande en livraison est arrivée. Bon appétit.",
    delivery_cancelled_lead:
      "Votre commande en livraison a été annulée.",
    pickup_lead:
      "Merci pour votre commande. Nous l'avons confirmée et avons commencé sa préparation pour le retrait.",
    owner_greeting_generic: "Bonjour,",
    owner_concert_subject: "Nouvelle réservation de concert pour {{restaurant}}",
    owner_reservation_subject: "Nouvelle réservation de table pour {{restaurant}}",
    owner_delivery_subject: "Nouvelle commande en livraison pour {{restaurant}}",
    owner_concert_headline: "Nouvelle réservation de concert reçue",
    owner_reservation_headline: "Nouvelle réservation de table reçue",
    owner_delivery_headline: "Nouvelle commande en livraison reçue",
    owner_concert_lead: "Un client a créé une nouvelle réservation de concert.",
    owner_reservation_lead: "Un client a créé une nouvelle réservation de table.",
    owner_delivery_lead: "Un client a passé une nouvelle commande en livraison.",
    owner_view_booking: "Voir la reservation",
    owner_view_order: "Voir la commande",
    reservation_closing:
      "Merci d'avoir choisi {{restaurant}}. Votre réservation est confirmée. Nous avons hâte de vous accueillir.",
    reservation_cancelled_closing:
      "Votre réservation a été annulée. Si cela est inattendu, veuillez contacter {{restaurant}}.",
    order_closing:
      "Merci d'avoir choisi {{restaurant}}. Votre commande est confirmée. Nous avons hâte de vous accueillir.",
    concert_pending_closing:
      "Nous vous informerons à nouveau si le statut de votre réservation change. Si cela est inattendu, veuillez contacter {{restaurant}}.",
    delivery_delivered_closing:
      "Votre commande a été livrée. S'il manque quelque chose, veuillez contacter {{restaurant}}.",
    delivery_cancelled_closing:
      "Votre commande en livraison a été annulée. Si cela est inattendu, veuillez contacter {{restaurant}}.",
    concert_cancelled_closing:
      "Votre réservation de concert a été annulée. Si cela est inattendu, veuillez contacter {{restaurant}}.",
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
    case CONFIRMATION_TYPES.CONCERT_TICKET_CANCELLED:
      return translateEmail(language, "concert_cancelled_subject", { restaurant: safeName });
    case CONFIRMATION_TYPES.TABLE_RESERVATION:
      return translateEmail(language, "reservation_subject", { restaurant: safeName });
    case CONFIRMATION_TYPES.TABLE_RESERVATION_CANCELLED:
      return translateEmail(language, "reservation_cancelled_subject", { restaurant: safeName });
    case CONFIRMATION_TYPES.DELIVERY_ORDER:
      return translateEmail(language, "delivery_subject", { restaurant: safeName });
    case CONFIRMATION_TYPES.DELIVERY_ORDER_DELIVERED:
      return translateEmail(language, "delivery_delivered_subject", { restaurant: safeName });
    case CONFIRMATION_TYPES.DELIVERY_ORDER_CANCELLED:
      return translateEmail(language, "delivery_cancelled_subject", { restaurant: safeName });
    case CONFIRMATION_TYPES.PICKUP_ORDER:
    default:
      return translateEmail(language, "pickup_subject", { restaurant: safeName });
  }
}

function buildConcertPendingSubject(restaurantName, language = "en") {
  const safeName = asText(restaurantName, translateEmail(language, "our_restaurant"));
  return translateEmail(language, "concert_pending_subject", { restaurant: safeName });
}

function buildHeadline(confirmationType, language = "en") {
  switch (confirmationType) {
    case CONFIRMATION_TYPES.CONCERT_TICKET:
      return translateEmail(language, "concert_headline");
    case CONFIRMATION_TYPES.CONCERT_TICKET_CANCELLED:
      return translateEmail(language, "concert_cancelled_headline");
    case CONFIRMATION_TYPES.TABLE_RESERVATION:
      return translateEmail(language, "reservation_headline");
    case CONFIRMATION_TYPES.TABLE_RESERVATION_CANCELLED:
      return translateEmail(language, "reservation_cancelled_headline");
    case CONFIRMATION_TYPES.DELIVERY_ORDER:
      return translateEmail(language, "delivery_headline");
    case CONFIRMATION_TYPES.DELIVERY_ORDER_DELIVERED:
      return translateEmail(language, "delivery_delivered_headline");
    case CONFIRMATION_TYPES.DELIVERY_ORDER_CANCELLED:
      return translateEmail(language, "delivery_cancelled_headline");
    case CONFIRMATION_TYPES.PICKUP_ORDER:
    default:
      return translateEmail(language, "pickup_headline");
  }
}

function buildConcertPendingHeadline(language = "en") {
  return translateEmail(language, "concert_pending_headline");
}

function buildLeadMessage(confirmationType, language = "en") {
  switch (confirmationType) {
    case CONFIRMATION_TYPES.CONCERT_TICKET:
      return translateEmail(language, "concert_lead");
    case CONFIRMATION_TYPES.CONCERT_TICKET_CANCELLED:
      return translateEmail(language, "concert_cancelled_lead");
    case CONFIRMATION_TYPES.TABLE_RESERVATION:
      return translateEmail(language, "reservation_lead");
    case CONFIRMATION_TYPES.TABLE_RESERVATION_CANCELLED:
      return translateEmail(language, "reservation_cancelled_lead");
    case CONFIRMATION_TYPES.DELIVERY_ORDER:
      return translateEmail(language, "delivery_lead");
    case CONFIRMATION_TYPES.DELIVERY_ORDER_DELIVERED:
      return translateEmail(language, "delivery_delivered_lead");
    case CONFIRMATION_TYPES.DELIVERY_ORDER_CANCELLED:
      return translateEmail(language, "delivery_cancelled_lead");
    case CONFIRMATION_TYPES.PICKUP_ORDER:
    default:
      return translateEmail(language, "pickup_lead");
  }
}

function buildConcertPendingLeadMessage(language = "en") {
  return translateEmail(language, "concert_pending_lead");
}

function buildClosingMessage(confirmationType, restaurantName, language = "en") {
  const safeRestaurant = asText(restaurantName, translateEmail(language, "our_restaurant"));
  if (confirmationType === CONFIRMATION_TYPES.TABLE_RESERVATION) {
    return translateEmail(language, "reservation_closing", { restaurant: safeRestaurant });
  }
  if (confirmationType === CONFIRMATION_TYPES.TABLE_RESERVATION_CANCELLED) {
    return translateEmail(language, "reservation_cancelled_closing", { restaurant: safeRestaurant });
  }
  if (confirmationType === CONFIRMATION_TYPES.CONCERT_TICKET_CANCELLED) {
    return translateEmail(language, "concert_cancelled_closing", { restaurant: safeRestaurant });
  }
  if (confirmationType === CONFIRMATION_TYPES.DELIVERY_ORDER_DELIVERED) {
    return translateEmail(language, "delivery_delivered_closing", { restaurant: safeRestaurant });
  }
  if (confirmationType === CONFIRMATION_TYPES.DELIVERY_ORDER_CANCELLED) {
    return translateEmail(language, "delivery_cancelled_closing", { restaurant: safeRestaurant });
  }
  return translateEmail(language, "order_closing", { restaurant: safeRestaurant });
}

function buildConcertPendingClosingMessage(restaurantName, language = "en") {
  const safeRestaurant = asText(restaurantName, translateEmail(language, "our_restaurant"));
  return translateEmail(language, "concert_pending_closing", { restaurant: safeRestaurant });
}

function buildOwnerNotificationSubject(notificationType, restaurantName, language = "en") {
  const safeName = asText(restaurantName, translateEmail(language, "our_restaurant"));
  switch (notificationType) {
    case OWNER_NOTIFICATION_TYPES.CONCERT_RESERVATION_CREATED:
      return translateEmail(language, "owner_concert_subject", { restaurant: safeName });
    case OWNER_NOTIFICATION_TYPES.DELIVERY_ORDER_CREATED:
      return translateEmail(language, "owner_delivery_subject", { restaurant: safeName });
    case OWNER_NOTIFICATION_TYPES.TABLE_RESERVATION_CREATED:
    default:
      return translateEmail(language, "owner_reservation_subject", { restaurant: safeName });
  }
}

function buildOwnerNotificationHeadline(notificationType, language = "en") {
  switch (notificationType) {
    case OWNER_NOTIFICATION_TYPES.CONCERT_RESERVATION_CREATED:
      return translateEmail(language, "owner_concert_headline");
    case OWNER_NOTIFICATION_TYPES.DELIVERY_ORDER_CREATED:
      return translateEmail(language, "owner_delivery_headline");
    case OWNER_NOTIFICATION_TYPES.TABLE_RESERVATION_CREATED:
    default:
      return translateEmail(language, "owner_reservation_headline");
  }
}

function buildOwnerNotificationLead(notificationType, language = "en") {
  switch (notificationType) {
    case OWNER_NOTIFICATION_TYPES.CONCERT_RESERVATION_CREATED:
      return translateEmail(language, "owner_concert_lead");
    case OWNER_NOTIFICATION_TYPES.DELIVERY_ORDER_CREATED:
      return translateEmail(language, "owner_delivery_lead");
    case OWNER_NOTIFICATION_TYPES.TABLE_RESERVATION_CREATED:
    default:
      return translateEmail(language, "owner_reservation_lead");
  }
}

function buildOwnerViewBookingUrl() {
  const baseUrl = normalizePublicBaseUrl(
    process.env.PUBLIC_WEB_BASE_URL ||
      process.env.PUBLIC_POS_BASE_URL ||
      process.env.POS_APP_BASE_URL ||
      "https://pos.beypro.com"
  );
  return `${baseUrl}/tableoverview?tab=tables&area=__VIEW_BOOKING__`;
}

function buildOwnerPacketOrdersUrl() {
  const baseUrl = normalizePublicBaseUrl(
    process.env.PUBLIC_WEB_BASE_URL ||
      process.env.PUBLIC_POS_BASE_URL ||
      process.env.POS_APP_BASE_URL ||
      "https://pos.beypro.com"
  );
  return `${baseUrl}/tableoverview?tab=packet`;
}

function buildOwnerActionUrl(notificationType) {
  if (notificationType === OWNER_NOTIFICATION_TYPES.DELIVERY_ORDER_CREATED) {
    return buildOwnerPacketOrdersUrl();
  }
  return buildOwnerViewBookingUrl();
}

function buildOwnerActionLabel(notificationType, language = "en") {
  if (notificationType === OWNER_NOTIFICATION_TYPES.DELIVERY_ORDER_CREATED) {
    return translateEmail(language, "owner_view_order");
  }
  return translateEmail(language, "owner_view_booking");
}

function buildHtmlTemplate({
  subject,
  confirmationType,
  restaurant,
  customerName,
  details,
  items,
  headline = "",
  leadMessage = "",
  closingMessage,
  qrUrl = "",
  qrImage = "",
  language = "en",
}) {
  const t = (key, params) => translateEmail(language, key, params);
  const brandColor = asText(restaurant.brandColor, "#0F766E");
  const safeQrUrl = normalizeExternalQrUrl(qrUrl);
  const qrImageSrc = buildEmailQrImageUrl(safeQrUrl) || asText(qrImage, "");
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
  const qrSectionHtml =
    safeQrUrl || qrImageSrc
      ? `<div style="margin-top:20px;padding:18px;border:1px solid #E5E7EB;border-radius:16px;background:#F9FAFB;text-align:center;">
          <div style="font-size:13px;color:#6B7280;letter-spacing:.02em;margin-bottom:10px;">QR Code</div>
          ${
            qrImageSrc
              ? `<img src="${escapeHtml(
                  qrImageSrc
                )}" alt="QR Code" width="180" height="180" style="display:block;width:180px;height:180px;margin:0 auto 12px auto;border-radius:12px;background:#FFFFFF;padding:10px;border:1px solid #E5E7EB;" />`
              : ""
          }
          ${
            safeQrUrl
              ? `<div style="font-size:13px;line-height:1.6;word-break:break-all;color:#111827;">
                  <a href="${escapeHtml(qrImageSrc || safeQrUrl)}" style="color:${escapeHtml(
                  brandColor
                )};text-decoration:underline;">Check-in Code</a>
                </div>`
              : ""
          }
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
                      headline || buildHeadline(confirmationType, language)
                    )}</h1>
                    <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#374151;">${escapeHtml(
                      leadMessage || buildLeadMessage(confirmationType, language)
                    )}</p>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #E5E7EB;border-bottom:1px solid #E5E7EB;padding:10px 0;">
                      ${detailRowsHtml}
                    </table>
                    ${itemsHtml}
                    ${qrSectionHtml}
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
  headline = "",
  leadMessage = "",
  closingMessage,
  qrUrl = "",
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
  const qrLines = qrUrl ? `\nQR Code:\n${qrUrl}\n` : "";

  return [
    greeting,
    "",
    headline || buildHeadline(confirmationType, language),
    leadMessage || buildLeadMessage(confirmationType, language),
    "",
    detailLines,
    itemLines,
    qrLines,
    closingMessage,
    "",
    `${restaurant.name}${restaurant.contactEmail ? ` | ${t("email_label")}: ${restaurant.contactEmail}` : ""}${
      restaurant.contactPhone ? ` | ${t("phone_label")}: ${restaurant.contactPhone}` : ""
    }`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildOwnerNotificationHtmlTemplate({
  subject,
  headline,
  leadMessage,
  restaurant,
  details,
  actionUrl = "",
  actionLabel = "",
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
                      t("owner_greeting_generic")
                    )}</p>
                    <h1 style="margin:0 0 10px 0;font-size:24px;line-height:1.25;color:#111827;">${escapeHtml(
                      headline
                    )}</h1>
                    <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#374151;">${escapeHtml(
                      leadMessage
                    )}</p>
                    ${
                      actionUrl
                        ? `<div style="margin:0 0 18px 0;">
                            <a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:12px 18px;border-radius:12px;background:${escapeHtml(
                              brandColor
                            )};color:#FFFFFF;font-size:14px;font-weight:700;line-height:1;text-decoration:none;">${escapeHtml(
                              actionLabel || t("owner_view_booking")
                            )}</a>
                          </div>`
                        : ""
                    }
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #E5E7EB;border-bottom:1px solid #E5E7EB;padding:10px 0;">
                      ${detailRowsHtml}
                    </table>
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

function buildOwnerNotificationTextTemplate({
  headline,
  leadMessage,
  restaurant,
  details,
  actionUrl = "",
  actionLabel = "",
  language = "en",
}) {
  const t = (key, params) => translateEmail(language, key, params);
  const detailLines = details.map((row) => `- ${row.label}: ${row.value}`).join("\n");

  return [
    t("owner_greeting_generic"),
    "",
    headline,
    leadMessage,
    "",
    actionUrl ? `${actionLabel || t("owner_view_booking")}: ${actionUrl}` : "",
    actionUrl ? "" : "",
    detailLines,
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

async function ensureOwnerNotificationEmailLogTable(pool) {
  if (ensureOwnerNotificationEmailLogTablePromise) return ensureOwnerNotificationEmailLogTablePromise;
  ensureOwnerNotificationEmailLogTablePromise = (async () => {
    logOwnerNotification("log_table.ensure.start", {
      table: "owner_reservation_notification_emails",
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS owner_reservation_notification_emails (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id INTEGER NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        notification_type TEXT NOT NULL,
        recipient_email TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        subject TEXT,
        triggered_from TEXT,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_owner_reservation_notification_emails_dedupe
      ON owner_reservation_notification_emails (restaurant_id, entity_type, entity_id, notification_type)
    `);
    logOwnerNotification("log_table.ensure.success", {
      table: "owner_reservation_notification_emails",
      dedupeIndex: "uq_owner_reservation_notification_emails_dedupe",
    });
  })().catch((err) => {
    ensureOwnerNotificationEmailLogTablePromise = null;
    errorOwnerNotification("log_table.ensure.failed", {
      table: "owner_reservation_notification_emails",
      error: err?.message || err,
    });
    throw err;
  });
  return ensureOwnerNotificationEmailLogTablePromise;
}

async function claimOwnerNotificationAttempt(client, payload) {
  const existingResult = await client.query(
    `
    SELECT id, status, recipient_email, sent_at, created_at
    FROM owner_reservation_notification_emails
    WHERE restaurant_id = $1
      AND entity_type = $2
      AND entity_id = $3
      AND notification_type = $4
    LIMIT 1
    `,
    [payload.restaurantId, payload.entityType, payload.entityId, payload.notificationType]
  );
  const existingRow = existingResult.rows?.[0] || null;

  if (existingRow && String(existingRow.status || "").toLowerCase() === EMAIL_STATUS.SENT) {
    logOwnerNotification("dedupe.hit", {
      restaurantId: payload.restaurantId,
      entityType: payload.entityType,
      entityId: payload.entityId,
      notificationType: payload.notificationType,
      existingAttemptId: Number(existingRow.id),
      existingStatus: existingRow.status,
      recipientEmail: existingRow.recipient_email || null,
      sentAt: existingRow.sent_at || null,
    });
    return {
      attemptId: null,
      dedupeHit: true,
      previousStatus: existingRow.status,
      recipientEmail: existingRow.recipient_email || null,
    };
  }

  const result = await client.query(
    `
    INSERT INTO owner_reservation_notification_emails (
      restaurant_id,
      entity_type,
      entity_id,
      notification_type,
      recipient_email,
      status,
      triggered_from
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (restaurant_id, entity_type, entity_id, notification_type)
    DO UPDATE
       SET status = 'pending',
           recipient_email = COALESCE(EXCLUDED.recipient_email, owner_reservation_notification_emails.recipient_email),
           triggered_from = COALESCE(EXCLUDED.triggered_from, owner_reservation_notification_emails.triggered_from),
           last_error = NULL
     WHERE owner_reservation_notification_emails.status <> 'sent'
    RETURNING id
    `,
    [
      payload.restaurantId,
      payload.entityType,
      payload.entityId,
      payload.notificationType,
      payload.recipientEmail || null,
      EMAIL_STATUS.PENDING,
      payload.triggeredFrom || null,
    ]
  );
  const attemptId = result.rows?.[0]?.id ? Number(result.rows[0].id) : null;
  if (!attemptId) {
    warnOwnerNotification("dedupe.claim_missing", {
      restaurantId: payload.restaurantId,
      entityType: payload.entityType,
      entityId: payload.entityId,
      notificationType: payload.notificationType,
      previousStatus: existingRow?.status || null,
      recipientEmail: payload.recipientEmail || null,
    });
    return {
      attemptId: null,
      dedupeHit: true,
      previousStatus: existingRow?.status || null,
      recipientEmail: existingRow?.recipient_email || payload.recipientEmail || null,
    };
  }

  logOwnerNotification("dedupe.miss", {
    restaurantId: payload.restaurantId,
    entityType: payload.entityType,
    entityId: payload.entityId,
    notificationType: payload.notificationType,
    attemptId,
    previousStatus: existingRow?.status || null,
    recipientEmail: payload.recipientEmail || null,
  });
  return {
    attemptId,
    dedupeHit: false,
    previousStatus: existingRow?.status || null,
    recipientEmail: payload.recipientEmail || null,
  };
}

async function markOwnerNotificationAttempt(client, id, status, updates = {}) {
  if (!id) return;
  await client.query(
    `
    UPDATE owner_reservation_notification_emails
       SET status = $2,
           recipient_email = COALESCE($3, recipient_email),
           subject = COALESCE($4, subject),
           last_error = $5,
           sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END
     WHERE id = $1
    `,
    [id, status, updates.recipientEmail || null, updates.subject || null, updates.lastError || null]
  );
  logOwnerNotification("attempt.mark", {
    attemptId: id,
    status,
    recipientEmail: updates.recipientEmail || null,
    subject: updates.subject || null,
    lastError: updates.lastError || null,
  });
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
    ownerEmail: normalizeEmail(restaurantRow.owner_email),
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

async function resolveOwnerNotificationRecipient(client, restaurantId, restaurantBranding) {
  const primaryOwnerEmail = normalizeEmail(restaurantBranding?.ownerEmail);
  let fallbackOwnerEmail = "";

  if (!primaryOwnerEmail) {
    try {
      const fallbackResult = await client.query(
        `
        SELECT email, id, role
        FROM users
        WHERE restaurant_id = $1
          AND email IS NOT NULL
          AND TRIM(email) <> ''
        ORDER BY (LOWER(COALESCE(role, '')) = 'admin') DESC, id ASC
        LIMIT 1
        `,
        [restaurantId]
      );
      fallbackOwnerEmail = normalizeEmail(fallbackResult.rows?.[0]?.email);
    } catch (err) {
      warnOwnerNotification("recipient.lookup_fallback_failed", {
        restaurantId,
        error: err?.message || err,
      });
    }
  }

  const contactEmail = normalizeEmail(restaurantBranding?.contactEmail);
  const resolvedEmail = primaryOwnerEmail || fallbackOwnerEmail || contactEmail || "";

  logOwnerNotification("recipient.resolved", {
    restaurantId,
    primaryOwnerEmail: primaryOwnerEmail || null,
    fallbackOwnerEmail: fallbackOwnerEmail || null,
    contactEmail: contactEmail || null,
    resolvedEmail: resolvedEmail || null,
  });

  return {
    primaryOwnerEmail,
    fallbackOwnerEmail,
    contactEmail,
    resolvedEmail,
  };
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

    const shouldUseConcertPendingCopy =
      confirmationType === CONFIRMATION_TYPES.CONCERT_TICKET &&
      String(loadedData.concertEmailState || "").toLowerCase() === "pending";
    const subject = shouldUseConcertPendingCopy
      ? buildConcertPendingSubject(restaurantBranding.name, language)
      : buildSubject(confirmationType, restaurantBranding.name, language);
    const headline = shouldUseConcertPendingCopy
      ? buildConcertPendingHeadline(language)
      : buildHeadline(confirmationType, language);
    const leadMessage = shouldUseConcertPendingCopy
      ? buildConcertPendingLeadMessage(language)
      : buildLeadMessage(confirmationType, language);
    const details = Array.isArray(loadedData.details) ? loadedData.details.filter(Boolean) : [];
    const items = Array.isArray(loadedData.items) ? loadedData.items.filter(Boolean) : [];
    const closingMessage = shouldUseConcertPendingCopy
      ? buildConcertPendingClosingMessage(restaurantBranding.name, language)
      : buildClosingMessage(confirmationType, restaurantBranding.name, language);

    const html = buildHtmlTemplate({
      subject,
      confirmationType,
      restaurant: restaurantBranding,
      customerName: loadedData.customerName,
      details,
      items,
      headline,
      leadMessage,
      closingMessage,
      qrUrl: loadedData.qrUrl,
      qrImage: loadedData.qrImage,
      language,
    });
    const text = buildTextTemplate({
      confirmationType,
      restaurant: restaurantBranding,
      customerName: loadedData.customerName,
      details,
      items,
      headline,
      leadMessage,
      closingMessage,
      qrUrl: loadedData.qrUrl,
      language,
    });

    await sendEmail({
      to: customerEmail,
      subject,
      html,
      text,
      fromName: restaurantBranding.name,
      replyTo: restaurantBranding.contactEmail || undefined,
      provider: RESEND_PROVIDER,
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

function isDeliveryOrderConfirmationType(confirmationType) {
  return (
    confirmationType === CONFIRMATION_TYPES.DELIVERY_ORDER ||
    confirmationType === CONFIRMATION_TYPES.DELIVERY_ORDER_DELIVERED ||
    confirmationType === CONFIRMATION_TYPES.DELIVERY_ORDER_CANCELLED
  );
}

async function loadOrderEmailContext(
  client,
  {
    restaurantId,
    orderId,
    confirmationType,
    orderSnapshot = null,
    language = "en",
    t = (key, params) => translateEmail(language, key, params),
  }
) {
  await ensureBookingQrSchema({
    query: (...args) => client.query(...args),
  });

  let order = orderSnapshot;
  if (!order) {
    const orderResult = await client.query(
      `
      SELECT
        id,
        order_number,
        total,
        created_at,
        updated_at,
        cancelled_at,
        delivered_at,
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
        takeaway_notes,
        table_number,
        cancellation_reason,
        qr_status,
        qr_url,
        qr_image
      FROM orders
      WHERE restaurant_id = $1
        AND id = $2
      LIMIT 1
      `,
      [restaurantId, orderId]
    );
    order = orderResult.rows?.[0] || null;
  }
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

  const isReservationType =
    confirmationType === CONFIRMATION_TYPES.TABLE_RESERVATION ||
    confirmationType === CONFIRMATION_TYPES.TABLE_RESERVATION_CANCELLED;
  const isDeliveryType = isDeliveryOrderConfirmationType(confirmationType);
  const isCancelledType =
    confirmationType === CONFIRMATION_TYPES.TABLE_RESERVATION_CANCELLED ||
    confirmationType === CONFIRMATION_TYPES.CONCERT_TICKET_CANCELLED ||
    confirmationType === CONFIRMATION_TYPES.DELIVERY_ORDER_CANCELLED;
  const isDeliveredType = confirmationType === CONFIRMATION_TYPES.DELIVERY_ORDER_DELIVERED;
  const isPickupType = confirmationType === CONFIRMATION_TYPES.PICKUP_ORDER;

  const details = [];
  const numberLabel = isReservationType ? t("reservation_number") : t("order_number");
  details.push({
    label: numberLabel,
    value: asText(order.order_number, "") || `#${order.id}`,
  });

  const timelineDate = isDeliveredType
    ? order.delivered_at || order.updated_at || new Date()
    : isCancelledType
      ? order.cancelled_at || order.updated_at || new Date()
      : order.created_at || new Date();
  details.push({ label: t("date"), value: formatDate(timelineDate, language) || "-" });

  if (isReservationType) {
    if (order.reservation_date) {
      details.push({ label: t("reservation_date"), value: formatDate(order.reservation_date, language) || "-" });
    }
    if (order.reservation_time) {
      details.push({ label: t("reservation_time"), value: formatTime(order.reservation_time, language) || "-" });
    }
    if (Number(order.reservation_clients) > 0) {
      details.push({ label: t("guests"), value: String(Number(order.reservation_clients)) });
    }
    if (Number(order.table_number) > 0) {
      details.push({
        label: t("table"),
        value: t("table_with_number", { number: Number(order.table_number) }),
      });
    }
  } else if (isDeliveryType) {
    if (order.customer_address) {
      details.push({ label: t("delivery_address"), value: asText(order.customer_address) });
    }
    if (asText(order.payment_method, "")) {
      details.push({ label: t("payment_method"), value: asText(order.payment_method) });
    }
  } else if (isPickupType) {
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

  if (Number.isFinite(Number(order.total)) && !isReservationType) {
    details.push({
      label: t("total_amount"),
      value: formatMoney(order.total, language) || String(order.total),
    });
  }
  if (asText(order.cancellation_reason, "") && isCancelledType) {
    details.push({ label: t("cancellation_reason"), value: asText(order.cancellation_reason) });
  }

  return {
    customerName: asText(order.customer_name, ""),
    customerPhone: asText(order.customer_phone, ""),
    customerEmail: "",
    details,
    items:
      isReservationType && confirmationType === CONFIRMATION_TYPES.TABLE_RESERVATION_CANCELLED
        ? []
        : normalizeItems(itemResult.rows, { language, t }),
    notes: asText(order.takeaway_notes || order.reservation_notes, ""),
    qrStatus: asText(order.qr_status, ""),
    qrUrl: asText(order.qr_url, ""),
    qrImage: asText(order.qr_image, ""),
  };
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
    dataLoader: async (client, { language = "en", t = (key, params) => translateEmail(language, key, params) }) =>
      loadOrderEmailContext(client, {
        restaurantId,
        orderId,
        confirmationType,
        language,
        t,
      }),
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
      await ensureBookingQrSchema({
        query: (...args) => client.query(...args),
      });
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
          cb.qr_status,
          cb.qr_url,
          cb.qr_image,
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
      const normalizedPaymentStatus = asText(booking.payment_status, "").toLowerCase();
      const concertEmailState = normalizedPaymentStatus === "confirmed" ? "confirmed" : "pending";

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
        qrStatus: asText(booking.qr_status, ""),
        qrUrl: asText(booking.qr_url, ""),
        qrImage: asText(booking.qr_image, ""),
        concertEmailState,
      };
    },
  });
}

async function sendOrderCustomerCancellationEmail({
  pool,
  restaurantId,
  orderId,
  confirmationType = CONFIRMATION_TYPES.TABLE_RESERVATION_CANCELLED,
  explicitCustomerEmail = "",
  triggeredFrom = "orders.cancellation",
  req = null,
  orderSnapshot = null,
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
    dataLoader: async (client, { language = "en", t = (key, params) => translateEmail(language, key, params) }) =>
      loadOrderEmailContext(client, {
        restaurantId,
        orderId,
        confirmationType,
        orderSnapshot,
        language,
        t,
      }),
  });
}

async function sendOrderCustomerDeliveredEmail({
  pool,
  restaurantId,
  orderId,
  explicitCustomerEmail = "",
  triggeredFrom = "orders.delivered",
  req = null,
  orderSnapshot = null,
}) {
  return sendCustomerConfirmationEmail({
    pool,
    entityType: "order",
    entityId: orderId,
    restaurantId,
    confirmationType: CONFIRMATION_TYPES.DELIVERY_ORDER_DELIVERED,
    explicitCustomerEmail,
    triggeredFrom,
    req,
    dataLoader: async (client, { language = "en", t = (key, params) => translateEmail(language, key, params) }) =>
      loadOrderEmailContext(client, {
        restaurantId,
        orderId,
        confirmationType: CONFIRMATION_TYPES.DELIVERY_ORDER_DELIVERED,
        orderSnapshot,
        language,
        t,
      }),
  });
}

async function sendConcertCustomerCancellationEmail({
  pool,
  restaurantId,
  bookingId,
  explicitCustomerEmail = "",
  triggeredFrom = "concerts.cancellation",
  req = null,
}) {
  return sendCustomerConfirmationEmail({
    pool,
    entityType: "concert_booking",
    entityId: bookingId,
    restaurantId,
    confirmationType: CONFIRMATION_TYPES.CONCERT_TICKET_CANCELLED,
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
          cb.cancelled_at,
          cb.updated_at,
          cb.cancellation_reason,
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
        { label: t("date"), value: formatDate(booking.cancelled_at || booking.updated_at || new Date(), language) || "-" },
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
      if (booking.order_number) {
        details.push({ label: t("order_number"), value: asText(booking.order_number) });
      }
      if (asText(booking.cancellation_reason, "")) {
        details.push({ label: t("cancellation_reason"), value: asText(booking.cancellation_reason) });
      }

      return {
        customerName: asText(booking.customer_name, ""),
        customerPhone: asText(booking.customer_phone, ""),
        customerEmail: "",
        details,
        items: [],
      };
    },
  });
}

async function sendOwnerReservationNotificationEmail({
  pool,
  entityType,
  entityId,
  restaurantId,
  notificationType,
  explicitCustomerEmail = "",
  triggeredFrom,
  req,
  dataLoader,
}) {
  logOwnerNotification("trigger.start", {
    restaurantId,
    entityType,
    entityId,
    notificationType,
    triggeredFrom: triggeredFrom || null,
    explicitCustomerEmail: normalizeEmail(explicitCustomerEmail) || null,
  });
  try {
    await ensureOwnerNotificationEmailLogTable(pool);
  } catch (err) {
    errorOwnerNotification("log_table.init_failed", {
      restaurantId,
      entityType,
      entityId,
      notificationType,
      error: err?.message || err,
    });
    return { sent: false, error: "owner_email_log_init_failed" };
  }

  const client = await pool.connect();
  let attemptId = null;
  try {
    let language = "en";
    try {
      const localization = await loadLocalizationForRestaurant(restaurantId);
      language = normalizeLanguageCode(localization?.language);
    } catch (localizationErr) {
      warnOwnerNotification("localization.load_failed", {
        restaurantId,
        entityType,
        entityId,
        notificationType,
        error: localizationErr?.message || localizationErr,
      });
    }

    const t = (key, params) => translateEmail(language, key, params);
    const loadedData = await dataLoader(client, { language, t });
    if (!loadedData) {
      warnOwnerNotification("context.missing", {
        restaurantId,
        entityType,
        entityId,
        notificationType,
      });
      return { sent: false, skipped: "missing_context" };
    }
    logOwnerNotification("context.loaded", {
      restaurantId,
      entityType,
      entityId,
      notificationType,
      customerName: loadedData.customerName || null,
      customerPhone: loadedData.customerPhone || null,
      detailCount: Array.isArray(loadedData.details) ? loadedData.details.length : 0,
      hasNotes: Boolean(loadedData.notes),
    });

    const restaurantBranding = await loadRestaurantBranding(client, restaurantId, req);
    if (!restaurantBranding) {
      warnOwnerNotification("restaurant.missing", {
        restaurantId,
        entityType,
        entityId,
        notificationType,
      });
      return { sent: false, skipped: "restaurant_not_found" };
    }

    const recipientResolution = await resolveOwnerNotificationRecipient(client, restaurantId, restaurantBranding);
    const recipientEmail = recipientResolution.resolvedEmail;
    if (!recipientEmail) {
      warnOwnerNotification("recipient.missing", {
        restaurantId,
        entityType,
        entityId,
        notificationType,
        primaryOwnerEmail: recipientResolution.primaryOwnerEmail || null,
        fallbackOwnerEmail: recipientResolution.fallbackOwnerEmail || null,
        contactEmail: recipientResolution.contactEmail || null,
      });
      return { sent: false, skipped: "missing_owner_email" };
    }

    const resolvedCustomerEmail = await resolveCustomerEmail(client, {
      restaurantId,
      phone: loadedData.customerPhone,
      explicitEmail: explicitCustomerEmail || loadedData.customerEmail,
    });
    logOwnerNotification("customer_email.resolved", {
      restaurantId,
      entityType,
      entityId,
      notificationType,
      explicitCustomerEmail: normalizeEmail(explicitCustomerEmail || loadedData.customerEmail) || null,
      resolvedCustomerEmail: resolvedCustomerEmail || null,
    });

    const claimResult = await claimOwnerNotificationAttempt(client, {
      restaurantId,
      entityType,
      entityId,
      notificationType,
      recipientEmail,
      triggeredFrom,
    });
    attemptId = claimResult?.attemptId || null;

    if (!attemptId) {
      logOwnerNotification("trigger.dedupe_skip", {
        restaurantId,
        entityType,
        entityId,
        notificationType,
        dedupeHit: Boolean(claimResult?.dedupeHit),
        previousStatus: claimResult?.previousStatus || null,
        recipientEmail: claimResult?.recipientEmail || recipientEmail || null,
      });
      return { sent: false, skipped: "duplicate" };
    }

    const details = Array.isArray(loadedData.details) ? loadedData.details.filter(Boolean) : [];
    if (loadedData.customerName) {
      details.push({ label: t("customer_name"), value: asText(loadedData.customerName) });
    }
    if (loadedData.customerPhone) {
      details.push({ label: t("customer_phone"), value: asText(loadedData.customerPhone) });
    }
    if (resolvedCustomerEmail) {
      details.push({ label: t("customer_email"), value: resolvedCustomerEmail });
    }
    if (loadedData.notes) {
      details.push({ label: t("notes"), value: asText(loadedData.notes) });
    }

    const subject = buildOwnerNotificationSubject(notificationType, restaurantBranding.name, language);
    const headline = buildOwnerNotificationHeadline(notificationType, language);
    const leadMessage = buildOwnerNotificationLead(notificationType, language);
    const actionUrl = buildOwnerActionUrl(notificationType);
    const actionLabel = buildOwnerActionLabel(notificationType, language);
    const html = buildOwnerNotificationHtmlTemplate({
      subject,
      headline,
      leadMessage,
      restaurant: restaurantBranding,
      details,
      actionUrl,
      actionLabel,
      language,
    });
    const text = buildOwnerNotificationTextTemplate({
      headline,
      leadMessage,
      restaurant: restaurantBranding,
      details,
      actionUrl,
      actionLabel,
      language,
    });

    logOwnerNotification("provider.send.start", {
      restaurantId,
      entityType,
      entityId,
      notificationType,
      attemptId,
      recipientEmail,
      subject,
      replyTo: restaurantBranding.contactEmail || null,
    });
    const providerResponse = await sendEmail({
      to: recipientEmail,
      subject,
      html,
      text,
      fromName: restaurantBranding.name,
      replyTo: restaurantBranding.contactEmail || undefined,
      provider: RESEND_PROVIDER,
      throwOnError: true,
    });
    logOwnerNotification("provider.send.result", {
      restaurantId,
      entityType,
      entityId,
      notificationType,
      attemptId,
      recipientEmail,
      providerResponse: providerResponse || null,
    });

    await markOwnerNotificationAttempt(client, attemptId, EMAIL_STATUS.SENT, {
      recipientEmail,
      subject,
      lastError: null,
    });
    const finalResult = {
      sent: true,
      attemptId,
      recipientEmail,
      providerResponse: providerResponse || null,
      ownerEmail: recipientResolution.primaryOwnerEmail || null,
      fallbackEmail: recipientResolution.fallbackOwnerEmail || null,
      contactEmail: recipientResolution.contactEmail || null,
    };
    logOwnerNotification("trigger.success", {
      restaurantId,
      entityType,
      entityId,
      notificationType,
      attemptId,
      recipientEmail,
      providerResponse: providerResponse || null,
    });
    return finalResult;
  } catch (err) {
    if (attemptId) {
      try {
        await markOwnerNotificationAttempt(client, attemptId, EMAIL_STATUS.FAILED, {
          lastError: err?.message || "send_failed",
        });
      } catch (markErr) {
        warnOwnerNotification("attempt.mark_failed", {
          restaurantId,
          entityType,
          entityId,
          notificationType,
          attemptId,
          error: markErr?.message || markErr,
        });
      }
    }
    errorOwnerNotification("trigger.failed", {
      restaurantId,
      entityType,
      entityId,
      notificationType,
      attemptId,
      error: err?.message || err,
      stack: err?.stack || null,
    });
    return { sent: false, error: err?.message || "send_failed" };
  } finally {
    client.release();
  }
}

async function sendTableReservationOwnerNotificationEmail({
  pool,
  restaurantId,
  reservationId,
  explicitCustomerEmail = "",
  triggeredFrom = "reservations.create",
  req = null,
}) {
  return sendOwnerReservationNotificationEmail({
    pool,
    entityType: "order",
    entityId: reservationId,
    restaurantId,
    notificationType: OWNER_NOTIFICATION_TYPES.TABLE_RESERVATION_CREATED,
    explicitCustomerEmail,
    triggeredFrom,
    req,
    dataLoader: async (client, { language = "en", t = (key, params) => translateEmail(language, key, params) }) => {
      const orderResult = await client.query(
        `
        SELECT
          id,
          order_number,
          created_at,
          reservation_date,
          reservation_time,
          reservation_clients,
          reservation_notes,
          table_number,
          customer_name,
          customer_phone
        FROM orders
        WHERE restaurant_id = $1
          AND id = $2
        LIMIT 1
        `,
        [restaurantId, reservationId]
      );
      const order = orderResult.rows?.[0];
      if (!order) return null;

      const details = [
        { label: t("reservation_number"), value: asText(order.order_number, "") || `#${order.id}` },
        { label: t("date"), value: formatDate(order.created_at, language) || "-" },
        { label: t("reservation_date"), value: formatDate(order.reservation_date, language) || "-" },
        { label: t("reservation_time"), value: formatTime(order.reservation_time, language) || "-" },
      ];

      if (Number(order.reservation_clients) > 0) {
        details.push({ label: t("guests"), value: String(Number(order.reservation_clients)) });
      }
      if (Number(order.table_number) > 0) {
        details.push({
          label: t("table"),
          value: t("table_with_number", { number: Number(order.table_number) }),
        });
      }

      return {
        customerName: asText(order.customer_name, ""),
        customerPhone: asText(order.customer_phone, ""),
        customerEmail: "",
        notes: asText(order.reservation_notes, ""),
        details,
      };
    },
  });
}

async function sendConcertOwnerReservationNotificationEmail({
  pool,
  restaurantId,
  bookingId,
  explicitCustomerEmail = "",
  triggeredFrom = "concerts.bookings.create",
  req = null,
}) {
  return sendOwnerReservationNotificationEmail({
    pool,
    entityType: "concert_booking",
    entityId: bookingId,
    restaurantId,
    notificationType: OWNER_NOTIFICATION_TYPES.CONCERT_RESERVATION_CREATED,
    explicitCustomerEmail,
    triggeredFrom,
    req,
    dataLoader: async (client, { language = "en", t = (key, params) => translateEmail(language, key, params) }) => {
      const bookingResult = await client.query(
        `
        SELECT
          cb.id,
          cb.created_at,
          cb.quantity,
          cb.guests_count,
          cb.total_amount,
          cb.customer_name,
          cb.customer_phone,
          cb.customer_note,
          cb.reserved_table_number,
          tt.name AS ticket_type_name,
          ce.event_title,
          ce.artist_name,
          ce.event_date,
          ce.event_time
        FROM concert_bookings cb
        LEFT JOIN concert_ticket_types tt ON tt.id = cb.ticket_type_id
        LEFT JOIN concert_events ce ON ce.id = cb.event_id
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
        { label: t("date"), value: formatDate(booking.created_at, language) || "-" },
      ];

      const eventLabel = [asText(booking.event_title), asText(booking.artist_name)].filter(Boolean).join(" - ");
      if (eventLabel) details.push({ label: t("concert"), value: eventLabel });
      if (booking.event_date) details.push({ label: t("event_date"), value: formatDate(booking.event_date, language) });
      if (booking.event_time) details.push({ label: t("event_time"), value: formatTime(booking.event_time, language) });
      if (booking.ticket_type_name) details.push({ label: t("ticket_type"), value: asText(booking.ticket_type_name) });
      if (Number(booking.quantity) > 0) details.push({ label: t("quantity"), value: String(Number(booking.quantity)) });
      if (Number(booking.guests_count) > 0) {
        details.push({ label: t("guests"), value: String(Number(booking.guests_count)) });
      }
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

      return {
        customerName: asText(booking.customer_name, ""),
        customerPhone: asText(booking.customer_phone, ""),
        customerEmail: "",
        notes: asText(booking.customer_note, ""),
        details,
      };
    },
  });
}

async function sendDeliveryOwnerOrderNotificationEmail({
  pool,
  restaurantId,
  orderId,
  explicitCustomerEmail = "",
  triggeredFrom = "orders.create.qr_delivery",
  req = null,
}) {
  return sendOwnerReservationNotificationEmail({
    pool,
    entityType: "order",
    entityId: orderId,
    restaurantId,
    notificationType: OWNER_NOTIFICATION_TYPES.DELIVERY_ORDER_CREATED,
    explicitCustomerEmail,
    triggeredFrom,
    req,
    dataLoader: async (client, { language = "en", t = (key, params) => translateEmail(language, key, params) }) => {
      const orderResult = await client.query(
        `
        SELECT
          id,
          order_number,
          created_at,
          total,
          customer_name,
          customer_phone,
          customer_address,
          payment_method,
          takeaway_notes
        FROM orders
        WHERE restaurant_id = $1
          AND id = $2
        LIMIT 1
        `,
        [restaurantId, orderId]
      );
      const order = orderResult.rows?.[0];
      if (!order) return null;

      const details = [
        { label: t("order_number"), value: asText(order.order_number, "") || `#${order.id}` },
        { label: t("date"), value: formatDate(order.created_at, language) || "-" },
      ];

      if (order.customer_address) {
        details.push({ label: t("delivery_address"), value: asText(order.customer_address) });
      }
      if (asText(order.payment_method, "")) {
        details.push({ label: t("payment_method"), value: asText(order.payment_method) });
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
        notes: asText(order.takeaway_notes, ""),
        details,
      };
    },
  });
}

module.exports = {
  CONFIRMATION_TYPES,
  OWNER_NOTIFICATION_TYPES,
  sendOrderCustomerConfirmationEmail,
  sendOrderCustomerDeliveredEmail,
  sendOrderCustomerCancellationEmail,
  sendConcertCustomerConfirmationEmail,
  sendConcertCustomerCancellationEmail,
  sendTableReservationOwnerNotificationEmail,
  sendConcertOwnerReservationNotificationEmail,
  sendDeliveryOwnerOrderNotificationEmail,
};
