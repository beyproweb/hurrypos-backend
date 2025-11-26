module.exports = function(io) {
  const express = require("express");
  const router = express.Router();

  const { pool } = require("../db");
  const { getIO } = require("../utils/socket");
  const { v4: uuidv4 } = require("uuid");
  const { performance } = require("perf_hooks");
  const jwt = require("jsonwebtoken");
  const dlog = (...args) =>
    console.log(new Date().toISOString(), "[orders]", ...args);
  const authMiddleware = require("../middleware/authMiddleware");
  const {
    ensureCustomerDebtColumn,
    increaseCustomerDebt,
    decreaseCustomerDebt,
  } = require("../utils/customerDebt");

  const TABLE_QR_SECRET =
    process.env.TABLE_QR_SECRET ||
    process.env.JWT_SECRET ||
    "table_qr_secret_2025";

  let hasOrderDebtTracking = null;
  async function ensureOrderDebtTracking() {
    if (hasOrderDebtTracking !== null) return hasOrderDebtTracking;
    try {
      await pool.query(
        `ALTER TABLE orders
           ADD COLUMN IF NOT EXISTS debt_recorded_total NUMERIC(12,2) NOT NULL DEFAULT 0`
      );
      await pool.query(
        `ALTER TABLE orders
           ADD COLUMN IF NOT EXISTS debt_paid_at TIMESTAMPTZ`
      );
      hasOrderDebtTracking = true;
    } catch (err) {
      console.warn("⚠️ Unable to ensure orders debt tracking columns:", err.message);
      hasOrderDebtTracking = false;
    }
    return hasOrderDebtTracking;
  }

  // ✅ Ensure payments table has previous_payment_method column for change tracking
  let hasPaymentChangeTracking = null;
  async function ensurePaymentChangeTracking() {
    if (hasPaymentChangeTracking !== null) return hasPaymentChangeTracking;
    try {
      await pool.query(
        `ALTER TABLE payments
           ADD COLUMN IF NOT EXISTS previous_payment_method VARCHAR(255)`
      );
      hasPaymentChangeTracking = true;
      console.log("✅ Payment change tracking column added/verified");
    } catch (err) {
      console.warn("⚠️ Unable to ensure payments change tracking column:", err.message);
      hasPaymentChangeTracking = false;
    }
    return hasPaymentChangeTracking;
  }

  ensureCustomerDebtColumn();
  ensureOrderDebtTracking();
  ensurePaymentChangeTracking();

  const toMoney = (value) => {
    const num = Number.parseFloat(value);
    if (!Number.isFinite(num)) return 0;
    return Math.round(num * 100) / 100;
  };

  const PUBLIC_GET_PATTERNS = [/^\/$/, /^\/\d+$/, /^\/\d+\/items$/];

  // Authentication layer:
  // - Public GETs with ?identifier=... stay public (for dashboards)
  // - Table QR mode (?mode=table) uses a lightweight table JWT
  // - Everything else falls back to normal staff authMiddleware
  router.use((req, res, next) => {
    const mode =
      typeof req.query.mode === "string"
        ? req.query.mode.toLowerCase()
        : String(req.query.mode || "").toLowerCase();

    // 1) Public GETs for non-table QR flows
    if (req.method === "GET" && mode !== "table") {
      const identifier =
        typeof req.query.identifier === "string"
          ? req.query.identifier.trim()
          : String(req.query.identifier || "").trim();
      if (identifier && PUBLIC_GET_PATTERNS.some((re) => re.test(req.path))) {
        return next();
      }
    }

    // 2) Table QR mode – require a table-scoped JWT and attach limited context
    if (mode === "table") {
      const authHeader = req.headers.authorization || "";
      if (!authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Missing table token" });
      }

      const token = authHeader.slice(7).trim();
      try {
        const decoded = jwt.verify(token, TABLE_QR_SECRET);
        if (
          !decoded ||
          decoded.type !== "table" ||
          !decoded.restaurant_id ||
          typeof decoded.table_number === "undefined"
        ) {
          return res.status(401).json({ error: "Invalid table token" });
        }

        req.qrTable = {
          restaurant_id: decoded.restaurant_id,
          table_number: Number(decoded.table_number),
        };

        // Minimal req.user so requireRestaurantId() continues to work
        req.user = {
          ...(req.user || {}),
          id: null,
          name: "QR Table",
          role: "qr-table",
          restaurant_id: decoded.restaurant_id,
        };

        return next();
      } catch (err) {
        console.warn("⚠️ Table QR token verification failed:", err.message);
        return res
          .status(401)
          .json({ error: "Invalid or expired table token" });
      }
    }

    // 3) Default: staff / backend tokens
    return authMiddleware(req, res, next);
  });


async function resolveRestaurantId(req) {
  const identifier = req.query.identifier;
  let restaurant_id = req.user?.restaurant_id;

  if (identifier) {
    if (/^\d+$/.test(identifier)) {
      restaurant_id = Number(identifier);
    } else {
      const result = await pool.query(
        "SELECT id FROM restaurants WHERE slug = $1 OR qr_code_id = $1 LIMIT 1",
        [identifier]
      );
      restaurant_id = result.rows[0]?.id;
    }
  }

  return restaurant_id;
}

async function requireRestaurantId(req, res) {
  const restaurantId = await resolveRestaurantId(req);
  if (!restaurantId) {
    res.status(400).json({ error: "Invalid restaurant" });
    return null;
  }
  return restaurantId;
}

// Track the last write/update time per order id to spot read-after-write timing
const ORDER_TOUCH = new Map(); // id:number -> { when:number(ms), source:string }
function touch(id, source) {
  if (id == null) return;
  const n = Number(id);
  if (!Number.isFinite(n)) return;
  ORDER_TOUCH.set(n, { when: Date.now(), source });
}
function since(id) {
  const n = Number(id);
  const info = ORDER_TOUCH.get(n);
  return info ? { ms: Date.now() - info.when, source: info.source } : null;
}


const { emitAlert, emitStockUpdate, emitOrderUpdate, emitOrderConfirmed, emitOrderDelivered, emitPaymentMade, emitOrderPreparing, emitDriverAssigned } = require('../utils/realtime');

let ordersHasCreatedByColumn = null;
async function hasOrdersCreatedByColumn() {
  if (ordersHasCreatedByColumn !== null) return ordersHasCreatedByColumn;
  try {
    const { rows } = await pool.query(
      `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'orders'
          AND column_name = 'created_by'
      ) AS exists
      `
    );
    ordersHasCreatedByColumn = !!rows?.[0]?.exists;
  } catch (err) {
    console.warn("⚠️ Unable to detect orders.created_by column:", err.message);
    ordersHasCreatedByColumn = false;
  }
  return ordersHasCreatedByColumn;
}

let ordersHasTakeawayFields = null;
async function ensureTakeawayFields() {
  if (ordersHasTakeawayFields === true) return true;
  try {
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS pickup_time TEXT`
    );
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS takeaway_notes TEXT`
    );
    ordersHasTakeawayFields = true;
    return true;
  } catch (err) {
    console.warn("⚠️ Unable to ensure takeaway columns:", err.message);
    ordersHasTakeawayFields = false;
    return false;
  }
}

let ordersHasCancellationFields = null;
async function ensureCancellationFields() {
  if (ordersHasCancellationFields === true) return true;
  try {
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS cancellation_reason TEXT`
    );
    await pool.query(
      `ALTER TABLE orders
         ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`
    );
    ordersHasCancellationFields = true;
    return true;
  } catch (err) {
    console.warn("⚠️ Unable to ensure cancellation columns:", err.message);
    ordersHasCancellationFields = false;
    return false;
  }
}

ensureCancellationFields();

let orderItemsHasCancellationFields = null;
async function ensureOrderItemCancellationFields() {
  if (orderItemsHasCancellationFields !== null) return orderItemsHasCancellationFields;
  try {
    await pool.query(
      `ALTER TABLE order_items
         ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`
    );
    await pool.query(
      `ALTER TABLE order_items
         ADD COLUMN IF NOT EXISTS cancellation_reason TEXT`
    );
    orderItemsHasCancellationFields = true;
    return true;
  } catch (err) {
    console.warn(
      "⚠️ Unable to ensure order_items cancellation columns:",
      err.message
    );
    orderItemsHasCancellationFields = false;
    return false;
  }
}

ensureOrderItemCancellationFields();


// ---- Shared payload builder for printer (no order_number) ----
async function buildFullOrderPayload(orderId, restaurantId) {
  const { rows: orderRows } = await pool.query(
    `SELECT id, status, table_number, order_type, total, created_at
     FROM orders WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, orderId]
  );

  if (!orderRows.length) throw new Error(`Order ${orderId} not found`);

  const { rows: itemRows } = await pool.query(
    `SELECT
       oi.product_id,
       oi.unique_id,
       oi.name AS order_item_name,
       p.name  AS product_name,
       oi.quantity,
       oi.price,
       oi.extras,
       oi.note,
       oi.kitchen_status,
       oi.paid_at
     FROM order_items oi
     LEFT JOIN products p ON oi.product_id = p.id
     WHERE oi.order_id = $1
     ORDER BY oi.id ASC`,
    [orderId]
  );

  const items = itemRows.map(it => ({
    ...it,
    name: it.order_item_name || it.product_name || "Item",
    extras: typeof it.extras === "string"
      ? (() => { try { return JSON.parse(it.extras); } catch { return []; } })()
      : (it.extras || []),
    total: (parseFloat(it.price) || 0) * (it.quantity || 1),
  }));

  const header = orderRows[0];
  return {
    id: header.id,
    order: {
      id: header.id,
      status: header.status,
      table_number: header.table_number,
      order_type: header.order_type,
      total: header.total,
      created_at: header.created_at,
      items,
    },
  };
}



// GET /orders
// Supports: ?status=open_phone to return ONLY non-closed phone/packet orders
router.get("/", async (req, res) => {
  try {
    const restaurantId = await requireRestaurantId(req, res);
    if (!restaurantId) return;
    const { status, table_number, type } = req.query;

    // 🔐 Special mode: always and only open phone/packet
    if (String(status).toLowerCase() === "open_phone") {
      const { rows } = await pool.query(
        `SELECT *
           FROM orders
          WHERE restaurant_id = $1
            AND order_type IN ('phone','packet')
            AND status <> 'closed'
          ORDER BY id DESC`,
        [restaurantId]
      );
      return res.json(rows);
    }

    // 🔎 default behavior
    let sql = "SELECT * FROM orders WHERE restaurant_id = $1";
    const params = [restaurantId];
    let idx = 2;

    if (status) {
      sql += ` AND status = $${idx++}`;
      params.push(status);
    }
    if (table_number) {
      sql += ` AND table_number = $${idx++}`;
      params.push(table_number);
    }
    if (type) {
      sql += ` AND order_type = $${idx++}`;
      params.push(type);
    }
    sql += " ORDER BY id DESC";

    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Orders fetch failed:", err);
    res.status(500).json({ error: "Database error" });
  }
});




