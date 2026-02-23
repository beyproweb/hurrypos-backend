const DEFAULT_CURRENCY = "TRY";

const LABELS = {
  card: {
    strong: [
      "KREDI KARTI",
      "KART TOPLAM",
      "KART TUTAR",
      "KART ISLEM TOPLAMI",
      "GENEL KART ISLEM TOPLAMI",
      "K KARTI",
      "KKARTI",
      "CARD TOTAL",
      "TOTAL CARD",
      "CREDIT CARD",
      "KARTENZAHLUNG",
      "KREDITKARTE",
      "SUMME KARTE",
      "TOTAL CARTE",
      "CARTE BANCAIRE",
      "PAIEMENT CARTE",
    ],
    weak: [
      "KREDI",
      "KART",
      "KART ISLEM",
      "KART ISLEMLERI",
      "KARTI",
      "K KART",
      "KKARTI",
      "CARD",
      "CREDIT",
      "CARTE",
      "CB",
      "KARTE",
      "KARTEN",
    ],
  },
  cash: {
    strong: ["CASH TOTAL", "NAKIT TOPLAM", "NAKİT TOPLAM", "TOTAL CASH", "BAR TOTAL", "ESPECES TOTAL", "ESPÈCES TOTAL"],
    weak: ["CASH", "NAKIT", "NAKİT", "BAR", "ESPECES", "ESPÈCES"],
  },
  grand: {
    strong: ["GENEL TOPLAM", "TOPLAM TUTAR", "GRAND TOTAL", "TOTAL GENERAL", "TOTAL GÉNÉRAL", "GESAMTSUMME"],
    weak: ["TOPLAM", "TOTAL", "AMOUNT", "GESAMT", "SUMME", "MONTANT"],
  },
  refund: {
    strong: ["REFUND", "RETURN", "RÜCKGABE", "STORNO", "REMBOURSEMENT", "ANNULATION", "IADE", "İADE"],
    weak: ["IADE", "İADE", "REFUND", "RETURN", "STORNO"],
  },
  tx: {
    strong: ["ISLEM ADET", "İŞLEM ADET", "TX COUNT", "TRANSACTION COUNT", "KARTENZAHLUNG ANZAHL"],
    weak: ["ISLEM", "İŞLEM", "ADET", "FIS", "FİŞ", "COUNT", "TRANSACTION", "TX", "SALES", "ANZAHL", "BUCHUNGEN", "NOMBRE"],
  },
};

const stripDiacritics = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "SS");

const normalizeText = (text) => {
  if (!text) return "";
  let t = String(text).toUpperCase();
  t = stripDiacritics(t);
  t = t.replace(/\r/g, "\n");
  // Fix common OCR mistakes in numeric contexts
  t = t.replace(/(?<=\d)[O]/g, "0");
  t = t.replace(/[O](?=\d)/g, "0");
  t = t.replace(/[I|L](?=\d)/g, "1");
  t = t.replace(/(?<=\d)[I|L]/g, "1");
  t = t.replace(/[^\S\n]+/g, " ");
  return t;
};

const hasCurrencyMarker = (line) =>
  /(?:\bTL\b|₺|\bTRY\b)/i.test(line);

const parseAmount = (raw) => {
  if (!raw) return null;
  const original = String(raw);
  let s = original.replace(/\s+/g, "");
  s = s.replace(/[^\d.,-]/g, "");
  if (!s) return null;

  // OCR frequently drops comma in patterns like "2 78500" (meant "2 785,00").
  if (
    !/[.,]/.test(original) &&
    /^[-+]?\d{1,3}\s+\d{5}$/.test(original.trim()) &&
    /^\d{6,8}$/.test(s) &&
    /00$/.test(s)
  ) {
    const intPart = s.slice(0, -2);
    const decPart = s.slice(-2);
    s = `${intPart}.${decPart}`;
  }

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let decimalSep = null;
  if (lastComma >= 0 || lastDot >= 0) {
    const lastSep = Math.max(lastComma, lastDot);
    const decimals = s.length - lastSep - 1;
    // OCR can drop one trailing decimal digit (e.g. 2 785,0 instead of 2 785,00).
    if (decimals === 1 || decimals === 2) {
      decimalSep = s[lastSep];
    }
  }

  if (decimalSep) {
    const otherSep = decimalSep === "," ? "." : ",";
    s = s.split(otherSep).join("");
    s = s.replace(decimalSep, ".");
  } else {
    s = s.replace(/[.,]/g, "");
  }

  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return value;
};

