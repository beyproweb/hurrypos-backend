const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
const { attachAllowedModules } = require("../middleware/moduleGuard");
const {
  ensureConcertTables,
  listEvents,
  getEventById,
  createEvent,
  updateEvent,
  deleteEvent,
  listAreas,
  createBooking,
  listBookingsForEvent,
  updateBookingPaymentStatus,
  mapBookingResponse,
} = require("../utils/concertsService");
const {
  sendConcertCustomerCancellationEmail,
  sendConcertOwnerReservationNotificationEmail,
} = require("../utils/customerConfirmationEmail");
const {
  ensureBookingQrSchema,
  markConcertBookingQrPending,
  queueConcertBookingQrEmailJob,
  scheduleBackgroundTask,
} = require("../utils/bookingQrAsync");
const {
  shouldServePublicQrImage,
  decodeGuestQrToken,
  buildGuestQrPngBuffer,
} = require("../utils/guestQrImage");

router.use((req, res, next) => {
  if (
    req.method === "GET" &&
    shouldServePublicQrImage(req) &&
    /^\/bookings\/qr\/[^/]+$/i.test(req.path || "")
  ) {
    return next();
  }
  return authMiddleware(req, res, next);
});
router.use(async (req, res, next) => {
  if (
    req.method === "GET" &&
    shouldServePublicQrImage(req) &&
    /^\/bookings\/qr\/[^/]+$/i.test(req.path || "")
  ) {
    return next();
  }
  const allowed = await attachAllowedModules(req);
  if (
    Array.isArray(allowed) &&
    !allowed.includes("pos_core") &&
    !allowed.includes("qr_kitchen") &&
    !allowed.includes("qr_menu")
  ) {
    return res.status(403).json({ error: "MODULE_NOT_ALLOWED" });
  }
  return next();
});

const getRestaurantId = (req) => Number(req.user?.restaurant_id || 0);

const emitConcertBookingPaymentStatusEvents = (io, restaurantId, result, cancellationReason = "") => {
  if (!io) return;
  const booking = result?.data?.booking || {};
  const reservationOrderId = Number(booking?.reservation_order_id);
  const reservationTable = Number(booking?.reserved_table_number);
  const normalizedPaymentStatus = String(booking?.payment_status || "").toLowerCase();
  const normalizedBookingType = String(booking?.booking_type || "").toLowerCase();
  const bookingCancellationReason = String(
    booking?.cancellation_reason ??
      booking?.cancel_reason ??
      booking?.reason ??
      cancellationReason ??
      ""
  ).trim();
  const room = `restaurant_${restaurantId}`;

  if (
    (Number.isFinite(reservationOrderId) && reservationOrderId > 0) ||
    (Number.isFinite(reservationTable) && reservationTable > 0)
  ) {
    io.to(room).emit("orders_updated");
  }

  if (Number.isFinite(reservationTable) && reservationTable > 0) {
    if (normalizedPaymentStatus === "cancelled") {
      io.to(room).emit("reservation_cancelled", {
        reservation_id: Number.isFinite(reservationOrderId) ? reservationOrderId : null,
        table_number: reservationTable,
        status: "cancelled",
        cancellation_reason: bookingCancellationReason || null,
        cancel_reason: bookingCancellationReason || null,
        reason: bookingCancellationReason || null,
      });
    } else if (normalizedPaymentStatus === "confirmed") {
      io.to(room).emit("reservation_updated", {
        reservation_id: Number.isFinite(reservationOrderId) ? reservationOrderId : null,
        table_number: reservationTable,
        status: "reserved",
      });
    }
  }

  if (
    normalizedPaymentStatus === "cancelled" &&
    Number.isFinite(reservationOrderId) &&
    reservationOrderId > 0
  ) {
    io.to(room).emit("order_cancelled", {
      orderId: reservationOrderId,
      id: reservationOrderId,
      status: "cancelled",
      cancellation_reason: bookingCancellationReason || null,
      cancel_reason: bookingCancellationReason || null,
      reason: bookingCancellationReason || null,
      order: {
        id: reservationOrderId,
        status: "cancelled",
        cancellation_reason: bookingCancellationReason || null,
        cancel_reason: bookingCancellationReason || null,
      },
      concert_booking: {
        id: booking?.id ?? null,
        payment_status: normalizedPaymentStatus,
        booking_type: normalizedBookingType || null,
        cancellation_reason: bookingCancellationReason || null,
        cancel_reason: bookingCancellationReason || null,
      },
    });
  }

  if (normalizedPaymentStatus === "confirmed" && normalizedBookingType === "ticket") {
    io.to(room).emit("concert_ticket_purchased", {
      booking_id: booking?.id ?? null,
      event_id: booking?.event_id ?? null,
      event_title: result?.data?.event?.event_title || null,
      ticket_type_name: booking?.ticket_type_name || null,
      quantity: booking?.quantity ?? null,
      customer_name: booking?.customer_name || "",
      customer_phone: booking?.customer_phone || "",
      reservation_order_id: Number.isFinite(reservationOrderId) ? reservationOrderId : null,
      payment_status: "confirmed",
      booking_type: "ticket",
    });
  }
};