// POST /orders - Create new order (table or phone)
router.post("/", async (req, res) => {
  console.log("💬 /orders payload:", req.body);

  // --- TIMEZONE-SAFE REGISTER OPEN LOGIC ---
  const { rows: openLogs } = await pool.query(`
    SELECT * FROM cash_register_logs WHERE type = 'open' ORDER BY created_at DESC LIMIT 1
  `);
  const lastOpen = openLogs[0];

  if (!lastOpen) {
    return res.status(403).json({ error: "Register is closed. Cannot place order." });
  }

  const { rows: closeLogs } = await pool.query(
    `SELECT * FROM cash_register_logs WHERE type = 'close' AND created_at > $1 ORDER BY created_at ASC LIMIT 1`,
    [lastOpen.created_at]
  );
  const lastClose = closeLogs[0] || null;

  if (lastClose) {
    return res.status(403).json({ error: "Register is closed. Cannot place order." });
  }
  // --- END REGISTER CHECK ---

  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;

  const client = await pool.connect();
  try {
    const {
      table_number,
      total,
      items = [],
      order_type,          // 'table' | 'phone' | 'packet' ...
      customer_name,
      customer_phone,
      customer_address,
      payment_method,
    } = req.body;

    // When coming from a QR table token, lock the table_number to the token
    let effectiveTableNumber = table_number || null;
    if (req.qrTable && order_type === "table") {
      const tokenTable = Number(req.qrTable.table_number);
      if (!Number.isFinite(tokenTable) || tokenTable <= 0) {
        return res.status(403).json({ error: "Invalid table in QR token" });
      }
      if (
        effectiveTableNumber !== null &&
        Number(effectiveTableNumber) !== tokenTable
      ) {
        return res
          .status(403)
          .json({ error: "QR token does not match requested table" });
      }
      effectiveTableNumber = tokenTable;
    }

    // Normalize pickup_time to a full timestamp string if only HH:MM is provided
    function normalizePickupTime(v) {
      if (!v) return null;
      const s = String(v).trim();
      try {
        // If only HH:MM or HH:MM:SS is provided, attach today's date
        if (/^\d{1,2}:\d{2}$/.test(s) || /^\d{1,2}:\d{2}:\d{2}$/.test(s)) {
          const now = new Date();
          const parts = s.split(":").map((x) => parseInt(x, 10));
          const hh = parts[0] || 0;
          const mm = parts[1] || 0;
          const ss = parts[2] || 0;
          const dt = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            hh,
            mm,
            ss,
            0
          );
          // Format as "YYYY-MM-DD HH:MM:SS" which Postgres TIMESTAMP accepts
          const pad = (n) => String(n).padStart(2, "0");
          const ts = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
          return ts;
        }
        // If it's a date/time-like string, try to keep it as-is
        if (/\d{4}-\d{2}-\d{2}.*\d{2}:\d{2}/.test(s)) return s;
        // Last resort: try Date parsing
        const d = new Date(s);
        if (!isNaN(d)) {
          const pad = (n) => String(n).padStart(2, "0");
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        }
      } catch (_) {
        // ignore and fall through
      }
      return s;
    }

    const pickupTimeRaw = req.body.pickup_time ?? req.body.pickupTime ?? null;
    const pickupTime = normalizePickupTime(pickupTimeRaw);
    const takeawayNotes =
      req.body.takeaway_notes ??
      req.body.notes ??
      req.body.takeawayNotes ??
      null;

    console.log("ORDER TYPE from payload:", order_type);
    const includeTakeawayFields = await ensureTakeawayFields();
    const hasCreatedByColumn = await hasOrdersCreatedByColumn();
    await client.query("BEGIN");

    const hasItems = Array.isArray(items) && items.length > 0;
    // Default to confirmed so tables remain actionable even before items are added
    const initialStatus = "confirmed";

    let createdBy = null;
    if (hasCreatedByColumn && req.user?.id) {
      const staffCreator = await pool.query(
        `SELECT id FROM staff WHERE restaurant_id = $1 AND id = $2 LIMIT 1`,
        [restaurantId, req.user.id]
      );
      if (staffCreator.rowCount) {
        createdBy = req.user.id;
      }
    }

    // 📍 Geocode customer delivery address if provided
    let deliveryLat = null;
    let deliveryLng = null;
    if (customer_address && (order_type === 'packet' || order_type === 'phone')) {
      try {
        console.log(`🌍 Attempting to geocode delivery address: "${customer_address}"`);
        
        const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
        if (GOOGLE_API_KEY) {
          const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
            customer_address + ', Turkey'
          )}&key=${GOOGLE_API_KEY}`;
          
          console.log(`📡 Google Maps geocoding request for: ${customer_address}`);
          const geocodeResponse = await fetch(geocodeUrl);
          const geocodeData = await geocodeResponse.json();
          
          console.log(`📊 Google Maps response status: ${geocodeData.status}`);
          
          if (geocodeData.status === 'OK' && geocodeData.results[0]) {
            deliveryLat = geocodeData.results[0].geometry.location.lat;
            deliveryLng = geocodeData.results[0].geometry.location.lng;
            console.log(`✅ Geocoded via Google Maps: ${customer_address} → (${deliveryLat}, ${deliveryLng})`);
          } else {
            console.warn(`⚠️ Google Maps geocoding failed (${geocodeData.status}). Trying Nominatim fallback...`);
            // Fallback to Nominatim
            const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
              customer_address + ', Turkey'
            )}&format=json&limit=1`;
            
            const nominatimResponse = await fetch(nominatimUrl, {
              headers: { 'User-Agent': 'HurryPOS-Backend' }
            });
            const nominatimData = await nominatimResponse.json();
            
            if (nominatimData && nominatimData.length > 0) {
              deliveryLat = parseFloat(nominatimData[0].lat);
              deliveryLng = parseFloat(nominatimData[0].lon);
              console.log(`✅ Geocoded via Nominatim: ${customer_address} → (${deliveryLat}, ${deliveryLng})`);
            } else {
              console.warn(`⚠️ Nominatim also failed for: ${customer_address}`);
            }
          }
        } else {
          console.warn('⚠️ GOOGLE_MAPS_API_KEY not set. Trying Nominatim...');
          // Use Nominatim as default
          const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
            customer_address + ', Turkey'
          )}&format=json&limit=1`;
          
          const nominatimResponse = await fetch(nominatimUrl, {
            headers: { 'User-Agent': 'HurryPOS-Backend' }
          });
          const nominatimData = await nominatimResponse.json();
          
          if (nominatimData && nominatimData.length > 0) {
            deliveryLat = parseFloat(nominatimData[0].lat);
            deliveryLng = parseFloat(nominatimData[0].lon);
            console.log(`✅ Geocoded via Nominatim: ${customer_address} → (${deliveryLat}, ${deliveryLng})`);
          } else {
            console.warn(`⚠️ Nominatim failed for: ${customer_address}`);
          }
        }
      } catch (err) {
        console.error('❌ Geocoding error:', err.message);
      }
    }
    
    console.log(`📍 FINAL DELIVERY COORDS FOR ORDER: lat=${deliveryLat}, lng=${deliveryLng}`);
    
    // 📍 Get restaurant pickup coordinates
    let pickupLat = null;
    let pickupLng = null;
    try {
      const restaurantCoords = await pool.query(
        'SELECT pos_location_lat, pos_location_lng FROM restaurants WHERE id = $1',
        [restaurantId]
      );
      if (restaurantCoords.rows[0]) {
        pickupLat = restaurantCoords.rows[0].pos_location_lat;
        pickupLng = restaurantCoords.rows[0].pos_location_lng;
      }
    } catch (err) {
      console.warn('⚠️ Failed to fetch restaurant coordinates:', err.message);
    }

    const insertColumns = [
      "restaurant_id",
      "table_number",
      "status",
      "total",
      "order_type",
      "customer_name",
      "customer_phone",
      "customer_address",
      "payment_method",
      "pickup_lat",
      "pickup_lng",
      "delivery_lat",
      "delivery_lng",
    ];
    const insertValues = [
      restaurantId,
      effectiveTableNumber || null,
      initialStatus,
      total,
      order_type || null,
      customer_name || null,
      customer_phone || null,
      customer_address || null,
      payment_method || null,
      pickupLat,
      pickupLng,
      deliveryLat,
      deliveryLng,
    ];

    if (includeTakeawayFields) {
      insertColumns.push("pickup_time", "takeaway_notes");
      insertValues.push(pickupTime, takeawayNotes);
    }

    if (hasCreatedByColumn) {
      insertColumns.push("created_by");
      insertValues.push(createdBy);
    }

    const placeholders = insertColumns.map((_, idx) => `$${idx + 1}`).join(", ");
    const orderInsertQuery = `
      INSERT INTO orders (${insertColumns.join(", ")})
      VALUES (${placeholders})
      RETURNING *
    `;

const orderResult = await client.query(orderInsertQuery, insertValues);

const order = orderResult.rows[0];

// ✅ Immediately persist customer + address (so it shows on frontend top bar)
if (customer_phone && customer_address) {
  // ---- Safe insert: only if phone not found for this restaurant ----
  const existingCustomer = await pool.query(
    `SELECT id FROM customers WHERE phone = $1 AND restaurant_id = $2 LIMIT 1`,
    [customer_phone, restaurantId]
  );

  let customerId;
  if (existingCustomer.rowCount === 0) {
    const inserted = await pool.query(
      `INSERT INTO customers (restaurant_id, name, phone)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [restaurantId, customer_name || 'Customer', customer_phone]
    );
    customerId = inserted.rows[0].id;
  } else {
    customerId = existingCustomer.rows[0].id;
  }

  // ---- Safe insert address (idempotent) ----
  await pool.query(
    `
    INSERT INTO customer_addresses (customer_id, address, is_default, restaurant_id)
    VALUES ($1, $2, true, $3)
    ON CONFLICT (customer_id, address)
    DO UPDATE SET is_default = EXCLUDED.is_default
    `,
    [customerId, customer_address, restaurantId]
  );
}

    // DEBUG
    dlog("POST /orders created", {
      id: order.id,
      order_type,
      table_number: effectiveTableNumber,
      total,
    });
    touch(order.id, "POST /orders create");

    if (hasItems) {
      await saveOrderItems(order.id, items);
      await updateStockForOrder(items, restaurantId);
      dlog("POST /orders saved items", { id: order.id, count: items.length });
    }

   await client.query("COMMIT");
touch(order.id, "POST /orders create+commit");

// ✅ Immediately notify this restaurant that a new order exists (so frontend refreshes instantly)
io.to(`restaurant_${restaurantId}`).emit("orders_updated");

if (typeof emitOrderUpdate === "function") emitOrderUpdate(io, restaurantId);

    // 🔥 If the order was created WITH items, emit a full payload for auto-print
    if (hasItems) {
      try {
        const { rows: orderRows } = await pool.query(
          `SELECT id, status, table_number, order_type, total, created_at
           FROM orders
           WHERE restaurant_id = $1 AND id = $2`,
          [restaurantId, order.id]
        );

        if (orderRows.length) {
          const { rows: itemRows } = await pool.query(
            `SELECT
               oi.product_id,
               oi.unique_id,
               oi.name AS order_item_name,
               p.name  AS product_name,
               oi.quantity,
               oi.price,
               oi.extras,
               oi.note,
               oi.kitchen_status,
               oi.paid_at
             FROM order_items oi
             LEFT JOIN products p ON oi.product_id = p.id
             WHERE oi.order_id = $1
             ORDER BY oi.id ASC`,
            [order.id]
          );

          const payloadItems = itemRows.map((it) => ({
            ...it,
            name: it.order_item_name || it.product_name || "Item",
            extras:
              typeof it.extras === "string"
                ? (() => {
                    try { return JSON.parse(it.extras); } catch { return []; }
                  })()
                : (it.extras || []),
            total: (parseFloat(it.price) || 0) * (it.quantity || 1),
          }));

          const header = orderRows[0];
          const payload = {
            id: header.id,
            order_number: header.order_number ?? undefined,
            number: header.order_number ?? undefined,
            order: {
              id: header.id,
              status: header.status,
              table_number: header.table_number,
              order_type: header.order_type,
              total: header.total,
              created_at: header.created_at,
              items: payloadItems,
            },
          };

          // ✅ tenant-safe emit to correct restaurant room
          io.to(`restaurant_${restaurantId}`).emit("order_confirmed", payload);
          console.log(`🖨️ [orders] order_confirmed emitted for restaurant_${restaurantId}:`, header.id);
        }
      } catch (e) {
        console.error("❌ Failed to emit order_confirmed from POST /orders:", e);
      }
    }

    return res.json(order);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Error creating order:", err);
    res.status(500).json({ error: "Database error" });
  } finally {
    client.release();
  }
});