const extractAmountsFromLine = (line) => {
  let rawLine = String(line || "");
  // OCR compacts decimals in spaced amounts: "2 78500" -> normalize to "2 785,00"
  rawLine = rawLine.replace(/([-+]?\d{1,3})\s+(\d{3})(\d{2})\b/g, "$1 $2,$3");
  // Join spaced thousands groups without merging separate numeric tokens (e.g. keep "10 2785,00").
  const compact = rawLine.replace(/(?<=\d)\s+(?=\d{3}(?:\D|$))/g, "");
  const matches = compact.match(/[-]?\d[\d.,]*\d/g) || [];
  return matches
    .map((m) => ({ raw: m, value: parseAmount(m), hasCurrency: hasCurrencyMarker(line) }))
    .filter((m) => Number.isFinite(m.value));
};

const extractLargeAmountFromLine = (line, minValue = 100) => {
  const amounts = extractAmountsFromLine(line);
  if (!amounts.length) return null;
  const candidates = amounts
    .map((a) => a.value)
    .filter((v) => Number.isFinite(v) && v >= minValue);
  if (!candidates.length) return null;
  return Math.max(...candidates);
};

const scoreCandidate = ({ strength, offset, hasCurrency, value }) => {
  let score = 0;
  score += strength * 2;
  score += offset === 0 ? 2 : offset === 1 ? 1 : 0.5;
  if (hasCurrency) score += 1;
  if (value >= 0 && value < 1e9) score += 1;
  return score;
};

const pickBestCandidate = (lines, labels) => {
  let best = null;
  let matchedLabel = null;

  lines.forEach((line, idx) => {
    const lineText = line.normalized;
    const strong = labels.strong.find((l) => lineText.includes(l));
    const weak = !strong && labels.weak.find((l) => lineText.includes(l));
    if (!strong && !weak) return;

    const strength = strong ? 2 : 1;
    matchedLabel = strong || weak || matchedLabel;

    for (let offset = 0; offset <= 3; offset += 1) {
      const target = lines[idx + offset];
      if (!target) continue;
      const large = extractLargeAmountFromLine(target.original, 100);
      if (large == null) continue;
      const amt = {
        value: large,
        hasCurrency: hasCurrencyMarker(target.original),
      };
      {
        const candidate = {
          value: amt.value,
          hasCurrency: amt.hasCurrency,
          score: scoreCandidate({ strength, offset, hasCurrency: amt.hasCurrency, value: amt.value }),
          label: strong || weak,
          lineIndex: idx,
          offset,
        };
        if (!best || candidate.score > best.score) {
          best = candidate;
          matchedLabel = candidate.label;
        }
      }
    }
  });

  return { best, matchedLabel };
};