router.get("/areas", async (req, res) => {
  const restaurantId = getRestaurantId(req);
  if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
    return res.status(401).json({ error: "Missing restaurant context" });
  }
  try {
    const areas = await listAreas(pool, restaurantId);
    res.json({ success: true, areas });
  } catch (err) {
    console.error("❌ Failed to load concert areas:", err);
    res.status(500).json({ error: "Failed to load areas" });
  }
});

router.get("/events", async (req, res) => {
  const restaurantId = getRestaurantId(req);
  if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
    return res.status(401).json({ error: "Missing restaurant context" });
  }
  try {
    await ensureConcertTables(pool);
    const includeHidden = String(req.query.include_hidden || "").toLowerCase() === "true";
    const events = await listEvents(pool, restaurantId, {
      includeHidden,
      upcomingOnly: false,
    });
    res.json({ success: true, events });
  } catch (err) {
    console.error("❌ Failed to load concert events:", err);
    res.status(500).json({ error: "Failed to load events" });
  }
});

router.get("/events/:eventId", async (req, res) => {
  const restaurantId = getRestaurantId(req);
  const eventId = Number(req.params.eventId);
  if (!Number.isFinite(eventId) || eventId <= 0) {
    return res.status(400).json({ error: "Invalid event id" });
  }
  try {
    await ensureConcertTables(pool);
    const event = await getEventById(pool, restaurantId, eventId);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    res.json({ success: true, event });
  } catch (err) {
    console.error("❌ Failed to load concert event:", err);
    res.status(500).json({ error: "Failed to load event" });
  }
});

router.post("/events", async (req, res) => {
  const restaurantId = getRestaurantId(req);
  if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
    return res.status(401).json({ error: "Missing restaurant context" });
  }
  try {
    const event = await createEvent(pool, restaurantId, req.body || {});
    res.status(201).json({ success: true, event });
  } catch (err) {
    console.error("❌ Failed to create concert event:", err);
    res.status(400).json({ error: err?.message || "Failed to create event" });
  }
});

router.put("/events/:eventId", async (req, res) => {
  const restaurantId = getRestaurantId(req);
  const eventId = Number(req.params.eventId);
  if (!Number.isFinite(eventId) || eventId <= 0) {
    return res.status(400).json({ error: "Invalid event id" });
  }
  try {
    const event = await updateEvent(pool, restaurantId, eventId, req.body || {});
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    res.json({ success: true, event });
  } catch (err) {
    console.error("❌ Failed to update concert event:", err);
    res.status(400).json({ error: err?.message || "Failed to update event" });
  }
});

