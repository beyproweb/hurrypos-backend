const { pool } = require("../db");

const JSON_COLUMN_TYPES = new Set(["json", "jsonb"]);
const DEFAULT_LOCALIZATION = { language: "en", currency: "₺ TRY" };

async function getSettingsSchemaInfo() {
  const { rows } = await pool.query(
    `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'settings'
    `
  );

  const find = (name) => rows.find((row) => row.column_name === name);

  return {
    hasLocalization: Boolean(find("localization")),
    localizationType: find("localization")?.data_type || null,
    hasRestaurantId: Boolean(find("restaurant_id")),
    hasValue: Boolean(find("value")),
  };
}

function parseMaybeJson(value) {
  if (value === null || typeof value === "undefined") return undefined;
  if (typeof value === "object") return value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return value;
      }
    }
  }

  return value;
}

function normalizeCurrency(currency) {
  if (!currency) return DEFAULT_LOCALIZATION.currency;

  const map = {
    "₺": "₺ TRY",
    "try": "₺ TRY",
    "₺ try": "₺ TRY",
    "try ₺": "₺ TRY",
  };

  const key = String(currency).trim().toLowerCase();
  return map[key] || currency;
}

function buildLocalizationResponse(rawLocalization = {}) {
  const merged = {
    ...DEFAULT_LOCALIZATION,
    ...rawLocalization,
  };

  merged.currency = normalizeCurrency(merged.currency);
  return merged;
}

async function loadLocalizationForRestaurant(restaurantId) {
  const schema = await getSettingsSchemaInfo();

  if (schema.hasLocalization && schema.hasRestaurantId && restaurantId) {
    const result = await pool.query(
      `
        SELECT localization, value
        FROM settings
        WHERE restaurant_id = $1 AND key = 'global'
        LIMIT 1
      `,
      [restaurantId]
    );

    const row = result.rows?.[0] || {};
    let localization = row.localization;

    if (!localization || typeof localization !== "object") {
      const parsedLocalization = parseMaybeJson(localization);
      if (parsedLocalization && typeof parsedLocalization === "object") {
        localization = parsedLocalization;
      } else {
        const parsed = parseMaybeJson(row.value);
        if (parsed && typeof parsed === "object" && parsed.localization) {
          localization = parsed.localization;
        } else {
          localization = {};
        }
      }
    }

    return buildLocalizationResponse(localization);
  }

  const params = [];
  let query = `
      SELECT key, value
      FROM settings
      WHERE key IN ('language', 'currency')
    `;

  if (schema.hasRestaurantId && restaurantId) {
    query += " AND restaurant_id = $1";
    params.push(restaurantId);
  }

  const fallbackResult = await pool.query(query, params);

  const settingsMap = fallbackResult.rows.reduce((acc, row) => {
    const parsed = parseMaybeJson(row.value);
    acc[row.key] = parsed?.value ?? parsed ?? row.value;
    return acc;
  }, {});

  return buildLocalizationResponse({
    language: settingsMap.language,
    currency: settingsMap.currency,
  });
}

module.exports = {
  JSON_COLUMN_TYPES,
  DEFAULT_LOCALIZATION,
  getSettingsSchemaInfo,
  parseMaybeJson,
  normalizeCurrency,
  buildLocalizationResponse,
  loadLocalizationForRestaurant,
};

