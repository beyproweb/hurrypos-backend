const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const {
  ensureConcertTables,
  resolveRestaurantIdByIdentifier,
  listEvents,
  getEventById,
  createBooking,
  listAvailableTablesForEvent,
  mapBookingResponse,
} = require("../utils/concertsService");
const {
  buildFloorPlanElementIndex,
  evaluateTableRestrictions,
  loadVenueFloorPlanLayout,
  resolveEffectiveFloorPlanLayout,
} = require("../utils/floorPlan");
const { sendConcertOwnerReservationNotificationEmail } = require("../utils/customerConfirmationEmail");
const {
  markConcertBookingQrPending,
  queueConcertBookingQrEmailJob,
  scheduleBackgroundTask,
} = require("../utils/bookingQrAsync");
const {
  MARKETPLACE_CUSTOMER_SCOPE,
  ensureMarketplaceCustomerSchema,
  getRestaurantCustomerProfile,
  getMarketplaceCustomerById,
  verifyCustomerAuthToken,
  ensureRestaurantCustomerForMarketplace,
} = require("../utils/marketplaceCustomerAuth");
const {
  assertCheckoutPhoneVerification,
  normalizePhoneForVerification,
  normalizePhoneVerificationToken,
} = require("../utils/customerPhoneVerification");

function normalizeText(value) {
  return String(value || "").trim();
}

function getBearerToken(req) {
  const authHeader = normalizeText(req.headers?.authorization);
  if (!authHeader.toLowerCase().startsWith("bearer ")) return "";
  return normalizeText(authHeader.slice(7));
}

async function resolveOptionalMarketplaceSession(req) {
  try {
    await ensureMarketplaceCustomerSchema();
    const token = getBearerToken(req);
    if (!token) return null;
    const decoded = verifyCustomerAuthToken(token);
    const scope = String(decoded?.scope || "").toLowerCase();
    if (scope !== MARKETPLACE_CUSTOMER_SCOPE || !decoded?.customer_id) return null;
    const marketplaceCustomer = await getMarketplaceCustomerById(decoded.customer_id);
    return marketplaceCustomer?.id ? marketplaceCustomer : null;
  } catch {
    return null;
  }
}

async function resolveOptionalQrCustomerSession(req, restaurantId) {
  try {
    const token = getBearerToken(req);
    if (!token) return null;
    const decoded = verifyCustomerAuthToken(token);
    if (!decoded?.customer_id) return null;

    const scope = String(decoded?.scope || "").toLowerCase();
    if (scope === MARKETPLACE_CUSTOMER_SCOPE) {
      const marketplaceCustomer = await getMarketplaceCustomerById(decoded.customer_id);
      if (!marketplaceCustomer?.id) return null;
      const localCustomerId = await ensureRestaurantCustomerForMarketplace({
        restaurantId,
        marketplaceCustomer,
      });
      return (await getRestaurantCustomerProfile(restaurantId, localCustomerId)) || null;
    }

    if (scope !== "qr_customer") return null;
    if (Number(decoded.restaurant_id) !== Number(restaurantId)) return null;

    return (await getRestaurantCustomerProfile(restaurantId, decoded.customer_id)) || null;
  } catch {
    return null;
  }
}

router.get("/:identifier/events", async (req, res) => {
  const identifier = String(req.params.identifier || "").trim();
  if (!identifier) {
    return res.status(400).json({ error: "Missing identifier" });
  }
  try {
    await ensureConcertTables(pool);
    const restaurantId = await resolveRestaurantIdByIdentifier(pool, identifier);
    if (!restaurantId) {
      return res.status(404).json({ error: "Restaurant not found" });
    }
    const events = await listEvents(pool, restaurantId, {
      includeHidden: false,
      upcomingOnly: true,
    });
    const visible = events.filter((event) => event.status !== "hidden");
    res.json({ success: true, events: visible });
  } catch (err) {
    console.error("❌ Failed to load public concert events:", err);
    res.status(500).json({ error: "Failed to load concerts" });
  }
});

router.get("/:identifier/events/:eventId", async (req, res) => {
  const identifier = String(req.params.identifier || "").trim();
  const eventId = Number(req.params.eventId);
  if (!identifier) {
    return res.status(400).json({ error: "Missing identifier" });
  }
  if (!Number.isFinite(eventId) || eventId <= 0) {
    return res.status(400).json({ error: "Invalid event id" });
  }
  try {
    await ensureConcertTables(pool);
    const restaurantId = await resolveRestaurantIdByIdentifier(pool, identifier);
    if (!restaurantId) {
      return res.status(404).json({ error: "Restaurant not found" });
    }
    const event = await getEventById(pool, restaurantId, eventId);
    if (!event || event.status === "hidden") {
      return res.status(404).json({ error: "Event not found" });
    }
    res.json({ success: true, event });
  } catch (err) {
    console.error("❌ Failed to load public concert event:", err);
    res.status(500).json({ error: "Failed to load concert event" });
  }
});