router.delete("/events/:eventId", async (req, res) => {
  const restaurantId = getRestaurantId(req);
  const eventId = Number(req.params.eventId);
  if (!Number.isFinite(eventId) || eventId <= 0) {
    return res.status(400).json({ error: "Invalid event id" });
  }
  try {
    await ensureConcertTables(pool);
    const deleted = await deleteEvent(pool, restaurantId, eventId);
    if (!deleted) {
      return res.status(404).json({ error: "Event not found" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to delete concert event:", err);
    res.status(500).json({ error: "Failed to delete event" });
  }
});

router.get("/events/:eventId/bookings", async (req, res) => {
  const restaurantId = getRestaurantId(req);
  const eventId = Number(req.params.eventId);
  if (!Number.isFinite(eventId) || eventId <= 0) {
    return res.status(400).json({ error: "Invalid event id" });
  }
  try {
    await ensureConcertTables(pool);
    const event = await getEventById(pool, restaurantId, eventId);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    const bookings = await listBookingsForEvent(pool, restaurantId, eventId);
    res.json({
      success: true,
      event,
      bookings: bookings.map(mapBookingResponse),
    });
  } catch (err) {
    console.error("❌ Failed to load concert bookings:", err);
    res.status(500).json({ error: "Failed to load bookings" });
  }
});

router.post("/events/:eventId/bookings", async (req, res) => {
  const restaurantId = getRestaurantId(req);
  const eventId = Number(req.params.eventId);
  if (!Number.isFinite(eventId) || eventId <= 0) {
    return res.status(400).json({ error: "Invalid event id" });
  }
  try {
    const result = await createBooking(pool, restaurantId, eventId, req.body || {});
    if (result.status >= 400) {
      return res.status(result.status).json({ error: result.error });
    }

    const io = req.app?.get?.("io");
    const linkedOrderId = Number(result.data?.booking?.reservation_order_id);
    if (io && Number.isFinite(linkedOrderId) && linkedOrderId > 0) {
      io.to(`restaurant_${restaurantId}`).emit("orders_updated");
    }
    if (result.data?.reservation?.table_number && io) {
      io.to(`restaurant_${restaurantId}`).emit("reservation_created", {
        reservation_id: result.data.reservation.id,
        table_number: result.data.reservation.table_number,
        reservation_date: result.data.reservation.reservation_date,
        reservation_time: result.data.reservation.reservation_time,
      });
    }
    await markConcertBookingQrPending(pool, restaurantId, Number(result.data?.booking?.id));

    res.status(result.status).json({
      success: true,
      ...result.data,
      booking: result.data?.booking
        ? {
            ...result.data.booking,
            qr_status: result.data.booking.qr_status || "pending",
          }
        : result.data?.booking,
    });

    scheduleBackgroundTask(`concerts.bookings.create:${Number(result.data?.booking?.id)}`, async () => {
      await queueConcertBookingQrEmailJob({
        pool,
        restaurantId,
        bookingId: Number(result.data?.booking?.id),
        explicitCustomerEmail: req.body?.customer_email || req.body?.email || "",
        triggeredFrom: "concerts.bookings.create.qr_ready",
        req,
        sendEmail: true,
      });

      console.log("[owner-reservation-email] route.trigger.start", {
        source: "concerts.bookings.create",
        reservationType: "concert",
        bookingId: Number(result.data?.booking?.id),
        restaurantId,
      });
      const ownerNotificationResult = await sendConcertOwnerReservationNotificationEmail({
        pool,
        restaurantId,
        bookingId: Number(result.data?.booking?.id),
        explicitCustomerEmail: req.body?.customer_email || req.body?.email || "",
        triggeredFrom: "concerts.bookings.create",
        req,
      });
      console.log("[owner-reservation-email] route.trigger.result", {
        source: "concerts.bookings.create",
        reservationType: "concert",
        bookingId: Number(result.data?.booking?.id),
        restaurantId,
        result: ownerNotificationResult,
      });
    });
  } catch (err) {
    console.error("❌ Failed to create concert booking:", err);
    res.status(500).json({ error: "Failed to create booking" });
  }
});

router.get("/bookings/qr/:token", async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) {
    return res.status(400).json({ error: "QR token is required" });
  }

  try {
    await ensureBookingQrSchema(pool);

    if (shouldServePublicQrImage(req)) {
      const decoded = decodeGuestQrToken(token, ["concert_booking"]);
      const restaurantId = Number(decoded?.restaurant_id || 0);
      if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
        return res.status(401).json({ error: "QR invalid", code: "qr_invalid" });
      }

      const imageResult = await pool.query(
        `
        SELECT
          id,
          qr_status,
          qr_url,
          qr_image
        FROM concert_bookings
        WHERE restaurant_id = $1
          AND qr_token = $2
        LIMIT 1
        `,
        [restaurantId, token]
      );

      const booking = imageResult.rows?.[0] || null;
      if (!booking) {
        return res.status(404).json({ error: "QR invalid", code: "qr_invalid" });
      }
      if (String(booking.qr_status || "").toLowerCase() !== "ready") {
        return res.status(409).json({ error: "QR not ready", code: "qr_not_ready" });
      }

      const pngBuffer = await buildGuestQrPngBuffer(booking.qr_url, booking.qr_image);
      if (!pngBuffer) {
        return res.status(503).json({ error: "QR image unavailable", code: "qr_image_unavailable" });
      }

      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.send(pngBuffer);
    }

    const restaurantId = getRestaurantId(req);
    if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
      return res.status(401).json({ error: "Missing restaurant context" });
    }

    const result = await pool.query(
      `
      SELECT
        cb.id,
        cb.event_id,
        cb.reservation_order_id,
        cb.reserved_table_number,
        cb.booking_type,
        cb.payment_status,
        cb.booking_status,
        cb.customer_name,
        cb.customer_phone,
        cb.quantity,
        cb.confirmed_at,
        cb.qr_status,
        cb.qr_url,
        cb.qr_ready_at,
        cb.updated_at,
        tt.name AS ticket_type_name,
        ce.event_title,
        ce.artist_name,
        ce.event_date,
        ce.event_time,
        o.order_number,
        o.status AS reservation_order_status,
        o.reservation_date,
        o.reservation_time
      FROM concert_bookings cb
      LEFT JOIN concert_ticket_types tt
        ON tt.id = cb.ticket_type_id
      LEFT JOIN concert_events ce
        ON ce.id = cb.event_id
       AND ce.restaurant_id = cb.restaurant_id
      LEFT JOIN orders o
        ON o.id = cb.reservation_order_id
       AND o.restaurant_id = cb.restaurant_id
      WHERE cb.restaurant_id = $1
        AND cb.qr_token = $2
      LIMIT 1
      `,
      [restaurantId, token]
    );

    const booking = result.rows?.[0] || null;
    if (!booking) {
      return res.status(404).json({ error: "QR invalid", code: "qr_invalid" });
    }
    if (String(booking.qr_status || "").toLowerCase() !== "ready") {
      return res.status(409).json({ error: "QR not ready", code: "qr_not_ready" });
    }

    const normalizedOrderStatus = String(booking.reservation_order_status || "").toLowerCase();
    const normalizedPaymentStatus = String(booking.payment_status || "").toLowerCase();
    const normalizedBookingStatus = String(booking.booking_status || "").toLowerCase();
    const isCheckedIn = normalizedOrderStatus === "checked_in";
    const canCheckIn =
      Number.isFinite(Number(booking.reservation_order_id)) &&
      Number(booking.reservation_order_id) > 0 &&
      normalizedPaymentStatus === "confirmed" &&
      normalizedBookingStatus !== "cancelled" &&
      !isCheckedIn;

    return res.json({
      success: true,
      booking: {
        ...booking,
        scan_booking_type:
          String(booking.booking_type || "").toLowerCase() === "ticket"
            ? "concert_ticket"
            : "reservation",
        guest_name: booking.customer_name || "",
        is_checked_in: isCheckedIn,
        can_check_in: canCheckIn,
        current_status:
          booking.reservation_order_status ||
          booking.booking_status ||
          booking.payment_status ||
          null,
        checkin_order_id: booking.reservation_order_id || null,
      },
    });
  } catch (err) {
    console.error("❌ Failed to resolve concert booking QR:", err);
    return res.status(500).json({ error: "Failed to resolve booking QR" });
  }
});

