const DEFAULT_CANVAS_WIDTH = 1200;
const DEFAULT_CANVAS_HEIGHT = 780;

const TABLE_TYPES = new Set([
  "regular",
  "vip",
  "standing",
  "couple",
  "men_only",
  "women_only",
  "mixed_only",
  "disabled",
  "hidden",
]);

const ELEMENT_KINDS = new Set([
  "table",
  "stage",
  "vip_block",
  "couch",
  "standing_zone",
  "dance_floor",
  "bar",
  "entrance",
  "exit",
  "wc",
  "wall",
  "label",
  "dj_booth",
  "no_go",
]);

function asText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const next = String(value).trim();
  return next || fallback;
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asPositiveInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function asBoolean(value, fallback = false) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeStringArray(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function normalizeNumberArray(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
    )
  ).sort((left, right) => left - right);
}

function normalizeTableType(value, fallback = "regular") {
  const normalized = asText(value, fallback).toLowerCase();
  return TABLE_TYPES.has(normalized) ? normalized : fallback;
}

function normalizeElementKind(value, fallback = "table") {
  const normalized = asText(value, fallback).toLowerCase();
  return ELEMENT_KINDS.has(normalized) ? normalized : fallback;
}

function normalizeShape(value, fallback = "circle") {
  const normalized = asText(value, fallback).toLowerCase();
  return ["circle", "square", "rectangle", "oval"].includes(normalized)
    ? normalized
    : fallback;
}