const findCardByCooccurrence = (lines) => {
  let best = null;
  let matchedLabel = null;
  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i].normalized;
    if (!lineText.includes("KART") && !lineText.includes("CARD")) continue;
    const window = [lines[i], lines[i + 1], lines[i + 2]].filter(Boolean);
    const hasTotal =
      window.some((l) => l.normalized.includes("TOPLAM")) ||
      window.some((l) => l.normalized.includes("TOTAL"));
    if (!hasTotal) continue;
    for (let offset = 0; offset <= 2; offset += 1) {
      const target = lines[i + offset];
      if (!target) continue;
      const amounts = extractAmountsFromLine(target.original);
      if (!amounts.length) continue;
      amounts.forEach((amt) => {
        const candidate = {
          value: amt.value,
          hasCurrency: amt.hasCurrency,
          score: scoreCandidate({ strength: 1, offset, hasCurrency: amt.hasCurrency, value: amt.value }),
          label: "KART+TOPLAM",
          lineIndex: i,
          offset,
        };
        if (!best || candidate.score > best.score) {
          best = candidate;
          matchedLabel = candidate.label;
        }
      });
    }
  }
  return { best, matchedLabel };
};

const findCardByStandaloneLabel = (lines) => {
  const labels = ["K KARTI", "K KAKI", "KKARTI", "KAKI", "KARTI", "KART"];
  let best = null;
  let matchedLabel = null;
  lines.forEach((line, idx) => {
    const text = line.normalized;
    const label = labels.find((l) => text.includes(l));
    if (!label) return;
    const largeSameLine = extractLargeAmountFromLine(line.original, 100);
    if (largeSameLine != null) {
      const candidate = {
        value: largeSameLine,
        hasCurrency: hasCurrencyMarker(line.original),
        score: scoreCandidate({
          strength: label === "KART" ? 1 : 2,
          offset: 0,
          hasCurrency: hasCurrencyMarker(line.original),
          value: largeSameLine,
        }) + 2,
        label,
        lineIndex: idx,
        offset: 0,
      };
      if (!best || candidate.score > best.score) {
        best = candidate;
        matchedLabel = candidate.label;
      }
    }

    for (let offset = 0; offset <= 4; offset += 1) {
      const target = lines[idx + offset];
      if (!target) continue;
      const large = extractLargeAmountFromLine(target.original, 100);
      if (large == null) continue;
      const candidate = {
        value: large,
        hasCurrency: hasCurrencyMarker(target.original),
        score: scoreCandidate({
          strength: label === "KART" ? 1 : 2,
          offset,
          hasCurrency: hasCurrencyMarker(target.original),
          value: large,
        }),
        label,
        lineIndex: idx,
        offset,
      };
      if (!best || candidate.score > best.score) {
        best = candidate;
        matchedLabel = candidate.label;
      }
    }
  });
  return { best, matchedLabel };
};

const confidenceFromScore = (score, hasCurrency, strength, offset) => {
  if (!score) return 0;
  if (strength >= 2 && offset === 0 && hasCurrency) return 0.9;
  if (strength >= 1 && offset <= 1) return 0.6;
  return 0.3;
};

const TX_COUNT_CONTEXT_TOKENS = [
  "ADET",
  "ISLEM",
  "FIS",
  "COUNT",
  "TRANSACTION",
  "TRANSACTIONS",
  "TX",
  "ANZAHL",
  "NOMBRE",
  "SATIS",
  "SALES",
];

const TX_MONEY_HINT_TOKENS = [
  "TOPLAM",
  "TOTAL",
  "TUTAR",
  "KART",
  "CARD",
  "NAKIT",
  "CASH",
  "TL",
  "TRY",
  "₺",
];

