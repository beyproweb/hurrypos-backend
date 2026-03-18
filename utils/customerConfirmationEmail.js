const { sendEmail } = require("./notifications");

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

function formatDate(value) {
  if (!value) return "";
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return asText(value);
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(parsed);
}

function formatTime(value) {
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
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

function formatMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "TRY",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function buildSubject(confirmationType, restaurantName) {
  const safeName = asText(restaurantName, "our restaurant");
  switch (confirmationType) {
    case CONFIRMATION_TYPES.CONCERT_TICKET:
      return `Your concert ticket is confirmed at ${safeName}`;
    case CONFIRMATION_TYPES.TABLE_RESERVATION:
      return `Your reservation is confirmed at ${safeName}`;
    case CONFIRMATION_TYPES.DELIVERY_ORDER:
      return `Thank you for your order - Delivery confirmed`;
    case CONFIRMATION_TYPES.PICKUP_ORDER:
    default:
      return `Thank you for your order - Pickup confirmed`;
  }
}

function buildHeadline(confirmationType) {
  switch (confirmationType) {
    case CONFIRMATION_TYPES.CONCERT_TICKET:
      return "Your concert ticket is confirmed";
    case CONFIRMATION_TYPES.TABLE_RESERVATION:
      return "Your reservation is confirmed";
    case CONFIRMATION_TYPES.DELIVERY_ORDER:
      return "Your order is confirmed for delivery";
    case CONFIRMATION_TYPES.PICKUP_ORDER:
    default:
      return "Your order is confirmed";
  }
}

function buildLeadMessage(confirmationType) {
  switch (confirmationType) {
    case CONFIRMATION_TYPES.CONCERT_TICKET:
      return "Thank you for your order. Your concert booking has been confirmed.";
    case CONFIRMATION_TYPES.TABLE_RESERVATION:
      return "Thank you for your reservation. Your table booking is now confirmed.";
    case CONFIRMATION_TYPES.DELIVERY_ORDER:
      return "Thank you for your order. We have confirmed it and started preparing it for delivery.";
    case CONFIRMATION_TYPES.PICKUP_ORDER:
    default:
      return "Thank you for your order. We have confirmed it and started preparing it for pickup.";
  }
}

function buildClosingMessage(confirmationType, restaurantName) {
  const safeRestaurant = asText(restaurantName, "our restaurant");
  if (confirmationType === CONFIRMATION_TYPES.TABLE_RESERVATION) {
    return `Thank you for choosing ${safeRestaurant}. Your reservation is confirmed. We look forward to seeing you soon.`;
  }
  return `Thank you for choosing ${safeRestaurant}. Your order is confirmed. We look forward to seeing you soon.`;
}

function buildHtmlTemplate({
  subject,
  confirmationType,
  restaurant,
  customerName,
  details,
  items,
  closingMessage,
}) {
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
        <div style="font-size:13px;color:#6B7280;letter-spacing:.02em;margin-bottom:8px;">Items</div>
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
    restaurant.contactEmail ? `Email: ${restaurant.contactEmail}` : "",
    restaurant.contactPhone ? `Phone: ${restaurant.contactPhone}` : "",
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en">
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
                      customerName ? `Hi ${customerName},` : "Hi,"
                    )}</p>
                    <h1 style="margin:0 0 10px 0;font-size:24px;line-height:1.25;color:#111827;">${escapeHtml(
                      buildHeadline(confirmationType)
                    )}</h1>
                    <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#374151;">${escapeHtml(
                      buildLeadMessage(confirmationType)
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
}) {
  const greeting = customerName ? `Hi ${customerName},` : "Hi,";
  const detailLines = details.map((row) => `- ${row.label}: ${row.value}`).join("\n");
  const itemLines = items.length ? `\nItems:\n${items.map((line) => `- ${line}`).join("\n")}\n` : "";

  return [
    greeting,
    "",
    buildHeadline(confirmationType),
    buildLeadMessage(confirmationType),
    "",
    detailLines,
    itemLines,
    closingMessage,
    "",
    `${restaurant.name}${restaurant.contactEmail ? ` | ${restaurant.contactEmail}` : ""}${
      restaurant.contactPhone ? ` | ${restaurant.contactPhone}` : ""
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
    ON CONFLICT (restaurant_id, entity_type, entity_id, confirmation_type) DO NOTHING
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

function normalizeItems(itemRows) {
  return (Array.isArray(itemRows) ? itemRows : [])
    .map((row) => {
      const quantity = Math.max(1, Number(row.quantity || 1));
      const lineName = pickFirstNonEmpty(
        row.order_item_name,
        row.external_product_name,
        row.product_name,
        "Item"
      );
      const price = Number(row.price || 0);
      const lineTotal = price * quantity;
      return `${quantity} x ${lineName}${Number.isFinite(lineTotal) ? ` (${formatMoney(lineTotal)})` : ""}`;
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

    const loadedData = await dataLoader(client);
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

    const subject = buildSubject(confirmationType, restaurantBranding.name);
    const details = Array.isArray(loadedData.details) ? loadedData.details.filter(Boolean) : [];
    const items = Array.isArray(loadedData.items) ? loadedData.items.filter(Boolean) : [];
    const closingMessage = buildClosingMessage(confirmationType, restaurantBranding.name);

    const html = buildHtmlTemplate({
      subject,
      confirmationType,
      restaurant: restaurantBranding,
      customerName: loadedData.customerName,
      details,
      items,
      closingMessage,
    });
    const text = buildTextTemplate({
      confirmationType,
      restaurant: restaurantBranding,
      customerName: loadedData.customerName,
      details,
      items,
      closingMessage,
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
    dataLoader: async (client) => {
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
          ? "Reservation number"
          : "Order number";
      details.push({
        label: numberLabel,
        value: asText(order.order_number, "") || `#${order.id}`,
      });
      details.push({ label: "Date", value: formatDate(order.created_at) || "-" });

      if (confirmationType === CONFIRMATION_TYPES.TABLE_RESERVATION) {
        details.push({ label: "Reservation date", value: formatDate(order.reservation_date) || "-" });
        details.push({ label: "Reservation time", value: formatTime(order.reservation_time) || "-" });
        if (Number(order.reservation_clients) > 0) {
          details.push({ label: "Guests", value: String(Number(order.reservation_clients)) });
        }
        if (Number(order.table_number) > 0) {
          details.push({ label: "Table", value: `Table ${Number(order.table_number)}` });
        }
      } else if (confirmationType === CONFIRMATION_TYPES.DELIVERY_ORDER) {
        if (order.customer_address) {
          details.push({ label: "Delivery address", value: asText(order.customer_address) });
        }
        if (asText(order.payment_method, "")) {
          details.push({ label: "Payment method", value: asText(order.payment_method) });
        }
      } else {
        details.push({ label: "Pickup type", value: "Pickup at restaurant" });
        if (order.pickup_time) {
          details.push({ label: "Pickup time", value: formatTime(order.pickup_time) || asText(order.pickup_time) });
        }
        if (asText(order.payment_method, "")) {
          details.push({ label: "Payment method", value: asText(order.payment_method) });
        }
      }

      if (Number.isFinite(Number(order.total))) {
        details.push({ label: "Total amount", value: formatMoney(order.total) || String(order.total) });
      }

      return {
        customerName: asText(order.customer_name, ""),
        customerPhone: asText(order.customer_phone, ""),
        customerEmail: "",
        details,
        items: normalizeItems(itemResult.rows),
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
    dataLoader: async (client) => {
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
        { label: "Booking number", value: `#${booking.id}` },
        { label: "Date", value: formatDate(booking.confirmed_at || new Date()) || "-" },
      ];

      const eventLabel = [asText(booking.event_title), asText(booking.artist_name)].filter(Boolean).join(" - ");
      if (eventLabel) details.push({ label: "Concert", value: eventLabel });
      if (booking.event_date) details.push({ label: "Event date", value: formatDate(booking.event_date) });
      if (booking.event_time) details.push({ label: "Event time", value: formatTime(booking.event_time) });
      if (booking.ticket_type_name) details.push({ label: "Ticket type", value: asText(booking.ticket_type_name) });
      if (Number(booking.quantity) > 0) details.push({ label: "Quantity", value: String(Number(booking.quantity)) });
      if (Number.isFinite(Number(booking.total_amount))) {
        details.push({ label: "Total amount", value: formatMoney(booking.total_amount) || String(booking.total_amount) });
      }
      if (Number(booking.reserved_table_number) > 0) {
        details.push({ label: "Reserved table", value: `Table ${Number(booking.reserved_table_number)}` });
      }
      if (Number(booking.guests_count) > 0) {
        details.push({ label: "Guests", value: String(Number(booking.guests_count)) });
      }
      if (booking.order_number || booking.reservation_order_id) {
        details.push({
          label: "Order number",
          value: asText(booking.order_number, "") || `#${booking.reservation_order_id}`,
        });
      }

      const itemLine = [asText(booking.ticket_type_name, "Concert ticket"), Number(booking.quantity) > 0 ? `${Number(booking.quantity)} ticket(s)` : ""]
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
