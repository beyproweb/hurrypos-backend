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
const COMPOUND_PUBLIC_SUFFIXES = new Set([
  "ac.uk",
  "co.id",
  "co.in",
  "co.jp",
  "co.nz",
  "co.uk",
  "co.za",
  "com.ar",
  "com.au",
  "com.br",
  "com.cn",
  "com.eg",
  "com.hk",
  "com.mx",
  "com.my",
  "com.ng",
  "com.sg",
  "com.tr",
  "com.ua",
  "firm.in",
  "gen.tr",
  "gov.uk",
  "net.au",
  "net.in",
  "net.tr",
  "org.au",
  "org.in",
  "org.tr",
  "org.uk",
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

function stripDomainInput(value) {
  let normalized = String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");

  if (!normalized) return "";

  normalized = normalized
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^\/\//, "")
    .split(/[/?#]/, 1)[0]
    .replace(/:\d+$/, "")
    .replace(/\.+$/g, "")
    .replace(/^www\./, "");

  return normalized;
}

function isValidDomainLabel(label) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(String(label || ""));
}

function isValidTld(label) {
  const value = String(label || "");
  return /^[a-z]{2,63}$/.test(value) || /^xn--[a-z0-9-]{2,59}$/.test(value);
}

function normalizeCustomDomain(value) {
  const host = stripDomainInput(value);
  if (!host) return "";

  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return "";
  if (!isValidTld(labels[labels.length - 1])) return "";
  if (labels.some((label) => !isValidDomainLabel(label))) return "";

  return labels.join(".");
}

function deriveRestaurantSlugFromDomain(value, options = {}) {
  const maxLen =
    Number.isFinite(options.maxLen) && options.maxLen > 10
      ? Math.floor(options.maxLen)
      : DEFAULT_MAX_LEN;
  const reserved = options.reserved instanceof Set ? options.reserved : DEFAULT_RESERVED;
  const domain = normalizeCustomDomain(value);
  if (!domain) return "";

  const labels = domain.split(".");
  const compoundSuffix =
    labels.length >= 3
      ? `${labels[labels.length - 2]}.${labels[labels.length - 1]}`
      : "";
  const registrableIndex =
    compoundSuffix && COMPOUND_PUBLIC_SUFFIXES.has(compoundSuffix)
      ? labels.length - 3
      : labels.length - 2;

  const slugSource = labels[Math.max(0, registrableIndex)] || "";
  const fallbackSource = labels.slice(0, Math.max(1, registrableIndex + 1)).join("-");
  const candidate =
    clampSlug(slugifyRestaurantName(slugSource), maxLen) ||
    clampSlug(slugifyRestaurantName(fallbackSource), maxLen);

  if (!candidate || reserved.has(candidate)) return "";
  return candidate;
}

function parseCustomDomain(value, options = {}) {
  const normalizedDomain = normalizeCustomDomain(value);
  const slug = normalizedDomain ? deriveRestaurantSlugFromDomain(normalizedDomain, options) : "";

  return {
    input: String(value || ""),
    normalizedDomain,
    slug,
    isValid: Boolean(normalizedDomain && slug),
  };
}

function randomSuffix() {
  return crypto.randomBytes(3).toString("hex"); // 6 chars
}

async function slugExists(db, slug) {
  const { rows } = await db.query(
    "SELECT 1 FROM restaurants WHERE lower(slug) = lower($1) LIMIT 1",
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
  clampSlug,
  normalizeCustomDomain,
  deriveRestaurantSlugFromDomain,
  parseCustomDomain,
  slugifyRestaurantName,
  generateUniqueRestaurantSlug,
  isMissingRestaurantSlug,
  DEFAULT_RESERVED,
};