const parseTxCountFromLine = (line) => {
  const text = String(line || "").toUpperCase();
  const hasSalesCue = /\bSATI[S5]\b|\bSATIS\b|\bSALI[S5]\b|\bSALLY\b|\bSALE[S]?\b/.test(text);
  const hasCountToken = /\bADET\b|\bCOUNT\b|\bANZAHL\b|\bNOMBRE\b|\bA[D0O]?[E3]?[T7]\b|A\)/.test(
    text
  );
  const hasTxContext = TX_COUNT_CONTEXT_TOKENS.some((t) => text.includes(t));
  if (!hasTxContext && !hasSalesCue) return null;

  const hasMoneyHint = TX_MONEY_HINT_TOKENS.some((t) => text.includes(t));
  if (
    hasMoneyHint &&
    !hasCountToken &&
    !hasSalesCue
  ) {
    return null;
  }

  const pairPatterns = [
    /\b(?:ISLEM(?:\s+ADET)?|TRANSACTIONS?|TX(?:\s+COUNT)?|FIS|ANZAHL|NOMBRE|SALES?|SATI[S5]|SATIS|SALI[S5]|SALLY)\s*[:=]?\s*(\d{1,5})\b/i,
    /\b(\d{1,5})\s*(?:ADET|ISLEM|FIS|TRANSACTIONS?|TX|ANZAHL|NOMBRE|SALES?|SATI[S5]|SATIS|SALI[S5]|SALLY|A[D0O]?[E3]?[T7]|A\))\b/i,
  ];
  for (const p of pairPatterns) {
    const m = text.match(p);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n >= 0) return n;
    }
  }

  const ints = (text.match(/\b\d{1,5}\b/g) || [])
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n));
  if (!ints.length) return null;

  if (hasSalesCue) {
    const countLike = ints.find((n) => n > 0 && n <= 99);
    if (countLike != null) return countLike;
    if (hasCountToken) {
      const relaxed = ints.find((n) => n > 0 && n <= 500);
      if (relaxed != null) return relaxed;
    }
    // Prevent reading monetary values (e.g. 165,00) as tx count.
    return null;
  }

  const bounded = ints.filter((n) => n >= 0 && n <= 9999);
  return bounded.length ? bounded[0] : null;
};

const BANK_KEYWORDS = [
  "SEKERBANK",
  "AKBANK",
  "GARANTI",
  "YAPI KREDI",
  "YAPIKREDI",
  "IS BANKASI",
  "ISBANK",
  "HALKBANK",
  "VAKIFBANK",
  "ZIRAAT",
  "QNB",
  "DENIZBANK",
  "TEB",
  "ING",
  "FINANSBANK",
  "KUVEYT TURK",
  "ALBARAKA",
];

const BANK_FUZZY_PATTERNS = [
  { bank: "SEKERBANK", re: /SEKERB(?:ANK|ANX|ARK|ARX)/ },
  { bank: "SEKERBANK", re: /SEKER.*BANK/ },
  { bank: "SEKERBANK", re: /SEKERBANK\.?COM/ },
  // Common OCR drifts for "SEKERBANK" seen on terminal slips.
  { bank: "SEKERBANK", re: /PEKERBANK|YEKEKBANK|KEKBANK|KERBANK/ },
  { bank: "AKBANK", re: /AKB[A-Z0-9]{0,2}N[KX]/ },
  { bank: "GARANTI", re: /GARAN[T7]I/ },
  { bank: "YAPI KREDI", re: /YAPI.*KREDI|YAPIKREDI/ },
  { bank: "IS BANKASI", re: /IS.?BANK|ISBANKASI/ },
  { bank: "HALKBANK", re: /HALK.*BANK/ },
  { bank: "VAKIFBANK", re: /VAKIF.*BANK/ },
  { bank: "ZIRAAT", re: /ZIR[A4]AT/ },
  { bank: "QNB", re: /QNB/ },
  { bank: "DENIZBANK", re: /DENIZ.*BANK/ },
  { bank: "TEB", re: /\bTEB\b/ },
  { bank: "ING", re: /\bING\b/ },
  { bank: "FINANSBANK", re: /FINANS.*BANK/ },
  { bank: "KUVEYT TURK", re: /KUVEYT.*TURK/ },
  { bank: "ALBARAKA", re: /ALBARAKA/ },
];

const detectBankName = (lines) => {
  for (const line of lines) {
    const t = line?.normalized || "";
    if (!t) continue;
    const direct = BANK_KEYWORDS.find((k) => t.includes(k));
    if (direct) return direct;
    const compact = t.replace(/[^A-Z0-9]/g, "");
    const fuzzy = BANK_FUZZY_PATTERNS.find((p) => p.re.test(compact));
    if (fuzzy) return fuzzy.bank;
  }
  return null;
};

