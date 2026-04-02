const moment = require("moment-timezone");

const DEFAULT_TZ = process.env.REPORTS_TIMEZONE || "Europe/Istanbul";

const DEFAULT_BOOKING_SLOT_SETTINGS = Object.freeze({
  reservation_booking_settings_enabled: true,
  booking_slot_settings_enabled: true,
  concert_booking_settings_enabled: true,
  reservation_default_duration_minutes: 120,
  reservation_buffer_minutes: 0,
  reservation_max_per_table_per_day: null,
  reservation_allow_while_occupied_now: false,
  reservation_early_checkin_window_minutes: 15,
  reservation_late_arrival_grace_minutes: 15,
  reservation_auto_cancel_no_show_after_minutes: 0,
  concert_event_duration_minutes: 150,
  concert_event_end_time: null,
  concert_early_entry_window_minutes: 30,
  concert_late_entry_cutoff_minutes: 30,
  concert_allow_reentry: false,
  booking_time_interval_minutes: 30,
  booking_max_days_in_advance: 30,
});

let ensureBookingSlotSchemaPromise = null;

function asText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const next = String(value).trim();
  return next || fallback;
}

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function asPositiveInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function asNullablePositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeYmd(value) {
  const next = asText(value, "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return null;
  return next;
}

function normalizeTimeValue(value) {
  const next = asText(value, "");
  if (!next) return null;
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(next)) {
    return next.length === 5 ? `${next}:00` : next;
  }

  const meridiemMatch = next.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])$/);
  if (!meridiemMatch) return null;

  let hours = Number(meridiemMatch[1]);
  const minutes = Number(meridiemMatch[2]);
  const seconds = Number(meridiemMatch[3] || "0");
  const meridiem = String(meridiemMatch[4] || "").toLowerCase();
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    hours < 1 ||
    hours > 12 ||
    minutes < 0 ||
    minutes > 59 ||
    seconds < 0 ||
    seconds > 59
  ) {
    return null;
  }

  if (meridiem === "am") {
    if (hours === 12) hours = 0;
  } else if (meridiem === "pm") {
    if (hours < 12) hours += 12;
  } else {
    return null;
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
    seconds
  ).padStart(2, "0")}`;
}

function toMinuteString(value) {
  const normalized = normalizeTimeValue(value);
  return normalized ? normalized.slice(0, 5) : null;
}

function combineLocalDateTime(dateValue, timeValue) {
  const ymd = normalizeYmd(dateValue);
  const normalizedTime = normalizeTimeValue(timeValue);
  if (!ymd || !normalizedTime) return null;
  return `${ymd} ${normalizedTime}`;
}

function parseLocalDateTime(value) {
  const raw = asText(value, "");
  if (!raw) return null;
  const normalized = raw.includes("T") ? raw.replace("T", " ") : raw;
  const candidate = moment.tz(normalized, ["YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD HH:mm"], DEFAULT_TZ);
  if (!candidate.isValid()) return null;
  return candidate.toDate();
}

function formatDatePart(date) {
  const zoned = moment(date).tz(DEFAULT_TZ);
  const year = zoned.year();
  const month = String(zoned.month() + 1).padStart(2, "0");
  const day = String(zoned.date()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTimePart(date) {
  const zoned = moment(date).tz(DEFAULT_TZ);
  const hours = String(zoned.hours()).padStart(2, "0");
  const minutes = String(zoned.minutes()).padStart(2, "0");
  const seconds = String(zoned.seconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatLocalDateTime(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  return `${formatDatePart(date)} ${formatTimePart(date)}`;
}

function addMinutesToDateTime(value, minutes) {
  const base = parseLocalDateTime(value);
  if (!base) return null;
  const safeMinutes = Number(minutes) || 0;
  base.setMinutes(base.getMinutes() + safeMinutes);
  return formatLocalDateTime(base);
}

function getDayNameForYmd(value) {
  const ymd = normalizeYmd(value);
  if (!ymd) return null;
  const parsed = new Date(`${ymd}T12:00:00`);
  if (!Number.isFinite(parsed.getTime())) return null;
  const names = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  return names[parsed.getDay()] || null;
}

function normalizeBookingSlotSettings(raw = {}) {
  return {
    reservation_booking_settings_enabled: asBoolean(
      raw.reservation_booking_settings_enabled,
      DEFAULT_BOOKING_SLOT_SETTINGS.reservation_booking_settings_enabled
    ),
    booking_slot_settings_enabled: asBoolean(
      raw.booking_slot_settings_enabled,
      DEFAULT_BOOKING_SLOT_SETTINGS.booking_slot_settings_enabled
    ),
    concert_booking_settings_enabled: asBoolean(
      raw.concert_booking_settings_enabled,
      DEFAULT_BOOKING_SLOT_SETTINGS.concert_booking_settings_enabled
    ),
    reservation_default_duration_minutes: Math.max(
      15,
      asPositiveInt(
        raw.reservation_default_duration_minutes,
        DEFAULT_BOOKING_SLOT_SETTINGS.reservation_default_duration_minutes
      )
    ),
    reservation_buffer_minutes: Math.max(
      0,
      asPositiveInt(
        raw.reservation_buffer_minutes,
        DEFAULT_BOOKING_SLOT_SETTINGS.reservation_buffer_minutes
      ) || 0
    ),
    reservation_max_per_table_per_day: asNullablePositiveInt(
      raw.reservation_max_per_table_per_day
    ),
    reservation_allow_while_occupied_now: asBoolean(
      raw.reservation_allow_while_occupied_now,
      DEFAULT_BOOKING_SLOT_SETTINGS.reservation_allow_while_occupied_now
    ),
    reservation_early_checkin_window_minutes: Math.max(
      0,
      asPositiveInt(
        raw.reservation_early_checkin_window_minutes,
        DEFAULT_BOOKING_SLOT_SETTINGS.reservation_early_checkin_window_minutes
      ) || 0
    ),
    reservation_late_arrival_grace_minutes: Math.max(
      0,
      asPositiveInt(
        raw.reservation_late_arrival_grace_minutes,
        DEFAULT_BOOKING_SLOT_SETTINGS.reservation_late_arrival_grace_minutes
      ) || 0
    ),
    reservation_auto_cancel_no_show_after_minutes: Math.max(
      0,
      asPositiveInt(
        raw.reservation_auto_cancel_no_show_after_minutes,
        DEFAULT_BOOKING_SLOT_SETTINGS.reservation_auto_cancel_no_show_after_minutes
      ) || 0
    ),
    concert_event_duration_minutes: Math.max(
      15,
      asPositiveInt(
        raw.concert_event_duration_minutes,
        DEFAULT_BOOKING_SLOT_SETTINGS.concert_event_duration_minutes
      )
    ),
    concert_event_end_time: toMinuteString(raw.concert_event_end_time),
    concert_early_entry_window_minutes: Math.max(
      0,
      asPositiveInt(
        raw.concert_early_entry_window_minutes,
        DEFAULT_BOOKING_SLOT_SETTINGS.concert_early_entry_window_minutes
      ) || 0
    ),
    concert_late_entry_cutoff_minutes: Math.max(
      0,
      asPositiveInt(
        raw.concert_late_entry_cutoff_minutes,
        DEFAULT_BOOKING_SLOT_SETTINGS.concert_late_entry_cutoff_minutes
      ) || 0
    ),
    concert_allow_reentry: asBoolean(
      raw.concert_allow_reentry,
      DEFAULT_BOOKING_SLOT_SETTINGS.concert_allow_reentry
    ),
    booking_time_interval_minutes: Math.max(
      5,
      Math.min(
        180,
        asPositiveInt(
          raw.booking_time_interval_minutes,
          DEFAULT_BOOKING_SLOT_SETTINGS.booking_time_interval_minutes
        )
      )
    ),
    booking_max_days_in_advance: Math.max(
      1,
      Math.min(
        365,
        asPositiveInt(
          raw.booking_max_days_in_advance,
          DEFAULT_BOOKING_SLOT_SETTINGS.booking_max_days_in_advance
        )
      )
    ),
  };
}

async function loadBookingSlotSettings(db, restaurantId) {
  const result = await db.query(
    `
    SELECT qr_menu_customization, value
    FROM settings
    WHERE restaurant_id = $1
      AND key = 'qr-menu-customization'
    LIMIT 1
    `,
    [restaurantId]
  );
  const row = result.rows?.[0] || null;
  const raw =
    row?.qr_menu_customization ??
    (typeof row?.value === "string" ? JSON.parse(row.value) : row?.value) ??
    {};
  return normalizeBookingSlotSettings(raw && typeof raw === "object" ? raw : {});
}

function computeReservationSlot({ reservationDate, reservationTime, settings }) {
  const slotSettings = normalizeBookingSlotSettings(settings);
  const slotStartDateTime = combineLocalDateTime(reservationDate, reservationTime);
  if (!slotStartDateTime) return null;
  const slotEndDateTime = addMinutesToDateTime(
    slotStartDateTime,
    slotSettings.reservation_default_duration_minutes
  );
  const slotEndWithBufferDateTime = addMinutesToDateTime(
    slotEndDateTime,
    slotSettings.reservation_buffer_minutes
  );
  return {
    slot_start_datetime: slotStartDateTime,
    slot_end_datetime: slotEndDateTime,
    slot_end_with_buffer_datetime: slotEndWithBufferDateTime,
    reservation_duration_minutes: slotSettings.reservation_default_duration_minutes,
    reservation_buffer_minutes: slotSettings.reservation_buffer_minutes,
  };
}

function computeConcertSlot({ eventDate, eventTime, settings }) {
  const slotSettings = normalizeBookingSlotSettings(settings);
  const slotStartDateTime = combineLocalDateTime(eventDate, eventTime);
  if (!slotStartDateTime) return null;

  let slotEndDateTime = null;
  if (slotSettings.concert_event_end_time) {
    const explicitEnd = combineLocalDateTime(eventDate, slotSettings.concert_event_end_time);
    const explicitEndDate = parseLocalDateTime(explicitEnd);
    const slotStartDate = parseLocalDateTime(slotStartDateTime);
    if (explicitEndDate && slotStartDate && explicitEndDate <= slotStartDate) {
      explicitEndDate.setDate(explicitEndDate.getDate() + 1);
      slotEndDateTime = formatLocalDateTime(explicitEndDate);
    } else {
      slotEndDateTime = explicitEnd;
    }
  }

  if (!slotEndDateTime) {
    slotEndDateTime = addMinutesToDateTime(
      slotStartDateTime,
      slotSettings.concert_event_duration_minutes
    );
  }

  const entryOpenDateTime = addMinutesToDateTime(
    slotStartDateTime,
    slotSettings.concert_early_entry_window_minutes * -1
  );
  const entryCloseDateTime = addMinutesToDateTime(
    slotStartDateTime,
    slotSettings.concert_late_entry_cutoff_minutes
  );

  return {
    slot_start_datetime: slotStartDateTime,
    slot_end_datetime: slotEndDateTime,
    entry_open_datetime: entryOpenDateTime,
    entry_close_datetime: entryCloseDateTime,
    allow_reentry: slotSettings.concert_allow_reentry,
    event_duration_minutes: slotSettings.concert_event_duration_minutes,
    event_end_time: slotSettings.concert_event_end_time,
  };
}

function computeReservationCheckinWindow({ slotStartDateTime, settings }) {
  const slotSettings = normalizeBookingSlotSettings(settings);
  if (!slotSettings.reservation_booking_settings_enabled) return null;
  const earlyMinutes = slotSettings.reservation_early_checkin_window_minutes;
  const graceMinutes = slotSettings.reservation_late_arrival_grace_minutes;
  const autoCancelMinutes = slotSettings.reservation_auto_cancel_no_show_after_minutes;
  const positiveCutoffs = [graceMinutes, autoCancelMinutes].filter(
    (value) => Number.isFinite(value) && value > 0
  );
  const cutoffMinutes =
    positiveCutoffs.length > 0 ? Math.min(...positiveCutoffs) : Math.max(graceMinutes, 0);

  return {
    checkin_open_datetime: addMinutesToDateTime(slotStartDateTime, earlyMinutes * -1),
    checkin_close_datetime:
      cutoffMinutes > 0 ? addMinutesToDateTime(slotStartDateTime, cutoffMinutes) : null,
  };
}

function computeConcertCheckinWindow({ slotStartDateTime, settings }) {
  const slotSettings = normalizeBookingSlotSettings(settings);
  if (!slotSettings.concert_booking_settings_enabled) return null;
  return {
    entry_open_datetime: addMinutesToDateTime(
      slotStartDateTime,
      slotSettings.concert_early_entry_window_minutes * -1
    ),
    entry_close_datetime: addMinutesToDateTime(
      slotStartDateTime,
      slotSettings.concert_late_entry_cutoff_minutes
    ),
  };
}

function isTimeAlignedToStep(timeValue, stepMinutes) {
  const normalized = normalizeTimeValue(timeValue);
  const safeStep = Math.max(1, asPositiveInt(stepMinutes, 1));
  if (!normalized) return false;
  const hours = Number(normalized.slice(0, 2));
  const minutes = Number(normalized.slice(3, 5));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return false;
  return ((hours * 60) + minutes) % safeStep === 0;
}

function isDateWithinAdvanceLimit(dateValue, maxDaysInAdvance) {
  const ymd = normalizeYmd(dateValue);
  if (!ymd) return false;
  const today = moment.tz(DEFAULT_TZ).startOf("day");
  const target = moment.tz(ymd, "YYYY-MM-DD", DEFAULT_TZ).startOf("day");
  if (!target.isValid()) return false;
  const diffDays = target.diff(today, "days");
  return diffDays >= 0 && diffDays <= Math.max(0, asPositiveInt(maxDaysInAdvance, 0));
}

function buildTimeSlotsForDay({
  dateValue,
  openTime,
  closeTime,
  stepMinutes,
  minDateTime = null,
}) {
  const ymd = normalizeYmd(dateValue);
  const open = normalizeTimeValue(openTime);
  const close = normalizeTimeValue(closeTime);
  const safeStep = Math.max(5, asPositiveInt(stepMinutes, 30));
  if (!ymd || !open || !close) return [];

  const start = parseLocalDateTime(combineLocalDateTime(ymd, open));
  const end = parseLocalDateTime(combineLocalDateTime(ymd, close));
  if (!start || !end) return [];
  if (end <= start) {
    end.setDate(end.getDate() + 1);
  }

  const minDate = parseLocalDateTime(minDateTime);
  const slots = [];
  const cursor = new Date(start.getTime());
  while (cursor < end) {
    if (!minDate || cursor >= minDate) {
      slots.push(formatTimePart(cursor).slice(0, 5));
    }
    cursor.setMinutes(cursor.getMinutes() + safeStep);
  }
  return slots;
}

function isCurrentTimeInsideWindow({
  openDateTime,
  closeDateTime,
  allowAfterClose = false,
  now = moment.tz(DEFAULT_TZ).toDate(),
}) {
  const open = parseLocalDateTime(openDateTime);
  const close = parseLocalDateTime(closeDateTime);
  if (!open) return false;
  if (!close) {
    return now >= open;
  }
  if (allowAfterClose) {
    return now >= open;
  }
  return now >= open && now <= close;
}

async function ensureBookingSlotSchema(pool) {
  if (!ensureBookingSlotSchemaPromise) {
    ensureBookingSlotSchemaPromise = (async () => {
      const statements = [
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS slot_start_datetime TIMESTAMP`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS slot_end_datetime TIMESTAMP`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS reservation_duration_minutes INTEGER`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS reservation_buffer_minutes INTEGER`,
        `CREATE INDEX IF NOT EXISTS idx_orders_booking_slots ON orders (restaurant_id, table_number, slot_start_datetime, slot_end_datetime) WHERE table_number IS NOT NULL`,
        `ALTER TABLE concert_bookings ADD COLUMN IF NOT EXISTS slot_start_datetime TIMESTAMP`,
        `ALTER TABLE concert_bookings ADD COLUMN IF NOT EXISTS slot_end_datetime TIMESTAMP`,
        `ALTER TABLE concert_bookings ADD COLUMN IF NOT EXISTS entry_open_datetime TIMESTAMP`,
        `ALTER TABLE concert_bookings ADD COLUMN IF NOT EXISTS entry_close_datetime TIMESTAMP`,
        `ALTER TABLE concert_bookings ADD COLUMN IF NOT EXISTS allow_reentry BOOLEAN`,
        `CREATE INDEX IF NOT EXISTS idx_concert_bookings_slots ON concert_bookings (restaurant_id, event_id, slot_start_datetime, slot_end_datetime)`,
      ];

      for (const statement of statements) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query(statement);
      }
    })().catch((err) => {
      ensureBookingSlotSchemaPromise = null;
      throw err;
    });
  }

  return ensureBookingSlotSchemaPromise;
}

module.exports = {
  DEFAULT_BOOKING_SLOT_SETTINGS,
  normalizeBookingSlotSettings,
  loadBookingSlotSettings,
  computeReservationSlot,
  computeConcertSlot,
  computeReservationCheckinWindow,
  computeConcertCheckinWindow,
  combineLocalDateTime,
  parseLocalDateTime,
  formatLocalDateTime,
  addMinutesToDateTime,
  normalizeYmd,
  normalizeTimeValue,
  toMinuteString,
  getDayNameForYmd,
  isTimeAlignedToStep,
  isDateWithinAdvanceLimit,
  buildTimeSlotsForDay,
  isCurrentTimeInsideWindow,
  ensureBookingSlotSchema,
};
