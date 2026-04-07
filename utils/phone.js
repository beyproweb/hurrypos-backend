function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizeTrPhoneForApi(value) {
  let digits = digitsOnly(value);
  if (!digits) return "";

  while (digits.startsWith("00") && digits.length > 2) {
    digits = digits.slice(2);
  }

  if (digits.startsWith("90")) {
    const national = digits.slice(2);
    if (national.length === 10) return `90${national}`;
    if (national.length === 11 && national.startsWith("0")) {
      return `90${national.slice(1)}`;
    }
    return digits;
  }

  if (digits.length === 11 && digits.startsWith("0")) {
    return `90${digits.slice(1)}`;
  }

  if (digits.length === 10) {
    return `90${digits}`;
  }

  return digits;
}

function buildTrPhoneCandidates(value) {
  const normalized = normalizeTrPhoneForApi(value);
  if (!normalized) return [];

  const national = normalized.startsWith("90") && normalized.length > 2
    ? normalized.slice(2)
    : normalized;

  const rawDigits = digitsOnly(value);
  const candidates = new Set([
    normalized,
    national,
    national.length === 10 ? `0${national}` : "",
    rawDigits,
  ]);

  return Array.from(candidates).filter(Boolean);
}

function isTrPhoneApiFormat(value) {
  return /^90\d{10}$/.test(String(value ?? "").trim());
}

module.exports = {
  digitsOnly,
  normalizeTrPhoneForApi,
  buildTrPhoneCandidates,
  isTrPhoneApiFormat,
};