function makeElementId(prefix = "element", value = null) {
  const suffix = value ? String(value).trim() : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${suffix}`;
}

function normalizeLayoutElement(raw = {}) {
  const kind = normalizeElementKind(
    raw.kind || raw.element_kind || raw.type_kind || (raw.table_number ? "table" : "label"),
    raw.table_number ? "table" : "label"
  );
  const linkedTableNumber = asPositiveInt(
    raw.table_number ??
      raw.tableNumber ??
      raw.linked_table_number ??
      raw.linkedTableNumber,
    0
  );
  const capacity = asPositiveInt(
    raw.capacity ?? raw.seats ?? raw.guest_limit ?? raw.guests,
    0
  );
  const width = Math.max(48, asNumber(raw.width, kind === "label" ? 180 : 96));
  const height = Math.max(32, asNumber(raw.height, kind === "label" ? 64 : 96));
  const col = Math.max(
    0,
    asNumber(
      raw.col ?? raw.column,
      Math.round(asNumber(raw.x, 0) / Math.max(1, asNumber(raw.cell_size ?? raw.cellSize, 84)))
    )
  );
  const row = Math.max(
    0,
    asNumber(
      raw.row,
      Math.round(asNumber(raw.y, 0) / Math.max(1, asNumber(raw.row_height ?? raw.rowHeight, 84)))
    )
  );
  const colSpan = Math.max(1, asPositiveInt(raw.col_span ?? raw.colSpan, Math.round(width / 84) || 1));
  const rowSpan = Math.max(1, asPositiveInt(raw.row_span ?? raw.rowSpan, Math.round(height / 84) || 1));
  const offsetX = asNumber(raw.offset_x ?? raw.offsetX, 0);
  const offsetY = asNumber(raw.offset_y ?? raw.offsetY, 0);

  return {
    id: asText(raw.id, makeElementId(kind, linkedTableNumber || null)),
    kind,
    name: asText(
      raw.name || raw.label,
      linkedTableNumber > 0 ? `Table ${linkedTableNumber}` : kind.replace(/_/g, " ")
    ),
    label: asText(raw.label || raw.name, ""),
    text: asText(raw.text || raw.caption, ""),
    shape: normalizeShape(raw.shape, kind === "table" ? "circle" : "rectangle"),
    col,
    row,
    col_span: colSpan,
    row_span: rowSpan,
    offset_x: offsetX,
    offset_y: offsetY,
    x: Math.max(0, col * Math.max(1, asNumber(raw.cell_size ?? raw.cellSize, 84)) + offsetX),
    y: Math.max(0, row * Math.max(1, asNumber(raw.row_height ?? raw.rowHeight, 84)) + offsetY),
    width,
    height,
    rotation: asNumber(raw.rotation, 0),
    visual_scale: Math.min(1.35, Math.max(0.15, asNumber(raw.visual_scale ?? raw.visualScale, 1))),
    color: asText(raw.color || raw.color_override, ""),
    zone: asText(raw.zone || raw.section || raw.area, ""),
    capacity,
    table_number: linkedTableNumber || null,
    table_type: normalizeTableType(raw.table_type || raw.tableType, "regular"),
    hidden: asBoolean(raw.hidden, false),
    compatible_ticket_type_ids: normalizeNumberArray(
      raw.compatible_ticket_type_ids || raw.compatibleTicketTypeIds
    ),
    compatible_area_names: normalizeStringArray(
      raw.compatible_area_names || raw.compatibleAreaNames
    ),
    metadata:
      raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
        ? raw.metadata
        : {},
  };
}

function normalizeFloorPlanLayout(layout) {
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) return null;

  const canvas = layout.canvas && typeof layout.canvas === "object" ? layout.canvas : {};
  const elements = (Array.isArray(layout.elements) ? layout.elements : [])
    .map((element) => normalizeLayoutElement(element))
    .filter(Boolean);

  return {
    id: asText(layout.id, "default-floor-plan"),
    name: asText(layout.name, "Floor Plan"),
    layout_type: asText(layout.layout_type || layout.layoutType, "venue"),
    version: asPositiveInt(layout.version, 1) || 1,
    canvas: {
      width: Math.max(600, asNumber(canvas.width, DEFAULT_CANVAS_WIDTH)),
      height: Math.max(420, asNumber(canvas.height, DEFAULT_CANVAS_HEIGHT)),
      background: asText(canvas.background, ""),
      grid_size: Math.max(4, asNumber(canvas.grid_size || canvas.gridSize, 20)),
      cell_size: Math.max(48, asNumber(canvas.cell_size || canvas.cellSize, canvas.grid_size || canvas.gridSize || 84)),
      row_height: Math.max(48, asNumber(canvas.row_height || canvas.rowHeight, canvas.cell_size || canvas.cellSize || canvas.grid_size || canvas.gridSize || 84)),
      columns: Math.max(1, asPositiveInt(canvas.columns, 12) || 12),
      rows: Math.max(1, asPositiveInt(canvas.rows, 8) || 8),
      table_gap_x: Math.max(0, Math.min(48, asNumber(canvas.table_gap_x ?? canvas.tableGapX, 0))),
      table_gap_y: Math.max(0, Math.min(48, asNumber(canvas.table_gap_y ?? canvas.tableGapY, 0))),
    },
    metadata:
      layout.metadata && typeof layout.metadata === "object" && !Array.isArray(layout.metadata)
        ? layout.metadata
        : {},
    elements,
  };
}

function buildGeneratedFloorPlan(tables = [], options = {}) {
  const normalizedTables = Array.isArray(tables) ? tables : [];
  const columns = Math.max(1, Math.min(5, asPositiveInt(options.columns, 4) || 4));
  const spacingX = 220;
  const spacingY = 180;
  const originX = 80;
  const originY = 90;

  const elements = normalizedTables.map((table, index) => {
    const tableNumber = asPositiveInt(table?.table_number ?? table?.number, 0);
    const capacity = asPositiveInt(table?.seats ?? table?.guests, 0);
    const zone = asText(table?.area, "");
    const row = Math.floor(index / columns);
    const col = index % columns;

    return normalizeLayoutElement({
      id: makeElementId("table", tableNumber || index + 1),
      kind: "table",
      table_number: tableNumber || null,
      name: asText(table?.label, tableNumber > 0 ? `Table ${tableNumber}` : `Table ${index + 1}`),
      x: originX + col * spacingX,
      y: originY + row * spacingY,
      width: 100,
      height: 100,
      shape: index % 2 === 0 ? "circle" : "square",
      capacity,
      zone,
      table_type: "regular",
    });
  });

  return normalizeFloorPlanLayout({
    id: "generated-floor-plan",
    name: "Generated Floor Plan",
    layout_type: "generated",
    version: 1,
    canvas: {
      width: Math.max(DEFAULT_CANVAS_WIDTH, originX * 2 + columns * spacingX),
      height: Math.max(
        DEFAULT_CANVAS_HEIGHT,
        originY * 2 + Math.max(1, Math.ceil(Math.max(elements.length, 1) / columns)) * spacingY
      ),
      grid_size: 20,
    },
    metadata: {
      generated: true,
    },
    elements,
  });
}

async function loadVenueFloorPlanLayout(db, restaurantId) {
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
  const source =
    row?.qr_menu_customization && typeof row.qr_menu_customization === "object"
      ? row.qr_menu_customization
      : row?.value && typeof row.value === "object"
        ? row.value
        : {};
  return normalizeFloorPlanLayout(
    source?.qr_floor_plan_layout || source?.floor_plan_layout || null
  );
}

function resolveEffectiveFloorPlanLayout({ venueLayout = null, eventLayout = null, tables = [] } = {}) {
  const normalizedEvent = normalizeFloorPlanLayout(eventLayout);
  if (normalizedEvent && normalizedEvent.elements.length > 0) {
    return {
      layout: normalizedEvent,
      source: "event",
    };
  }

  const normalizedVenue = normalizeFloorPlanLayout(venueLayout);
  if (normalizedVenue && normalizedVenue.elements.length > 0) {
    return {
      layout: normalizedVenue,
      source: "venue",
    };
  }

  return {
    layout: buildGeneratedFloorPlan(tables),
    source: "generated",
  };
}

function buildFloorPlanElementIndex(layout) {
  const index = new Map();
  const normalized = normalizeFloorPlanLayout(layout);
  if (!normalized) return index;
  for (const element of normalized.elements) {
    const tableNumber = asPositiveInt(element?.table_number, 0);
    if (!tableNumber) continue;
    index.set(tableNumber, element);
  }
  return index;
}

function evaluateTableRestrictions({
  table = {},
  element = null,
  guestCount = 0,
  menCount = null,
  womenCount = null,
  ticketTypeId = null,
  areaName = "",
}) {
  const linkedElement = element ? normalizeLayoutElement(element) : null;
  const effectiveCapacity = asPositiveInt(
    linkedElement?.capacity ?? table?.seats ?? table?.guests,
    0
  );
  const normalizedGuestCount = asPositiveInt(guestCount, 0);
  const normalizedMenCount =
    menCount === null || menCount === undefined || menCount === ""
      ? null
      : asPositiveInt(menCount, 0);
  const normalizedWomenCount =
    womenCount === null || womenCount === undefined || womenCount === ""
      ? null
      : asPositiveInt(womenCount, 0);
  const effectiveTableType = normalizeTableType(linkedElement?.table_type, "regular");

  if (linkedElement?.hidden || effectiveTableType === "hidden") {
    return { valid: false, reason: "Hidden table" };
  }
  if (effectiveTableType === "disabled") {
    return { valid: false, reason: "Table is disabled" };
  }
  if (normalizedGuestCount > 0 && effectiveCapacity > 0 && normalizedGuestCount > effectiveCapacity) {
    return { valid: false, reason: `Capacity ${effectiveCapacity}` };
  }

  if (linkedElement?.compatible_ticket_type_ids?.length > 0) {
    const numericTicketTypeId = asPositiveInt(ticketTypeId, 0);
    if (!numericTicketTypeId || !linkedElement.compatible_ticket_type_ids.includes(numericTicketTypeId)) {
      return { valid: false, reason: "Package mismatch" };
    }
  }

  if (linkedElement?.compatible_area_names?.length > 0) {
    const normalizedAreaName = asText(areaName || table?.area, "").toLowerCase();
    if (
      !normalizedAreaName ||
      !linkedElement.compatible_area_names.some(
        (value) => String(value || "").trim().toLowerCase() === normalizedAreaName
      )
    ) {
      return { valid: false, reason: "Section mismatch" };
    }
  }

  if (
    ["couple", "mixed_only", "men_only", "women_only"].includes(effectiveTableType) &&
    (normalizedMenCount === null || normalizedWomenCount === null)
  ) {
    return { valid: false, reason: "Guest composition required" };
  }

  switch (effectiveTableType) {
    case "men_only":
      if ((normalizedMenCount || 0) < 1 || (normalizedWomenCount || 0) > 0) {
        return { valid: false, reason: "Men only" };
      }
      break;
    case "women_only":
      if ((normalizedWomenCount || 0) < 1 || (normalizedMenCount || 0) > 0) {
        return { valid: false, reason: "Women only" };
      }
      break;
    case "mixed_only":
      if ((normalizedMenCount || 0) < 1 || (normalizedWomenCount || 0) < 1) {
        return { valid: false, reason: "Mixed groups only" };
      }
      break;
    case "couple":
      if (
        normalizedGuestCount <= 0 ||
        normalizedGuestCount % 2 !== 0 ||
        normalizedMenCount !== normalizedWomenCount ||
        (normalizedMenCount || 0) < 1
      ) {
        return { valid: false, reason: "Couples only" };
      }
      break;
    case "standing":
    case "vip":
    case "regular":
    default:
      break;
  }

  return {
    valid: true,
    reason: "",
    capacity: effectiveCapacity,
    tableType: effectiveTableType,
  };
}

module.exports = {
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  buildFloorPlanElementIndex,
  buildGeneratedFloorPlan,
  evaluateTableRestrictions,
  loadVenueFloorPlanLayout,
  normalizeFloorPlanLayout,
  normalizeLayoutElement,
  resolveEffectiveFloorPlanLayout,
};