router.get("/:identifier/events/:eventId/available-tables", async (req, res) => {
  const identifier = String(req.params.identifier || "").trim();
  const eventId = Number(req.params.eventId);
  if (!identifier) {
    return res.status(400).json({ error: "Missing identifier" });
  }
  if (!Number.isFinite(eventId) || eventId <= 0) {
    return res.status(400).json({ error: "Invalid event id" });
  }

  try {
    await ensureConcertTables(pool);
    const restaurantId = await resolveRestaurantIdByIdentifier(pool, identifier);
    if (!restaurantId) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const tables = await listAvailableTablesForEvent(pool, restaurantId, eventId, {
      areaName: req.query.area_name,
      ticketTypeId: req.query.ticket_type_id,
      guestCount: req.query.guest_count,
      maleGuestsCount: req.query.male_guests_count,
      femaleGuestsCount: req.query.female_guests_count,
    });
    if (tables === null) {
      return res.status(404).json({ error: "Event not found" });
    }
    res.json({ success: true, tables });
  } catch (err) {
    console.error("❌ Failed to load available concert tables:", err);
    res.status(500).json({ error: "Failed to load available tables" });
  }
});

router.get("/:identifier/events/:eventId/floor-plan", async (req, res) => {
  const identifier = String(req.params.identifier || "").trim();
  const eventId = Number(req.params.eventId);
  if (!identifier) {
    return res.status(400).json({ error: "Missing identifier" });
  }
  if (!Number.isFinite(eventId) || eventId <= 0) {
    return res.status(400).json({ error: "Invalid event id" });
  }

  try {
    await ensureConcertTables(pool);
    const restaurantId = await resolveRestaurantIdByIdentifier(pool, identifier);
    if (!restaurantId) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const event = await getEventById(pool, restaurantId, eventId);
    if (!event || event.status === "hidden") {
      return res.status(404).json({ error: "Event not found" });
    }

    const [tablesResult, venueLayout, availableTables] = await Promise.all([
      pool.query(
        `
        SELECT number, area, seats, label, COALESCE(locked, FALSE) AS locked
        FROM tables
        WHERE restaurant_id = $1
          AND COALESCE(active, TRUE) = TRUE
        ORDER BY number ASC
        `,
        [restaurantId]
      ),
      loadVenueFloorPlanLayout(pool, restaurantId),
      listAvailableTablesForEvent(pool, restaurantId, eventId, {
        areaName: req.query.area_name,
        ticketTypeId: req.query.ticket_type_id,
        guestCount: req.query.guest_count,
        maleGuestsCount: req.query.male_guests_count,
        femaleGuestsCount: req.query.female_guests_count,
      }),
    ]);

    const { layout, source } = resolveEffectiveFloorPlanLayout({
      venueLayout,
      eventLayout: event.floor_plan_layout,
      tables: tablesResult.rows,
    });
    const layoutIndex = buildFloorPlanElementIndex(layout);
    const availableSet = new Set(
      (Array.isArray(availableTables) ? availableTables : [])
        .map((row) => Number(row?.table_number))
        .filter((value) => Number.isFinite(value) && value > 0)
    );

    const tableStates = tablesResult.rows.map((table) => {
      const tableNumber = Number(table?.number);
      const element = layoutIndex.get(tableNumber) || null;
      const restriction = evaluateTableRestrictions({
        table: {
          seats: table?.seats,
          area: table?.area,
        },
        element,
        guestCount: req.query.guest_count,
        menCount: req.query.male_guests_count,
        womenCount: req.query.female_guests_count,
        ticketTypeId: req.query.ticket_type_id,
        areaName: req.query.area_name || table?.area || "",
      });

      let status = "available";
      let reason = "";
      if (element?.hidden || restriction.reason === "Hidden table") {
        status = "hidden";
        reason = restriction.reason;
      } else if (Boolean(table?.locked)) {
        status = "blocked";
        reason = "Table is locked";
      } else if (!restriction.valid) {
        status = "blocked";
        reason = restriction.reason;
      } else if (availableSet.has(tableNumber)) {
        status = "available";
      } else {
        status = "reserved";
        reason = "Already reserved";
      }

      return {
        table_number: tableNumber,
        status,
        reason,
        capacity: Number(element?.capacity || table?.seats || 0) || 0,
        zone: String(element?.zone || table?.area || "").trim(),
        table_type: String(element?.table_type || "regular").trim(),
        label: String(element?.name || table?.label || "").trim(),
        seats: Number(table?.seats || 0) || 0,
      };
    });

    res.json({
      success: true,
      source,
      event,
      layout,
      table_states: tableStates,
    });
  } catch (err) {
    console.error("❌ Failed to load concert floor plan:", err);
    res.status(500).json({ error: "Failed to load concert floor plan" });
  }
});