router.patch("/bookings/confirm", async (req, res) => {
  const restaurantId = getRestaurantId(req);
  const explicitBookingId = Number(req.body?.booking_id ?? req.body?.bookingId);
  const reservationOrderId = Number(
    req.body?.reservation_order_id ?? req.body?.reservationOrderId
  );
  const tableNumber = Number(req.body?.table_number ?? req.body?.tableNumber);
  const eventId = Number(req.body?.event_id ?? req.body?.eventId);

  if (
    (!Number.isFinite(explicitBookingId) || explicitBookingId <= 0) &&
    (!Number.isFinite(reservationOrderId) || reservationOrderId <= 0) &&
    (!Number.isFinite(tableNumber) || tableNumber <= 0)
  ) {
    return res.status(400).json({
      error: "booking_id or reservation_order_id or table_number is required",
    });
  }

  try {
    let bookingId = Number.isFinite(explicitBookingId) && explicitBookingId > 0
      ? explicitBookingId
      : null;

    if (!bookingId) {
      const { rows } = await pool.query(
        `
        SELECT id
        FROM concert_bookings
        WHERE restaurant_id = $1
          AND LOWER(COALESCE(payment_status, '')) NOT IN ('cancelled', 'canceled')
          AND (
            ($2::int IS NOT NULL AND reservation_order_id = $2::int)
            OR ($3::int IS NOT NULL AND reserved_table_number = $3::int)
          )
          AND ($4::int IS NULL OR event_id = $4::int)
        ORDER BY
          CASE
            WHEN $2::int IS NOT NULL AND reservation_order_id = $2::int THEN 0
            WHEN $3::int IS NOT NULL AND reserved_table_number = $3::int THEN 1
            ELSE 2
          END,
          updated_at DESC NULLS LAST,
          created_at DESC NULLS LAST,
          id DESC
        LIMIT 1
        `,
        [
          restaurantId,
          Number.isFinite(reservationOrderId) && reservationOrderId > 0 ? reservationOrderId : null,
          Number.isFinite(tableNumber) && tableNumber > 0 ? tableNumber : null,
          Number.isFinite(eventId) && eventId > 0 ? eventId : null,
        ]
      );
      bookingId = Number(rows?.[0]?.id);
    }

    if (!Number.isFinite(bookingId) || bookingId <= 0) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const result = await updateBookingPaymentStatus(
      pool,
      restaurantId,
      bookingId,
      "confirmed",
      ""
    );
    if (result.status >= 400) {
      return res.status(result.status).json({ error: result.error });
    }

    const io = req.app?.get?.("io");
    emitConcertBookingPaymentStatusEvents(io, restaurantId, result, "");

    if (String(result?.data?.booking?.payment_status || "").toLowerCase() === "confirmed") {
      await markConcertBookingQrPending(pool, restaurantId, bookingId);
      scheduleBackgroundTask(`concerts.bookings.confirmed:${bookingId}`, async () => {
        await queueConcertBookingQrEmailJob({
          pool,
          restaurantId,
          bookingId,
          triggeredFrom: "concerts.bookings.confirmed",
          req,
          sendEmail: true,
        });
      });
    }
    return res.json({ success: true, ...result.data });
  } catch (err) {
    console.error("❌ Failed to confirm concert booking:", err);
    return res.status(500).json({ error: "Failed to confirm concert booking" });
  }
});