// PUT /orders/:id/pay - Update payment info and insert a payment record
router.put("/:id/pay", async (req, res) => {
  const { id } = req.params;
  const { payment_method, total, amount, item_ids } = req.body;
  const orderId = parseInt(id, 10);
  const restaurantId = req.user.restaurant_id;

  const client = await pool.connect();
  try {
    await ensureOrderDebtTracking();
    await client.query("BEGIN");

    const hasCreatedByColumn = await hasOrdersCreatedByColumn();

    const { rows: orderRows } = await client.query(
      `SELECT
         total,
         is_paid,
         customer_name,
         customer_phone,
         COALESCE(debt_recorded_total, 0) AS debt_recorded_total
       FROM orders
      WHERE restaurant_id = $1 AND id = $2
      FOR UPDATE`,
      [restaurantId, orderId]
    );
    if (!orderRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }
    const existingOrder = orderRows[0];

    const finalOrderTotal =
      total !== undefined && total !== null ? total : existingOrder.total;
    const paymentValue =
      amount !== undefined && amount !== null ? amount : finalOrderTotal;
    const amountPaid = toMoney(paymentValue);
    const recorded = toMoney(existingOrder.debt_recorded_total);
    const debtReduction =
      recorded > 0 && amountPaid > 0 ? Math.min(recorded, amountPaid) : 0;
    const nextRecordedTotal = Math.max(recorded - debtReduction, 0);
    const paidOff =
      nextRecordedTotal === 0 &&
      (recorded > 0
        ? amountPaid >= recorded
        : amountPaid >= toMoney(finalOrderTotal));

    const markDebtPaid = debtReduction > 0;

    // 1️⃣ Insert payment
    const paymentResult = await client.query(
      `INSERT INTO payments (order_id, amount, payment_method)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [orderId, amountPaid, payment_method]
    );

    // 2️⃣ Update order
    const orderResult = await client.query(
      `UPDATE orders
          SET payment_method = $1,
              total = $2,
              is_paid = $6,
              debt_recorded_total = $5,
              debt_paid_at = CASE WHEN $7 THEN NOW() ELSE debt_paid_at END
        WHERE restaurant_id = $3 AND id = $4
        RETURNING *`,
      [
        payment_method,
        finalOrderTotal,
        restaurantId,
        orderId,
        nextRecordedTotal,
        paidOff,
        markDebtPaid && nextRecordedTotal === 0,
      ]
    );

    // 3️⃣ Mark selected items as paid (or all unpaid if item_ids not provided)
    if (Array.isArray(item_ids) && item_ids.length > 0) {
      // Partial payment: mark only selected items
      const itemIds = item_ids.map(id => parseInt(id, 10)).filter(id => Number.isFinite(id));
      if (itemIds.length > 0) {
        await client.query(
          `UPDATE order_items
           SET paid_at = NOW(),
               confirmed = true
           WHERE order_id = $1 AND id = ANY($2)`,
          [orderId, itemIds]
        );
      }
    } else {
      // Full payment: mark all unpaid items
      await client.query(
        `UPDATE order_items
         SET paid_at = NOW(),
             confirmed = true
         WHERE order_id = $1 AND paid_at IS NULL`,
        [orderId]
      );
    }

    if (debtReduction > 0 && existingOrder.customer_phone) {
      await decreaseCustomerDebt(
        client,
        restaurantId,
        { phone: existingOrder.customer_phone },
        debtReduction
      );
    }

    const kitchenCheck = await client.query(
      `SELECT id, product_id, kitchen_status, paid_at
       FROM order_items
       WHERE order_id = $1`,
      [orderId]
    );

    console.log("🔍 Kitchen status after PAY:", kitchenCheck.rows);

    await client.query("COMMIT");

    if (typeof emitOrderUpdate === "function") emitOrderUpdate(io, restaurantId);
    else io.to(`restaurant_${restaurantId}`).emit("orders_updated");

    emitPaymentMade(io, restaurantId, orderId, payment_method, total);

    console.log(`💸 [orders] payment_made emitted for restaurant_${restaurantId}, order ${orderId}`);

    res.json({
      order: orderResult.rows[0],
      payment: paymentResult.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to update payment info:", err);
    res.status(500).json({ error: "Failed to mark order as paid" });
  } finally {
    client.release();
  }
});



router.put("/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status, total, payment_method, payment_status } = req.body; // ✅ added payment_status
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;
  const client = await pool.connect();

  try {
    await ensureOrderDebtTracking();
    await client.query("BEGIN");

    const { rows: existingRows } = await client.query(
      `SELECT
         total,
         is_paid,
         customer_phone,
         table_number,
         payment_method AS current_payment_method,
         COALESCE(debt_recorded_total, 0) AS debt_recorded_total
       FROM orders
      WHERE id = $1 AND restaurant_id = $2
      FOR UPDATE`,
      [id, restaurantId]
    );
    if (!existingRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }
    const existingOrder = existingRows[0];

    // In table QR mode, only allow status changes for the matching table
    if (req.qrTable) {
      const tokenTable = Number(req.qrTable.table_number);
      const orderTable = Number(existingOrder.table_number || 0);
      if (
        !Number.isFinite(tokenTable) ||
        !Number.isFinite(orderTable) ||
        tokenTable !== orderTable
      ) {
        await client.query("ROLLBACK");
        return res
          .status(403)
          .json({ error: "QR token does not match this table" });
      }
    }

    const result = await client.query(
      `UPDATE orders
       SET
         status = COALESCE($1, status),
         total = COALESCE($2, total),
         payment_method = COALESCE($3, payment_method),
         payment_status = COALESCE($4, payment_status),       -- ✅ added this
         is_paid = CASE
                     WHEN $1 = 'paid' OR $4 = 'paid' THEN true  -- ✅ support both status or payment_status
                     WHEN $1 IN ('confirmed') THEN false
                     ELSE is_paid
                   END
       WHERE id = $5 AND restaurant_id = $6
       RETURNING *`,
      [status, total, payment_method, payment_status, id, restaurantId]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    const updatedOrder = result.rows[0];
    const becamePaid = updatedOrder.is_paid && !existingOrder.is_paid;

    // ✅ If payment_method changed, insert a record tracking the change
    if (payment_method && payment_method !== existingOrder.current_payment_method) {
      console.log(`💾 Payment changed from "${existingOrder.current_payment_method}" to "${payment_method}"`);
      try {
        await client.query(
          `INSERT INTO payments (order_id, payment_method, previous_payment_method, amount, created_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT DO NOTHING`,
          [id, payment_method, existingOrder.current_payment_method, 0]
        );
      } catch (paymentErr) {
        console.warn("⚠️  Could not insert payment change record:", paymentErr.message);
        // Don't fail the whole transaction if this fails
      }
    }

    if (becamePaid) {
      // ✅ Also mark all existing order_items as paid for this order
      try {
        await client.query(
          `UPDATE order_items
             SET paid_at = NOW(),
                 confirmed = TRUE
           WHERE order_id = $1 AND paid_at IS NULL`,
          [id]
        );
      } catch (markErr) {
        console.warn("⚠️ Failed to mark order_items paid in /orders/:id/status:", markErr);
      }

      const recorded = toMoney(existingOrder.debt_recorded_total);
      const amountReference = toMoney(
        total !== undefined && total !== null ? total : existingOrder.total
      );
      let reduction =
        recorded > 0
          ? amountReference > 0
            ? Math.min(recorded, amountReference)
            : recorded
          : 0;
      let nextRecorded = Math.max(recorded - reduction, 0);
      if (nextRecorded > 0 && recorded > 0) {
        reduction = recorded;
        nextRecorded = 0;
      }

      if (recorded > 0) {
        await client.query(
          `UPDATE orders
              SET debt_recorded_total = $1
            WHERE id = $2 AND restaurant_id = $3`,
          [nextRecorded, id, restaurantId]
        );
      }

      if (reduction > 0 && existingOrder.customer_phone) {
        await decreaseCustomerDebt(
          client,
          restaurantId,
          { phone: existingOrder.customer_phone },
          reduction
        );
      }

      if (reduction > 0) {
        await client.query(
          `UPDATE orders
              SET debt_paid_at = NOW()
            WHERE id = $1 AND restaurant_id = $2`,
          [id, restaurantId]
        );
      }
    }

    await client.query("COMMIT");

    io.to(`restaurant_${restaurantId}`).emit("orders_updated");
    res.json(updatedOrder);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to update order status:", err);
    res.status(500).json({ error: "Failed to update order status" });
  } finally {
    client.release();
  }
});



// GET /api/driver-report?driver_id=1&date=YYYY-MM-DD
router.get("/driver-report", async (req, res) => {
  const { driver_id, date } = req.query;
  if (!driver_id || !date) {
    return res.status(400).json({ error: "driver_id and date are required" });
  }

  try {
    // 👇 Add customer_name, customer_address to SELECT
    const ordersRes = await pool.query(`
      SELECT
        id, payment_method, status, driver_status,
        created_at, picked_up_at, delivered_at, kitchen_delivered_at,
        customer_name, customer_address
      FROM orders
      WHERE driver_id = $1
        AND DATE(delivered_at) = $2
        AND driver_status = 'delivered'
        AND status = 'closed'
      ORDER BY delivered_at ASC
    `, [driver_id, date]);
    const orders = ordersRes.rows;

    let total_sales = 0;
    const sales_by_method = {};
    const order_details = [];
    for (const order of orders) {
      const { rows: items } = await pool.query(
        "SELECT price, quantity FROM order_items WHERE order_id = $1",
        [order.id]
      );
      const orderTotal = items.reduce((sum, i) => sum + parseFloat(i.price) * i.quantity, 0);
      total_sales += orderTotal;
      order_details.push({
        ...order,
        total: orderTotal,
        delivery_time_seconds:
          order.picked_up_at && order.delivered_at
            ? (new Date(order.delivered_at) - new Date(order.picked_up_at)) / 1000
            : null,
        kitchen_to_delivery_seconds:
          order.kitchen_delivered_at && order.delivered_at
            ? (new Date(order.delivered_at) - new Date(order.kitchen_delivered_at)) / 1000
            : null,
      });
      if (order.payment_method) {
        sales_by_method[order.payment_method] = (sales_by_method[order.payment_method] || 0) + orderTotal;
      }
    }

    res.json({
      packets_delivered: orders.length,
      total_sales,
      sales_by_method,
      orders: order_details,
    });
  } catch (err) {
    console.error("❌ Error in /driver-report:", err);
    res.status(500).json({ error: "DB error" });
  }
});

router.get("/debt/find", async (req, res) => {
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;
  const phone = (req.query.phone || req.query.customer_phone || "").trim();
  if (!phone) {
    return res.status(400).json({ error: "customer_phone is required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT
          id,
          table_number,
          status,
          total,
          order_type,
          created_at,
          updated_at,
          customer_name,
          customer_phone,
          COALESCE(debt_recorded_total, 0) AS debt_recorded_total
         FROM orders
        WHERE restaurant_id = $1
          AND customer_phone = $2
          AND status = 'closed'
          AND COALESCE(is_paid, false) = false
          AND COALESCE(debt_recorded_total, 0) > 0
        ORDER BY updated_at DESC NULLS LAST, id DESC`,
      [restaurantId, phone]
    );
    if (!rows.length) return res.json({ orders: [], total_debt: 0 });
    const normalized = rows.map((row) => ({
      ...row,
      debt_recorded_total: Number(row.debt_recorded_total || 0),
    }));
    const totalDebt = normalized.reduce(
      (sum, order) => sum + (order.debt_recorded_total || 0),
      0
    );
    res.json({ orders: normalized, total_debt: totalDebt });
  } catch (err) {
    console.error("❌ Failed to find debt order:", err);
    res.status(500).json({ error: "Failed to find debt order" });
  }
});


// POST order items (with upsert for existing items)
router.post("/order-items", async (req, res) => {
  const { order_id, items, receipt_id } = req.body;
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;

  // If this request comes from a table QR token, make sure the order
  // really belongs to that table in this restaurant.
  if (req.qrTable) {
    try {
      const { rows } = await pool.query(
        `SELECT table_number
         FROM orders
         WHERE id = $1 AND restaurant_id = $2`,
        [order_id, restaurantId]
      );
      const dbTable = rows.length
        ? Number(rows[0].table_number || 0)
        : null;
      const tokenTable = Number(req.qrTable.table_number);
      if (!rows.length || !Number.isFinite(dbTable)) {
        return res.status(404).json({ error: "Order not found" });
      }
      if (!Number.isFinite(tokenTable) || dbTable !== tokenTable) {
        return res
          .status(403)
          .json({ error: "QR token does not match this table" });
      }
    } catch (err) {
      console.error(
        "❌ Failed to verify table ownership for /orders/order-items:",
        err
      );
      return res
        .status(500)
        .json({ error: "Failed to verify table ownership" });
    }
  }

  const preparedItems = items.map((item, idx) => {

    return {
      ...item,
      receipt_id: item.receipt_id || receipt_id || null,
      kitchen_status: item.confirmed && !item.paid_at ? 'new' : item.kitchen_status || null // ✅ only if confirmed and not yet paid
    };
  });

  try {
    await saveOrderItems(order_id, preparedItems);
    await updateStockForOrder(preparedItems, restaurantId);
     // --- ADD THIS BLOCK:
const orderRes = await pool.query(
  "SELECT status FROM orders WHERE restaurant_id = $1 AND id = $2",
  [restaurantId, order_id]
);
const currentStatus = String(orderRes.rows[0]?.status || '').toLowerCase();
if (["closed", "pending", "open"].includes(currentStatus)) {
  await pool.query(
    "UPDATE orders SET status = 'confirmed' WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, order_id]
  );
}

// --- Ensure all items and stock updates are fully written before any emit ---
await new Promise(resolve => setTimeout(resolve, 250)); // short wait ensures DB visibility

// ✅ Build payload after all commits — full and fresh
try {
  const payload = await buildFullOrderPayload(order_id, restaurantId);

  // emit both updates and confirmation together
  io.to(`restaurant_${restaurantId}`).emit("order_confirmed", payload);
  io.to(`restaurant_${restaurantId}`).emit("orders_updated");

  console.log(
    `🖨️ [orders] order_confirmed+updated emitted after saveOrderItems for restaurant_${restaurantId}, order ${order_id}`
  );
} catch (e) {
  console.error("❌ Failed to emit order_confirmed after /order-items:", e);
}

res.json({ message: "Order items saved successfully" });



  } catch (err) {
    console.error("❌ Error saving order items:", err);
    res.status(500).json({ error: "Failed to save order items" });
  }
});

router.get("/:id/payments", async (req, res) => {
  const { id } = req.params;
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;
  try {
    const { rows } = await pool.query(
      `SELECT
          p.id,
          p.amount,
          p.payment_method,
          p.previous_payment_method,
          p.created_at
       FROM payments p
       JOIN orders o ON o.id = p.order_id
      WHERE p.order_id = $1
        AND o.restaurant_id = $2
      ORDER BY p.created_at ASC`,
      [id, restaurantId]
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ Failed to fetch order payments:", err);
    res.status(500).json({ error: "Failed to fetch order payments" });
  }
});


async function saveOrderItems(orderId, items) {
  for (const item of items) {
    const extrasString = JSON.stringify(item.extras || []);
    const unique_id = item.unique_id || uuidv4();

    // ensure inserts finish before continuing
    const existing = await pool.query(
      "SELECT id FROM order_items WHERE unique_id = $1 AND order_id = $2",
      [unique_id, orderId]
    );

    if (existing.rowCount > 0) {
      await pool.query(
        "UPDATE order_items SET discount_type=$1, discount_value=$2, price=$3, quantity=$4 WHERE id=$5",
        [
          item.discountType || null,
          item.discountValue || 0,
          parseFloat(item.price) || 0,
          item.quantity || 1,
          existing.rows[0].id,
        ]
      );
      continue;
    }

    // ✅ Await each insert fully
    await pool.query(
      `INSERT INTO order_items (
        order_id, product_id, quantity, price,
        ingredients, extras, unique_id,
        confirmed, kitchen_status, payment_method, receipt_id, note,
        discount_type, discount_value,
        external_product_id, external_product_name, name
      )
      VALUES (
        $1,$2,$3,$4,
        $5::jsonb,$6::jsonb,$7,
        $8,$9,$10,$11,$12,
        $13,$14,
        $15,$16,$17
      )`,
      [
        orderId,
        Number(item.product_id) || null,
        item.quantity || 1,
        parseFloat(item.price) || 0,
        JSON.stringify(item.ingredients || []),
        extrasString,
        unique_id,
        true,
        item.kitchen_status || "new",
        item.payment_method || null,
        item.receipt_id || null,
        item.note || null,
        item.discountType || null,
        item.discountValue || 0,
        item.product_id || null,
        item.name || null,
        item.name || null,
      ]
    );
  }

  // ✅ Force DB commit visibility delay
  await new Promise((resolve) => setTimeout(resolve, 300));
}


// GET /order-items/preparing - Returns IDs of order_items still preparing
router.get("/order-items/preparing", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM order_items WHERE kitchen_status = 'preparing'`
    );
    // Return just the IDs as an array of numbers
    res.json(rows.map(r => r.id));
  } catch (err) {
    console.error("❌ Error in /order-items/preparing:", err);
    res.status(500).json({ error: "Failed to fetch preparing items" });
  }
});


router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { total, payment_method, driver_id, receipt_id, changed_by } = req.body;

  let _payment_method = payment_method;

  // --- Normalize payment_method safely ---
  if (_payment_method && Array.isArray(_payment_method)) {
    _payment_method =
      _payment_method[0]?.payment_method ||
      _payment_method[0] ||
      null;
  } else if (
    _payment_method &&
    typeof _payment_method === "object" &&
    _payment_method !== null
  ) {
    _payment_method = _payment_method.payment_method || null;
  }

  // Always cast to string if defined
  if (_payment_method !== null && _payment_method !== undefined) {
    _payment_method = String(_payment_method).trim();
  }

  try {
    // 1️⃣ Get current payment_method for change log
    let old_method;
    let old_driver_id;
    if (payment_method !== undefined || driver_id !== undefined) {
      const oldOrder = await pool.query(
        "SELECT payment_method, driver_id FROM orders WHERE restaurant_id = $1 AND id = $2",
        [req.user.restaurant_id, id]
      );
      old_method = oldOrder.rows[0]?.payment_method;
      old_driver_id = oldOrder.rows[0]?.driver_id;
    }

    // 2️⃣ Build SET clause dynamically
    let setClauses = [];
    let params = [];
    let idx = 1;

    if (total !== undefined) {
      setClauses.push(`total = $${idx++}`);
      params.push(total);
    }

    if (_payment_method) {
      setClauses.push(`payment_method = $${idx++}::text`);
      params.push(_payment_method);
    }

    if (driver_id !== undefined) {
      setClauses.push(`driver_id = $${idx++}`);
      params.push(driver_id);
    }

    if (receipt_id !== undefined) {
      setClauses.push(`receipt_id = $${idx++}`);
      params.push(receipt_id);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    // 3️⃣ Add restaurant_id + id at end
   // 3️⃣ Add restaurant_id and id at the END, not start
params.push(req.user.restaurant_id); // now this will always be the last -1 param
params.push(id);                     // and this will be the last param index

// Calculate actual indexes properly
const restaurantIdx = params.length - 1;
const idIdx = params.length;

const result = await pool.query(
  `UPDATE orders
   SET ${setClauses.join(", ")}
   WHERE restaurant_id = $${restaurantIdx} AND id = $${idIdx}
   RETURNING *`,
  params
);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    const updatedOrder = result.rows[0];

    // 5️⃣ Log payment change (optional)
    if (
      _payment_method !== undefined &&
      old_method !== undefined &&
      _payment_method !== old_method
    ) {
      await pool.query(
        `INSERT INTO payment_method_changes (order_id, old_method, new_method, changed_by)
         VALUES ($1, $2, $3, $4)`,
        [id, old_method, _payment_method, changed_by || "system"]
      );
    }

    // 6️⃣ Emit update to frontend
    setTimeout(() => emitOrderUpdate(req.app.get("io")), 250);

    if (
      driver_id !== undefined &&
      Number(old_driver_id || 0) !== Number(updatedOrder.driver_id || 0) &&
      updatedOrder.driver_id
    ) {
      let driverName = null;
      try {
        const driverRes = await pool.query(
          "SELECT name, full_name, fullName FROM staff WHERE id = $1",
          [updatedOrder.driver_id]
        );
        const row = driverRes.rows[0];
        driverName =
          row?.name || row?.full_name || row?.fullname || row?.fullName || null;
      } catch (err) {
        console.warn("⚠️ Failed to fetch driver name for notification:", err);
      }

      const ioRef = req.app.get("io");
      if (ioRef) {
        const payload = {
          driverId: updatedOrder.driver_id,
          driverName,
        };
        emitDriverAssigned(ioRef, req.user.restaurant_id, updatedOrder.id, payload);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Failed to update order:", err);
    res.status(500).json({ error: "Update failed" });
  }
});




// POST /orders/:id/close
router.post("/:id/close", async (req, res) => {
  const { id } = req.params;
  const restaurantId = req.user.restaurant_id;
  const client = await pool.connect();
  try {
    await ensureOrderDebtTracking();
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT
         id,
         status,
         total,
         is_paid,
         table_number,
         customer_name,
         customer_phone,
         kitchen_delivered_at,
         COALESCE(debt_recorded_total, 0) AS debt_recorded_total
       FROM orders
      WHERE restaurant_id = $1 AND id = $2
      FOR UPDATE`,
      [restaurantId, id]
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    const existing = rows[0];
    if (existing.status === "closed") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Order already closed" });
    }

    // Check if kitchen has delivered the order. If the order-level flag isn't set,
    // fall back to item-level kitchen_status (some setups mark items but not order flag).
    let kitchenDelivered = Boolean(existing.kitchen_delivered_at);
    console.log(`🔍 [Order ${id}] Order-level kitchen_delivered_at: ${existing.kitchen_delivered_at} (delivered=${kitchenDelivered})`);
    
    if (!kitchenDelivered) {
      try {
        const itemsRes = await client.query(
          `SELECT id, kitchen_status FROM order_items WHERE order_id = $1 AND restaurant_id = $2`,
          [id, restaurantId]
        );
        const items = itemsRes.rows || [];
        console.log(`🍽️ [Order ${id}] Found ${items.length} items:`, items.map(it => ({ id: it.id, kitchen_status: it.kitchen_status })));
        
        // If there are NO items, allow close (empty order or items not tracked)
        if (items.length === 0) {
          console.log(`✅ [Order ${id}] No items found - allowing close`);
          kitchenDelivered = true;
        } else if (items.length > 0) {
          const allReady = items.every((it) => {
            const s = (it.kitchen_status || "").toString().toLowerCase();
            const ready = s === "delivered" || s === "ready";
            console.log(`   - Item ${it.id}: status="${it.kitchen_status}" → normalized="${s}" → ready=${ready}`);
            return ready;
          });
          console.log(`✅ [Order ${id}] All items ready? ${allReady}`);
          if (allReady) kitchenDelivered = true;
        }
      } catch (err) {
        // If item-level check fails, fall back to strict order flag behavior
        console.error("⚠️ Failed to read order items while checking kitchen delivery:", err);
      }
    }

    if (!kitchenDelivered) {
      await client.query("ROLLBACK");
      console.log(`❌ [Order ${id}] Kitchen NOT delivered. Rejecting close.`);
      return res.status(409).json({ error: "Order still preparing. Kitchen must deliver first!" });
    }
    console.log(`✅ [Order ${id}] Kitchen delivered. Proceeding with close.`);

    const totalNow = toMoney(existing.total);
    const recorded = toMoney(existing.debt_recorded_total);
    const delta = existing.is_paid ? 0 : toMoney(totalNow - recorded);
    const needsDebtAdjustment = delta !== 0 && !existing.is_paid;

    if (needsDebtAdjustment) {
      const phoneOk = (existing.customer_phone || "").trim();
      if (!phoneOk) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Customer phone is required before closing an unpaid order.",
        });
      }
      if (delta > 0) {
        const nameOk = (existing.customer_name || "").trim();
        if (!nameOk) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Customer name is required before adding unpaid debt.",
          });
        }
      }
    }

    const updated = await client.query(
      `UPDATE orders
          SET status = 'closed',
              debt_recorded_total = $3
        WHERE restaurant_id = $1 AND id = $2
        RETURNING *`,
      [restaurantId, id, existing.is_paid ? recorded : totalNow]
    );

    const order = updated.rows[0];

    if (needsDebtAdjustment) {
      if (delta > 0) {
        await increaseCustomerDebt(
          client,
          restaurantId,
          { name: existing.customer_name, phone: existing.customer_phone },
          delta
        );
      } else if (delta < 0) {
        await decreaseCustomerDebt(
          client,
          restaurantId,
          { phone: existing.customer_phone },
          Math.abs(delta)
        );
      }
    }

    await client.query("COMMIT");

    io.to(`restaurant_${restaurantId}`).emit("order_closed", { orderId: Number(order.id) });
    res.json({
      message: needsDebtAdjustment
        ? delta > 0
          ? "✅ Order closed and debt recorded"
          : "✅ Order closed and debt adjusted"
        : "✅ Order closed",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Error in closing order:", err);
    res.status(500).json({ error: "Failed to close order" });
  } finally {
    client.release();
  }
});