router.post("/:identifier/events/:eventId/bookings", async (req, res) => {
  const identifier = String(req.params.identifier || "").trim();
  const eventId = Number(req.params.eventId);
  if (!identifier) {
    return res.status(400).json({ error: "Missing identifier" });
  }
  if (!Number.isFinite(eventId) || eventId <= 0) {
    return res.status(400).json({ error: "Invalid event id" });
  }

  try {
    await ensureConcertTables(pool);
    const restaurantId = await resolveRestaurantIdByIdentifier(pool, identifier);
    if (!restaurantId) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const customerPhone = normalizePhoneForVerification(
      req.body?.customer_phone || req.body?.phone || ""
    );
    if (!/^90\d{10}$/.test(customerPhone)) {
      return res.status(400).json({
        error: "Valid phone number is required for concert booking.",
        code: "invalid_phone",
      });
    }
    const marketplaceCustomer = await resolveOptionalMarketplaceSession(req);
    const qrCustomer = await resolveOptionalQrCustomerSession(req, restaurantId);
    const phoneVerificationResult = assertCheckoutPhoneVerification({
      restaurantId,
      phoneNumber: customerPhone,
      marketplaceCustomer,
      qrCustomer,
      phoneVerificationToken: normalizePhoneVerificationToken(
        req.body?.phone_verification_token ||
          req.body?.phoneVerificationToken ||
          req.headers?.["x-phone-verification-token"] ||
          ""
      ),
    });
    if (!phoneVerificationResult?.ok) {
      return res.status(Number(phoneVerificationResult?.statusCode || 403)).json({
        error:
          String(phoneVerificationResult?.message || "").trim() ||
          "Phone verification is required before booking.",
        code:
          String(phoneVerificationResult?.code || "").trim() ||
          "phone_verification_required",
      });
    }

    const bookingPayload = {
      ...(req.body || {}),
      customer_phone: customerPhone,
    };
    const result = await createBooking(pool, restaurantId, eventId, bookingPayload);
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

    const bookingResponse = mapBookingResponse(result.data.booking || {});
    res.status(result.status).json({
      success: true,
      booking: {
        ...bookingResponse,
        qr_status: bookingResponse?.qr_status || "pending",
        payment_instructions:
          result.data?.booking?.payment_instructions ||
          result.data?.event?.bank_transfer_instructions ||
          "Please complete bank transfer and wait for venue confirmation.",
      },
      reservation: result.data?.reservation || null,
      event: result.data?.event || null,
    });

    scheduleBackgroundTask(
      `public_concerts.bookings.create:${Number(result.data?.booking?.id)}`,
      async () => {
        await queueConcertBookingQrEmailJob({
          pool,
          restaurantId,
          bookingId: Number(result.data?.booking?.id),
          explicitCustomerEmail: req.body?.customer_email || req.body?.email || "",
          triggeredFrom: "public_concerts.bookings.create.qr_ready",
          req,
          sendEmail: true,
        });

        console.log("[owner-reservation-email] route.trigger.start", {
          source: "public_concerts.bookings.create",
          reservationType: "concert",
          bookingId: Number(result.data?.booking?.id),
          restaurantId,
        });
        const ownerNotificationResult = await sendConcertOwnerReservationNotificationEmail({
          pool,
          restaurantId,
          bookingId: Number(result.data?.booking?.id),
          explicitCustomerEmail: req.body?.customer_email || req.body?.email || "",
          triggeredFrom: "public_concerts.bookings.create",
          req,
        });
        console.log("[owner-reservation-email] route.trigger.result", {
          source: "public_concerts.bookings.create",
          reservationType: "concert",
          bookingId: Number(result.data?.booking?.id),
          restaurantId,
          result: ownerNotificationResult,
        });
      }
    );
  } catch (err) {
    console.error("❌ Failed to create public concert booking:", err);
    res.status(500).json({ error: "Failed to create booking" });
  }
});

module.exports = router;
