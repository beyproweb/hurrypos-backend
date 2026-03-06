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

    const result = await createBooking(pool, restaurantId, eventId, req.body || {});
    if (result.status >= 400) {
      return res.status(result.status).json({ error: result.error });
    }

    const io = req.app?.get?.("io");
    if (result.data?.reservation?.table_number && io) {
      io.to(`restaurant_${restaurantId}`).emit("orders_updated");
      io.to(`restaurant_${restaurantId}`).emit("reservation_created", {
        reservation_id: result.data.reservation.id,
        table_number: result.data.reservation.table_number,
        reservation_date: result.data.reservation.reservation_date,
        reservation_time: result.data.reservation.reservation_time,
      });
    }

    const bookingResponse = mapBookingResponse(result.data.booking || {});
    res.status(result.status).json({
      success: true,
      booking: {
        ...bookingResponse,
        payment_instructions:
          result.data?.booking?.payment_instructions ||
          result.data?.event?.bank_transfer_instructions ||
          "Please complete bank transfer and wait for venue confirmation.",
      },
      reservation: result.data?.reservation || null,
      event: result.data?.event || null,
    });
  } catch (err) {
    console.error("❌ Failed to create public concert booking:", err);
    res.status(500).json({ error: "Failed to create booking" });
  }
});

module.exports = router;