router.patch("/:id/cancel", async (req, res) => {
  const { id } = req.params;
  const orderId = Number(id);
  if (!Number.isFinite(orderId)) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  const restaurantId = await requireRestaurantId(req);
  if (!restaurantId) return;

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  const partialItems = Array.from(
    new Set(
      rawItems
        .map((entry) => {
          if (entry === null || entry === undefined) return "";
          return typeof entry === "string" ? entry.trim() : String(entry).trim();
        })
        .filter(Boolean)
    )
  );

  if (partialItems.length > 0) {
    const hasFields = await ensureOrderItemCancellationFields();
    if (!hasFields) {
      return res.status(500).json({
        error: "Unable to prepare order item cancellation; contact your administrator.",
      });
    }

    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");

      const { rows: orderRows } = await client.query(
        `SELECT id, total, status
         FROM orders
         WHERE restaurant_id = $1 AND id = $2
         FOR UPDATE`,
        [restaurantId, orderId]
      );

      if (!orderRows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Order not found" });
      }

      if (orderRows[0].status === "cancelled") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Order already cancelled" });
      }

      const { rows: itemsRows } = await client.query(
        `SELECT id, unique_id, price, quantity
         FROM order_items
         WHERE order_id = $1
           AND unique_id = ANY($2::text[])
           AND cancelled_at IS NULL
         FOR UPDATE`,
        [orderId, partialItems]
      );

      if (!itemsRows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "No matching items found" });
      }

      const itemIds = itemsRows.map((item) => item.id);
      const totalReduction = itemsRows.reduce((sum, item) => {
        const price = toMoney(parseFloat(item.price) || 0);
        const qty = Number(item.quantity) || 0;
        return sum + price * qty;
      }, 0);
      const updatedTotal = Math.max(
        0,
        toMoney(orderRows[0].total || 0) - toMoney(totalReduction)
      );

      await client.query(
        `UPDATE order_items
           SET cancelled_at = NOW(),
               cancellation_reason = NULLIF($1, ''),
               kitchen_status = 'cancelled'
         WHERE id = ANY($2::int[])`,
        [reason, itemIds]
      );

      await client.query(
        `UPDATE orders
           SET total = $1
         WHERE restaurant_id = $2 AND id = $3`,
        [updatedTotal, restaurantId, orderId]
      );

      const { rows: remainingRows } = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM order_items
         WHERE order_id = $1
           AND cancelled_at IS NULL`,
        [orderId]
      );
      const remainingCount = Number(remainingRows[0]?.count ?? 0);
      let orderNowCancelled = false;

      if (remainingCount === 0) {
        await client.query(
          `UPDATE orders
             SET status = 'cancelled',
                 cancellation_reason = NULLIF($1, cancellation_reason),
                 cancelled_at = NOW()
           WHERE restaurant_id = $2 AND id = $3`,
          [reason, restaurantId, orderId]
        );
        orderNowCancelled = true;
      }

      await client.query("COMMIT");

      const ioRef = req.app.get("io");
      ioRef && ioRef.to(`restaurant_${restaurantId}`).emit("orders_updated");
      if (orderNowCancelled) {
        ioRef && ioRef.to(`restaurant_${restaurantId}`).emit("order_cancelled", { orderId });
      }

      return res.json({
        ok: true,
        partial: true,
        orderCancelled: orderNowCancelled,
        itemsCancelled: itemIds.length,
        remainingCount,
        newTotal: updatedTotal,
      });
    } catch (err) {
      if (client) await client.query("ROLLBACK");
      console.error("❌ Failed to cancel selected items:", err);
      return res.status(500).json({ error: "Failed to cancel selected items" });
    } finally {
      if (client) client.release();
    }
  }

  try {
    const { rows } = await pool.query(
      `UPDATE orders
         SET status = 'cancelled',
             cancellation_reason = NULLIF($1, ''),
             cancelled_at = NOW()
       WHERE restaurant_id = $2 AND id = $3 AND status <> 'cancelled'
       RETURNING id, table_number`,
      [reason, restaurantId, orderId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Order not found or already cancelled" });
    }

    const ioRef = req.app.get("io");
    ioRef && ioRef.to(`restaurant_${restaurantId}`).emit("order_cancelled", { orderId });
    return res.json({ ok: true, orderId, orderCancelled: true, partial: false });
  } catch (err) {
    console.error("❌ Failed to cancel order:", err);
    res.status(500).json({ error: "Failed to cancel order" });
  }
});

router.post("/:id/add-debt", async (req, res) => {
  const { id } = req.params;
  const restaurantId = req.user.restaurant_id;
  const client = await pool.connect();
  try {
    await ensureOrderDebtTracking();
    await client.query("BEGIN");

    const payload = req.body || {};
    const inputName = (payload.customer_name || "").trim();
    const inputPhone = (payload.customer_phone || "").trim();

    const { rows } = await client.query(
      `SELECT
         id,
         total,
         status,
         is_paid,
         table_number,
         customer_name,
         customer_phone,
         COALESCE(debt_recorded_total, 0) AS debt_recorded_total
       FROM orders
      WHERE restaurant_id = $1 AND id = $2
      FOR UPDATE`,
      [restaurantId, id]
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    const existing = rows[0];
    if (existing.is_paid) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Paid orders cannot be added to debt" });
    }

    let customerName = (existing.customer_name || "").trim();
    let customerPhone = (existing.customer_phone || "").trim();

    if (!customerName && inputName) customerName = inputName;
    if (!customerPhone && inputPhone) customerPhone = inputPhone;

    if (!customerPhone) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Customer phone is required to track debt" });
    }
    if (!customerName) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Customer name is required to track debt" });
    }

    const currentTotal = toMoney(existing.total);
    const recorded = toMoney(existing.debt_recorded_total);
    const requestedAmount = toMoney(payload.amount);
    let delta = currentTotal - recorded;
    if (requestedAmount > 0) {
      delta = requestedAmount;
    }

    if (delta <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No remaining balance to add to debt" });
    }

    await increaseCustomerDebt(
      client,
      restaurantId,
      { name: customerName, phone: customerPhone },
      delta
    );

    const newRecordedTotal = recorded + delta;
    const nextOrderTotal = Math.max(currentTotal, newRecordedTotal);
    const updateResult = await client.query(
      `UPDATE orders
          SET status = 'closed',
              is_paid = false,
              debt_recorded_total = $3,
              total = $4,
              customer_name = $5,
              customer_phone = $6,
              debt_paid_at = NULL
        WHERE restaurant_id = $1 AND id = $2
        RETURNING *`,
      [restaurantId, id, newRecordedTotal, nextOrderTotal, customerName, customerPhone]
    );

    const order = updateResult.rows[0];

    await client.query("COMMIT");

    io.to(`restaurant_${restaurantId}`).emit("order_closed", { orderId: Number(order.id) });

    res.json({
      message: "✅ Order amount added to customer debt",
      debt_added: delta,
      order,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to add order debt:", err);
    res.status(500).json({ error: "Failed to add order debt" });
  } finally {
    client.release();
  }
});



// Add to routes/orders.js or a debug file
router.get('/debug/order-item-discounts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, order_id, product_id, discount_type, discount_value
       FROM order_items
       WHERE discount_value IS NOT NULL AND discount_value > 0
       ORDER BY id DESC
       LIMIT 20`
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ Debug discount check failed:', err);
    res.status(500).json({ error: 'Failed to fetch discounted items' });
  }
});





