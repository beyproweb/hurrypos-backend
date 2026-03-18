const TERMINAL_ORDER_STATUSES = new Set([
  "closed",
  "completed",
  "cancelled",
  "canceled",
  "deleted",
  "void",
]);

const BOOKING_CANCELLED_STATUSES = new Set(["cancelled", "canceled"]);
const EVENT_STATUSES = new Set(["active", "sold_out", "hidden"]);
const BOOKING_TYPES = new Set(["ticket", "table"]);
const PAYMENT_STATUSES = new Set(["pending_bank_transfer", "confirmed", "cancelled"]);

let concertTablesEnsured = false;

function asText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const next = String(value).trim();
  return next || fallback;
}

function asNullableText(value) {
  const next = asText(value, "");
  return next || null;
}

function normalizeEmail(value) {
  const next = asText(value, "").toLowerCase();
  if (!next) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next) ? next : null;
}

function asMoney(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Number(n.toFixed(2)));
}

function asInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeBookingType(value, fallback = "ticket") {
  const next = asText(value, fallback).toLowerCase();
  return BOOKING_TYPES.has(next) ? next : fallback;
}

function normalizeEventStatus(value, fallback = "active") {
  const next = asText(value, fallback).toLowerCase();
  return EVENT_STATUSES.has(next) ? next : fallback;
}

function normalizePaymentStatus(value, fallback = "pending_bank_transfer") {
  const next = asText(value, fallback).toLowerCase();
  return PAYMENT_STATUSES.has(next) ? next : fallback;
}

function normalizeAreaName(value) {
  const next = asText(value, "");
  return next || null;
}

function normalizeDateInput(value) {
  const next = asText(value, "");
  if (!next) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return null;
  return next;
}

function normalizeTimeInput(value) {
  const next = asText(value, "");
  if (!next) return null;
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(next)) return null;
  return next.length === 5 ? `${next}:00` : next;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isActiveBooking(row) {
  const payment = asText(row?.payment_status, "").toLowerCase();
  const booking = asText(row?.booking_status, "").toLowerCase();
  return !BOOKING_CANCELLED_STATUSES.has(payment) && !BOOKING_CANCELLED_STATUSES.has(booking);
}

function sanitizeEventInput(payload = {}, { isPatch = false } = {}) {
  const eventDate = normalizeDateInput(payload.event_date || payload.concert_date);
  const eventTime = normalizeTimeInput(payload.event_time || payload.concert_time);

  const artistName = asText(payload.artist_name, "");
  if (!isPatch && !artistName) {
    throw new Error("Artist name is required");
  }
  if (!isPatch && !eventDate) {
    throw new Error("Concert date is required");
  }
  if (!isPatch && !eventTime) {
    throw new Error("Concert time is required");
  }

  const status = normalizeEventStatus(payload.status, "active");
  const reservationPaymentMethod = "bank_transfer";

  const base = {
    artist_name: artistName,
    event_title: asNullableText(payload.event_title),
    event_date: eventDate,
    event_time: eventTime,
    description: asText(payload.description, ""),
    event_image: asNullableText(payload.event_image),
    ticket_price: asMoney(payload.ticket_price, 0),
    total_ticket_quantity: asInt(payload.total_ticket_quantity, 0),
    total_table_quantity: asInt(payload.total_table_quantity, 0),
    reservation_payment_method: reservationPaymentMethod,
    bank_transfer_instructions: asNullableText(payload.bank_transfer_instructions),
    status,
    free_concert: asBoolean(payload.free_concert, false),
  };

  const areaAllocations = normalizeArray(payload.area_allocations).map((row) => ({
    area_name: normalizeAreaName(row?.area_name || row?.area),
    allocation_type: normalizeBookingType(row?.allocation_type || row?.type || row?.inventory_kind || "ticket"),
    price: asMoney(row?.price, 0),
    quantity_total: asInt(row?.quantity_total ?? row?.quantity, 0),
  }));

  const ticketTypes = normalizeArray(payload.ticket_types).map((row) => ({
    name: asText(row?.name || row?.ticket_name || row?.package_name, ""),
    area_name: normalizeAreaName(row?.area_name || row?.linked_area || row?.area),
    price: asMoney(row?.price, 0),
    quantity_total: asInt(row?.quantity_total ?? row?.quantity, 0),
    description: asText(row?.description, ""),
    is_table_package: Boolean(row?.is_table_package || row?.is_table || row?.booking_type === "table"),
  }));

  const validatedAllocations = areaAllocations.filter((row) => row.area_name);
  const validatedTypes = ticketTypes.filter((row) => row.name);

  return {
    ...base,
    area_allocations: validatedAllocations,
    ticket_types: validatedTypes,
  };
}

