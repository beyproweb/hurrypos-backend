const crypto = require("crypto");

const DEFAULT_MAX_LEN = 60;
const DEFAULT_RESERVED = new Set([
  "api",
  "uploads",
  "sounds",
  "bridge",
  "favicon.ico",
  "qr",
  "menu",
  "qr-menu",
  "login",
  "dashboard",
]);

function slugifyRestaurantName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";

  const normalized = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  return normalized
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function clampSlug(value, maxLen) {
  const s = String(value || "");
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).replace(/-+$/g, "");
}

function randomSuffix() {
  return crypto.randomBytes(3).toString("hex"); // 6 chars
}

async function slugExists(db, slug) {
  const { rows } = await db.query(
    "SELECT 1 FROM restaurants WHERE slug = $1 LIMIT 1",
    [slug]
  );
  return rows.length > 0;
}

async function generateUniqueRestaurantSlug(db, restaurantName, options = {}) {
  const maxLen =
    Number.isFinite(options.maxLen) && options.maxLen > 10
      ? Math.floor(options.maxLen)
      : DEFAULT_MAX_LEN;
  const reserved = options.reserved instanceof Set ? options.reserved : DEFAULT_RESERVED;

  const baseRaw = slugifyRestaurantName(restaurantName) || "restaurant";
  const base = clampSlug(baseRaw, maxLen);

  const candidates = [];
  candidates.push(base);
  for (let i = 2; i <= 20; i += 1) candidates.push(`${base}-${i}`);

  for (const c of candidates) {
    const candidate = clampSlug(c, maxLen);
    if (!candidate) continue;
    if (reserved.has(candidate)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await slugExists(db, candidate))) return candidate;
  }

  for (let tries = 0; tries < 20; tries += 1) {
    const suffix = randomSuffix();
    const trimmedBase = clampSlug(base, Math.max(10, maxLen - (suffix.length + 1)));
    const candidate = clampSlug(`${trimmedBase}-${suffix}`, maxLen);
    if (!candidate) continue;
    if (reserved.has(candidate)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await slugExists(db, candidate))) return candidate;
  }

  // As a last resort, return something deterministic; callers may rely on DB constraints.
  return clampSlug(`${base}-${Date.now().toString(36)}`, maxLen);
}

function isMissingRestaurantSlug(slug) {
  const s = String(slug || "").trim().toLowerCase();
  return !s || s === "null" || s === "undefined";
}

module.exports = {
  slugifyRestaurantName,
  generateUniqueRestaurantSlug,
  isMissingRestaurantSlug,
  DEFAULT_RESERVED,
};