// ✅ Update stock based on ingredients and extras
async function updateStockForOrder(orderItems, restaurantId) {
  console.log("🧾 Received order items:", orderItems);

  // Helper: resolve extras group amount/unit
  async function resolveExtraFromGroups(name) {
    const q = await pool.query(
      `SELECT amount, unit
       FROM extras_group_items
       WHERE LOWER(ingredient_name) = LOWER($1)
       ORDER BY id DESC
       LIMIT 1`,
      [name]
    );
    if (!q.rows.length) return null;
    const r = q.rows[0] || {};
    return { amount: Number(r.amount), unit: (r.unit || "").toLowerCase() };
  }

  // Helper: fallback unit from stock
  async function resolveUnitFromStock(name) {
    const q = await pool.query(
      `SELECT unit
       FROM stock
       WHERE restaurant_id = $1 AND LOWER(name) = LOWER($2)
       ORDER BY id DESC
       LIMIT 1`,
      [restaurantId, name]
    );
    if (!q.rows.length) return "";
    return (q.rows[0].unit || "").toLowerCase();
  }

  for (const item of orderItems) {
    const quantityMultiplier = parseInt(item.quantity) || 1;

    let ingredients = Array.isArray(item.ingredients)
      ? item.ingredients
      : JSON.parse(item.ingredients || "[]");

    const extras = Array.isArray(item.extras)
      ? item.extras
      : JSON.parse(item.extras || "[]");

    // 🚑 Fallback: fetch recipe ingredients from DB if none provided
    if ((!ingredients || ingredients.length === 0) && item.product_id) {
      try {
        const q = await pool.query(
          `SELECT ingredients
           FROM products
           WHERE restaurant_id = $1 AND id = $2`,
          [restaurantId, item.product_id]
        );
        if (q.rows[0]?.ingredients) {
          const parsed =
            typeof q.rows[0].ingredients === "string"
              ? JSON.parse(q.rows[0].ingredients)
              : q.rows[0].ingredients;
          if (Array.isArray(parsed)) {
            ingredients = parsed;
            console.log(`📦 Loaded ${parsed.length} ingredients for product_id=${item.product_id}`);
          }
        }
      } catch (e) {
        console.error("❌ Could not fetch fallback ingredients:", e);
      }
    }

    // 🔻 Deduct Ingredients
    for (const ing of ingredients) {
      let ingUnit = (ing.unit || "").toLowerCase();
      let amountPerUnit = parseFloat(ing.quantity) * quantityMultiplier;

      const stockRes = await pool.query(
        `SELECT id, unit
         FROM stock
         WHERE restaurant_id = $1 AND LOWER(name) = LOWER($2)
         LIMIT 1`,
        [restaurantId, ing.ingredient || ing.name]
      );

      if (stockRes.rows.length) {
        const stockUnit = (stockRes.rows[0].unit || "").toLowerCase();

        // Normalize units (g/kg, ml/l, piece/portion)
        if (ingUnit && ingUnit !== stockUnit) {
          if (ingUnit === "g" && stockUnit === "kg") {
            amountPerUnit /= 1000;
            ingUnit = stockUnit;
          } else if (ingUnit === "kg" && stockUnit === "g") {
            amountPerUnit *= 1000;
            ingUnit = stockUnit;
          } else if (ingUnit === "ml" && stockUnit === "l") {
            amountPerUnit /= 1000;
            ingUnit = stockUnit;
          } else if (ingUnit === "l" && stockUnit === "ml") {
            amountPerUnit *= 1000;
            ingUnit = stockUnit;
          } else if (
            (ingUnit === "piece" && stockUnit === "portion") ||
            (ingUnit === "portion" && stockUnit === "piece")
          ) {
            ingUnit = stockUnit;
          }
        }
      }

      console.log(`🔻 Deducting Ingredient: ${ing.ingredient || ing.name} -${amountPerUnit} ${ingUnit}`);

      const res = await pool.query(
        `UPDATE stock
         SET quantity = quantity - $1
         WHERE restaurant_id = $2 AND LOWER(name) = LOWER($3)
         RETURNING *`,
        [amountPerUnit, restaurantId, ing.ingredient || ing.name]
      );

      if (res.rowCount > 0) {
        const updatedStock = res.rows[0];
        emitStockUpdate(io, updatedStock.id);

        if (updatedStock.quantity > updatedStock.critical_quantity && updatedStock.auto_added_to_cart) {
          await pool.query(
            "UPDATE stock SET auto_added_to_cart = FALSE WHERE restaurant_id = $1 AND id = $2",
            [restaurantId, updatedStock.id]
          );
        }

        if (updatedStock.critical_quantity && updatedStock.quantity <= updatedStock.critical_quantity) {
          emitAlert(
   io,
   restaurantId,
   `🧂 Stock Low: ${updatedStock.name} (${updatedStock.quantity} ${updatedStock.unit})`,
   updatedStock.id,
   "stock",
   { stockId: updatedStock.id }
 );
        }
      }
    }

    // 🔻 Deduct Extras
    for (const ex of extras) {
      const extraName = ex.name || ex.ingredient_name;
      if (!extraName) continue;

      let amountPerPortion = Number(ex.amount);
      let extraUnit = (ex.unit || "").toLowerCase();
      const portionsPicked = parseInt(ex.quantity) || 1;

      if (!Number.isFinite(amountPerPortion) || amountPerPortion <= 0 || !extraUnit) {
        const grp = await resolveExtraFromGroups(extraName);
        if (grp) {
          amountPerPortion = grp.amount;
          extraUnit = grp.unit;
        }
      }

      const stockRes = await pool.query(
        `SELECT id, unit
         FROM stock
         WHERE restaurant_id = $1 AND LOWER(name) = LOWER($2)
         LIMIT 1`,
        [restaurantId, extraName]
      );

      if (stockRes.rows.length) {
        const stockUnit = (stockRes.rows[0].unit || "").toLowerCase();
        if (extraUnit && extraUnit !== stockUnit) {
          if (extraUnit === "g" && stockUnit === "kg") {
            amountPerPortion /= 1000;
            extraUnit = stockUnit;
          } else if (extraUnit === "kg" && stockUnit === "g") {
            amountPerPortion *= 1000;
            extraUnit = stockUnit;
          } else if (extraUnit === "ml" && stockUnit === "l") {
            amountPerPortion /= 1000;
            extraUnit = stockUnit;
          } else if (extraUnit === "l" && stockUnit === "ml") {
            amountPerPortion *= 1000;
            extraUnit = stockUnit;
          } else if (
            (extraUnit === "piece" && stockUnit === "portion") ||
            (extraUnit === "portion" && stockUnit === "piece")
          ) {
            extraUnit = stockUnit;
          }
        }
      }

      if (!extraUnit) {
        extraUnit = await resolveUnitFromStock(extraName);
      }

      if (!Number.isFinite(amountPerPortion) || amountPerPortion <= 0) {
        amountPerPortion = 1;
      }

      const usedQty = amountPerPortion * portionsPicked * quantityMultiplier;

      console.log(`🔻 Deducting Extra: ${extraName} -${usedQty} ${extraUnit}`);

     const res = await pool.query(
  `UPDATE stock
   SET quantity = quantity - $1
   WHERE restaurant_id = $2 AND LOWER(name) = LOWER($3)
   RETURNING *`,
  [usedQty, restaurantId, extraName]   // ✅ only 3 params now
);


      if (res.rowCount > 0) {
        const updatedStock = res.rows[0];
        emitStockUpdate(io, updatedStock.id);

        if (updatedStock.quantity > updatedStock.critical_quantity && updatedStock.auto_added_to_cart) {
          await pool.query(
            "UPDATE stock SET auto_added_to_cart = FALSE WHERE restaurant_id = $1 AND id = $2",
            [restaurantId, updatedStock.id]
          );
        }

        if (updatedStock.critical_quantity && updatedStock.quantity <= updatedStock.critical_quantity) {
          emitAlert(
            io,
            `🧂 Stock Low: ${updatedStock.name} (${updatedStock.quantity} ${updatedStock.unit})`,
            updatedStock.id,
            "stock",
            { stockId: updatedStock.id }
          );
        }
      }
    }
  }
}




 // ✅ Public route for QR Menu order view