async function ensureConcertTables(pool) {
  if (concertTablesEnsured) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS concert_events (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      artist_name TEXT NOT NULL,
      event_title TEXT,
      event_date DATE NOT NULL,
      event_time TIME NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      event_image TEXT,
      ticket_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_ticket_quantity INTEGER NOT NULL DEFAULT 0,
      total_table_quantity INTEGER NOT NULL DEFAULT 0,
      reservation_payment_method TEXT NOT NULL DEFAULT 'bank_transfer',
      bank_transfer_instructions TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT concert_events_status_chk CHECK (status IN ('active', 'sold_out', 'hidden')),
      CONSTRAINT concert_events_payment_method_chk CHECK (reservation_payment_method IN ('bank_transfer'))
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS concert_area_allocations (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      event_id INTEGER NOT NULL REFERENCES concert_events(id) ON DELETE CASCADE,
      area_name TEXT NOT NULL,
      allocation_type TEXT NOT NULL DEFAULT 'ticket',
      price NUMERIC(12,2) NOT NULL DEFAULT 0,
      quantity_total INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT concert_area_allocations_type_chk CHECK (allocation_type IN ('ticket', 'table'))
    );
  `);

  await pool.query(`
    ALTER TABLE concert_events
    ADD COLUMN IF NOT EXISTS event_image TEXT
  `);
  await pool.query(`
    ALTER TABLE concert_events
    ADD COLUMN IF NOT EXISTS free_concert BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS concert_ticket_types (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      event_id INTEGER NOT NULL REFERENCES concert_events(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      area_name TEXT,
      price NUMERIC(12,2) NOT NULL DEFAULT 0,
      quantity_total INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      is_table_package BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS concert_bookings (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      event_id INTEGER NOT NULL REFERENCES concert_events(id) ON DELETE CASCADE,
      ticket_type_id INTEGER REFERENCES concert_ticket_types(id) ON DELETE SET NULL,
      area_name TEXT,
      booking_type TEXT NOT NULL DEFAULT 'ticket',
      quantity INTEGER NOT NULL DEFAULT 1,
      guests_count INTEGER,
      unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      customer_name TEXT,
      customer_phone TEXT,
      customer_note TEXT,
      payment_method TEXT NOT NULL DEFAULT 'bank_transfer',
      payment_status TEXT NOT NULL DEFAULT 'pending_bank_transfer',
      booking_status TEXT NOT NULL DEFAULT 'pending',
      reservation_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      reserved_table_number INTEGER,
      bank_reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      CONSTRAINT concert_bookings_type_chk CHECK (booking_type IN ('ticket', 'table')),
      CONSTRAINT concert_bookings_payment_method_chk CHECK (payment_method IN ('bank_transfer')),
      CONSTRAINT concert_bookings_payment_status_chk CHECK (payment_status IN ('pending_bank_transfer', 'confirmed', 'cancelled'))
    );
  `);
  await pool.query(`
    ALTER TABLE concert_bookings
    ADD COLUMN IF NOT EXISTS cancellation_reason TEXT
  `);
  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS cancellation_reason TEXT
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_concert_events_restaurant_date ON concert_events(restaurant_id, event_date, event_time)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_concert_ticket_types_event ON concert_ticket_types(restaurant_id, event_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_concert_allocations_event ON concert_area_allocations(restaurant_id, event_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_concert_bookings_event ON concert_bookings(restaurant_id, event_id)`
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_concert_area_allocations_event_area_type ON concert_area_allocations(event_id, area_name, allocation_type)`
  );

  concertTablesEnsured = true;
}

async function resolveRestaurantIdByIdentifier(pool, identifier) {
  const clean = asText(identifier, "");
  if (!clean) return null;
  const result = await pool.query(
    `
    SELECT id
    FROM restaurants
    WHERE slug = $1 OR qr_code_id = $1 OR id::text = $1
    LIMIT 1
    `,
    [clean]
  );
  const id = Number(result.rows?.[0]?.id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function fetchEventRow(client, restaurantId, eventId, { forUpdate = false } = {}) {
  const result = await client.query(
    `
    SELECT *
    FROM concert_events
    WHERE restaurant_id = $1
      AND id = $2
    ${forUpdate ? "FOR UPDATE" : ""}
    LIMIT 1
    `,
    [restaurantId, eventId]
  );
  return result.rows?.[0] || null;
}

async function replaceEventNestedRows(client, restaurantId, eventId, areaAllocations = [], ticketTypes = []) {
  await client.query(
    `DELETE FROM concert_area_allocations WHERE restaurant_id = $1 AND event_id = $2`,
    [restaurantId, eventId]
  );
  await client.query(
    `DELETE FROM concert_ticket_types WHERE restaurant_id = $1 AND event_id = $2`,
    [restaurantId, eventId]
  );

  for (const allocation of areaAllocations) {
    await client.query(
      `
      INSERT INTO concert_area_allocations (
        restaurant_id,
        event_id,
        area_name,
        allocation_type,
        price,
        quantity_total,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `,
      [
        restaurantId,
        eventId,
        allocation.area_name,
        allocation.allocation_type,
        allocation.price,
        allocation.quantity_total,
      ]
    );
  }

  for (const ticketType of ticketTypes) {
    await client.query(
      `
      INSERT INTO concert_ticket_types (
        restaurant_id,
        event_id,
        name,
        area_name,
        price,
        quantity_total,
        description,
        is_table_package,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      `,
      [
        restaurantId,
        eventId,
        ticketType.name,
        ticketType.area_name,
        ticketType.price,
        ticketType.quantity_total,
        ticketType.description,
        ticketType.is_table_package,
      ]
    );
  }
}

async function getEventBookingCounters(client, restaurantId, eventId) {
  const result = await client.query(
    `
    SELECT
      booking_type,
      COALESCE(SUM(quantity), 0)::int AS booked_quantity,
      COUNT(*)::int AS booking_count
    FROM concert_bookings
    WHERE restaurant_id = $1
      AND event_id = $2
      AND LOWER(COALESCE(payment_status, '')) <> 'cancelled'
      AND LOWER(COALESCE(booking_status, '')) <> 'cancelled'
    GROUP BY booking_type
    `,
    [restaurantId, eventId]
  );
  let bookedTickets = 0;
  let bookedTables = 0;
  for (const row of result.rows) {
    const type = normalizeBookingType(row.booking_type);
    const qty = asInt(row.booked_quantity, 0);
    if (type === "table") {
      bookedTables += asInt(row.booking_count, 0);
    } else {
      bookedTickets += qty;
    }
  }
  return { bookedTickets, bookedTables };
}

async function getTicketTypesWithAvailability(client, restaurantId, eventId) {
  const result = await client.query(
    `
    SELECT
      tt.*,
      COALESCE(SUM(
        CASE
          WHEN LOWER(COALESCE(cb.payment_status, '')) <> 'cancelled'
           AND LOWER(COALESCE(cb.booking_status, '')) <> 'cancelled'
          THEN cb.quantity
          ELSE 0
        END
      ), 0)::int AS sold_count
    FROM concert_ticket_types tt
    LEFT JOIN concert_bookings cb
      ON cb.ticket_type_id = tt.id
     AND cb.restaurant_id = tt.restaurant_id
    WHERE tt.restaurant_id = $1
      AND tt.event_id = $2
    GROUP BY tt.id
    ORDER BY tt.created_at ASC, tt.id ASC
    `,
    [restaurantId, eventId]
  );

  return result.rows.map((row) => {
    const quantityTotal = asInt(row.quantity_total, 0);
    const soldCount = asInt(row.sold_count, 0);
    const availableCount = Math.max(0, quantityTotal - soldCount);
    return {
      id: row.id,
      name: row.name,
      area_name: row.area_name || null,
      price: asMoney(row.price, 0),
      quantity_total: quantityTotal,
      sold_count: soldCount,
      available_count: availableCount,
      description: row.description || "",
      is_table_package: Boolean(row.is_table_package),
      sold_out: quantityTotal > 0 && availableCount <= 0,
    };
  });
}

async function getAreaAllocationsWithAvailability(client, restaurantId, eventId) {
  const result = await client.query(
    `
    SELECT
      aa.*,
      COALESCE(SUM(
        CASE
          WHEN LOWER(COALESCE(cb.payment_status, '')) <> 'cancelled'
           AND LOWER(COALESCE(cb.booking_status, '')) <> 'cancelled'
          THEN CASE
            WHEN LOWER(COALESCE(aa.allocation_type, '')) = 'table' THEN 1
            ELSE cb.quantity
          END
          ELSE 0
        END
      ), 0)::int AS sold_count
    FROM concert_area_allocations aa
    LEFT JOIN concert_bookings cb
      ON cb.event_id = aa.event_id
     AND cb.restaurant_id = aa.restaurant_id
     AND LOWER(COALESCE(cb.area_name, '')) = LOWER(COALESCE(aa.area_name, ''))
     AND LOWER(COALESCE(cb.booking_type, '')) = LOWER(COALESCE(aa.allocation_type, ''))
    WHERE aa.restaurant_id = $1
      AND aa.event_id = $2
    GROUP BY aa.id
    ORDER BY aa.created_at ASC, aa.id ASC
    `,
    [restaurantId, eventId]
  );

  return result.rows.map((row) => {
    const quantityTotal = asInt(row.quantity_total, 0);
    const soldCount = asInt(row.sold_count, 0);
    const availableCount = Math.max(0, quantityTotal - soldCount);
    return {
      id: row.id,
      area_name: row.area_name,
      allocation_type: normalizeBookingType(row.allocation_type),
      price: asMoney(row.price, 0),
      quantity_total: quantityTotal,
      sold_count: soldCount,
      available_count: availableCount,
      sold_out: quantityTotal > 0 && availableCount <= 0,
    };
  });
}

function computePriceRange({ eventRow, ticketTypes, areaAllocations }) {
  const prices = [];
  const eventPrice = asMoney(eventRow?.ticket_price, 0);
  if (eventPrice > 0) prices.push(eventPrice);
  for (const row of ticketTypes || []) {
    const price = asMoney(row.price, 0);
    if (price > 0) prices.push(price);
  }
  for (const row of areaAllocations || []) {
    const price = asMoney(row.price, 0);
    if (price > 0) prices.push(price);
  }
  if (prices.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

function evaluateSoldOut({ eventRow, ticketTypes, areaAllocations, availableTickets, availableTables }) {
  const ticketPools = [];
  const tablePools = [];

  const eventTicketCap = asInt(eventRow?.total_ticket_quantity, 0);
  const eventTableCap = asInt(eventRow?.total_table_quantity, 0);

  if (eventTicketCap > 0) ticketPools.push(availableTickets);
  if (eventTableCap > 0) tablePools.push(availableTables);

  for (const row of ticketTypes || []) {
    if (row.is_table_package) {
      if (asInt(row.quantity_total, 0) > 0) tablePools.push(asInt(row.available_count, 0));
    } else if (asInt(row.quantity_total, 0) > 0) {
      ticketPools.push(asInt(row.available_count, 0));
    }
  }
  for (const row of areaAllocations || []) {
    if (asInt(row.quantity_total, 0) <= 0) continue;
    if (normalizeBookingType(row.allocation_type) === "table") {
      tablePools.push(asInt(row.available_count, 0));
    } else {
      ticketPools.push(asInt(row.available_count, 0));
    }
  }

  const ticketTracked = ticketPools.length > 0;
  const tableTracked = tablePools.length > 0;
  const ticketsSoldOut = ticketTracked && ticketPools.every((qty) => qty <= 0);
  const tablesSoldOut = tableTracked && tablePools.every((qty) => qty <= 0);

  if (!ticketTracked && !tableTracked) return false;
  if (ticketTracked && tableTracked) return ticketsSoldOut && tablesSoldOut;
  if (ticketTracked) return ticketsSoldOut;
  return tablesSoldOut;
}

async function buildEventView(client, eventRow) {
  const restaurantId = Number(eventRow.restaurant_id);
  const eventId = Number(eventRow.id);
  const { bookedTickets, bookedTables } = await getEventBookingCounters(client, restaurantId, eventId);
  const ticketTypes = await getTicketTypesWithAvailability(client, restaurantId, eventId);
  const areaAllocations = await getAreaAllocationsWithAvailability(client, restaurantId, eventId);

  const totalTickets = asInt(eventRow.total_ticket_quantity, 0);
  const totalTables = asInt(eventRow.total_table_quantity, 0);
  const availableTickets = Math.max(0, totalTickets - bookedTickets);
  const availableTables = Math.max(0, totalTables - bookedTables);
  const soldOutAuto = evaluateSoldOut({
    eventRow,
    ticketTypes,
    areaAllocations,
    availableTickets,
    availableTables,
  });
  const priceRange = computePriceRange({ eventRow, ticketTypes, areaAllocations });

  return {
    id: eventId,
    restaurant_id: restaurantId,
    artist_name: eventRow.artist_name,
    event_title: eventRow.event_title || "",
    event_date: eventRow.event_date,
    event_time: eventRow.event_time,
    description: eventRow.description || "",
    event_image: eventRow.event_image || "",
    ticket_price: asMoney(eventRow.ticket_price, 0),
    total_ticket_quantity: totalTickets,
    total_table_quantity: totalTables,
    reservation_payment_method: "bank_transfer",
    bank_transfer_instructions: eventRow.bank_transfer_instructions || "",
    status: normalizeEventStatus(eventRow.status, "active"),
    free_concert: Boolean(eventRow.free_concert),
    auto_sold_out: soldOutAuto,
    sold_ticket_count: bookedTickets,
    sold_table_count: bookedTables,
    available_ticket_count: availableTickets,
    available_table_count: availableTables,
    price_min: priceRange.min,
    price_max: priceRange.max,
    ticket_types: ticketTypes,
    area_allocations: areaAllocations,
    created_at: eventRow.created_at,
    updated_at: eventRow.updated_at,
  };
}

async function refreshEventStatus(client, restaurantId, eventId) {
  const eventRow = await fetchEventRow(client, restaurantId, eventId, { forUpdate: true });
  if (!eventRow) return null;
  const currentStatus = normalizeEventStatus(eventRow.status);
  if (currentStatus === "hidden") return "hidden";

  const view = await buildEventView(client, eventRow);
  const nextStatus =
    view.auto_sold_out || currentStatus === "sold_out" ? "sold_out" : "active";
  if (currentStatus !== nextStatus) {
    await client.query(
      `
      UPDATE concert_events
      SET status = $3,
          updated_at = NOW()
      WHERE restaurant_id = $1
        AND id = $2
      `,
      [restaurantId, eventId, nextStatus]
    );
  }
  return nextStatus;
}

async function listEvents(client, restaurantId, { includeHidden = true, upcomingOnly = false } = {}) {
  const conditions = ["restaurant_id = $1"];
  const params = [restaurantId];

  if (!includeHidden) {
    conditions.push(`LOWER(COALESCE(status, '')) <> 'hidden'`);
  }
  if (upcomingOnly) {
    conditions.push(
      `(event_date > CURRENT_DATE OR (event_date = CURRENT_DATE AND event_time >= (CURRENT_TIME - INTERVAL '6 hours')))`,
    );
  }

  const query = `
    SELECT *
    FROM concert_events
    WHERE ${conditions.join(" AND ")}
    ORDER BY event_date ASC, event_time ASC, id ASC
  `;

  const result = await client.query(query, params);
  const events = [];
  for (const row of result.rows) {
    events.push(await buildEventView(client, row));
  }
  return events;
}

async function getEventById(client, restaurantId, eventId) {
  const row = await fetchEventRow(client, restaurantId, eventId);
  if (!row) return null;
  return buildEventView(client, row);
}

async function createEvent(pool, restaurantId, payload) {
  await ensureConcertTables(pool);
  const clean = sanitizeEventInput(payload || {}, { isPatch: false });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `
      INSERT INTO concert_events (
        restaurant_id,
        artist_name,
        event_title,
        event_date,
        event_time,
        description,
        event_image,
        ticket_price,
        total_ticket_quantity,
        total_table_quantity,
        reservation_payment_method,
        bank_transfer_instructions,
        status,
        free_concert
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'bank_transfer', $11, $12, $13)
      RETURNING id
      `,
      [
        restaurantId,
        clean.artist_name,
        clean.event_title,
        clean.event_date,
        clean.event_time,
        clean.description,
        clean.event_image,
        clean.ticket_price,
        clean.total_ticket_quantity,
        clean.total_table_quantity,
        clean.bank_transfer_instructions,
        clean.status,
        clean.free_concert,
      ]
    );
    const eventId = inserted.rows[0].id;
    await replaceEventNestedRows(
      client,
      restaurantId,
      eventId,
      clean.area_allocations,
      clean.ticket_types
    );
    await refreshEventStatus(client, restaurantId, eventId);
    await client.query("COMMIT");
    return await getEventById(client, restaurantId, eventId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function updateEvent(pool, restaurantId, eventId, payload) {
  await ensureConcertTables(pool);
  const clean = sanitizeEventInput(payload || {}, { isPatch: false });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await fetchEventRow(client, restaurantId, eventId, { forUpdate: true });
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `
      UPDATE concert_events
      SET artist_name = $3,
          event_title = $4,
          event_date = $5,
          event_time = $6,
          description = $7,
          event_image = $8,
          ticket_price = $9,
          total_ticket_quantity = $10,
          total_table_quantity = $11,
          bank_transfer_instructions = $12,
          status = $13,
          free_concert = $14,
          updated_at = NOW()
      WHERE restaurant_id = $1
        AND id = $2
      `,
      [
        restaurantId,
        eventId,
        clean.artist_name,
        clean.event_title,
        clean.event_date,
        clean.event_time,
        clean.description,
        clean.event_image,
        clean.ticket_price,
        clean.total_ticket_quantity,
        clean.total_table_quantity,
        clean.bank_transfer_instructions,
        clean.status,
        clean.free_concert,
      ]
    );

    await replaceEventNestedRows(
      client,
      restaurantId,
      eventId,
      clean.area_allocations,
      clean.ticket_types
    );
    await refreshEventStatus(client, restaurantId, eventId);
    await client.query("COMMIT");
    return await getEventById(client, restaurantId, eventId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function deleteEvent(pool, restaurantId, eventId) {
  await ensureConcertTables(pool);
  const result = await pool.query(
    `
    DELETE FROM concert_events
    WHERE restaurant_id = $1
      AND id = $2
    RETURNING id
    `,
    [restaurantId, eventId]
  );
  return result.rowCount > 0;
}

async function listAreas(pool, restaurantId) {
  await ensureConcertTables(pool);
  const result = await pool.query(
    `
    SELECT DISTINCT COALESCE(area, 'Main Hall') AS area
    FROM tables
    WHERE restaurant_id = $1
      AND COALESCE(active, TRUE) = TRUE
    ORDER BY area ASC
    `,
    [restaurantId]
  );
  return result.rows.map((row) => row.area).filter(Boolean);
}

async function chooseAvailableTable(client, restaurantId, eventDate, eventTime, areaName = null) {
  const tablesResult = await client.query(
    `
    SELECT number, area, seats
    FROM tables
    WHERE restaurant_id = $1
      AND COALESCE(active, TRUE) = TRUE
      AND ($2::text IS NULL OR LOWER(COALESCE(area, 'Main Hall')) = LOWER($2::text))
    ORDER BY number ASC
    `,
    [restaurantId, areaName]
  );
  if (!tablesResult.rows.length) return null;

  const busyResult = await client.query(
    `
    SELECT DISTINCT table_number
    FROM orders
    WHERE restaurant_id = $1
      AND table_number IS NOT NULL
      AND LOWER(COALESCE(status, '')) NOT IN ('closed', 'completed', 'cancelled', 'canceled')
      AND reservation_date = $2::date
      AND (
        $3::time IS NULL
        OR COALESCE(reservation_time, '00:00:00'::time) = $3::time
      )
    `,
    [restaurantId, eventDate, eventTime]
  );
  const busy = new Set(
    busyResult.rows
      .map((row) => Number(row.table_number))
      .filter((n) => Number.isFinite(n) && n > 0)
  );
  const candidate = tablesResult.rows.find((row) => !busy.has(Number(row.number)));
  if (!candidate) return null;
  return {
    table_number: Number(candidate.number),
    seats: asInt(candidate.seats, 0),
    area_name: candidate.area || null,
  };
}

async function chooseSpecificAvailableTable(
  client,
  restaurantId,
  eventDate,
  eventTime,
  requestedTableNumber,
  areaName = null
) {
  const tableNumber = asInt(requestedTableNumber, 0);
  if (!tableNumber) return null;

  const tableResult = await client.query(
    `
    SELECT number, area, seats
    FROM tables
    WHERE restaurant_id = $1
      AND COALESCE(active, TRUE) = TRUE
      AND number = $2
      AND ($3::text IS NULL OR LOWER(COALESCE(area, 'Main Hall')) = LOWER($3::text))
    LIMIT 1
    `,
    [restaurantId, tableNumber, areaName]
  );
  const tableRow = tableResult.rows?.[0] || null;
  if (!tableRow) return null;

  const busyResult = await client.query(
    `
    SELECT id
    FROM orders
    WHERE restaurant_id = $1
      AND table_number = $2
      AND LOWER(COALESCE(status, '')) NOT IN ('closed', 'completed', 'cancelled', 'canceled')
      AND reservation_date = $3::date
      AND (
        $4::time IS NULL
        OR COALESCE(reservation_time, '00:00:00'::time) = $4::time
      )
    LIMIT 1
    `,
    [restaurantId, tableNumber, eventDate, eventTime]
  );
  if (busyResult.rows?.length) return null;

  return {
    table_number: Number(tableRow.number),
    seats: asInt(tableRow.seats, 0),
    area_name: tableRow.area || null,
  };
}

async function listAvailableTablesForEvent(
  pool,
  restaurantId,
  eventId,
  { areaName = null, ticketTypeId = null } = {}
) {
  await ensureConcertTables(pool);
  const client = await pool.connect();
  try {
    const eventRow = await fetchEventRow(client, restaurantId, eventId);
    if (!eventRow) return null;

    let resolvedAreaName = normalizeAreaName(areaName);
    const numericTicketTypeId = Number(ticketTypeId);
    if (!resolvedAreaName && Number.isFinite(numericTicketTypeId) && numericTicketTypeId > 0) {
      const ticketTypeResult = await client.query(
        `
        SELECT area_name
        FROM concert_ticket_types
        WHERE restaurant_id = $1
          AND event_id = $2
          AND id = $3
        LIMIT 1
        `,
        [restaurantId, eventId, numericTicketTypeId]
      );
      resolvedAreaName = normalizeAreaName(ticketTypeResult.rows?.[0]?.area_name);
    }

    const eventDate = normalizeDateInput(eventRow.event_date);
    const eventTime = normalizeTimeInput(eventRow.event_time) || "00:00:00";
    if (!eventDate) return [];

    const tablesResult = await client.query(
      `
      SELECT number, area, seats
      FROM tables
      WHERE restaurant_id = $1
        AND COALESCE(active, TRUE) = TRUE
        AND ($2::text IS NULL OR LOWER(COALESCE(area, 'Main Hall')) = LOWER($2::text))
      ORDER BY number ASC
      `,
      [restaurantId, resolvedAreaName]
    );

    const busyResult = await client.query(
      `
      SELECT DISTINCT table_number
      FROM orders
      WHERE restaurant_id = $1
        AND table_number IS NOT NULL
        AND LOWER(COALESCE(status, '')) NOT IN ('closed', 'completed', 'cancelled', 'canceled')
        AND reservation_date = $2::date
        AND (
          $3::time IS NULL
          OR COALESCE(reservation_time, '00:00:00'::time) = $3::time
        )
      `,
      [restaurantId, eventDate, eventTime]
    );
    const busy = new Set(
      busyResult.rows
        .map((row) => Number(row.table_number))
        .filter((n) => Number.isFinite(n) && n > 0)
    );

    return tablesResult.rows
      .filter((row) => !busy.has(Number(row.number)))
      .map((row) => ({
        table_number: Number(row.number),
        area_name: row.area || null,
        seats: asInt(row.seats, 0),
      }));
  } finally {
    client.release();
  }
}

async function createReservationOrder(client, payload) {
  const result = await client.query(
    `
    INSERT INTO orders (
      restaurant_id,
      table_number,
      status,
      total,
      order_type,
      customer_name,
      customer_phone,
      reservation_date,
      reservation_time,
      reservation_clients,
      reservation_notes,
      created_at
    )
    VALUES (
      $1, $2, 'reserved', 0, 'reservation', $3, $4, $5, $6, $7, $8, NOW()
    )
    RETURNING id, table_number, status, reservation_date, reservation_time
    `,
    [
      payload.restaurant_id,
      payload.table_number,
      payload.customer_name,
      payload.customer_phone,
      payload.reservation_date,
      payload.reservation_time,
      payload.reservation_clients,
      payload.reservation_notes,
    ]
  );
  return result.rows?.[0] || null;
}

async function createConcertTicketOrder(client, payload) {
  const orderResult = await client.query(
    `
    INSERT INTO orders (
      restaurant_id,
      status,
      total,
      order_type,
      customer_name,
      customer_phone,
      created_at
    )
    VALUES (
      $1, 'pending', $2, 'takeaway', $3, $4, NOW()
    )
    RETURNING id, status, order_type, total, customer_name, customer_phone, created_at
    `,
    [
      payload.restaurant_id,
      asMoney(payload.total_amount, 0),
      payload.customer_name || null,
      payload.customer_phone || null,
    ]
  );
  const createdOrder = orderResult.rows?.[0] || null;
  if (!createdOrder) return null;

  const quantity = Math.max(1, asInt(payload.quantity, 1) || 1);
  const unitPrice = asMoney(payload.unit_price, 0);
  const itemName = "Ticket concert";
  const itemNote = asText(payload.item_note, "");
  const uniqueId = `concert-ticket-${createdOrder.id}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  await client.query(
    `
    INSERT INTO order_items (
      order_id,
      product_id,
      quantity,
      price,
      ingredients,
      extras,
      unique_id,
      confirmed,
      kitchen_status,
      payment_method,
      receipt_id,
      note,
      discount_type,
      discount_value,
      external_product_id,
      external_product_name,
      name
    )
    VALUES (
      $1, NULL, $2, $3,
      '[]'::jsonb, '[]'::jsonb, $4,
      TRUE, 'delivered', NULL, NULL, $5,
      NULL, 0, NULL, $6, $7
    )
    `,
    [createdOrder.id, quantity, unitPrice, uniqueId, itemNote || null, itemName, itemName]
  );

  return createdOrder;
}

function makeConcertReservationNote(eventRow, customerNote) {
  const eventLabel = [asText(eventRow.event_title, ""), asText(eventRow.artist_name, "")]
    .filter(Boolean)
    .join(" - ");
  const prefix = eventLabel ? `Concert: ${eventLabel}` : "Concert booking";
  const cleanNote = asText(customerNote, "");
  return cleanNote ? `${prefix} | ${cleanNote}` : prefix;
}

async function createBooking(pool, restaurantId, eventId, rawPayload = {}) {
  await ensureConcertTables(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const eventRow = await fetchEventRow(client, restaurantId, eventId, { forUpdate: true });
    if (!eventRow) {
      await client.query("ROLLBACK");
      return { status: 404, error: "Concert event not found" };
    }

    const lockedStatus = normalizeEventStatus(eventRow.status);
    if (lockedStatus === "hidden" || lockedStatus === "sold_out") {
      await client.query("ROLLBACK");
      return { status: 409, error: "This concert is currently not available" };
    }

    const requestedTicketTypeId = Number(rawPayload.ticket_type_id);
    const hasTicketType = Number.isFinite(requestedTicketTypeId) && requestedTicketTypeId > 0;
    let ticketTypeRow = null;
    if (hasTicketType) {
      const ticketTypeResult = await client.query(
        `
        SELECT *
        FROM concert_ticket_types
        WHERE restaurant_id = $1
          AND event_id = $2
          AND id = $3
        FOR UPDATE
        `,
        [restaurantId, eventId, requestedTicketTypeId]
      );
      ticketTypeRow = ticketTypeResult.rows?.[0] || null;
      if (!ticketTypeRow) {
        await client.query("ROLLBACK");
        return { status: 404, error: "Ticket type not found for this event" };
      }
    }

    const requestedType = normalizeBookingType(rawPayload.booking_type, "ticket");
    const bookingType = ticketTypeRow
      ? ticketTypeRow.is_table_package
        ? "table"
        : requestedType
      : requestedType;

    let quantity = Math.max(1, asInt(rawPayload.quantity, 1) || 1);

    const areaName = normalizeAreaName(rawPayload.area_name || ticketTypeRow?.area_name);
    const paymentMethod = "bank_transfer";
    const paymentStatus = "pending_bank_transfer";
    const customerName = asNullableText(rawPayload.customer_name);
    const customerPhone = asNullableText(rawPayload.customer_phone);
    const customerEmail = normalizeEmail(rawPayload.customer_email || rawPayload.email);
    const customerNote = asText(rawPayload.customer_note || rawPayload.note || "", "");
    const requestedGuestsCount = asInt(
      rawPayload.guests_count || rawPayload.reservation_clients || rawPayload.guests || 0,
      0
    );
    const guestsCount =
      bookingType === "table"
        ? Math.max(1, requestedGuestsCount || quantity)
        : requestedGuestsCount;
    if (bookingType === "table") {
      quantity = guestsCount;
    }

    let areaAllocationRow = null;
    if (areaName) {
      const allocationResult = await client.query(
        `
        SELECT *
        FROM concert_area_allocations
        WHERE restaurant_id = $1
          AND event_id = $2
          AND LOWER(COALESCE(area_name, '')) = LOWER($3)
          AND allocation_type = $4
        FOR UPDATE
        `,
        [restaurantId, eventId, areaName, bookingType]
      );
      areaAllocationRow = allocationResult.rows?.[0] || null;
    }

    const bookingCounters = await getEventBookingCounters(client, restaurantId, eventId);
    if (bookingType === "table") {
      const totalTableQty = asInt(eventRow.total_table_quantity, 0);
      const tableUnitsRequested = 1;
      if (totalTableQty > 0 && bookingCounters.bookedTables + tableUnitsRequested > totalTableQty) {
        await client.query("ROLLBACK");
        return { status: 409, error: "Concert table stock is sold out" };
      }
    } else {
      const totalTicketQty = asInt(eventRow.total_ticket_quantity, 0);
      if (totalTicketQty > 0 && bookingCounters.bookedTickets + quantity > totalTicketQty) {
        await client.query("ROLLBACK");
        return { status: 409, error: "Ticket stock is sold out" };
      }
    }

    if (ticketTypeRow) {
      const ticketTypeBookedResult = await client.query(
        `
        SELECT COALESCE(SUM(quantity), 0)::int AS qty
        FROM concert_bookings
        WHERE restaurant_id = $1
          AND event_id = $2
          AND ticket_type_id = $3
          AND LOWER(COALESCE(payment_status, '')) <> 'cancelled'
          AND LOWER(COALESCE(booking_status, '')) <> 'cancelled'
        `,
        [restaurantId, eventId, ticketTypeRow.id]
      );
      const ticketTypeBooked = asInt(ticketTypeBookedResult.rows?.[0]?.qty, 0);
      const ticketTypeCapacity = asInt(ticketTypeRow.quantity_total, 0);
      if (ticketTypeCapacity > 0 && ticketTypeBooked + quantity > ticketTypeCapacity) {
        await client.query("ROLLBACK");
        return { status: 409, error: "Selected ticket type is sold out" };
      }
    }

    if (areaAllocationRow) {
      const areaBookedResult = await client.query(
        `
        SELECT COALESCE(
          SUM(
            CASE
              WHEN LOWER(COALESCE(booking_type, '')) = 'table' THEN 1
              ELSE quantity
            END
          ),
          0
        )::int AS qty
        FROM concert_bookings
        WHERE restaurant_id = $1
          AND event_id = $2
          AND LOWER(COALESCE(area_name, '')) = LOWER($3)
          AND LOWER(COALESCE(booking_type, '')) = LOWER($4)
          AND LOWER(COALESCE(payment_status, '')) <> 'cancelled'
          AND LOWER(COALESCE(booking_status, '')) <> 'cancelled'
        `,
        [restaurantId, eventId, areaAllocationRow.area_name, bookingType]
      );
      const areaBooked = asInt(areaBookedResult.rows?.[0]?.qty, 0);
      const areaCapacity = asInt(areaAllocationRow.quantity_total, 0);
      const areaUnitsRequested = bookingType === "table" ? 1 : quantity;
      if (areaCapacity > 0 && areaBooked + areaUnitsRequested > areaCapacity) {
        await client.query("ROLLBACK");
        return { status: 409, error: `${areaAllocationRow.area_name} is sold out` };
      }
    }

    let unitPrice = asMoney(eventRow.ticket_price, 0);
    if (areaAllocationRow) {
      unitPrice = asMoney(areaAllocationRow.price, unitPrice);
    }
    if (ticketTypeRow) {
      unitPrice = asMoney(ticketTypeRow.price, unitPrice);
    }
    const totalAmount = asMoney(unitPrice * quantity, 0);

    let reservationOrder = null;
    let linkedOrder = null;
    let reservedTableNumber = null;
    if (bookingType === "table") {
      const eventDate = normalizeDateInput(eventRow.event_date);
      const eventTime = normalizeTimeInput(eventRow.event_time) || "00:00:00";
      const requestedTableNumber = asInt(
        rawPayload.requested_table_number || rawPayload.table_number,
        0
      );
      const tableChoice =
        requestedTableNumber > 0
          ? await chooseSpecificAvailableTable(
              client,
              restaurantId,
              eventDate,
              eventTime,
              requestedTableNumber,
              areaName
            )
          : await chooseAvailableTable(
              client,
              restaurantId,
              eventDate,
              eventTime,
              areaName
            );
      if (!tableChoice) {
        await client.query("ROLLBACK");
        return {
          status: 409,
          error:
            requestedTableNumber > 0
              ? "Selected table is not available for this concert slot"
              : "No available concert tables in this area",
        };
      }

      reservedTableNumber = tableChoice.table_number;
      reservationOrder = await createReservationOrder(client, {
        restaurant_id: restaurantId,
        table_number: reservedTableNumber,
        customer_name: customerName,
        customer_phone: customerPhone,
        reservation_date: eventDate,
        reservation_time: eventTime,
        reservation_clients: guestsCount || Math.max(1, tableChoice.seats || 1),
        reservation_notes: makeConcertReservationNote(eventRow, customerNote),
      });
      if (!reservationOrder) {
        await client.query("ROLLBACK");
        return { status: 500, error: "Failed to reserve a concert table" };
      }
      linkedOrder = reservationOrder;
    } else {
      const eventLabel = [asText(eventRow.event_title, ""), asText(eventRow.artist_name, "")]
        .filter(Boolean)
        .join(" - ");
      linkedOrder = await createConcertTicketOrder(client, {
        restaurant_id: restaurantId,
        total_amount: totalAmount,
        quantity,
        unit_price: unitPrice,
        customer_name: customerName,
        customer_phone: customerPhone,
        item_note: eventLabel ? `Concert: ${eventLabel}` : "Concert ticket",
      });
      if (!linkedOrder) {
        await client.query("ROLLBACK");
        return { status: 500, error: "Failed to create concert ticket order" };
      }
    }

    if (customerPhone) {
      await client.query(
        `
        INSERT INTO customers (restaurant_id, name, phone, email)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (restaurant_id, phone)
        DO UPDATE SET
          name = COALESCE(NULLIF(EXCLUDED.name, ''), customers.name),
          email = COALESCE(NULLIF(EXCLUDED.email, ''), customers.email)
        `,
        [restaurantId, customerName || "Customer", customerPhone, customerEmail]
      );
    }

    const insertResult = await client.query(
      `
      INSERT INTO concert_bookings (
        restaurant_id,
        event_id,
        ticket_type_id,
        area_name,
        booking_type,
        quantity,
        guests_count,
        unit_price,
        total_amount,
        customer_name,
        customer_phone,
        customer_note,
        payment_method,
        payment_status,
        booking_status,
        reservation_order_id,
        reserved_table_number,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13, $14, 'pending', $15, $16, NOW()
      )
      RETURNING *
      `,
      [
        restaurantId,
        eventId,
        ticketTypeRow?.id || null,
        areaName,
        bookingType,
        quantity,
        bookingType === "table" ? guestsCount : null,
        unitPrice,
        totalAmount,
        customerName,
        customerPhone,
        customerNote || null,
        paymentMethod,
        paymentStatus,
        linkedOrder?.id || null,
        reservedTableNumber,
      ]
    );

    await refreshEventStatus(client, restaurantId, eventId);
    const booking = insertResult.rows[0];
    const eventView = await getEventById(client, restaurantId, eventId);
    await client.query("COMMIT");

    return {
      status: 201,
      data: {
        booking: {
          ...booking,
          payment_instructions:
            eventView?.bank_transfer_instructions ||
            "Please complete bank transfer and wait for venue confirmation.",
        },
        reservation: reservationOrder,
        linked_order: linkedOrder,
        event: eventView,
      },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function listBookingsForEvent(pool, restaurantId, eventId) {
  await ensureConcertTables(pool);
  const result = await pool.query(
    `
    SELECT
      cb.*,
      tt.name AS ticket_type_name,
      o.status AS reservation_order_status
    FROM concert_bookings cb
    LEFT JOIN concert_ticket_types tt
      ON tt.id = cb.ticket_type_id
    LEFT JOIN orders o
      ON o.id = cb.reservation_order_id
    WHERE cb.restaurant_id = $1
      AND cb.event_id = $2
    ORDER BY cb.created_at DESC, cb.id DESC
    `,
    [restaurantId, eventId]
  );
  return result.rows;
}

async function updateBookingPaymentStatus(
  pool,
  restaurantId,
  bookingId,
  paymentStatus,
  cancellationReason = ""
) {
  await ensureConcertTables(pool);
  const normalizedStatus = normalizePaymentStatus(paymentStatus);
  const normalizedReason = asText(cancellationReason, "");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const bookingResult = await client.query(
      `
      SELECT *
      FROM concert_bookings
      WHERE restaurant_id = $1
        AND id = $2
      FOR UPDATE
      `,
      [restaurantId, bookingId]
    );
    const booking = bookingResult.rows?.[0] || null;
    if (!booking) {
      await client.query("ROLLBACK");
      return { status: 404, error: "Booking not found" };
    }

    const nextBookingStatus =
      normalizedStatus === "confirmed"
        ? "confirmed"
        : normalizedStatus === "cancelled"
        ? "cancelled"
        : "pending";
    await client.query(
      `
      UPDATE concert_bookings
      SET payment_status = $3,
          booking_status = $4,
          updated_at = NOW(),
          confirmed_at = CASE WHEN $3 = 'confirmed' THEN NOW() ELSE confirmed_at END,
          cancelled_at = CASE WHEN $3 = 'cancelled' THEN NOW() ELSE cancelled_at END,
          cancellation_reason = CASE
            WHEN $3 = 'cancelled' THEN NULLIF($5, '')
            ELSE NULL
          END
      WHERE restaurant_id = $1
        AND id = $2
      `,
      [restaurantId, bookingId, normalizedStatus, nextBookingStatus, normalizedReason]
    );

    if (booking.reservation_order_id) {
      const bookingType = normalizeBookingType(booking.booking_type);
      if (normalizedStatus === "cancelled") {
        await client.query(
          `
          UPDATE orders
          SET status = 'cancelled',
              cancellation_reason = CASE
                WHEN NULLIF($3, '') IS NULL THEN cancellation_reason
                ELSE NULLIF($3, '')
              END,
              reservation_date = NULL,
              reservation_time = NULL,
              reservation_clients = NULL,
              reservation_notes = NULL,
              updated_at = NOW()
          WHERE restaurant_id = $1
            AND id = $2
          `,
          [restaurantId, booking.reservation_order_id, normalizedReason]
        );
      } else if (normalizedStatus === "confirmed") {
        if (bookingType === "table") {
          await client.query(
            `
            UPDATE orders
            SET status = CASE
                  WHEN LOWER(COALESCE(status, '')) IN ('cancelled', 'canceled')
                    THEN 'reserved'
                  ELSE status
                END,
                cancellation_reason = NULL,
                updated_at = NOW()
            WHERE restaurant_id = $1
              AND id = $2
            `,
            [restaurantId, booking.reservation_order_id]
          );
        } else {
          await client.query(
            `
            UPDATE orders
            SET status = CASE
                  WHEN LOWER(COALESCE(status, '')) IN ('closed', 'completed')
                    THEN status
                  ELSE 'confirmed'
                END,
                cancellation_reason = NULL,
                updated_at = NOW()
            WHERE restaurant_id = $1
              AND id = $2
            `,
            [restaurantId, booking.reservation_order_id]
          );
        }
      }
    }

    await refreshEventStatus(client, restaurantId, booking.event_id);
    const refreshedEvent = await getEventById(client, restaurantId, booking.event_id);
    const refreshedBooking = (
      await client.query(
        `
        SELECT *
        FROM concert_bookings
        WHERE restaurant_id = $1
          AND id = $2
        LIMIT 1
        `,
        [restaurantId, bookingId]
      )
    ).rows?.[0];

    await client.query("COMMIT");
    return {
      status: 200,
      data: {
        booking: refreshedBooking,
        event: refreshedEvent,
      },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function mapBookingResponse(row) {
  return {
    id: row.id,
    event_id: row.event_id,
    ticket_type_id: row.ticket_type_id,
    ticket_type_name: row.ticket_type_name || null,
    area_name: row.area_name || null,
    booking_type: normalizeBookingType(row.booking_type),
    quantity: asInt(row.quantity, 0),
    guests_count: row.guests_count == null ? null : asInt(row.guests_count, 0),
    unit_price: asMoney(row.unit_price, 0),
    total_amount: asMoney(row.total_amount, 0),
    customer_name: row.customer_name || "",
    customer_phone: row.customer_phone || "",
    customer_note: row.customer_note || "",
    payment_method: "bank_transfer",
    payment_status: normalizePaymentStatus(row.payment_status),
    booking_status: asText(row.booking_status, "pending"),
    reservation_order_id: row.reservation_order_id || null,
    reservation_order_status: row.reservation_order_status || null,
    reserved_table_number: row.reserved_table_number || null,
    bank_reference: row.bank_reference || null,
    cancellation_reason: asText(row.cancellation_reason, "") || null,
    cancel_reason: asText(row.cancellation_reason, "") || null,
    reason: asText(row.cancellation_reason, "") || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    confirmed_at: row.confirmed_at || null,
    cancelled_at: row.cancelled_at || null,
  };
}

module.exports = {
  TERMINAL_ORDER_STATUSES,
  isActiveBooking,
  ensureConcertTables,
  resolveRestaurantIdByIdentifier,
  sanitizeEventInput,
  listEvents,
  getEventById,
  createEvent,
  updateEvent,
  deleteEvent,
  listAreas,
  createBooking,
  listBookingsForEvent,
  updateBookingPaymentStatus,
  listAvailableTablesForEvent,
  mapBookingResponse,
};