const findTxCount = (lines) => {
  let best = null;

  lines.forEach((line, idx) => {
    const strong = LABELS.tx.strong.find((l) => line.normalized.includes(l));
    const weak = !strong && LABELS.tx.weak.find((l) => line.normalized.includes(l));
    if (!strong && !weak) return;

    const strength = strong ? 2 : 1;
    for (let offset = 0; offset <= 2; offset += 1) {
      const target = lines[idx + offset];
      if (!target) continue;
      const count = parseTxCountFromLine(target.normalized);
      if (count == null) continue;
      const score = strength * 3 + (offset === 0 ? 2 : offset === 1 ? 1 : 0);
      const candidate = { value: count, score };
      if (!best || candidate.score > best.score) {
        best = candidate;
      }
    }
  });

  return best?.value ?? null;
};

function parseZReportText(text, debug = false) {
  const normalized = normalizeText(text);
  const originalLines = String(text || "").split(/\n/);
  const normalizedLines = normalized.split(/\n/);
  const lines = normalizedLines.map((line, i) => ({
    normalized: line.trim(),
    original: (originalLines[i] || "").trim(),
  }));

  if (debug) {
    console.log("🔎 [zreport] Normalized lines:", lines.slice(0, 30));
  }

  let card = pickBestCandidate(lines, LABELS.card);
  if (!card.best) {
    card = findCardByCooccurrence(lines);
  }
  if (!card.best) {
    card = findCardByStandaloneLabel(lines);
  }
  const cash = pickBestCandidate(lines, LABELS.cash);
  const grand = pickBestCandidate(lines, LABELS.grand);
  const refund = pickBestCandidate(lines, LABELS.refund);
  const txCount = findTxCount(lines);

  let cardTotal = card.best?.value ?? null;
  const cashTotal = cash.best?.value ?? null;
  let grandTotal = grand.best?.value ?? null;
  const refundTotal = refund.best?.value ?? null;

  // Guardrail: on card-only slips OCR can under-read GRAND lines (e.g. 785 vs 2785).
  // If grand is missing or much smaller than card, prefer card as grand.
  if (
    cardTotal != null &&
    cashTotal == null &&
    (grandTotal == null || grandTotal < cardTotal * 0.8)
  ) {
    grandTotal = cardTotal;
  }

  const cardConfidence = card.best
    ? confidenceFromScore(
        card.best.score,
        card.best.hasCurrency,
        card.best.label ? (LABELS.card.strong.includes(card.best.label) ? 2 : 1) : 1,
        card.best.offset ?? 0
      )
    : 0;
  const txConfidence = txCount != null ? 0.6 : 0;

  const overall =
    cardConfidence >= 0.8 ? "high" : cardConfidence >= 0.5 ? "medium" : "low";

  const currency = /(?:\bTL\b|₺|\bTRY\b)/i.test(text || "")
    ? "TRY"
    : DEFAULT_CURRENCY;
  const bankName = detectBankName(lines);

  return {
    extracted: {
      card_total: cardTotal,
      cash_total: cashTotal,
      grand_total: grandTotal,
      tx_count: txCount,
      refund_total: refundTotal,
      bank_name: bankName,
      currency,
    },
    confidence: {
      overall,
      card_total: cardConfidence,
      tx_count: txConfidence,
    },
    raw: {
      text_excerpt: String(text || "").slice(0, 1000),
      matched_label: card.matchedLabel || null,
      bank_name: bankName,
      debug_lines: debug
        ? lines.slice(0, 30).map((l) => l.normalized.slice(0, 140))
        : undefined,
    },
  };
}

module.exports = { parseZReportText, normalizeText, parseAmount };
