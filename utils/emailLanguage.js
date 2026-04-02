const { loadLocalizationForRestaurant } = require("./localization");

function normalizeEmailLanguage(value, fallback = "en") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
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
  return mapped || fallback;
}

function isTurkishLanguage(language) {
  return normalizeEmailLanguage(language, "en") === "tr";
}

async function resolveRestaurantEmailLanguage(restaurantId, options = {}) {
  const fallback = normalizeEmailLanguage(options.fallback || "en", "en");
  const id = Number(restaurantId);
  if (!Number.isFinite(id) || id <= 0) return fallback;

  try {
    const localization = await loadLocalizationForRestaurant(id);
    return normalizeEmailLanguage(localization?.language, fallback);
  } catch (err) {
    console.warn("⚠️ Failed to resolve restaurant email language:", err?.message || err);
    return fallback;
  }
}

module.exports = {
  normalizeEmailLanguage,
  isTurkishLanguage,
  resolveRestaurantEmailLanguage,
};
