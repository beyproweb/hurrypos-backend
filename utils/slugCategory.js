// utils/slugCategory.js
export function toCategorySlug(cat) {
  if (!cat) return "";
  // If your DB has a canonical 'slug' field, prefer that:
  if (cat.slug) return String(cat.slug).toLowerCase();

  // Else derive from a stable name/code. DO NOT use translated labels.
  const base = cat.code || cat.name || cat; // supports string or object
  return String(base)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")  // strip diacritics
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