// ✅ Safe for both authenticated POS users AND public QR menu views
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  const identifier = req.query.identifier;
  let restaurant_id = req.user?.restaurant_id || null;

  try {
    // Allow public QR menu with ?identifier=
    if (!restaurant_id && identifier) {
      if (/^\d+$/.test(identifier)) {
        restaurant_id = Number(identifier);
      } else {
        const r = await pool.query("SELECT id FROM restaurants WHERE slug = $1", [identifier]);
        restaurant_id = r.rows[0]?.id || null;
      }
    }

    if (!restaurant_id) {
      return res.status(400).json({ error: "Missing restaurant ID" });
    }

    const orderRes = await pool.query(
      `
      SELECT
        o.*,
        r.name AS restaurant_name,
        r.slug AS restaurant_slug,
        r.logo_url AS restaurant_logo_url,
        r.pos_location AS restaurant_pos_location,
        r.pos_location_lat AS restaurant_pos_location_lat,
        r.pos_location_lng AS restaurant_pos_location_lng
      FROM orders o
      LEFT JOIN restaurants r ON r.id = o.restaurant_id
      WHERE o.id = $1 AND o.restaurant_id = $2
      LIMIT 1
      `,
      [id, restaurant_id]
    );

    if (orderRes.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    const record = orderRes.rows[0];
    const payment_method =
      record.payment_method ||
      record.payment_type ||
      record.pay_method ||
      record.method ||
      null;

    const response = {
      ...record,
      payment_method,
      pos_location: record.restaurant_pos_location || null,
      pos_location_lat: record.restaurant_pos_location_lat || null,
      pos_location_lng: record.restaurant_pos_location_lng || null,
    };

    if (!response.restaurant && (record.restaurant_name || record.restaurant_slug || record.restaurant_logo_url)) {
      response.restaurant = {
        name: record.restaurant_name || null,
        slug: record.restaurant_slug || null,
        logo_url: record.restaurant_logo_url || null,
        pos_location: record.restaurant_pos_location || null,
        pos_location_lat: record.restaurant_pos_location_lat || null,
        pos_location_lng: record.restaurant_pos_location_lng || null,
      };
    }

    res.json(response);
  } catch (err) {
    console.error("❌ Error fetching order by id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


// GET order items by order ID
router.get("/:id/items", async (req, res) => {
  const { id } = req.params;
  const restaurantId = await requireRestaurantId(req, res);
  if (!restaurantId) return;
  try {
    const hasCancellationColumn = await ensureOrderItemCancellationFields();
    const cancelFilter = hasCancellationColumn ? "AND oi.cancelled_at IS NULL" : "";
    const result = await pool.query(
  `SELECT
     oi.id,
     oi.product_id,
     oi.external_product_id,
     oi.quantity,
     oi.price,
     oi.ingredients,
     oi.extras,
     oi.unique_id,
     oi.paid_at,
     oi.confirmed,
     oi.payment_method,
     oi.receipt_id,
     oi.note,
     oi.kitchen_status,
     oi.discount_type,
     oi.discount_value,
     oi.name AS order_item_name,
     oi.external_product_name,
     p.name AS product_name
   FROM order_items oi
   LEFT JOIN products p ON oi.product_id = p.id
   JOIN orders o ON o.id = oi.order_id
   WHERE oi.order_id = $1 AND o.restaurant_id = $2 ${cancelFilter}`,
  [id, restaurantId]
);

    const items = result.rows.map(item => ({
  ...item,
  extras: typeof item.extras === 'string' ? JSON.parse(item.extras) : (item.extras || [])
}));

res.json(items);

  } catch (err) {
    console.error("❌ Error fetching order items:", err);
    res.status(500).json({ error: "Failed to load order items" });
  }
});


// PATCH /orders/:id/reset-if-empty
router.patch("/:id/reset-if-empty", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    const itemsRes = await client.query("SELECT COUNT(*) FROM order_items WHERE order_id = $1", [id]);
    const itemCount = parseInt(itemsRes.rows[0].count, 10);

if (itemCount === 0) {
  const typeRes = await client.query("SELECT order_type FROM orders WHERE id = $1", [id]);
  const type = typeRes.rows[0]?.order_type;

  if (type !== 'quick') {
    await client.query(
      "UPDATE orders SET status = 'closed' WHERE restaurant_id = $1 AND id = $2",
      [req.user.restaurant_id, id]
    );
    io.to(`restaurant_${req.user.restaurant_id}`).emit("order_closed", { orderId: parseInt(id, 10) });
    return res.json({ message: "Order status reset to closed" });
  }

  return res.json({ message: "Quick order skipped from auto-close" });
}


    res.json({ message: "Order has items, not resetting" });
  } catch (error) {
    console.error("❌ Error resetting order:", error);
    res.status(500).json({ error: "Failed to reset order" });
  } finally {
    client.release();
  }
});



// POST /sub-orders
// POST /sub-orders  (supports paid & unpaid flows via mark_paid)
router.post("/sub-orders", async (req, res) => {
  const {
    order_id,
    total = 0,
    payment_method,
    items = [],
    receipt_id,
    mark_paid = true, // <-- NEW: if false, will NOT stamp paid_at
  } = req.body;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO sub_orders (order_id, total, payment_method, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id AS sub_order_id`,
      [order_id, total, payment_method || null]
    );
    const subOrderId = rows[0].sub_order_id;

    const itemsWithReceipt = items.map((item) => ({
      ...item,
      receipt_id: receipt_id || null,
      payment_method: item.payment_method || payment_method || null,
      product_id: item.product_id ?? item.id ?? null,
      // kitchen_status intentionally not forced here
    }));

    // ❌ Prevent double deduction if these items were already confirmed before payment
const unconfirmedItems = itemsWithReceipt.filter(it => !it.confirmed && !it.paid_at);
if (unconfirmedItems.length > 0) {
  await updateStockForOrder(unconfirmedItems, req.user.restaurant_id);
}



    const uniqueIds = itemsWithReceipt.map((i) => i.unique_id);

    if (mark_paid && receipt_id) {
      const updateRes = await client.query(
        `UPDATE order_items
         SET sub_order_id = $1,
             paid_at = NOW(),
             confirmed = true,
             receipt_id = $4,
             payment_method = $5
         WHERE order_id = $2
           AND unique_id = ANY($3::text[])`,
        [subOrderId, order_id, uniqueIds, receipt_id, payment_method || "Split"]
      );
      console.log(
        `✅ Marked ${updateRes.rowCount} item(s) as paid for sub_order ${subOrderId}`
      );
    } else {
      const updateRes = await client.query(
        `UPDATE order_items
         SET sub_order_id = $1,
             confirmed = true
         WHERE order_id = $2
           AND unique_id = ANY($3::text[])`,
        [subOrderId, order_id, uniqueIds]
      );
      console.log(
        `🟡 Added ${updateRes.rowCount} item(s) to sub_order ${subOrderId} (UNPAID)`
      );
    }

    // Keep order total in sync with the sub-order's total
    await client.query(
      `UPDATE orders
SET total = total + $1
WHERE restaurant_id = $2 AND id = $3`,
     [total, req.user.restaurant_id, order_id]
    );

await client.query("COMMIT");
// 🔒 Tenant-safe emit only for this restaurant
if (typeof emitOrderUpdate === "function") emitOrderUpdate(io, req.user.restaurant_id);


// 🔥 Emit payment event if marked paid
if (mark_paid) {
  const restaurantId = req.user.restaurant_id;
 emitPaymentMade(io, restaurantId, order_id, payment_method, total);

  console.log(`💸 [orders] payment_made emitted from sub-order for restaurant_${restaurantId}, order ${order_id}`);
}

res.json({ sub_order_id: subOrderId, mark_paid: !!mark_paid });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Sub-order failed:", err);
    res.status(500).json({ error: "Sub-order creation failed" });
  } finally {
    client.release();
  }
});

// GET /orders/:orderId/suborders
router.get("/:orderId/suborders", async (req, res) => {
  const { orderId } = req.params;
  try {
    const result = await pool.query(`
      SELECT
        so.id AS sub_order_id,
        so.payment_method,
        so.total,
        so.created_at,
        COALESCE(
          json_agg(
            json_build_object(
              'product_id', oi.product_id,
              'name', COALESCE(oi.name, p.name, oi.external_product_name, 'Item'),
              'quantity', oi.quantity,
              'price', oi.price,
              'ingredients', oi.ingredients,
              'extras', oi.extras,
              'unique_id', oi.unique_id,
              'payment_method', oi.payment_method,
              'paid_at', oi.paid_at,
              'receipt_id', oi.receipt_id
            )
          ) FILTER (WHERE oi.id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM sub_orders so
      LEFT JOIN order_items oi ON so.id = oi.sub_order_id
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE so.order_id = $1
      GROUP BY so.id
      ORDER BY so.created_at ASC
    `, [orderId]);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching sub-orders:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});





// ✅ PATCH /orders/:id/reopen
// ✅ PATCH /orders/:id/reopen — restores paid order properly
router.patch("/:id/reopen", async (req, res) => {
  const { id } = req.params;
  const restaurantId = req.user.restaurant_id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1️⃣ Get the last order details
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, id]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    const order = rows[0];

    // 2️⃣ If it's already closed or paid, reopen it visually only
    const updated = await client.query(
      `UPDATE orders
       SET status = 'confirmed',
           is_paid = false
       WHERE restaurant_id = $1 AND id = $2
       RETURNING *`,
      [restaurantId, id]
    );

    await client.query("COMMIT");

    // 4️⃣ Return the order with its items
    const { rows: itemRows } = await client.query(
      `SELECT *
       FROM order_items
       WHERE order_id = $1
       ORDER BY id ASC`,
      [id]
    );

    res.json({
      ...updated.rows[0],
      items: itemRows,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to reopen order:", err);
    res.status(500).json({ error: "Failed to reopen order" });
  } finally {
    client.release();
  }
});

// ✅ GET all payment methods used for a specific receipt
router.get("/receipt-methods/:receipt_id", async (req, res) => {
  const { receipt_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT payment_method, amount
       FROM receipt_methods
       WHERE receipt_id = $1
       ORDER BY id ASC`,
      [receipt_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching receipt methods:", err);
    res.status(500).json({ error: "Failed to fetch receipt methods" });
  }
});

// ✅ INSERT receipt_methods for a given receipt
async function insertReceiptMethods(receiptId, methodAmounts = {}) {
  // Always delete old methods for this receipt before inserting new ones!
  await pool.query(
    `DELETE FROM receipt_methods WHERE receipt_id = $1`, [receiptId]
  );
  const entries = Object.entries(methodAmounts).filter(([_, amount]) => parseFloat(amount) > 0);
  for (const [method, amount] of entries) {
    await pool.query(
      `INSERT INTO receipt_methods (receipt_id, payment_method, amount)
       VALUES ($1, $2, $3)`,
      [receiptId, method, amount]
    );
  }
}


// ✅ Support both single and sub-orders in split receipts
// PATCHED: Always save receipt_id to the order when posting split payments

router.post("/receipt-methods", async (req, res) => {
  let { receipt_id, methods, order_id } = req.body;

  try {
    // If missing, generate new receipt_id and update order
    if ((!receipt_id || receipt_id === "null") && order_id) {
      const { rows } = await pool.query(
        "UPDATE orders SET receipt_id = gen_random_uuid() WHERE restaurant_id = $1 AND id = $2 RETURNING receipt_id",
        [req.user.restaurant_id, order_id]
      );
      receipt_id = rows[0].receipt_id;
    }

    // Always set receipt_id on order (even if already present)
    if (order_id && receipt_id) {
      await pool.query(
        "UPDATE orders SET receipt_id = $1 WHERE restaurant_id = $2 AND id = $3",
        [receipt_id, req.user.restaurant_id, order_id]
      );
    }

    // Validate input
    if (!receipt_id || typeof methods !== "object") {
      return res.status(400).json({ error: "Invalid payload: missing receipt_id" });
    }

    // Remove existing methods for this receipt
    await pool.query(`DELETE FROM receipt_methods WHERE receipt_id = $1`, [receipt_id]);

    // Insert all split methods for this receipt
    for (const [method, amount] of Object.entries(methods)) {
      if (parseFloat(amount) > 0) {
        await pool.query(
          `INSERT INTO receipt_methods (receipt_id, payment_method, amount) VALUES ($1, $2, $3)`,
          [receipt_id, method, amount]
        );
      }
    }

    // Update payment_method string on order for clarity
    const paymentMethodStr = Object.keys(methods)
      .filter((k) => parseFloat(methods[k]) > 0)
      .join("+");

    await pool.query(
      `UPDATE orders SET payment_method = $1 WHERE receipt_id = $2`,
      [paymentMethodStr, receipt_id]
    );

    // 🔥 Emit payment_made after split receipt saved
    const restaurantId = req.user.restaurant_id;
    const { rows } = await pool.query(
      "SELECT id FROM orders WHERE receipt_id = $1 AND restaurant_id = $2",
      [receipt_id, restaurantId]
    );
    const orderId = rows[0]?.id;
    if (orderId) {
 emitPaymentMade(io, restaurantId, orderId, paymentMethodStr || "Split", null);

      console.log(
        `💸 [orders] payment_made emitted after receipt_methods for restaurant_${restaurantId}, order ${orderId}`
      );
    }

    res.json({ message: "Receipt methods saved", receipt_id });
  } catch (err) {
    console.error("❌ Error inserting receipt methods:", err);
    res.status(500).json({ error: "Failed to insert receipt methods" });
  }
});


// ✅ UPDATE kitchen_status for multiple order_items
router.put("/order-items/kitchen-status", async (req, res) => {
  const { ids, status } = req.body;
  if (!Array.isArray(ids) || !status) {
    return res.status(400).json({ error: "Missing ids or status" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Update kitchen_status for all items
    await client.query(
  `UPDATE order_items SET kitchen_status = $1 WHERE restaurant_id = $2 AND id = ANY($3::int[])`,
  [status, req.user.restaurant_id, ids]
);


    // 2. Find affected order IDs
    const { rows: itemOrders } = await client.query(
  `SELECT DISTINCT order_id FROM order_items WHERE restaurant_id = $1 AND id = ANY($2::int[])`,
  [req.user.restaurant_id, ids]
);

    const orderIds = itemOrders.map((r) => r.order_id);

    // 3. For each order, set prep_started_at / estimated_ready_at / kitchen_delivered_at
    const deliveredOrderIds = [];
    const penaltyPerBatch = (orderIds.length - 1) * 2 * 60; // +2min per extra order in the batch

    for (const orderId of orderIds) {
      // Fetch all items for this order
      const { rows: allItems } = await client.query(
        `SELECT kitchen_status FROM order_items WHERE order_id = $1`,
        [orderId]
      );
      const statuses = allItems.map((i) => i.kitchen_status);

      // --- PENALTY LOGIC ---
      if (statuses.includes("preparing")) {
        // Calculate max prep time among all products in this order,
        // including per-item (quantity) penalty!
        const { rows: itemsWithPrep } = await client.query(
          `SELECT oi.quantity, p.preparation_time
           FROM order_items oi
           JOIN products p ON oi.product_id = p.id
          WHERE oi.order_id = $1 AND oi.restaurant_id = $2`,
         [id, req.user.restaurant_id]
        );

        const penaltyPerExtra = 2 * 60; // 2min per extra of same product
        let itemTimes = [];

        for (const row of itemsWithPrep) {
          const prep = parseInt(row.preparation_time, 10) || 1; // minutes
          const qty = parseInt(row.quantity, 10) || 1;
          // Each product: first one prep time, others add penalty only
          const timeForThisProduct = (prep * 60) + ((qty - 1) * penaltyPerExtra);
          itemTimes.push(timeForThisProduct);
        }

        // Take the max product time as totalSeconds for the order
        let totalSeconds = itemTimes.length ? Math.max(...itemTimes) : 0;
        if (itemsWithPrep.length >= 3) totalSeconds = Math.round(totalSeconds * 1.2);

        // Add batch penalty if preparing multiple orders together
        totalSeconds += penaltyPerBatch;

        const estReadyAt = new Date(Date.now() + totalSeconds * 1000);

        // Save to DB
        await client.query(
  `UPDATE orders
   SET prep_started_at = COALESCE(prep_started_at, NOW()),
       estimated_ready_at = $1
   WHERE restaurant_id = $2 AND id = $3`,
  [estReadyAt, req.user.restaurant_id, orderId]
);

      } else {
        await client.query(
  `UPDATE orders SET estimated_ready_at = NULL WHERE restaurant_id = $1 AND id = $2`,
  [req.user.restaurant_id, orderId]
);

      }

      // a) PREP STARTED (prep_started_at always set above)
      // b) ALL DELIVERED
      if (statuses.length && statuses.every((s) => s === "delivered")) {
        await client.query(
  `UPDATE orders SET kitchen_delivered_at = NOW() WHERE restaurant_id = $1 AND id = $2`,
  [req.user.restaurant_id, orderId]
);

        deliveredOrderIds.push(orderId);
      }
    }

await client.query("COMMIT");

// 4️⃣ Tenant-safe socket emits
const io = getIO();
io.to(`restaurant_${req.user.restaurant_id}`).emit("orders_updated");

if (status === "preparing" && orderIds.length) {
  orderIds.forEach((orderId) =>
    emitOrderPreparing(io, req.user.restaurant_id, orderId)
  );
}

if (status === "ready" && orderIds.length) {
  io.to(`restaurant_${req.user.restaurant_id}`).emit("order_ready", { orderIds });
}

if (status === "delivered" && deliveredOrderIds.length) {
  deliveredOrderIds.forEach((orderId) =>
    emitOrderDelivered(io, req.user.restaurant_id, orderId)
  );
}

    res.json({ updated: ids.length });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to update kitchen_status:", err);
    res.status(500).json({ error: "Database update error" });
  } finally {
    client.release();
  }
});





// PATCH /orders/:id/driver-status
router.patch("/:id/driver-status", async (req, res) => {
  const { id } = req.params;
  let { driver_status } = req.body;
  const client = await pool.connect();

  // Defensive type casting
  if (typeof driver_status !== "string") {
    driver_status = String(driver_status || "");
  }

  try {
    await client.query("BEGIN");

    // 🛑 Block driver status change if driver_id is not assigned
    const driverCheck = await client.query(
  `SELECT driver_id FROM orders WHERE restaurant_id = $1 AND id = $2`,
  [req.user.restaurant_id, id]
);

    const order = driverCheck.rows[0];
    if (!order || !order.driver_id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Cannot change driver status: no driver assigned!" });
    }

    // 1. Always update driver_status
   await client.query(
  `UPDATE orders
   SET driver_status = $1
   WHERE restaurant_id = $2 AND id = $3`,
  [driver_status, req.user.restaurant_id, id]
);


    // 2. If delivered, set delivered_at
    if (driver_status === "delivered") {
      await client.query(
  `UPDATE orders
   SET delivered_at = NOW()
   WHERE restaurant_id = $1 AND id = $2 AND delivered_at IS NULL`,
  [req.user.restaurant_id, id]
);

    }

    await client.query("COMMIT");

// 🔒 Tenant-safe emit only to this restaurant
getIO().to(`restaurant_${req.user.restaurant_id}`).emit("orders_updated");
res.json({ success: true });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Driver status update failed:", err);
    res.status(500).json({ error: "Failed to update driver status" });
  } finally {
    client.release();
  }
});
// ✅ PATCH /orders/:id/move-table
// ✅ PATCH /orders/:id/move-table
router.patch("/:id/move-table", async (req, res) => {
  const { id } = req.params;
  const { new_table_number } = req.body;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT * FROM orders WHERE restaurant_id = $1 AND id = $2`,
      [req.user.restaurant_id, id]
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    const order = rows[0];

    // 3️⃣ Move the order
    const updatedOrder = await client.query(
      `UPDATE orders
       SET table_number = $1,
           status = CASE
                      WHEN status = 'paid' THEN 'confirmed'
                      ELSE status
                    END
       WHERE restaurant_id = $2 AND id = $3
       RETURNING *`,
      [new_table_number, req.user.restaurant_id, id]
    );

    await client.query("COMMIT");

    // Emit socket update
    io.emit("table_moved", {
      order_id: id,
      from: order.table_number,
      to: new_table_number,
      order: updatedOrder.rows[0],
    });

    res.json({
      message: `✅ Table moved from ${order.table_number} to ${new_table_number}`,
      order: updatedOrder.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Move table failed:", err);
    res.status(500).json({ error: "Failed to move table" });
  } finally {
    client.release();
  }
});


// ✅ FINAL PATCH: Merge tables preserving all paid/unpaid states
router.patch("/:orderId/merge-table", async (req, res) => {
  const { orderId } = req.params;
  const { target_table_number } = req.body;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1️⃣ Find destination order (open)
    const { rows: target } = await client.query(
      `SELECT id, restaurant_id, total, is_paid
         FROM orders
        WHERE table_number = $1 AND status <> 'closed'
        LIMIT 1`,
      [target_table_number]
    );
    if (!target.length) throw new Error("Target order not found or closed");
    const targetOrder = target[0];

    // 2️⃣ Find source
    const { rows: source } = await client.query(
      `SELECT id, restaurant_id, total
         FROM orders
        WHERE id = $1
        LIMIT 1`,
      [orderId]
    );
    if (!source.length) throw new Error("Source order not found");
    const sourceOrder = source[0];

    if (targetOrder.restaurant_id !== sourceOrder.restaurant_id)
      throw new Error("Cross-restaurant merge is not allowed");

    const restaurantId = targetOrder.restaurant_id;

    // 3️⃣ Move all order_items (preserve all payment info!)
    await client.query(
      `UPDATE order_items
       SET order_id = $1
       WHERE order_id = $2`,
      [targetOrder.id, sourceOrder.id]
    );

    // 4️⃣ Move sub_orders
    await client.query(
      `UPDATE sub_orders
       SET order_id = $1
       WHERE order_id = $2`,
      [targetOrder.id, sourceOrder.id]
    );

    // 5️⃣ Roll totals and detect if target should now be marked paid
    const { rows: paidCheck } = await client.query(
      `SELECT COUNT(*) FILTER (WHERE paid_at IS NULL) AS unpaid_count
         FROM order_items
        WHERE order_id = $1`,
      [targetOrder.id]
    );

    const unpaidCount = parseInt(paidCheck[0].unpaid_count, 10) || 0;
    const newStatus = unpaidCount === 0 ? "paid" : "confirmed";

    await client.query(
      `UPDATE orders
         SET total = COALESCE(total,0) + $2,
             status = $3,
             is_paid = $4
       WHERE id = $1`,
      [
        targetOrder.id,
        sourceOrder.total || 0,
        newStatus,
        unpaidCount === 0, // true if all paid
      ]
    );

    // 6️⃣ Close and zero the source
    await client.query(
      `UPDATE orders SET status='closed', total=0 WHERE id=$1`,
      [sourceOrder.id]
    );

    await client.query("COMMIT");

 // 7️⃣ Emit (tenant-safe)
if (typeof emitOrderUpdate === "function") emitOrderUpdate(io, restaurantId);

io.to(`restaurant_${restaurantId}`).emit("order_merged", {
  order: { id: targetOrder.id, table_number: Number(target_table_number) },
});

    res.json({
      ok: true,
      target_id: targetOrder.id,
      merged_status: newStatus,
      message: unpaidCount === 0
        ? "Merged successfully (all paid)"
        : "Merged successfully (some unpaid items remain)",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ merge-table failed:", err);
    res.status(500).json({ error: "Failed to merge table" });
  } finally {
    client.release();
  }
});




// POST /api/orders/:id/confirm-online
router.post("/:id/confirm-online", async (req, res) => {
console.log("✅ confirm-online route loaded");

  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Get order
const orderRes = await pool.query(`
  SELECT o.*,
         c.name AS customer_name,
         c.phone AS customer_phone,
         ca.address AS customer_address
  FROM orders o
  LEFT JOIN customers c ON o.customer_phone = c.phone
  LEFT JOIN customer_addresses ca ON ca.customer_id = c.id AND ca.is_default = true
  WHERE o.restaurant_id = $1 AND o.id = $2
`, [req.user.restaurant_id, req.params.id]);

    const order = rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    // 2. Check order type (packet/phone only)
    if (!["packet", "phone"].includes(order.order_type)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Only online orders can be auto-confirmed." });
    }

    // 3. Only confirm if not already confirmed/closed
    if (order.status === "confirmed" || order.status === "closed") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Order already confirmed or closed." });
    }

    // 4. Update status to "confirmed"
   const updateRes = await client.query(
  `UPDATE orders
   SET status = 'confirmed'
   WHERE restaurant_id = $1 AND id = $2
   RETURNING *`,
  [req.user.restaurant_id, id]
);

    await client.query("COMMIT");

const ioRef = req.app.get("io");
const restaurantId = req.user.restaurant_id;

try {
  const payload = await buildFullOrderPayload(id, restaurantId);
  ioRef.to(`restaurant_${restaurantId}`).emit("order_confirmed", payload);
  console.log(`🖨️ [orders] order_confirmed emitted for restaurant_${restaurantId}:`, id);
} catch (e) {
  console.error("❌ Failed to build full order payload for order_confirmed:", e);
}

// 🔒 tenant-safe update emit
if (typeof emitOrderUpdate === "function") emitOrderUpdate(ioRef, restaurantId);
else ioRef.to(`restaurant_${restaurantId}`).emit("orders_updated");





    res.json({ message: "Order confirmed", order: updateRes.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Error confirming online order:", err);
    res.status(500).json({ error: "Failed to confirm order" });
  } finally {
    client.release();
  }
});

// GET /api/orders/:id/payment-changes
router.get('/:id/payment-changes', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT old_method, new_method, changed_by, changed_at
         FROM payment_method_changes
         WHERE order_id = $1
         ORDER BY changed_at ASC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching payment method changes:', err);
    res.status(500).json({ error: 'Failed to fetch payment method changes' });
  }
});

router.get("/:raw", async (req, res) => {
  const raw = String(req.params.raw || "").trim();
  console.log(`🧪 [orders] GET /api/orders/${raw} — resolver start`);

  try {
    const restaurantId = await requireRestaurantId(req, res);
    if (!restaurantId) return;
    // Only allow numeric ID now (order_number column removed/not used)
    if (!/^\d+$/.test(raw)) {
      return res.status(400).json({ error: "Order id must be numeric", raw });
    }
    const internalId = parseInt(raw, 10);

    // 3) Fetch header
    const { rows: orderRows } = await pool.query(
      `SELECT id, status, table_number, order_type, total, created_at
       FROM orders WHERE restaurant_id = $1 AND id = $2`,
[restaurantId, internalId]

    );
    if (!orderRows.length) {
      return res.status(404).json({ error: "Order not found", id: internalId });
    }

    // 4) Fetch items
    const { rows: itemRows } = await pool.query(
      `SELECT
         oi.product_id,
         oi.unique_id,
         oi.name AS order_item_name,
         p.name  AS product_name,
         oi.quantity,
         oi.price,
         oi.extras,
         oi.note,
         oi.kitchen_status,
         oi.paid_at
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1
       ORDER BY oi.id ASC`,
      [internalId]
    );

    const items = itemRows.map((it) => ({
      ...it,
      name: it.order_item_name || it.product_name || "Item",
      extras:
        typeof it.extras === "string"
          ? (() => {
              try { return JSON.parse(it.extras); } catch { return []; }
            })()
          : (it.extras || []),
      total: (parseFloat(it.price) || 0) * (it.quantity || 1),
    }));

    console.log(`✅ [orders] resolver success id=${internalId} items=${items.length}`);
    return res.json({ ...orderRows[0], items });
  } catch (e) {
    console.error("🔥 [orders] resolver failed", e);
    return res.status(500).json({ error: "Failed to fetch order" });
  }
});
// ✅ Merge all open orders with the same customer_name into one
router.patch("/merge-by-customer", async (req, res) => {
  const { customer_name } = req.body;
  const restaurantId = req.user.restaurant_id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1️⃣ Find all open orders for this customer
    const { rows: openOrders } = await client.query(
      `SELECT id, total FROM orders
       WHERE restaurant_id = $1 AND status <> 'closed' AND LOWER(customer_name) = LOWER($2)
       ORDER BY id ASC`,
      [restaurantId, customer_name]
    );

    if (openOrders.length < 2) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No multiple open orders found for this name." });
    }

    const target = openOrders[0];
    const others = openOrders.slice(1);

    // 2️⃣ Merge all others into target
    for (const order of others) {
      await client.query(`UPDATE order_items SET order_id = $1 WHERE order_id = $2`, [target.id, order.id]);
      await client.query(`UPDATE sub_orders SET order_id = $1 WHERE order_id = $2`, [target.id, order.id]);
      await client.query(`UPDATE orders SET status='closed', total=0 WHERE id=$1`, [order.id]);
      await client.query(`UPDATE orders SET total = total + $2 WHERE id=$1`, [target.id, order.total || 0]);
    }

    await client.query("COMMIT");

    // Emit update to frontend
    io.to(`restaurant_${restaurantId}`).emit("orders_updated");

    res.json({ message: `Merged ${others.length} orders for ${customer_name}`, target_id: target.id });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ merge-by-customer failed:", err);
    res.status(500).json({ error: "Failed to merge by customer" });
  } finally {
    client.release();
  }
});

return router;
};