router.patch("/bookings/:bookingId/payment-status", async (req, res) => {
  const restaurantId = getRestaurantId(req);
  const bookingId = Number(req.params.bookingId);
  if (!Number.isFinite(bookingId) || bookingId <= 0) {
    return res.status(400).json({ error: "Invalid booking id" });
  }
  try {
    const paymentStatus = req.body?.payment_status;
    const cancellationReason = String(
      req.body?.cancellation_reason ??
        req.body?.cancel_reason ??
        req.body?.delete_reason ??
        req.body?.reason ??
        ""
    ).trim();
    const result = await updateBookingPaymentStatus(
      pool,
      restaurantId,
      bookingId,
      paymentStatus,
      cancellationReason
    );
    if (result.status >= 400) {
      return res.status(result.status).json({ error: result.error });
    }

    const io = req.app?.get?.("io");
    emitConcertBookingPaymentStatusEvents(io, restaurantId, result, cancellationReason);

    const normalizedPaymentStatus = String(result?.data?.booking?.payment_status || "").toLowerCase();
    if (normalizedPaymentStatus === "confirmed") {
      await markConcertBookingQrPending(pool, restaurantId, bookingId);
      scheduleBackgroundTask(`concerts.bookings.payment_status_confirmed:${bookingId}`, async () => {
        await queueConcertBookingQrEmailJob({
          pool,
          restaurantId,
          bookingId,
          triggeredFrom: "concerts.bookings.payment_status_confirmed",
          req,
          sendEmail: true,
        });
      });
    } else if (normalizedPaymentStatus === "cancelled") {
      scheduleBackgroundTask(`concerts.bookings.payment_status_cancelled:${bookingId}`, async () => {
        await sendConcertCustomerCancellationEmail({
          pool,
          restaurantId,
          bookingId,
          triggeredFrom: "concerts.bookings.payment_status_cancelled",
          req,
        });
      });
    }

    res.json({ success: true, ...result.data });
  } catch (err) {
    console.error("❌ Failed to update concert booking payment status:", err);
    res.status(500).json({ error: "Failed to update payment status" });
  }
});

module.exports = router;
