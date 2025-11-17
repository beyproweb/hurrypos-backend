const DEFAULT_CURRENCY = {
  key: "TRY",
  label: "₺ TRY",
  symbol: "₺",
  locale: "tr-TR",
  position: "prefix",
};

const CURRENCY_MAP = {
  "₺ TRY": {
    key: "TRY",
    label: "₺ TRY",
    symbol: "₺",
    locale: "tr-TR",
    position: "prefix",
  },
  "€ EUR": {
    key: "EUR",
    label: "€ EUR",
    symbol: "€",
    locale: "de-DE",
    position: "suffix",
  },
  "$ USD": {
    key: "USD",
    label: "$ USD",
    symbol: "$",
    locale: "en-US",
    position: "prefix",
  },
  "£ GBP": {
    key: "GBP",
    label: "£ GBP",
    symbol: "£",
    locale: "en-GB",
    position: "prefix",
  },
  "₨ MUR": {
    key: "MUR",
    label: "₨ MUR",
    symbol: "₨",
    locale: "en-MU",
    position: "prefix",
  },
};

const CODE_TO_LABEL = Object.values(CURRENCY_MAP).reduce((acc, cfg) => {
  acc[cfg.key] = cfg.label;
  return acc;
}, {});

function normalizeCurrencyLabel(raw) {
  if (!raw) return DEFAULT_CURRENCY.label;
  const str = String(raw).trim();
  if (CURRENCY_MAP[str]) return str;

  const upper = str.toUpperCase();
  if (CODE_TO_LABEL[upper]) return CODE_TO_LABEL[upper];

  const bySymbol = Object.entries(CURRENCY_MAP).find(
    ([, cfg]) => cfg.symbol === str,
  );
  if (bySymbol) return bySymbol[0];

  return DEFAULT_CURRENCY.label;
}

function getCurrencyMeta(raw) {
  const label = normalizeCurrencyLabel(raw);
  return CURRENCY_MAP[label] || DEFAULT_CURRENCY;
}

function formatCurrency(value, rawLabel) {
  const meta = getCurrencyMeta(rawLabel);
  const num = Number.isFinite(Number(value)) ? Number(value) : 0;

  const formatted = num.toLocaleString(meta.locale || undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

  if (!meta.symbol) return formatted;
  return meta.position === "suffix"
    ? `${formatted} ${meta.symbol}`
    : `${meta.symbol}${formatted}`;
}

module.exports = {
  DEFAULT_CURRENCY,
  getCurrencyMeta,
  formatCurrency,
};

