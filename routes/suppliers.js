// routes/suppliers.js
module.exports = (io) => {
  const express = require("express");
  const router = express.Router();
  const { pool } = require("../db");
  const multer = require("multer");
  const path = require("path");
  const fs = require("fs");
  const sharp = require("sharp");
  const { execFile } = require("child_process");
  const authMiddleware = require("../middleware/authMiddleware");
  const { maybeEmitExpiryAlert, normalizeExpiryDate } = require("../utils/expiryMonitor");

  let cleaningColumnsEnsured = false;
  async function ensureCleaningColumns(client) {
    if (cleaningColumnsEnsured) return;
    const runner = client || pool;
    try {
      await runner.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_cleaning_supply BOOLEAN DEFAULT FALSE`);
    } catch (err) {
      console.warn("⚠️ ensureCleaningColumns products failed:", err.message);
    }
    try {
      await runner.query(`ALTER TABLE stock ADD COLUMN IF NOT EXISTS is_cleaning_supply BOOLEAN DEFAULT FALSE`);
    } catch (err) {
      console.warn("⚠️ ensureCleaningColumns stock failed:", err.message);
    }
    cleaningColumnsEnsured = true;
  }

  // ✅ Apply tenant auth everywhere
  router.use(authMiddleware);

  // Ensure uploads folder exists
  const uploadDir = path.join(__dirname, "..", "uploads", "receipts");
  fs.mkdirSync(uploadDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname);
      cb(null, "receipt-" + uniqueSuffix + ext);
    },
  });
  const upload = multer({ storage });

  const UNIT_MAPPINGS = [
    { key: "kg", tokens: ["kg", "kilogram", "kilo"] },
    { key: "g", tokens: ["g", "gram"] },
    { key: "lt", tokens: ["lt", "liter", "litre", "l"] },
    { key: "ml", tokens: ["ml", "mil", "milliliter", "millilitre"] },
    { key: "piece", tokens: ["pcs", "pc", "adet", "piece", "unit", "paket", "pkt", "set"] },
  ];

  const normalizeUnitToken = (value) => {
    if (!value) return "piece";
    const normalized = String(value).trim().toLowerCase();
    const mapping = UNIT_MAPPINGS.find((entry) =>
      entry.tokens.some((token) => normalized === token)
    );
    return mapping ? mapping.key : "piece";
  };

  async function resolveUnitForConflict(restaurantId, ingredient, desiredUnit) {
    const normalized = normalizeUnitToken(desiredUnit);
    // Try to reuse existing unit to hit ON CONFLICT
    if (normalized === "piece") {
      const { rows } = await pool.query(
        `SELECT unit
           FROM stock
          WHERE restaurant_id = $1
            AND LOWER(BTRIM(name)) = LOWER(BTRIM($2))
            AND LOWER(BTRIM(unit)) IN ('pcs','pc','piece','unit')
          LIMIT 1`,
        [restaurantId, ingredient]
      );
      if (rows[0]?.unit) return rows[0].unit;
    }
    return normalized;
  }

const parseCurrency = (text) => {
  if (!text) return "TRY";
  const normalized = text.toLowerCase();
  if (normalized.includes("eur") || normalized.includes("€")) return "EUR";
  if (normalized.includes("usd") || normalized.includes("$")) return "USD";
    if (
      normalized.includes("try") ||
      normalized.includes("tl") ||
      normalized.includes("₺")
    ) {
      return "TRY";
    }
    return "TRY";
  };

  const detectDate = (lines) => {
    const joined = Array.isArray(lines) ? lines.join(" ") : String(lines || "");
    const isoMatch = joined.match(/\d{4}[-/]\d{2}[-/]\d{2}/);
    if (isoMatch) {
      return isoMatch[0].replace(/\//g, "-");
    }
    const altMatch = joined.match(/\d{2}[./-]\d{2}[./-]\d{4}/);
    if (altMatch) {
      const parts = altMatch[0].replace(/[./]/g, "-").split("-");
      if (parts.length === 3) {
        const numericFirst = Number(parts[0]) > 12;
        const day = numericFirst ? parts[0] : parts[1];
        const month = numericFirst ? parts[1] : parts[0];
        const year = parts[2];
        return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
      }
    }
    return null;
  };

  const sanitizeNumber = (value) => {
    if (value === null || value === undefined) return null;
    const normalized = String(value).replace(",", ".").replace(/[^\d.]/g, "");
    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const applyDigitSwaps = (value) =>
    String(value || "").replace(/[Oo]/g, "0").replace(/[İIıl]/g, "1").replace(/S/g, "5");

  const normalizeNumberString = (value) => {
    let raw = applyDigitSwaps(String(value || "").trim());
    if (!raw) return "";
    raw = raw.replace(/\s+/g, "");
    raw = raw.replace(/[^0-9,.\-]/g, "");
    if (!raw) return "";

    const negative = raw.startsWith("-");
    raw = raw.replace(/-/g, "");
    if (!raw) return "";

    const hasComma = raw.includes(",");
    const hasDot = raw.includes(".");
    const commaCount = (raw.match(/,/g) || []).length;
    const dotCount = (raw.match(/\./g) || []).length;

    if (hasComma && hasDot) {
      const lastComma = raw.lastIndexOf(",");
      const lastDot = raw.lastIndexOf(".");
      if (lastComma > lastDot) {
        const intPart = raw.slice(0, lastComma).replace(/[.,]/g, "");
        const fracPart = raw.slice(lastComma + 1).replace(/[.,]/g, "");
        raw = fracPart ? `${intPart}.${fracPart}` : intPart;
      } else {
        const intPart = raw.slice(0, lastDot).replace(/[.,]/g, "");
        const fracPart = raw.slice(lastDot + 1).replace(/[.,]/g, "");
        raw = fracPart ? `${intPart}.${fracPart}` : intPart;
      }
    } else if (hasComma) {
      if (commaCount > 1) {
        const lastComma = raw.lastIndexOf(",");
        const intPart = raw.slice(0, lastComma).replace(/,/g, "");
        const fracPart = raw.slice(lastComma + 1).replace(/,/g, "");
        raw = fracPart ? `${intPart}.${fracPart}` : intPart;
      } else {
        const lastComma = raw.lastIndexOf(",");
        const decimals = raw.length - lastComma - 1;
        if (decimals === 0) {
          raw = raw.replace(/,/g, "");
        } else if (decimals === 3 && raw.slice(0, lastComma).replace(/\D/g, "").length <= 2) {
          // Common OCR thousand separator artifact like 2,330.
          raw = raw.replace(/,/g, "");
        } else {
          raw = raw.replace(",", ".");
        }
      }
    } else if (hasDot && dotCount > 1) {
      const lastDot = raw.lastIndexOf(".");
      const intPart = raw.slice(0, lastDot).replace(/\./g, "");
      const fracPart = raw.slice(lastDot + 1).replace(/\./g, "");
      raw = fracPart ? `${intPart}.${fracPart}` : intPart;
    }

    return negative ? `-${raw}` : raw;
  };

  const parseOcrNumber = (value) => {
    const normalized = normalizeNumberString(value);
    if (!normalized) return null;
    const num = parseFloat(normalized);
    return Number.isFinite(num) ? num : null;
  };

  const parseJsonFromStdout = (stdout) => {
    const text = String(stdout || "").trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      // Fallback for noisy output where JSON is wrapped by extra log lines.
      const firstBrace = text.indexOf("{");
      const lastBrace = text.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        const candidate = text.slice(firstBrace, lastBrace + 1);
        try {
          return JSON.parse(candidate);
        } catch (_) {
          return null;
        }
      }
      return null;
    }
  };

  const parseOptionalJson = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "object") return value;
    const raw = String(value).trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  };

  const isMissingReceiptImportsSchemaError = (err) => {
    const code = String(err?.code || "");
    const message = String(err?.message || "").toLowerCase();
    return (
      code === "42P01" || // undefined_table
      code === "42703" || // undefined_column
      code === "42704" || // undefined_object
      message.includes("receipt_imports") && message.includes("does not exist")
    );
  };

  const tailText = (value, maxChars = 2000) => {
    const text = String(value || "");
    if (text.length <= maxChars) return text;
    return text.slice(-maxChars);
  };

  const shouldRetryWithForcedTesseract = (pythonMeta) => {
    if (!pythonMeta || typeof pythonMeta !== "object") return false;
    if (pythonMeta.force_tesseract) return false;
    if (pythonMeta.timed_out) return true;
    if (pythonMeta.signal === "SIGSEGV") return true;
    if (pythonMeta.exit_code === 139) return true;
    if (pythonMeta.stdout_bytes === 0) return true;
    return false;
  };

  const KOLI_QTY_REGEX = /(\d+(?:[.,]\d+)?)\s*kol(?:i|ı|1|l)?[a-zçğıöşüıi1l]*\b/i;

  const extractNumbersWithIdx = (line) => {
    const results = [];
    const regex = /-?\d[\d.,]*/g;
    let match;
    while ((match = regex.exec(line)) !== null) {
      const value = parseOcrNumber(match[0]);
      results.push({ value, index: match.index, raw: match[0] });
    }
    return results;
  };

  const containsAny = (text, tokens) =>
    tokens.some((t) => text.includes(t.toLowerCase()));

  const normalizeTextKey = (value) => {
    if (!value) return "";
    return String(value)
      .toLowerCase()
      .replace(/[ğĞ]/g, "g")
      .replace(/[şŞ]/g, "s")
      .replace(/[ıİ]/g, "i")
      .replace(/[çÇ]/g, "c")
      .replace(/[öÖ]/g, "o")
      .replace(/[üÜ]/g, "u")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  let ensureSupplierLearningTablesPromise = null;
  const ensureSupplierLearningTables = async () => {
    if (!ensureSupplierLearningTablesPromise) {
      ensureSupplierLearningTablesPromise = (async () => {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS supplier_invoice_templates (
            id SERIAL PRIMARY KEY,
            restaurant_id INTEGER NOT NULL,
            supplier_id INTEGER NOT NULL,
            profile JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await pool.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS supplier_invoice_templates_unique
            ON supplier_invoice_templates (restaurant_id, supplier_id)
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS supplier_product_mappings (
            id SERIAL PRIMARY KEY,
            restaurant_id INTEGER NOT NULL,
            supplier_id INTEGER NOT NULL,
            supplier_product_code TEXT NOT NULL DEFAULT '',
            supplier_product_name_normalized TEXT NOT NULL DEFAULT '',
            supplier_product_name_raw TEXT,
            ingredient_id INTEGER,
            ingredient_name TEXT NOT NULL,
            ingredient_unit TEXT NOT NULL,
            units_per_case NUMERIC,
            mapped_unit TEXT,
            conversion_multiplier NUMERIC,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await pool.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS supplier_product_mappings_unique
            ON supplier_product_mappings (
              restaurant_id,
              supplier_id,
              supplier_product_code,
              supplier_product_name_normalized
            )
        `);
      })().catch((err) => {
        ensureSupplierLearningTablesPromise = null;
        throw err;
      });
    }
    return ensureSupplierLearningTablesPromise;
  };

  const toFiniteNumber = (value) => {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  const round2 = (value) => {
    const n = toFiniteNumber(value);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100) / 100;
  };

  const parseNumberWithLocale = (value, localeRules = {}) => {
    let raw = String(value || "").trim();
    if (!raw) return null;
    raw = applyDigitSwaps(raw);
    const decimalSep = String(localeRules.decimal_separator || ",").trim();
    raw = raw.replace(/[^\d.,\-]/g, "");
    if (!raw) return null;

    if (decimalSep === ",") {
      if (raw.includes(".") && raw.includes(",")) {
        raw = raw.replace(/\./g, "").replace(",", ".");
      } else if (raw.includes(",")) {
        raw = raw.replace(",", ".");
      }
    } else if (decimalSep === ".") {
      if (raw.includes(",") && raw.includes(".")) {
        raw = raw.replace(/,/g, "");
      } else if (raw.includes(",")) {
        raw = raw.replace(/,/g, ".");
      }
    } else {
      raw = normalizeNumberString(raw);
    }

    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const normalizeOcrWord = (word) => {
    const text = String(word?.text || "").trim();
    const x0 = toFiniteNumber(word?.x0);
    const x1 = toFiniteNumber(word?.x1);
    const y0 = toFiniteNumber(word?.y0);
    const y1 = toFiniteNumber(word?.y1);
    if (!text || !Number.isFinite(x0) || !Number.isFinite(x1) || !Number.isFinite(y0) || !Number.isFinite(y1)) {
      return null;
    }
    return {
      text,
      x0: Math.min(x0, x1),
      x1: Math.max(x0, x1),
      y0: Math.min(y0, y1),
      y1: Math.max(y0, y1),
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
    };
  };

  const groupWordsByRow = (words, tolerance = 10) => {
    const sorted = [...words].sort((a, b) => (a.cy - b.cy) || (a.x0 - b.x0));
    const rows = [];
    for (const word of sorted) {
      const last = rows[rows.length - 1];
      if (!last || Math.abs(last.cy - word.cy) > tolerance) {
        rows.push({ cy: word.cy, words: [word] });
      } else {
        last.words.push(word);
        last.cy = (last.cy * (last.words.length - 1) + word.cy) / last.words.length;
      }
    }
    return rows.map((row) => ({
      cy: row.cy,
      words: row.words.sort((a, b) => a.x0 - b.x0),
      text: row.words.map((w) => w.text).join(" ").trim(),
    }));
  };

  const findTemplateHeaderY = (words, headerKeywords = []) => {
    if (!Array.isArray(words) || words.length === 0) return null;
    const keys = (Array.isArray(headerKeywords) ? headerKeywords : [])
      .map((k) => normalizeTextKey(k))
      .filter(Boolean);
    if (!keys.length) return null;

    let best = null;
    for (const word of words) {
      const wKey = normalizeTextKey(word.text);
      if (!wKey) continue;
      if (!keys.some((k) => wKey.includes(k) || k.includes(wKey))) continue;
      if (!best || word.cy < best.cy) {
        best = word;
      }
    }
    return best ? best.cy : null;
  };

  const inferTemplateFromWords = (words) => {
    if (!Array.isArray(words) || words.length === 0) return null;
    const normalizedWords = words.map(normalizeOcrWord).filter(Boolean);
    if (!normalizedWords.length) return null;
    const rows = groupWordsByRow(normalizedWords, 12);
    const headerRow = rows.find((row) => {
      const key = normalizeTextKey(row.text);
      return (
        key.includes("kod") &&
        (key.includes("mal") || key.includes("urun")) &&
        (key.includes("kdv") || key.includes("tutar"))
      );
    });
    if (!headerRow) return null;

    const tokens = headerRow.words.map((w) => ({
      ...w,
      key: normalizeTextKey(w.text),
    }));
    const getRange = (predicates) => {
      const hit = tokens.find((w) => predicates.some((p) => w.key.includes(p)));
      if (!hit) return null;
      return { min: Math.max(0, Math.floor(hit.x0 - 10)), max: Math.ceil(hit.x1 + 20) };
    };

    const codeRange = getRange(["kod"]);
    const qtyRange = getRange(["miktar", "adet", "koli", "qty"]);
    const vatRange = getRange(["kdv"]);
    const totalRange = getRange(["tutar", "toplam"]);
    const unitPriceRange = getRange(["birim fiyat", "fiyat"]);

    const ranges = [codeRange, qtyRange, unitPriceRange, vatRange, totalRange].filter(Boolean);
    if (!ranges.length) return null;
    const left = Math.min(...ranges.map((r) => r.min));
    const right = Math.max(...ranges.map((r) => r.max));
    const descriptionRange = {
      min: codeRange ? codeRange.max + 1 : left,
      max: qtyRange ? qtyRange.min - 1 : right,
    };

    return {
      table: {
        header_anchor_keywords: ["kod", "mal", "kdv", "tutar"],
        row_stop_keywords: ["mal hizmet toplam", "vergiler dahil", "odenecek tutar"],
      },
      columns: {
        code: codeRange,
        description: descriptionRange,
        qty: qtyRange,
        units_per_case: null,
        unit_price: unitPriceRange,
        vat_percent: vatRange,
        line_total: totalRange,
      },
      locale: {
        decimal_separator: ",",
        currency_symbols: ["TL", "₺"],
        percent_sign: "%",
      },
      source: "ocr_inferred",
      inferred_at: new Date().toISOString(),
    };
  };

  const parseItemsFromTemplateWithWords = (words, profile = {}) => {
    const normalizedWords = (Array.isArray(words) ? words : [])
      .map(normalizeOcrWord)
      .filter(Boolean);
    if (!normalizedWords.length) return { items: [], rejected: [], applied: false, reason: "NO_WORDS" };

    const table = profile?.table || {};
    const columns = profile?.columns || {};
    const localeRules = profile?.locale || {};

    const headerKeywords = Array.isArray(table.header_anchor_keywords)
      ? table.header_anchor_keywords
      : ["kod", "mal", "urun"];
    const stopKeywords = Array.isArray(table.row_stop_keywords)
      ? table.row_stop_keywords
      : ["mal hizmet toplam", "vergiler dahil", "odenecek tutar"];

    const headerY = findTemplateHeaderY(normalizedWords, headerKeywords);
    if (!Number.isFinite(headerY)) {
      return { items: [], rejected: [], applied: false, reason: "NO_HEADER_ANCHOR" };
    }
    const startY = headerY + 8;

    let stopY = null;
    for (const word of normalizedWords) {
      if (word.cy <= startY) continue;
      const wKey = normalizeTextKey(word.text);
      if (stopKeywords.some((k) => wKey.includes(normalizeTextKey(k)))) {
        if (!Number.isFinite(stopY) || word.cy < stopY) stopY = word.cy;
      }
    }
    if (!Number.isFinite(stopY)) {
      stopY = Math.max(...normalizedWords.map((w) => w.cy)) + 1;
    }

    const tableWords = normalizedWords.filter((w) => w.cy >= startY && w.cy <= stopY);
    const rows = groupWordsByRow(tableWords, 10);

    const toTextInRange = (rowWords, range) => {
      if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return "";
      return rowWords
        .filter((w) => w.cx >= range.min && w.cx <= range.max)
        .map((w) => w.text)
        .join(" ")
        .trim();
    };

    const items = [];
    const rejected = [];
    for (const row of rows) {
      if (!row?.words?.length) continue;
      const codeText = toTextInRange(row.words, columns.code);
      const nameText = toTextInRange(row.words, columns.description);
      const qtyText = toTextInRange(row.words, columns.qty);
      const upcText = toTextInRange(row.words, columns.units_per_case);
      const unitPriceText = toTextInRange(row.words, columns.unit_price);
      const vatText = toTextInRange(row.words, columns.vat_percent);
      const totalText = toTextInRange(row.words, columns.line_total);

      const name = String(nameText || "").replace(/\s+/g, " ").trim();
      if (!name || name.length < 2) {
        rejected.push({ line: row.text, reason: "no_name" });
        continue;
      }

      const qtyCases = parseNumberWithLocale(qtyText, localeRules);
      const unitsPerCase = parseNumberWithLocale(upcText, localeRules);
      let qtyUnits = qtyCases;
      let unit = "piece";
      if (Number.isFinite(unitsPerCase) && Number.isFinite(qtyCases) && unitsPerCase > 0 && qtyCases > 0) {
        qtyUnits = qtyCases * unitsPerCase;
        unit = "case";
      } else if (!Number.isFinite(qtyUnits) || qtyUnits <= 0) {
        qtyUnits = 1;
      }

      const item = {
        code: String(codeText || "").trim() || null,
        name,
        qty_cases: Number.isFinite(qtyCases) && qtyCases > 0 ? qtyCases : null,
        units_per_case: Number.isFinite(unitsPerCase) && unitsPerCase > 1 ? unitsPerCase : null,
        qty_units: qtyUnits,
        unit,
        unit_price_ex_vat: parseNumberWithLocale(unitPriceText, localeRules),
        discount_rate: null,
        vat_rate: parseNumberWithLocale(vatText, localeRules),
        line_total_inc_vat: parseNumberWithLocale(totalText, localeRules),
      };

      if (!Number.isFinite(item.line_total_inc_vat) || item.line_total_inc_vat <= 0) {
        rejected.push({ line: row.text, reason: "no_total" });
        continue;
      }
      items.push(item);
    }

    return {
      items,
      rejected,
      applied: items.length > 0,
      reason: items.length > 0 ? null : "NO_ROWS_PARSED",
    };
  };

  const attachSupplierProductMappings = (items, mappings) => {
    const byCode = new Map();
    const byName = new Map();
    for (const map of Array.isArray(mappings) ? mappings : []) {
      const code = String(map?.supplier_product_code || "").trim();
      const nameKey = normalizeTextKey(map?.supplier_product_name_normalized || map?.supplier_product_name_raw || "");
      if (code && !byCode.has(code)) byCode.set(code, map);
      if (nameKey && !byName.has(nameKey)) byName.set(nameKey, map);
    }

    return (Array.isArray(items) ? items : []).map((item) => {
      const code = String(item?.code || "").trim();
      const nameKey = normalizeTextKey(item?.name || "");
      const match = (code && byCode.get(code)) || byName.get(nameKey) || null;
      if (!match) return item;
      return {
        ...item,
        matched_mapping: {
          id: match.id,
          ingredient_id: match.ingredient_id || null,
          ingredient: match.ingredient_name,
          unit: match.ingredient_unit,
          units_per_case: toFiniteNumber(match.units_per_case),
          mapped_unit: match.mapped_unit || null,
          conversion_multiplier: toFiniteNumber(match.conversion_multiplier),
          supplier_product_code: match.supplier_product_code || "",
          supplier_product_name_raw: match.supplier_product_name_raw || "",
        },
      };
    });
  };

  const parseInvoiceTableItems = (text) => {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/\s+/g, " "))
      .filter(Boolean);

    const mergeTableLines = (input) => {
      const merged = [];
      let current = "";
      const looksLikeItemRow = (line) => {
        if (!line) return false;
        const hasAmountTail = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*(?:tl|₺)?\s*$/i.test(
          line
        );
        if (!hasAmountTail) return false;
        return /\b(koli|kutu|pet|dys|remix|sugar|cola|damla|seft|ml|lt|kg|gr)\b|\b\d+\s*[xX]\s*\d+\b/i.test(
          line
        );
      };
      const isRowStart = (line) =>
        /\b\d{5,8}\b/.test(line) ||
        /^\d+\s*\|/.test(line) ||
        KOLI_QTY_REGEX.test(line) ||
        looksLikeItemRow(line);
      for (const line of input) {
        if (!line) continue;
        const digits = (line.match(/\d/g) || []).length;
        const letters = (line.match(/[A-Za-zÇĞİÖŞÜçğıöşü]/g) || []).length;
        const currentLooksComplete = looksLikeItemRow(current);
        if (isRowStart(line)) {
          if (current) merged.push(current.trim());
          current = line;
          continue;
        }
        if (!current) {
          current = line;
          continue;
        }
        const currentHasCode = /\b\d{5,8}\b/.test(current);
        const lineHasCode = /\b\d{5,8}\b/.test(line);
        if (!currentLooksComplete && digits <= 1 && letters >= 2) {
          current = `${current} ${line}`;
          continue;
        }
        if (!currentLooksComplete && currentHasCode && !lineHasCode) {
          current = `${current} ${line}`;
          continue;
        }
        merged.push(current.trim());
        current = line;
      }
      if (current) merged.push(current.trim());
      return merged;
    };

    const hasStrongName = (value) => {
      const raw = String(value || "").replace(/[-–—|]+/g, " ").replace(/\s+/g, " ").trim();
      if (!raw) return false;
      const letters = (raw.match(/[A-Za-zÇĞİÖŞÜçğıöşü]/g) || []).length;
      if (letters < 3) return false;
      const words = raw.split(/\s+/).filter(Boolean);
      const alphaLens = words
        .map((w) => (w.match(/[A-Za-zÇĞİÖŞÜçğıöşü]/g) || []).length)
        .filter((n) => n > 0);
      const longWords = alphaLens.filter((n) => n >= 3).length;
      const singleLetters = alphaLens.filter((n) => n === 1).length;
      if (longWords < 1) return false;
      if (singleLetters > longWords + 1) return false;
      return true;
    };

    const normalizeNameCandidate = (value) =>
      String(value || "")
        .replace(/^\s*[\[(]?\d+\s*[|.)]?\s*/, " ")
        .replace(/\b\d{5,8}\b/g, " ")
        .replace(/[-–—|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const sanitizeTableName = (value) => {
      const base = normalizeNameCandidate(value);
      if (!base) return "";
      const tokens = base.split(/\s+/).filter(Boolean);
      const kept = [];
      for (const token of tokens) {
        const t = String(token || "").trim();
        if (!t) continue;
        if (/^(tl|₺|kdv|oran[ıi]?|tutar[ıi]?|iskonto)$/i.test(t)) break;
        if (/^%/.test(t)) break;
        if (/^\d{1,3}(?:[.,]\d{2,3})+$/.test(t)) break;
        if (/^\d+(?:[.,]\d+)?$/.test(t)) continue;
        kept.push(t);
      }
      const name = kept.join(" ").replace(/\s+/g, " ").replace(/[>]+$/g, "").trim();
      const key = normalizeTextKey(name);
      if (/^\d+\s*x\s*\d+(?:\s+[a-z]{1,4})?$/.test(key)) return "";
      return name;
    };

    const nameQualityScore = (value) => {
      const cleaned = sanitizeTableName(value);
      if (!cleaned) return -100;
      const key = normalizeTextKey(cleaned);
      const words = key.split(" ").filter(Boolean);
      const letters = (key.match(/[a-z]/g) || []).length;
      const longWords = words.filter((w) => w.length >= 4).length;
      const shortWords = words.filter((w) => w.length <= 2).length;
      const hasPackOnly = /\b\d+\s*[xX]\s*\d+\b/.test(cleaned);
      return (
        letters +
        (longWords * 4) -
        (shortWords * 1.5) -
        (hasPackOnly ? 8 : 0)
      );
    };

    const scoreParseResult = (result) => {
      const rows = Array.isArray(result?.items) ? result.items : [];
      if (!rows.length) return -100000;
      const badNameTokens = [
        "fatura",
        "musteri",
        "müsteri",
        "banka",
        "iban",
        "vkn",
        "vergi",
        "tarih",
        "saat",
        "odeme",
        "ödeme",
        "adres",
      ];
      let score = rows.length * 100;
      for (const row of rows) {
        const key = normalizeTextKey(row?.name || "");
        const letters = (key.match(/[a-z]/g) || []).length;
        const total = parseOcrNumber(row?.line_total_inc_vat);
        const qty = parseOcrNumber(row?.qty_units ?? row?.qty_cases);
        if (letters >= 3) score += 15;
        else score -= 50;
        if (Number.isFinite(total) && total > 0) score += 10;
        else score -= 25;
        if (Number.isFinite(qty) && qty > 0) score += 5;
        if (row?.code) score += 8;
        if (containsAny(key, badNameTokens)) score -= 80;
      }
      return score;
    };

    const pickBestResult = (candidates) => {
      const list = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
      if (!list.length) return { items: [], rejected: [] };
      let best = list[0];
      let bestScore = scoreParseResult(best);
      for (let i = 1; i < list.length; i += 1) {
        const current = list[i];
        const currentScore = scoreParseResult(current);
        if (currentScore > bestScore) {
          best = current;
          bestScore = currentScore;
        }
      }
      return best;
    };

    const mergeParseResults = (...results) => {
      const mergedItems = [];
      const mergedRejected = [];
      for (const result of results) {
        if (!result) continue;
        const rows = Array.isArray(result.items) ? result.items : [];
        for (const row of rows) {
          const nameKey = normalizeTextKey(row?.name || "");
          const totalKey = parseOcrNumber(row?.line_total_inc_vat) || 0;
          if (!nameKey || !Number.isFinite(totalKey) || totalKey <= 0) continue;
          const existingIdx = mergedItems.findIndex((existing) => {
            const existingName = normalizeTextKey(existing?.name || "");
            const existingTotal = parseOcrNumber(existing?.line_total_inc_vat) || 0;
            if (Math.abs(existingTotal - totalKey) > 0.02) return false;
            return (
              existingName === nameKey ||
              existingName.includes(nameKey) ||
              nameKey.includes(existingName)
            );
          });
          if (existingIdx === -1) {
            mergedItems.push(row);
            continue;
          }
          const existing = mergedItems[existingIdx];
          const rowScore =
            (String(row?.code || "").trim() ? 5 : 0) +
            ((nameKey.match(/[a-z]/g) || []).length >= 6 ? 3 : 0) +
            (Number.isFinite(parseOcrNumber(row?.qty_units ?? row?.qty_cases)) ? 2 : 0);
          const existingName = normalizeTextKey(existing?.name || "");
          const existingScore =
            (String(existing?.code || "").trim() ? 5 : 0) +
            ((existingName.match(/[a-z]/g) || []).length >= 6 ? 3 : 0) +
            (Number.isFinite(parseOcrNumber(existing?.qty_units ?? existing?.qty_cases)) ? 2 : 0);
          if (rowScore > existingScore) {
            mergedItems[existingIdx] = row;
          }
        }
        if (Array.isArray(result.rejected)) {
          mergedRejected.push(...result.rejected);
        }
      }
      return { items: mergedItems, rejected: mergedRejected };
    };

    const scoreItemQuality = (row) => {
      const name = String(row?.name || "");
      const key = normalizeTextKey(name);
      const total = parseOcrNumber(row?.line_total_inc_vat);
      const qty = parseOcrNumber(row?.qty_units ?? row?.qty_cases);
      let score = 0;
      if (String(row?.code || "").trim()) score += 30;
      if (hasStrongName(name)) score += 20;
      score += Math.min((key.match(/[a-z]/g) || []).length, 20);
      if (Number.isFinite(total) && total >= 10) score += 10;
      if (Number.isFinite(qty) && qty > 1) score += 5;
      if (/^[^A-Za-zÇĞİÖŞÜçğıöşü]/.test(name)) score -= 8;
      return score;
    };

    const finalizeParseResult = (result) => {
      const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
      const sourceItems = Array.isArray(result?.items) ? result.items : [];
      let items = sourceItems
        .map((row) => ({
          ...row,
          name: sanitizeTableName(
            String(row?.name || "")
              .replace(/[-–—|]+/g, " ")
              .replace(/\s+/g, " ")
              .trim()
          ),
        }))
        .filter((row) => hasStrongName(row.name))
        .filter((row) => {
          const key = normalizeTextKey(row?.name || "");
          return !/^\d+\s*x\s*\d+(?:\s+[a-z]{1,4})?$/.test(key);
        })
        .filter((row) => {
          const total = parseOcrNumber(row?.line_total_inc_vat);
          return Number.isFinite(total) && total > 0;
        });

      const qtyDonorByTotal = new Map();
      for (const row of sourceItems) {
        const total = parseOcrNumber(row?.line_total_inc_vat);
        if (!Number.isFinite(total) || total <= 0) continue;
        const qc = parseOcrNumber(row?.qty_cases);
        const upc = parseOcrNumber(row?.units_per_case);
        const hasUsefulQty = (Number.isFinite(qc) && qc > 1) || (Number.isFinite(upc) && upc > 1);
        if (!hasUsefulQty) continue;
        const key = total.toFixed(2);
        const existing = qtyDonorByTotal.get(key);
        const score =
          (Number.isFinite(qc) && qc > 1 ? 2 : 0) +
          (Number.isFinite(upc) && upc > 1 ? 2 : 0) +
          (String(row?.code || "").trim() ? 1 : 0);
        if (!existing || score > existing.score) {
          qtyDonorByTotal.set(key, { row, score });
        }
      }

      items = items.map((row) => {
        const total = parseOcrNumber(row?.line_total_inc_vat);
        const key = Number.isFinite(total) && total > 0 ? total.toFixed(2) : null;
        const donor = key ? qtyDonorByTotal.get(key)?.row : null;
        let qtyCases = parseOcrNumber(row?.qty_cases);
        let unitsPerCase = parseOcrNumber(row?.units_per_case);
        if (
          donor &&
          ((!Number.isFinite(qtyCases) || qtyCases <= 1) || (!Number.isFinite(unitsPerCase) || unitsPerCase <= 1))
        ) {
          const donorQc = parseOcrNumber(donor?.qty_cases);
          const donorUpc = parseOcrNumber(donor?.units_per_case);
          if ((!Number.isFinite(qtyCases) || qtyCases <= 1) && Number.isFinite(donorQc) && donorQc > 1) {
            qtyCases = donorQc;
          }
          if ((!Number.isFinite(unitsPerCase) || unitsPerCase <= 1) && Number.isFinite(donorUpc) && donorUpc > 1) {
            unitsPerCase = donorUpc;
          }
        }

        const packInName = String(row?.name || "").match(/\b(\d+(?:[.,]\d+)?)\s*[xX]\s*(\d+(?:[.,]\d+)?)\b/);
        if ((!Number.isFinite(unitsPerCase) || unitsPerCase <= 1) && packInName) {
          const nameUpc = parseOcrNumber(packInName[2]);
          if (Number.isFinite(nameUpc) && nameUpc > 1 && nameUpc <= 200) {
            unitsPerCase = nameUpc;
          }
        }
        if (Number.isFinite(unitsPerCase) && unitsPerCase > 1 && !packInName) {
          const roundedUpc = Math.round(unitsPerCase);
          if (Math.abs(unitsPerCase - roundedUpc) <= 0.05 && roundedUpc <= 200) {
            unitsPerCase = roundedUpc;
          } else {
            // Drop noisy OCR values like discount/price percentages misread as units-per-case.
            unitsPerCase = null;
          }
        }

        let qtyUnits = parseOcrNumber(row?.qty_units);
        let unit = row?.unit || "piece";
        if (Number.isFinite(unitsPerCase) && unitsPerCase > 1) {
          if (!Number.isFinite(qtyCases) || qtyCases <= 0) qtyCases = 1;
          qtyUnits = qtyCases * unitsPerCase;
          unit = "case";
        } else if (!Number.isFinite(qtyUnits) || qtyUnits <= 0) {
          qtyUnits = Number.isFinite(qtyCases) && qtyCases > 0 ? qtyCases : 1;
        }
        let unitPrice = parseOcrNumber(row?.unit_price_ex_vat);
        const totalValue = parseOcrNumber(row?.line_total_inc_vat);
        const qtyForPrice = Number.isFinite(qtyCases) && qtyCases > 0 ? qtyCases : qtyUnits;
        if (
          Number.isFinite(totalValue) &&
          totalValue > 0 &&
          Number.isFinite(qtyForPrice) &&
          qtyForPrice > 0
        ) {
          const implied = totalValue / qtyForPrice;
          if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
            unitPrice = implied;
          } else {
            const drift = Math.abs(unitPrice - implied) / Math.max(unitPrice, implied, 0.0001);
            if (drift > 0.65) {
              unitPrice = implied;
            }
          }
        }

        return {
          ...row,
          qty_cases:
            Number.isFinite(qtyCases) && qtyCases > 0
              ? qtyCases
              : unit === "case"
                ? 1
                : null,
          units_per_case: Number.isFinite(unitsPerCase) && unitsPerCase > 1 ? unitsPerCase : null,
          qty_units: Number.isFinite(qtyUnits) && qtyUnits > 0 ? qtyUnits : 1,
          unit,
          unit_price_ex_vat: Number.isFinite(unitPrice) && unitPrice > 0 ? Number(unitPrice.toFixed(3)) : null,
        };
      });

      const hasMediumTotals = items.some((row) => (parseOcrNumber(row?.line_total_inc_vat) || 0) >= 10);
      if (hasMediumTotals) {
        items = items.filter((row) => (parseOcrNumber(row?.line_total_inc_vat) || 0) >= 10);
      }

      // If a total appears in both coded and non-coded rows, keep stronger rows for that total.
      const byTotal = new Map();
      for (const row of items) {
        const total = parseOcrNumber(row?.line_total_inc_vat);
        if (!Number.isFinite(total) || total <= 0) continue;
        const key = total.toFixed(2);
        const bucket = byTotal.get(key) || [];
        bucket.push(row);
        byTotal.set(key, bucket);
      }
      const shadowDrop = new Set();
      for (const bucket of byTotal.values()) {
        if (bucket.length < 2) continue;
        const coded = bucket.filter((r) => String(r?.code || "").trim());
        if (!coded.length) continue;
        const codedBestScore = Math.max(...coded.map((r) => scoreItemQuality(r)));
        for (const row of bucket) {
          if (String(row?.code || "").trim()) continue;
          const s = scoreItemQuality(row);
          if (s < codedBestScore - 5) {
            shadowDrop.add(row);
          }
        }
      }
      if (shadowDrop.size > 0) {
        items = items.filter((row) => !shadowDrop.has(row));
      }

      if (items.length > 6) {
        const byTotal = new Map();
        for (const row of items) {
          const total = parseOcrNumber(row?.line_total_inc_vat) || 0;
          const key = total.toFixed(2);
          const existing = byTotal.get(key);
          if (!existing || scoreItemQuality(row) > scoreItemQuality(existing)) {
            byTotal.set(key, row);
          }
        }
        items = [...byTotal.values()];
      }

      items.sort((a, b) => scoreItemQuality(b) - scoreItemQuality(a));
      return { items, rejected };
    };

    // Deterministic column parser for Coca-Cola style table
    const parseFixedColumns = () => {
      const items = [];
      const rejected = [];
      // Find table block: from first line containing "kod" & "mal" to line containing "mal hizmet toplam"
      const startIdx = lines.findIndex((l) => {
        const k = normalizeTextKey(l);
        return k.includes("kod") && (k.includes("mal") || k.includes("urun"));
      });
      const endIdx = lines.findIndex((l) => normalizeTextKey(l).includes("mal hizmet toplam"));
      if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return { items, rejected };

      const tableLines = mergeTableLines(lines.slice(startIdx + 1, endIdx));

      tableLines.forEach((rawLine) => {
        if (!rawLine) return;
        const tokens = rawLine.split(/\s+/);
        // Need at least: Sira, code, name..., qty, unitsPerCase, unitPrice, discount, discountAmt, kdvRate, kdvAmt, total
        if (tokens.length < 8) {
          rejected.push({ line: rawLine, reason: "too few tokens" });
          return;
        }

        // SiraNo (first token) may be non-numeric; skip it
        let idx = 0;
        if (/^\d+$/.test(tokens[0])) idx = 1;

        const code = tokens[idx];
        if (!/^\d{5,8}$/.test(code)) {
          rejected.push({ line: rawLine, reason: "no code" });
          return;
        }

        // From end: total, kdv_tutar, kdv_oran, iskonto_tutar, iskonto_oran, unit_price, units_per_case, qty
        const totalStr = tokens[tokens.length - 1];
        const kdvTutarStr = tokens[tokens.length - 2];
        const kdvOranStr = tokens[tokens.length - 3];
        const iskontoTutarStr = tokens[tokens.length - 4];
        const iskontoOranStr = tokens[tokens.length - 5];
        const unitPriceStr = tokens[tokens.length - 6];
        const unitsPerCaseStr = tokens[tokens.length - 7];
        const qtyStr = tokens[tokens.length - 8];

        const total = parseOcrNumber(totalStr);
        const qtyCases = parseOcrNumber(qtyStr);
        const unitsPerCase = parseOcrNumber(unitsPerCaseStr);
        const unitPrice = parseOcrNumber(unitPriceStr);
        const kdvRate = parseOcrNumber(kdvOranStr);

        if (!total || !qtyCases || !unitsPerCase) {
          rejected.push({ line: rawLine, reason: "missing totals/qty" });
          return;
        }

        const nameTokens = tokens.slice(idx + 1, tokens.length - 8);
        const name = nameTokens.join(" ").replace(/\s+/g, " ").trim();
        if (!name || name.length < 3) {
          rejected.push({ line: rawLine, reason: "no name" });
          return;
        }

        items.push({
          code,
          name,
          qty_cases: qtyCases,
          units_per_case: unitsPerCase,
          qty_units: qtyCases * unitsPerCase,
          unit: "piece",
          unit_price_ex_vat: unitPrice,
          discount_rate: parseOcrNumber(iskontoOranStr),
          vat_rate: kdvRate,
          line_total_inc_vat: total,
        });
      });

      return { items, rejected };
    };

    // Numbered e-Fatura table parser:
    // "No | Urun Kodu | Mal Hizmet | Miktar Koli | ... | Toplam Tutar"
    const parseNumberedCodeRows = () => {
      const items = [];
      const rejected = [];

      const headerIdx = lines.findIndex((line) => {
        const key = normalizeTextKey(line);
        return (
          (
            key.includes("urun kodu") ||
            key.includes("urunkodu") ||
            (key.includes("kod") && (key.includes("mal hizmet") || key.includes("malhizmet")))
          ) &&
          (key.includes("miktar") || key.includes("koli")) &&
          key.includes("tutar")
        );
      });
      if (headerIdx === -1) return { items, rejected };

      const endIdx = (() => {
        for (let i = headerIdx + 1; i < lines.length; i += 1) {
          const key = normalizeTextKey(lines[i]);
          if (
            key.includes("mal hizmet toplam") ||
            key.includes("hesaplanan kdv") ||
            key.includes("vergiler dahil") ||
            key.includes("odenecek tutar") ||
            key.includes("genel toplam")
          ) {
            return i;
          }
        }
        return lines.length;
      })();

      const rowStartRegex = /^\s*\d{1,3}(?:[.)-])?\s+(?:\d{5,8}\s+)?[A-Za-zÇĞİÖŞÜçğıöşü]/i;
      const tableLines = lines
        .slice(headerIdx + 1, endIdx)
        .map((line) => String(line || "").trim())
        .filter(Boolean);

      const rowChunks = [];
      let current = [];
      for (const line of tableLines) {
        if (rowStartRegex.test(line)) {
          if (current.length > 0) rowChunks.push(current.join(" "));
          current = [line];
        } else if (current.length > 0) {
          current.push(line);
        }
      }
      if (current.length > 0) rowChunks.push(current.join(" "));

      const dedupe = new Set();
      for (const chunk of rowChunks) {
        const rawLine = String(chunk || "").replace(/\s+/g, " ").trim();
        if (!rawLine) continue;

        const codeMatch = rawLine.match(/\b(\d{5,8})\b/);
        const code = codeMatch ? codeMatch[1] : null;
        if (!code) {
          rejected.push({ line: rawLine, reason: "no code" });
          continue;
        }

        const koliMatch = rawLine.match(KOLI_QTY_REGEX);
        const qtyCases = parseOcrNumber(koliMatch?.[1]);
        if (!Number.isFinite(qtyCases) || qtyCases <= 0) {
          rejected.push({ line: rawLine, reason: "no koli quantity" });
          continue;
        }

        const packMatch = rawLine.match(/\b(\d+(?:[.,]\d+)?)\s*[xX]\s*(\d+(?:[.,]\d+)?)\b/);
        let unitsPerCase = parseOcrNumber(packMatch?.[2]);
        if (!Number.isFinite(unitsPerCase) || unitsPerCase <= 1 || unitsPerCase > 200) {
          unitsPerCase = null;
        }

        const numberTokens = extractNumbersWithIdx(rawLine).filter(
          (n) => Number.isFinite(n.value) && n.value > 0
        );
        const tlTokens = [];
        const tlRegex =
          /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?=\s*tl|\s*₺)/gi;
        let tMatch;
        while ((tMatch = tlRegex.exec(rawLine)) !== null) {
          const value = parseOcrNumber(tMatch[1]);
          if (Number.isFinite(value) && value > 0) {
            tlTokens.push({ value, index: tMatch.index });
          }
        }

        let lineTotal = tlTokens.length > 0
          ? tlTokens[tlTokens.length - 1].value
          : numberTokens.length > 0
            ? numberTokens[numberTokens.length - 1].value
            : null;
        if (!Number.isFinite(lineTotal) || lineTotal <= 0) {
          rejected.push({ line: rawLine, reason: "no total" });
          continue;
        }

        const lineTotalIdx = tlTokens.length > 0
          ? tlTokens[tlTokens.length - 1].index
          : numberTokens.length > 0
            ? numberTokens[numberTokens.length - 1].index
            : Number.MAX_SAFE_INTEGER;
        const amountCandidates = numberTokens.filter((n) => n.index < lineTotalIdx);
        const targetUnitPrice = lineTotal / qtyCases;
        let unitPrice = null;
        if (amountCandidates.length > 0) {
          unitPrice = amountCandidates
            .slice()
            .sort((a, b) => Math.abs(a.value - targetUnitPrice) - Math.abs(b.value - targetUnitPrice))[0]
            ?.value ?? null;
        } else if (tlTokens.length > 1) {
          unitPrice = tlTokens[0].value;
        }

        const nameStart = (codeMatch.index || 0) + code.length;
        const nameEnd = koliMatch?.index || lineTotalIdx || rawLine.length;
        const name = normalizeNameCandidate(rawLine.slice(nameStart, nameEnd));
        if (!hasStrongName(name)) {
          rejected.push({ line: rawLine, reason: "name weak" });
          continue;
        }

        let vatRate = null;
        const vatMatches = [...rawLine.matchAll(/%\s*([0-9]{1,2}(?:[.,]\d+)?)/gi)];
        if (vatMatches.length > 0) {
          vatRate = parseOcrNumber(vatMatches[vatMatches.length - 1][1]);
          if (Number.isFinite(vatRate) && vatRate > 50 && vatRate <= 100) {
            vatRate = vatRate / 100;
          }
        }

        const dedupeKey = `${normalizeTextKey(name)}|${qtyCases}|${lineTotal.toFixed(2)}`;
        if (dedupe.has(dedupeKey)) continue;
        dedupe.add(dedupeKey);

        items.push({
          code,
          name,
          qty_cases: qtyCases,
          units_per_case: unitsPerCase,
          qty_units: Number.isFinite(unitsPerCase) ? qtyCases * unitsPerCase : qtyCases,
          unit: Number.isFinite(unitsPerCase) ? "case" : "piece",
          unit_price_ex_vat: Number.isFinite(unitPrice) ? unitPrice : null,
          discount_rate: null,
          vat_rate: Number.isFinite(vatRate) ? vatRate : null,
          line_total_inc_vat: lineTotal,
        });
      }

      return { items, rejected };
    };

    // Template parser for Coca-Cola style invoices (lines with "Koli" and TL amounts)
    const parseCocaTemplate = () => {
      const items = [];
      const rejected = [];
      const rowRegex =
        /^\s*\d+\s+(\d{5,8})\s+(.+?)\s+(\d+)\s*Koli\s+(\d+)\s+([0-9.,]+)\s*TL.*?([0-9.,]+)\s*TL\s*$/i;
      const scanLines = mergeTableLines(lines);
      for (const rawLine of scanLines) {
        const match = rawLine.match(rowRegex);
        if (!match) continue;
        const [, code, nameRaw, qtyCasesStr, unitsPerCaseStr, unitPriceStr, lineTotalStr] = match;
        const qtyCases = parseOcrNumber(qtyCasesStr);
        const unitsPerCase = parseOcrNumber(unitsPerCaseStr);
        const unitPrice = parseOcrNumber(unitPriceStr);
        const lineTotal = parseOcrNumber(lineTotalStr);
        const name = (nameRaw || "").replace(/\s+/g, " ").trim();
        if (!name || !qtyCases || !unitsPerCase || !lineTotal) {
          rejected.push({ line: rawLine, reason: "template parse fail" });
          continue;
        }
        items.push({
          code,
          name,
          qty_cases: qtyCases,
          units_per_case: unitsPerCase,
          qty_units: qtyCases * unitsPerCase,
          unit: "case",
          unit_price_ex_vat: unitPrice,
          discount_rate: null,
          vat_rate: null,
          line_total_inc_vat: lineTotal,
        });
      }
      return { items, rejected };
    };

    const parseCodeKoliRows = () => {
      const items = [];
      const rejected = [];
      const blockTokens = [
        "fatura",
        "musteri",
        "müsteri",
        "vkn",
        "vergi",
        "banka",
        "iban",
        "odeme",
        "ödeme",
        "adres",
        "satis temsilcisi",
        "satıs temsilcisi",
        "mal hizmet toplam",
        "toplam iskonto",
        "hesaplanan kdv",
        "odenecek tutar",
        "vergiler dahil toplam",
      ];

      const normalizeUnitsPerCase = (value) => {
        let v = value;
        while (Number.isFinite(v) && v > 200 && v % 10 === 0) {
          v = v / 10;
        }
        return v;
      };

      const scanLines = mergeTableLines(lines);
      const dedupe = new Set();
      for (let idx = 0; idx < scanLines.length; idx += 1) {
        const rawLine = scanLines[idx];
        const key = normalizeTextKey(rawLine);
        if (!rawLine) continue;
        if (containsAny(key, blockTokens)) continue;

        const koliMatch = rawLine.match(KOLI_QTY_REGEX);
        const rawCodeMatch = rawLine.match(/\b\d{5,8}\b/);
        const codeMatch =
          rawCodeMatch && (!koliMatch || (rawCodeMatch.index || 0) < (koliMatch.index || 0))
            ? rawCodeMatch
            : null;
        const code = codeMatch ? codeMatch[0] : null;
        const packMatch = rawLine.match(/\b(\d+(?:[.,]\d+)?)\s*[xX]\s*(\d+(?:[.,]\d+)?)\b/);
        const hasCodeAndPack = Boolean(code && packMatch);
        if (!koliMatch && !hasCodeAndPack) continue;
        const hasCurrencyMarker = /(tl|₺)/i.test(rawLine);
        if (!koliMatch && hasCodeAndPack && !hasCurrencyMarker) continue;

        let qtyCases = koliMatch ? parseOcrNumber(koliMatch[1]) : parseOcrNumber(packMatch?.[1]);
        if (!Number.isFinite(qtyCases) || qtyCases <= 0) {
          rejected.push({ line: rawLine, reason: "koli qty invalid" });
          continue;
        }

        const prevLine = String(scanLines[idx - 1] || "");
        const nextLine = String(scanLines[idx + 1] || "");
        const prevKey = normalizeTextKey(prevLine);
        const nextKey = normalizeTextKey(nextLine);
        const prevLooksLikeName =
          prevLine &&
          !containsAny(prevKey, blockTokens) &&
          !/\b\d{5,8}\b/.test(prevLine) &&
          !KOLI_QTY_REGEX.test(prevLine);
        const nextLooksLikeName =
          nextLine &&
          !containsAny(nextKey, blockTokens) &&
          !/\b\d{5,8}\b/.test(nextLine) &&
          !KOLI_QTY_REGEX.test(nextLine);
        const nextLooksLikeAmountTail =
          nextLine &&
          !containsAny(nextKey, blockTokens) &&
          !/\b\d{5,8}\b/.test(nextLine) &&
          !KOLI_QTY_REGEX.test(nextLine) &&
          /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?:\s*tl|\s*₺)?\s*$/i.test(nextLine);

        let unitsPerCase = parseOcrNumber(packMatch?.[2]);
        if (Number.isFinite(unitsPerCase)) unitsPerCase = normalizeUnitsPerCase(unitsPerCase);
        if (!Number.isFinite(unitsPerCase) || unitsPerCase <= 1 || unitsPerCase > 200) {
          unitsPerCase = null;
        }

        const amountContext = `${prevLooksLikeName ? `${prevLine} ` : ""}${rawLine}${nextLooksLikeAmountTail ? ` ${nextLine}` : ""}`.trim();
        const amountTokensWithIdx = extractNumbersWithIdx(amountContext).filter(
          (n) => Number.isFinite(n.value) && n.value > 0
        );
        const tlValues = [];
        const tlRegex =
          /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?=\s*tl|\s*₺)/gi;
        let tMatch;
        while ((tMatch = tlRegex.exec(amountContext)) !== null) {
          const v = parseOcrNumber(tMatch[1]);
          if (Number.isFinite(v) && v > 0) {
            tlValues.push(v);
          }
        }
        const allNumbers = amountTokensWithIdx.map((n) => n.value).filter((n) => n < 10000);
        const maxAmount = allNumbers.length > 0 ? Math.max(...allNumbers) : null;

        let unitPrice = tlValues.length > 0 ? tlValues[0] : null;
        let lineTotal = tlValues.length > 0 ? tlValues[tlValues.length - 1] : null;
        if (!Number.isFinite(lineTotal)) {
          const numbers = extractNumbersWithIdx(rawLine)
            .map((n) => n.value)
            .filter((n) => Number.isFinite(n) && n > 0);
          unitPrice = numbers.find((n) => n >= 5 && n <= 5000) || unitPrice;
          lineTotal = numbers.length ? numbers[numbers.length - 1] : null;
        }
        const excluded = [qtyCases, parseOcrNumber(packMatch?.[1]), parseOcrNumber(packMatch?.[2])].filter(
          (n) => Number.isFinite(n)
        );
        const candidateTotals = amountTokensWithIdx
          .map((n) => n.value)
          .filter((n) => n >= 5 && n < 200000)
          .filter((n) => !excluded.some((ex) => Math.abs(ex - n) <= 0.01));
        const rightmostCandidate = candidateTotals.length ? candidateTotals[candidateTotals.length - 1] : null;
        if (Number.isFinite(rightmostCandidate)) {
          lineTotal = rightmostCandidate;
        } else if (Number.isFinite(maxAmount) && (!Number.isFinite(lineTotal) || maxAmount > lineTotal * 1.25)) {
          lineTotal = maxAmount;
        }
        if (!Number.isFinite(unitPrice) && Number.isFinite(lineTotal) && qtyCases > 0) {
          unitPrice = lineTotal / qtyCases;
        }
        if (
          Number.isFinite(unitPrice) &&
          unitPrice > 0 &&
          Number.isFinite(qtyCases) &&
          qtyCases > 0 &&
          Number.isFinite(lineTotal) &&
          lineTotal > 0
        ) {
          const anchor = unitPrice * qtyCases;
          if (lineTotal < anchor * 0.35) {
            const biggerCandidate = candidateTotals.find((n) => n >= anchor * 0.35);
            if (Number.isFinite(biggerCandidate)) {
              lineTotal = biggerCandidate;
            }
          }
        }
        if (Number.isFinite(unitPrice) && unitPrice > 0 && Number.isFinite(lineTotal) && lineTotal > 0) {
          lineTotal = rescaleTowardsTarget(lineTotal, Math.max(unitPrice, 1) * qtyCases);
        }

        const nameStart = codeMatch ? (codeMatch.index || 0) + code.length : 0;
        const nameEnd = (koliMatch?.index || packMatch?.index || rawLine.length);
        const currentName = normalizeNameCandidate(rawLine.slice(nameStart, nameEnd));
        const fallbackName = normalizeNameCandidate(
          rawLine
            .replace(/^\s*[\[(]?\d+\s*[|.)]?\s*/, "")
            .replace(KOLI_QTY_REGEX, " ")
        );
        const prevName = prevLooksLikeName
          ? normalizeNameCandidate(
              prevLine
                .replace(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?=\s*tl|\s*₺)/gi, " ")
            )
          : "";
        const nextName = nextLooksLikeName
          ? normalizeNameCandidate(
              nextLine
                .replace(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?=\s*tl|\s*₺)/gi, " ")
            )
          : "";

        let name = [currentName, fallbackName, prevName, nextName]
          .filter(Boolean)
          .sort((a, b) => nameQualityScore(b) - nameQualityScore(a))[0] || "";

        if (!hasStrongName(name)) {
          rejected.push({ line: rawLine, reason: "name weak" });
          continue;
        }

        let vatRate = null;
        const vatMatches = [...rawLine.matchAll(/%\s*([0-9]{1,2}(?:[.,]\d+)?)/gi)];
        if (vatMatches.length > 0) {
          const vatCandidates = vatMatches
            .map((m) => parseOcrNumber(m[1]))
            .filter((v) => Number.isFinite(v));
          const lastVatLike = [...vatCandidates].reverse().find((v) => v >= 0 && v <= 20);
          vatRate = Number.isFinite(lastVatLike) ? lastVatLike : null;
        }

        const dedupeKey = `${normalizeTextKey(name)}|${qtyCases}|${lineTotal || 0}`;
        if (dedupe.has(dedupeKey)) continue;
        dedupe.add(dedupeKey);

        items.push({
          code,
          name,
          qty_cases: qtyCases,
          units_per_case: unitsPerCase,
          qty_units: Number.isFinite(unitsPerCase) ? qtyCases * unitsPerCase : qtyCases,
          unit: Number.isFinite(unitsPerCase) ? "case" : "piece",
          unit_price_ex_vat: Number.isFinite(unitPrice) ? unitPrice : null,
          discount_rate: null,
          vat_rate: Number.isFinite(vatRate) ? vatRate : null,
          line_total_inc_vat: Number.isFinite(lineTotal) ? lineTotal : null,
        });
      }
      return { items, rejected };
    };

    const parseNameAmountRows = () => {
      const items = [];
      const rejected = [];
      const stopTokens = [
        "fatura",
        "musteri",
        "müsteri",
        "vkn",
        "vergi",
        "banka",
        "iban",
        "odeme",
        "ödeme",
        "mal hizmet toplam",
        "toplam iskonto",
        "hesaplanan kdv",
        "odenecek tutar",
        "vergiler dahil toplam",
      ];
      const rowSignalRegex =
        /\b(koli|kutu|pet|dys|remix|sugar|cola|damla|seft|ml|lt|kg|gr)\b|\b\d+\s*[xX]\s*\d+\b/i;
      const dedupe = new Set();
      const scanLines = lines;

      for (const rawLine of scanLines) {
        if (!rawLine) continue;
        const key = normalizeTextKey(rawLine);
        if (containsAny(key, stopTokens)) continue;
        if (!rowSignalRegex.test(rawLine)) continue;
        if (KOLI_QTY_REGEX.test(rawLine)) continue;
        if (!/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(rawLine)) continue;

        const amountTail = rawLine.match(
          /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?:\s*tl|\s*₺)?\s*$/i
        );
        const numberTokens = extractNumbersWithIdx(rawLine).filter(
          (n) => Number.isFinite(n.value) && n.value > 0 && n.value < 200000
        );
        const fallbackToken = numberTokens.length ? numberTokens[numberTokens.length - 1] : null;
        const amountIdx = amountTail ? amountTail.index : fallbackToken?.index;
        const amountRaw = amountTail ? amountTail[1] : fallbackToken?.raw;
        const lineTotal = parseOcrNumber(amountRaw);
        if (!Number.isFinite(lineTotal) || lineTotal <= 0 || lineTotal > 200000) continue;

        const textPart = rawLine.slice(0, amountIdx || 0).trim();
        let name = textPart
          .replace(/^\s*[\[(]?\d+\s*[|.)]?\s*/, "")
          .replace(/\b\d{5,8}\b/g, " ")
          .replace(/[-–—|]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        name = name.replace(/\s+\d+(?:[.,]\d+)?\s*$/g, "").trim();
        if (!hasStrongName(name)) {
          rejected.push({ line: rawLine, reason: "name weak" });
          continue;
        }

        const qtyKoliMatch = rawLine.match(KOLI_QTY_REGEX);
        const packMatch = rawLine.match(/\b(\d+(?:[.,]\d+)?)\s*[xX]\s*(\d+(?:[.,]\d+)?)\b/);
        const hasCurrencyMarker = /(tl|₺)/i.test(rawLine);
        let qtyCases = qtyKoliMatch ? parseOcrNumber(qtyKoliMatch[1]) : null;
        let unitsPerCase = packMatch ? parseOcrNumber(packMatch[2]) : null;
        if (!Number.isFinite(qtyCases) || qtyCases <= 0) qtyCases = 1;
        if (!Number.isFinite(unitsPerCase) || unitsPerCase <= 1 || unitsPerCase > 200) {
          unitsPerCase = null;
        }
        if (!qtyKoliMatch && !hasCurrencyMarker && Number.isFinite(unitsPerCase)) {
          const packA = parseOcrNumber(packMatch?.[1]);
          const packB = unitsPerCase;
          // If total is exactly pack-size and no currency marker, this is usually OCR noise from "1x24".
          if (
            Math.abs(lineTotal - (packA || -1)) <= 0.01 ||
            Math.abs(lineTotal - (packB || -1)) <= 0.01
          ) {
            continue;
          }
        }
        if (/\b\d+\s*[xX]\s*$/i.test(name)) {
          continue;
        }

        const dedupeKey = `${normalizeTextKey(name)}|${lineTotal}`;
        if (dedupe.has(dedupeKey)) continue;
        dedupe.add(dedupeKey);

        items.push({
          code: null,
          name,
          qty_cases: qtyCases,
          units_per_case: unitsPerCase,
          qty_units: Number.isFinite(unitsPerCase) ? qtyCases * unitsPerCase : qtyCases,
          unit: Number.isFinite(unitsPerCase) ? "case" : "piece",
          unit_price_ex_vat: Number.isFinite(qtyCases) && qtyCases > 0 ? lineTotal / qtyCases : lineTotal,
          discount_rate: null,
          vat_rate: null,
          line_total_inc_vat: lineTotal,
        });
      }
      return { items, rejected };
    };

    // Thermal slip parser (market-style):
    // "2,000Adt X 85,00" + next line "T.AYRAN ... %01 *170,00"
    const parseThermalSlipItems = () => {
      const items = [];
      const rejected = [];
      let pendingQty = null;
      let pendingUnitPrice = null;
      let pendingQtyIsAdet = false;
      const hasQtyPriceAnchor = lines.some((line) =>
        /(\d+(?:[.,]\d+)?)\s*(adet|adt|4dt)\s*[xX*]\s*(\d+(?:[.,]\d+)?)/i.test(line)
      );
      const thermalSignalCount = lines.reduce((acc, line) => {
        const key = normalizeTextKey(line);
        if (
          key.includes("fis no") ||
          key.includes("fi no") ||
          key.includes("saat") ||
          key.includes("topkdv") ||
          key.includes("nakit")
        ) {
          return acc + 1;
        }
        return acc;
      }, 0);
      // Prevent thermal parser from hijacking full e-fatura tables.
      if (!hasQtyPriceAnchor || thermalSignalCount < 2) {
        return { items, rejected };
      }

      const stopTokens = [
        "fis no",
        "fi no",
        "fatura no",
        "tarih",
        "saat",
        "toplam",
        "topkdv",
        "nakit",
        "iban",
        "vkn",
        "vd",
        "vergi",
        "adres",
        "mersis",
      ];

      for (const rawLine of lines) {
        const key = normalizeTextKey(rawLine);
        if (!rawLine) continue;
        if (containsAny(key, stopTokens)) continue;

        const qtyAnchorLine = rawLine
          .replace(/4dt/gi, "adt")
          .replace(/aot/gi, "adt")
          .replace(/\s+/g, " ");

        const qtyPriceMatch = qtyAnchorLine.match(
          /(\d+(?:[.,]\d+)?)\s*(adet|adt)\s*[xX*]\s*(\d+(?:[.,]\d+)?)/i
        );
        if (qtyPriceMatch) {
          const qty = parseOcrNumber(qtyPriceMatch[1]);
          const unitPrice = parseOcrNumber(qtyPriceMatch[3]);
          if (Number.isFinite(qty) && qty > 0 && Number.isFinite(unitPrice) && unitPrice > 0) {
            pendingQty = qty;
            pendingUnitPrice = unitPrice;
            pendingQtyIsAdet = true;
            continue;
          }
        }

        if (!/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(rawLine)) continue;

        const totalMatch = rawLine.match(
          /[*]?\s*(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?:\s*tl|\s*₺)?\s*$/i
        );
        if (!totalMatch) continue;

        const hasItemSignal =
          /(adet|adt|kg|gr|g|ml|lt|l|li|lı|lu|lü|koli|paket|pcs|pc|piece|unit)\b/i.test(rawLine) ||
          /[*]\s*\d+(?:[.,]\d+)?\s*$/.test(rawLine);
        if (!pendingQty && !hasItemSignal) continue;

        let lineTotal = parseOcrNumber(totalMatch[1]);
        if (!Number.isFinite(lineTotal) || lineTotal <= 0) continue;

        let beforeTotal = rawLine.slice(0, totalMatch.index).trim();
        if (!beforeTotal) continue;

        let vatRate = null;
        const vatMatch = beforeTotal.match(/%\s*([0-9]{1,2}(?:[.,]\d+)?)/i);
        if (vatMatch) {
          vatRate = parseOcrNumber(vatMatch[1]);
          beforeTotal = beforeTotal.replace(vatMatch[0], " ").replace(/\s+/g, " ").trim();
        }
        if (!Number.isFinite(vatRate)) {
          const tailTaxMatch = beforeTotal.match(/\b([0-9]{1,2}(?:[.,]\d+)?)\s*$/);
          if (tailTaxMatch) {
            const candidate = parseOcrNumber(tailTaxMatch[1]);
            if (Number.isFinite(candidate) && candidate >= 0 && candidate <= 20) {
              vatRate = candidate;
              beforeTotal = beforeTotal.slice(0, tailTaxMatch.index).trim();
            }
          }
        }
        if (Number.isFinite(vatRate) && vatRate > 50 && vatRate <= 100) {
          vatRate = vatRate / 100;
        }

        const name = beforeTotal
          .replace(/[*=]+$/g, "")
          .replace(/[*xX]\s*\d+(?:[.,]\d+)?\s*$/g, "")
          .replace(/\s+/g, " ")
          .trim();
        const letters = (name.match(/[A-Za-zÇĞİÖŞÜçğıöşü]/g) || []).length;
        if (!name || letters < 2) continue;
        if (/^(sl|si|s1)\b/i.test(name)) continue;

        let qty = Number.isFinite(pendingQty) && pendingQty > 0 ? pendingQty : 1;
        let unitPrice =
          Number.isFinite(pendingUnitPrice) && pendingUnitPrice > 0
            ? pendingUnitPrice
            : lineTotal / qty;

        const anchoredExpectedTotal =
          Number.isFinite(pendingQty) &&
          pendingQty > 0 &&
          Number.isFinite(pendingUnitPrice) &&
          pendingUnitPrice > 0
            ? pendingQty * pendingUnitPrice
            : null;
        if (
          Number.isFinite(anchoredExpectedTotal) &&
          anchoredExpectedTotal > 0 &&
          Number.isFinite(lineTotal) &&
          lineTotal > 0
        ) {
          const drift = Math.abs(lineTotal - anchoredExpectedTotal) / anchoredExpectedTotal;
          // When OCR total is clearly wrong (e.g. 8,00 instead of 170,00), trust qty x unit price anchor.
          if (drift > 0.35) {
            lineTotal = anchoredExpectedTotal;
          }
        }

        if (Number.isFinite(qty) && qty > 0 && Number.isFinite(unitPrice) && unitPrice > 0) {
          lineTotal = rescaleTowardsTarget(lineTotal, unitPrice * qty);
          unitPrice = rescaleTowardsTarget(unitPrice, lineTotal / qty);
          lineTotal = rescaleTowardsTarget(lineTotal, unitPrice * qty);
        }

        let unit = "piece";
        let qtyUnits = qty;
        let qtyCases = null;
        let unitsPerCase = null;
        if (pendingQtyIsAdet) {
          const packPieceMatch = name.match(/(\d+(?:[.,]\d+)?)\s*(li|l[ıiuü]|lt)\b/i);
          if (packPieceMatch) {
            const packCount = parseOcrNumber(packPieceMatch[1]);
            if (Number.isFinite(packCount) && packCount >= 2 && packCount <= 200) {
              qtyCases = qty;
              unitsPerCase = packCount;
              qtyUnits = qty * packCount;
              unit = "piece";
            }
          }
        } else {
          const packMatch = name.match(/(\d+(?:[.,]\d+)?)\s*(kg|gr|g|lt|l|ml)\b/i);
          if (packMatch) {
            const packRaw = parseOcrNumber(packMatch[1]);
            const packUnit = String(packMatch[2] || "").toLowerCase();
            if (Number.isFinite(packRaw) && packRaw > 0) {
              if (packUnit === "kg" || packUnit === "g" || packUnit === "gr") {
                unit = "kg";
                const packInKg =
                  packUnit === "kg" ? packRaw : packRaw / 1000;
                qtyUnits = qty * packInKg;
                qtyCases = qty;
                unitsPerCase = packInKg;
              } else if (packUnit === "lt" || packUnit === "l" || packUnit === "ml") {
                unit = "L";
                const packInL =
                  packUnit === "ml" ? packRaw / 1000 : packRaw;
                qtyUnits = qty * packInL;
                qtyCases = qty;
                unitsPerCase = packInL;
              }
            }
          }
        }

        items.push({
          code: null,
          name,
          qty_cases: qtyCases,
          units_per_case: unitsPerCase,
          qty_units: Number.isFinite(qtyUnits) ? qtyUnits : qty,
          unit,
          unit_price_ex_vat: Number.isFinite(unitPrice) ? unitPrice : null,
          discount_rate: null,
          vat_rate: Number.isFinite(vatRate) ? vatRate : null,
          line_total_inc_vat: Number.isFinite(lineTotal) ? lineTotal : null,
        });

        pendingQty = null;
        pendingUnitPrice = null;
        pendingQtyIsAdet = false;
      }

      return { items, rejected };
    };

    const inferQtyFromPriceTotal = (unitPrice, lineTotal) => {
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) return null;
      if (!Number.isFinite(lineTotal) || lineTotal <= 0) return null;
      const candidates = [unitPrice, unitPrice / 10, unitPrice / 100, unitPrice / 1000];
      let best = null;
      for (const price of candidates) {
        if (!Number.isFinite(price) || price <= 0) continue;
        const rawQty = lineTotal / price;
        if (!Number.isFinite(rawQty) || rawQty <= 0.01 || rawQty > 500) continue;
        const rounded = Math.round(rawQty);
        const delta = Math.abs(rawQty - rounded);
        const score = delta + (rounded < 1 || rounded > 200 ? 0.2 : 0);
        if (!best || score < best.score) {
          best = { rawQty, rounded, score };
        }
      }
      if (!best) return null;
      if (best.rounded >= 1 && Math.abs(best.rawQty - best.rounded) <= 0.2) {
        return best.rounded;
      }
      return Number(best.rawQty.toFixed(3));
    };

    const rescaleTowardsTarget = (value, target) => {
      if (!Number.isFinite(value) || value <= 0) return value;
      if (!Number.isFinite(target) || target <= 0) return value;
      const candidates = [value, value / 10, value / 100, value / 1000, value / 10000];
      let best = { value, rel: Math.abs(value - target) / target };
      for (const c of candidates) {
        if (!Number.isFinite(c) || c <= 0) continue;
        const rel = Math.abs(c - target) / target;
        if (rel < best.rel) best = { value: c, rel };
      }
      if (best.rel <= 0.2) return Number(best.value.toFixed(3));
      return value;
    };

    const pickBestAmountsAndQty = (unitPrice, lineTotal) => {
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) return null;
      if (!Number.isFinite(lineTotal) || lineTotal <= 0) return null;

      const scales = [1, 0.1, 0.01, 0.001, 0.0001];
      const qtyCandidates = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 100];
      let best = null;

      for (const upScale of scales) {
        const up = unitPrice * upScale;
        if (!Number.isFinite(up) || up <= 0) continue;
        for (const totalScale of scales) {
          const total = lineTotal * totalScale;
          if (!Number.isFinite(total) || total <= 0) continue;
          for (const qty of qtyCandidates) {
            const predicted = up * qty;
            const denom = Math.max(predicted, total, 0.0001);
            const relErr = Math.abs(predicted - total) / denom;
            const qtyPenalty = qty > 10 ? (qty - 10) * 0.003 : 0;
            const score = relErr + qtyPenalty;
            if (!best || score < best.score) {
              best = { score, unitPrice: up, lineTotal: total, qty };
            }
          }
        }
      }
      if (!best) return null;
      if (best.score > 0.12) return null;
      return {
        unitPrice: Number(best.unitPrice.toFixed(3)),
        lineTotal: Number(best.lineTotal.toFixed(2)),
        qty: best.qty,
      };
    };

    // Generic e-Arsiv table parser:
    // Sira No | Mal Hizmet | Miktar | Birim Fiyat | KDV Orani | Mal Hizmet Tutari
    const parseMalHizmetTable = () => {
      const items = [];
      const rejected = [];

      const headerIdx = lines.findIndex((line) => {
        const key = normalizeTextKey(line);
        return (
          key.includes("mal hizmet") &&
          (key.includes("miktar") || key.includes("fiyat")) &&
          (key.includes("kdv") || key.includes("kov") || key.includes("oran")) &&
          (key.includes("tutar") || key.includes("tutan") || key.includes("tutari"))
        );
      });
      const firstRowIdx = lines.findIndex(
        (line) =>
          /^\s*[\[(]?\d+\s*[|.)]/.test(line) &&
          /(?:tl|₺)/i.test(line) &&
          /[a-zA-ZÇĞİÖŞÜçğıöşü]/.test(line)
      );
      const startIdx =
        headerIdx !== -1
          ? headerIdx
          : firstRowIdx !== -1
            ? Math.max(firstRowIdx - 1, 0)
            : -1;
      if (startIdx === -1) return { items, rejected };

      const endIdx = (() => {
        for (let i = startIdx + 1; i < lines.length; i += 1) {
          const key = normalizeTextKey(lines[i]);
          if (
            key.includes("ara toplam") ||
            key.includes("aratoplam") ||
            key.includes("hesaplanan kdv") ||
            key.includes("odenecek tutar") ||
            key.includes("genel toplam")
          ) {
            return i;
          }
        }
        return lines.length;
      })();

      const tableLines = lines.slice(startIdx + 1, endIdx);

      for (const rawLine of tableLines) {
        const key = normalizeTextKey(rawLine);
        if (!rawLine || key === "orani") continue;
        if (!/^\s*[\[(]?\d+\s*[|.]?/.test(rawLine)) {
          rejected.push({ line: rawLine, reason: "no row index" });
          continue;
        }

        const amountTokens = [];
        const amountRegex =
          /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?=\s*tl|\s*₺)/gi;
        let amt;
        while ((amt = amountRegex.exec(rawLine)) !== null) {
          const value = parseOcrNumber(amt[1]);
          if (Number.isFinite(value)) {
            amountTokens.push({
              value,
              index: amt.index,
              raw: amt[1],
            });
          }
        }
        if (amountTokens.length < 2) {
          rejected.push({ line: rawLine, reason: "missing amounts" });
          continue;
        }

        let unitPrice = amountTokens[0].value;
        let lineTotal = amountTokens[amountTokens.length - 1].value;
        if (!Number.isFinite(lineTotal) || lineTotal <= 0) {
          rejected.push({ line: rawLine, reason: "invalid total" });
          continue;
        }

        const beforePrice = rawLine
          .slice(0, amountTokens[0].index)
          .replace(/[|[\]]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const withoutRowNo = beforePrice
          .replace(/^\s*[\[(]?\d+\s*[|.)]?\s*/, "")
          .trim();
        if (!withoutRowNo) {
          rejected.push({ line: rawLine, reason: "missing name" });
          continue;
        }

        let qty = null;
        let qtyCases = null;
        let unitsPerCase = null;
        let name = withoutRowNo;
        let hasExplicitQty = false;

        const qtyWithUnitMatch = withoutRowNo.match(
          /(\d+(?:[.,]\d+)?)\s*([cç]uval|cuval|adet|kol[iı1l]{1,4}[a-zçğıöşü]*|paket|pcs|pc|piece|unit)\b/i
        );
        if (qtyWithUnitMatch) {
          qty = parseOcrNumber(qtyWithUnitMatch[1]);
          name = withoutRowNo.slice(0, qtyWithUnitMatch.index).trim();
          hasExplicitQty = Number.isFinite(qty) && qty > 0;
        } else {
          const trailingQtyMatch = withoutRowNo.match(/(\d+(?:[.,]\d+)?)\s*$/);
          if (trailingQtyMatch) {
            qty = parseOcrNumber(trailingQtyMatch[1]);
            name = withoutRowNo.slice(0, trailingQtyMatch.index).trim();
          }
        }

        const derivedQty = inferQtyFromPriceTotal(unitPrice, lineTotal);
        if (!Number.isFinite(qty) || qty <= 0) {
          qty = derivedQty || 1;
        } else if (
          Number.isFinite(derivedQty) &&
          derivedQty > 0 &&
          Math.abs(derivedQty - qty) / Math.max(derivedQty, qty) > 0.35
        ) {
          // OCR often misreads Miktar digits; trust financial consistency when far apart.
          qty = derivedQty;
        }

        if (!hasExplicitQty) {
          const solved = pickBestAmountsAndQty(unitPrice, lineTotal);
          if (solved) {
            unitPrice = solved.unitPrice;
            lineTotal = solved.lineTotal;
            qty = solved.qty;
          }
        }

        // OCR can drop separators (431,670 -> 431670).
        // Reconcile amount scale using qty/price/total consistency.
        if (Number.isFinite(qty) && qty > 0) {
          if (Number.isFinite(unitPrice) && unitPrice > 0) {
            lineTotal = rescaleTowardsTarget(lineTotal, unitPrice * qty);
          }
          if (Number.isFinite(lineTotal) && lineTotal > 0) {
            unitPrice = rescaleTowardsTarget(unitPrice, lineTotal / qty);
          }
          if (Number.isFinite(unitPrice) && unitPrice > 0) {
            lineTotal = rescaleTowardsTarget(lineTotal, unitPrice * qty);
          }
        }

        const packMatch = name.match(/(\d+(?:[.,]\d+)?)\s*(kg|gr|g|lt|l|ml)\b/i);
        let unit = "piece";
        let qtyUnits = qty;
        if (packMatch) {
          const packRaw = parseOcrNumber(packMatch[1]);
          const packUnit = String(packMatch[2] || "").toLowerCase();
          if (Number.isFinite(packRaw) && packRaw > 0) {
            if (packUnit === "kg" || packUnit === "g" || packUnit === "gr") {
              unit = "kg";
              const packInKg =
                packUnit === "kg" ? packRaw : packRaw / 1000;
              qtyUnits = qty * packInKg;
              qtyCases = qty;
              unitsPerCase = packInKg;
            } else if (packUnit === "lt" || packUnit === "l" || packUnit === "ml") {
              unit = "L";
              const packInL =
                packUnit === "ml" ? packRaw / 1000 : packRaw;
              qtyUnits = qty * packInL;
              qtyCases = qty;
              unitsPerCase = packInL;
            }
          }
        }

        if (!name || (name.match(/[A-Za-zÇĞİÖŞÜçğıöşü]/g) || []).length < 2) {
          rejected.push({ line: rawLine, reason: "weak name" });
          continue;
        }

        const vatMatches = [...rawLine.matchAll(/%\s*([0-9.,]+)/g)];
        let vatRate =
          vatMatches.length > 0
            ? parseOcrNumber(vatMatches[vatMatches.length - 1][1])
            : null;
        if (!Number.isFinite(vatRate) && amountTokens.length >= 2) {
          const midSegment = rawLine.slice(
            amountTokens[0].index + String(amountTokens[0].raw || "").length,
            amountTokens[amountTokens.length - 1].index
          );
          const midNumbers = extractNumbersWithIdx(midSegment)
            .map((n) => n.value)
            .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
          if (midNumbers.length > 0) {
            vatRate = midNumbers[0];
          }
        }
        if (Number.isFinite(vatRate) && vatRate > 50 && vatRate <= 100) {
          vatRate = vatRate / 100;
        }

        items.push({
          code: null,
          name: name.replace(/\s+/g, " ").trim(),
          qty_cases: qtyCases,
          units_per_case: unitsPerCase,
          qty_units: Number.isFinite(qtyUnits) ? qtyUnits : qty,
          unit,
          unit_price_ex_vat: Number.isFinite(unitPrice) ? unitPrice : null,
          discount_rate: null,
          vat_rate: Number.isFinite(vatRate) ? vatRate : null,
          line_total_inc_vat: lineTotal,
        });
      }

      return { items, rejected };
    };

    const headerIdxFinder = () => {
      for (let i = 0; i < lines.length; i += 1) {
        const key = normalizeTextKey(lines[i]);
        if (
          (key.includes("sira") || key.includes("sirano")) &&
          key.includes("kod") &&
          (key.includes("mal hizmet") || key.includes("urun")) &&
          key.includes("miktar")
        ) {
          return i;
        }
      }
      return -1;
    };

    const fallbackParse = () => {
      const items = [];
      const rejected = [];
      const bankTokens = ["iban", "banka", "ziraat", "sube", "hesap", "vergi", "mersis", "adres", "tel"];
      const totalsTokens = ["ara toplam", "aratoplam", "hesaplanan kdv", "odenecek tutar", "genel toplam"];

      for (const rawLine of lines) {
        const key = normalizeTextKey(rawLine);
        if (containsAny(key, bankTokens)) continue;
        if (containsAny(key, totalsTokens)) continue;

        // Strong Adet + TL pattern: qty + two monetary amounts (unit price, line total)
        const adetQtyMatch = rawLine.match(/(\d+(?:[.,]\d+)?)\s*adet/i);
        const tlAmounts = [];
        const tlRegex = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?=\s*tl|\s*₺)/gi;
        let tlm;
        while ((tlm = tlRegex.exec(rawLine)) !== null) {
          const val = parseOcrNumber(tlm[1]);
          if (Number.isFinite(val)) tlAmounts.push({ value: val, idx: tlm.index });
        }
        if (adetQtyMatch && tlAmounts.length >= 2) {
          const qty = parseOcrNumber(adetQtyMatch[1]);
          if (qty && qty > 0) {
            const unitPrice = tlAmounts[0].value;
            const lineTotal = tlAmounts[tlAmounts.length - 1].value;
            const qtyIdx = adetQtyMatch.index;
            let name = rawLine.slice(0, qtyIdx).replace(/\s+\d+$/, "").trim();
            if (!name) name = rawLine.replace(adetQtyMatch[0], "").trim();
            const letters = (name.match(/[A-Za-zÇĞİÖŞÜçğıöşü]/g) || []).length;
            if (letters >= 2 && lineTotal > 0) {
              items.push({
                code: null,
                name,
                qty_cases: null,
                units_per_case: null,
                qty_units: qty,
                unit: "piece",
                unit_price_ex_vat: unitPrice,
                discount_rate: null,
                vat_rate: null,
                line_total_inc_vat: lineTotal,
              });
              continue;
            }
          }
        }

        // Adet-based rows (no product code)
        const adetMatch = rawLine.match(/(\d+(?:[.,]\d+)?)\s*adet/i);
        if (adetMatch) {
          const qty = parseOcrNumber(adetMatch[1]);
          if (!qty || qty <= 0) {
            rejected.push({ line: rawLine, reason: "adet qty invalid" });
          } else {
            const currencyNums = [];
            const currencyRegex = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)(?=\s*tl|\s*₺)/gi;
            let m;
            while ((m = currencyRegex.exec(rawLine)) !== null) {
              const val = parseOcrNumber(m[1]);
              if (Number.isFinite(val)) currencyNums.push(val);
            }
            let lineTotal = currencyNums.length ? currencyNums[currencyNums.length - 1] : null;
            let unitPrice = currencyNums.length > 1 ? currencyNums[0] : null;
            if (!lineTotal) {
              const nums = extractNumbersWithIdx(rawLine).map((n) => n.value).filter(Number.isFinite);
              if (nums.length) {
                lineTotal = Math.max(...nums);
                unitPrice = nums.length > 1 ? nums[0] : null;
              }
            }
            const qtyIdx = adetMatch.index;
            let name = rawLine.slice(0, qtyIdx).replace(/\s+\d+$/, "").trim();
            if (!name) {
              name = rawLine.replace(adetMatch[0], "").trim();
            }
            const letters = (name.match(/[A-Za-zÇĞİÖŞÜçğıöşü]/g) || []).length;
            if (letters < 2 || !lineTotal || lineTotal <= 0) {
              rejected.push({ line: rawLine, reason: "adet parse failed" });
            } else {
              items.push({
                code: null,
                name,
                qty_cases: null,
                units_per_case: null,
                qty_units: qty,
                unit: "piece",
                unit_price_ex_vat: unitPrice,
                discount_rate: null,
                vat_rate: null,
                line_total_inc_vat: lineTotal,
              });
              continue;
            }
          }
        }

        const codeMatch = rawLine.match(/\b\d{5,8}\b/);
        if (!codeMatch) {
          rejected.push({ line: rawLine, reason: "no code" });
          continue;
        }
        const code = codeMatch[0];
        const codeIdx = codeMatch.index || 0;
        const numbers = extractNumbersWithIdx(rawLine);
        if (numbers.length < 2) {
          rejected.push({ line: rawLine, reason: "no numbers" });
          continue;
        }

        // Prefer explicit "... Koli" quantity if present; fallback to first number after code.
        const koliQtyMatch = rawLine.match(KOLI_QTY_REGEX);
        const explicitKoliQty = parseOcrNumber(koliQtyMatch?.[1]);
        const qtyToken = Number.isFinite(explicitKoliQty) && explicitKoliQty > 0
          ? { value: explicitKoliQty, index: koliQtyMatch?.index || 0, raw: koliQtyMatch?.[1] || "" }
          : numbers.find((n) => n.index > codeIdx);
        if (!qtyToken || !Number.isFinite(qtyToken.value) || qtyToken.value <= 0) {
          rejected.push({ line: rawLine, reason: "no qty" });
          continue;
        }
        const qtyCases = qtyToken.value;

        // units per case only from explicit pack pattern like 1x24
        let unitsPerCase = null;
        const packMatch = rawLine.match(/(\d+(?:[.,]\d+)?)\s*[xX]\s*(\d+(?:[.,]\d+)?)/);
        if (packMatch) {
          unitsPerCase = parseOcrNumber(packMatch[2]);
        }

        // Line total: last number; prefer one marked with TL/₺
        const tlMatch = rawLine.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)(?=\s*tl|\s*₺)/i);
        let lineTotal = tlMatch ? parseOcrNumber(tlMatch[1]) : null;
        if (!lineTotal && numbers.length) {
          lineTotal = numbers[numbers.length - 1].value;
        }
        if (!Number.isFinite(lineTotal) || lineTotal <= 0) {
          rejected.push({ line: rawLine, reason: "no total" });
          continue;
        }

        const qtyIdx = qtyToken.index;
        const nameStart = codeIdx + code.length;
        const nameEnd = qtyIdx > nameStart ? qtyIdx : rawLine.length;
        let name = rawLine.slice(nameStart, nameEnd).replace(/\d+$/, "").trim();
        if (!name) name = rawLine.slice(0, qtyIdx).trim();
        const letters = (name.match(/[A-Za-zÇĞİÖŞÜçğıöşü]/g) || []).length;
        if (letters < 2) {
          rejected.push({ line: rawLine, reason: "no name" });
          continue;
        }

        let unit = "piece";
        let qtyUnits = qtyCases;
        if (unitsPerCase) {
          unit = "case";
          qtyUnits = qtyCases * unitsPerCase;
        } else if (/kg|g/i.test(rawLine)) {
          unit = "kg";
          qtyUnits = qtyCases;
        } else if (/lt|l|ml/i.test(rawLine)) {
          unit = "L";
          qtyUnits = qtyCases;
        }

        items.push({
          code,
          name,
          qty_cases: unit === "case" ? qtyCases : null,
          units_per_case: unitsPerCase,
          qty_units: qtyUnits,
          unit,
          unit_price_ex_vat: null,
          discount_rate: null,
          vat_rate: null,
          line_total_inc_vat: lineTotal,
        });
      }
      return { items, rejected };
    };

    const codeKoliResult = parseCodeKoliRows();
    const nameAmountResult = parseNameAmountRows();
    const numberedCodeResult = parseNumberedCodeRows();
    const combinedLooseResult = mergeParseResults(codeKoliResult, nameAmountResult);

    const headerIdx = headerIdxFinder();

    if (numberedCodeResult.items.length >= 4) {
      return finalizeParseResult(numberedCodeResult);
    }

    if (headerIdx === -1) {
      const malHizmetResult = parseMalHizmetTable();
      const fixed = parseFixedColumns();
      const templateResult = parseCocaTemplate();
      const thermalResult = parseThermalSlipItems();
      const fallbackResult = fallbackParse();
      return finalizeParseResult(
        pickBestResult([
          numberedCodeResult,
          malHizmetResult,
          fixed,
          templateResult,
          codeKoliResult,
          nameAmountResult,
          combinedLooseResult,
          thermalResult,
          fallbackResult,
        ])
      );
    }

    const stopTokens = ["mal hizmet toplam", "toplam", "odenecek", "vergiler", "kdv", "matrah"];
    const endIdx = (() => {
      for (let i = headerIdx + 1; i < lines.length; i += 1) {
        if (containsAny(normalizeTextKey(lines[i]), stopTokens)) return i;
      }
      return lines.length;
    })();

    const items = [];
    const rejected = [];
    const bankTokens = ["iban", "banka", "ziraat", "sube", "hesap", "vergi", "mersis", "adres", "tel"];

    const tableLines = mergeTableLines(lines.slice(Math.max(0, headerIdx + 1), endIdx));
    for (const rawLine of tableLines) {
      const key = normalizeTextKey(rawLine);
      if (containsAny(key, bankTokens)) {
        rejected.push({ line: rawLine, reason: "bank" });
        continue;
      }

      const codeMatch = rawLine.match(/\b\d{5,8}\b/);
      if (!codeMatch) {
        rejected.push({ line: rawLine, reason: "no code" });
        continue;
      }
      const code = codeMatch[0];
      const codeIdx = codeMatch.index || 0;
      const numbers = extractNumbersWithIdx(rawLine);
      if (numbers.length < 2) {
        rejected.push({ line: rawLine, reason: "no numbers" });
        continue;
      }

      // Prefer explicit "... Koli" quantity if present; fallback to first number after code.
      const koliQtyMatch = rawLine.match(KOLI_QTY_REGEX);
      const explicitKoliQty = parseOcrNumber(koliQtyMatch?.[1]);
      const qtyToken = Number.isFinite(explicitKoliQty) && explicitKoliQty > 0
        ? { value: explicitKoliQty, index: koliQtyMatch?.index || 0, raw: koliQtyMatch?.[1] || "" }
        : numbers.find((n) => n.index > codeIdx);
      if (!qtyToken || !Number.isFinite(qtyToken.value) || qtyToken.value <= 0) {
        rejected.push({ line: rawLine, reason: "no qty" });
        continue;
      }
      const qtyCases = qtyToken.value;

      // Units per case: only from explicit pack pattern like 1x24
      let unitsPerCase = null;
      const packMatch = rawLine.match(/(\d+(?:[.,]\d+)?)\s*[xX]\s*(\d+(?:[.,]\d+)?)/);
      if (packMatch) {
        unitsPerCase = parseOcrNumber(packMatch[2]);
      }

      // Line total: last number; prefer one marked with TL/₺
      const tlMatch = rawLine.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)(?=\s*tl|\s*₺)/i);
      let lineTotal = tlMatch ? parseOcrNumber(tlMatch[1]) : null;
      if (!lineTotal && numbers.length) {
        lineTotal = numbers[numbers.length - 1].value;
      }
      if (!Number.isFinite(lineTotal) || lineTotal <= 0) {
        rejected.push({ line: rawLine, reason: "no total" });
        continue;
      }

      // Name: between code and qty
      const qtyIdx = qtyToken.index;
      const nameStart = codeIdx + code.length;
      const nameEnd = qtyIdx > nameStart ? qtyIdx : rawLine.length;
      let name = rawLine.slice(nameStart, nameEnd).replace(/\d+$/, "").trim();
      if (!name) name = rawLine.slice(0, qtyIdx).trim();
      const letters = (name.match(/[A-Za-zÇĞİÖŞÜçğıöşü]/g) || []).length;
      if (letters < 2) {
        rejected.push({ line: rawLine, reason: "no name" });
        continue;
      }

      // Unit determination
      let unit = null;
      let qtyUnits = qtyCases;
      if (unitsPerCase) {
        unit = "case";
        qtyUnits = qtyCases * unitsPerCase;
      } else if (/kg|g/i.test(rawLine)) {
        unit = "kg";
      } else if (/lt|l|ml/i.test(rawLine)) {
        unit = "L";
      } else {
        unit = "piece";
      }

      items.push({
        code,
        name,
        qty_cases: unit === "case" ? qtyCases : null,
        units_per_case: unitsPerCase,
        qty_units: qtyUnits,
        unit,
        unit_price_ex_vat: null,
        discount_rate: null,
        vat_rate: null,
        line_total_inc_vat: lineTotal,
      });
    }

    const headerResult = { items, rejected };
    const fixed = parseFixedColumns();
    const templateResult = parseCocaTemplate();
    const mergedHeaderResult = mergeParseResults(
      numberedCodeResult,
      headerResult,
      codeKoliResult,
      nameAmountResult
    );
    return finalizeParseResult(
      pickBestResult([
        numberedCodeResult,
        mergedHeaderResult,
        headerResult,
        codeKoliResult,
        nameAmountResult,
        fixed,
        templateResult,
      ])
    );
  };

  // ---------------- SUPPLIERS ----------------

  // GET /suppliers - tenant-safe
  router.get("/", async (req, res) => {
    try {
      const restaurantId = req.user.restaurant_id;

      // Include basic aggregates per supplier so the dashboard
      // can display total paid / spent and last purchase date.
      const result = await pool.query(
        `
        SELECT
          s.*,
          COALESCE(tx.total_spent, 0)::numeric   AS total_spent,
          COALESCE(tx.total_spent, 0)::numeric   AS total_purchase,
          COALESCE(tx.total_paid, 0)::numeric    AS total_paid,
          tx.last_purchase_date
        FROM suppliers s
        LEFT JOIN (
          SELECT
            supplier_id,
            -- Sum of all purchase amounts (exclude pure payment rows)
            COALESCE(SUM(
              CASE
                WHEN ingredient <> 'Payment' THEN total_cost
                ELSE 0
              END
            ), 0) AS total_spent,
            -- Sum of all recorded payments
            COALESCE(SUM(
              CASE
                WHEN ingredient = 'Payment' THEN amount_paid
                ELSE 0
              END
            ), 0) AS total_paid,
            -- Latest purchase date (ignore payment-only rows)
            MAX(
              CASE
                WHEN ingredient <> 'Payment' THEN delivery_date
                ELSE NULL
              END
            ) AS last_purchase_date
          FROM transactions
          WHERE restaurant_id = $1
          GROUP BY supplier_id
        ) AS tx
          ON tx.supplier_id = s.id
        WHERE s.restaurant_id = $1
        ORDER BY s.name
        `,
        [restaurantId]
      );
      res.json(result.rows);
    } catch (err) {
      console.error("❌ Error fetching suppliers:", err);
      res.status(500).json({ error: "Database error" });
    }
  });

  // GET /suppliers/ingredients - distinct ingredient list across supplier-linked stock
  router.get("/ingredients", async (req, res) => {
    try {
      const restaurantId = req.user.restaurant_id;
      const result = await pool.query(
        `
        SELECT DISTINCT ON (LOWER(BTRIM(name)), LOWER(BTRIM(unit)))
          name,
          unit,
          supplier_id,
          COALESCE(price_per_unit, 0) AS price_per_unit,
          quantity
        FROM stock
        WHERE restaurant_id = $1
          AND supplier_id IS NOT NULL
        ORDER BY LOWER(BTRIM(name)), LOWER(BTRIM(unit)), id DESC
        `,
        [restaurantId]
      );
      res.json(result.rows);
    } catch (err) {
      const missingPricePerUnit =
        String(err?.code || "") === "42703" ||
        String(err?.message || "").toLowerCase().includes("price_per_unit");
      if (missingPricePerUnit) {
        try {
          const fallback = await pool.query(
            `
            SELECT DISTINCT ON (LOWER(BTRIM(name)), LOWER(BTRIM(unit)))
              name,
              unit,
              supplier_id,
              0::numeric AS price_per_unit,
              quantity
            FROM stock
            WHERE restaurant_id = $1
              AND supplier_id IS NOT NULL
            ORDER BY LOWER(BTRIM(name)), LOWER(BTRIM(unit)), id DESC
            `,
            [restaurantId]
          );
          return res.json(fallback.rows);
        } catch (fallbackErr) {
          console.error("❌ Error fetching supplier ingredients fallback:", fallbackErr);
        }
      }
      console.error("❌ Error fetching supplier ingredients:", err);
      res.status(500).json({ error: "Database error" });
    }
  });

  // GET /suppliers/:id - tenant-safe supplier details with aggregates
  router.get("/:id", async (req, res) => {
    try {
      const restaurantId = req.user.restaurant_id;
      const supplierId = toFiniteNumber(req.params?.id);
      if (!supplierId) {
        return res.status(400).json({ error: "Invalid supplier id" });
      }

      const result = await pool.query(
        `
        SELECT
          s.*,
          COALESCE(tx.total_spent, 0)::numeric AS total_spent,
          COALESCE(tx.total_spent, 0)::numeric AS total_purchase,
          COALESCE(tx.total_paid, 0)::numeric AS total_paid,
          tx.last_purchase_date
        FROM suppliers s
        LEFT JOIN (
          SELECT
            supplier_id,
            COALESCE(SUM(
              CASE
                WHEN ingredient <> 'Payment' THEN total_cost
                ELSE 0
              END
            ), 0) AS total_spent,
            COALESCE(SUM(
              CASE
                WHEN ingredient = 'Payment' THEN amount_paid
                ELSE 0
              END
            ), 0) AS total_paid,
            MAX(
              CASE
                WHEN ingredient <> 'Payment' THEN delivery_date
                ELSE NULL
              END
            ) AS last_purchase_date
          FROM transactions
          WHERE restaurant_id = $1
          GROUP BY supplier_id
        ) AS tx
          ON tx.supplier_id = s.id
        WHERE s.restaurant_id = $1
          AND s.id = $2
        LIMIT 1
        `,
        [restaurantId, supplierId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Supplier not found" });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error("❌ Error fetching supplier details:", err);
      res.status(500).json({ error: "Database error" });
    }
  });

  // GET /suppliers/:id/transactions - tenant-safe supplier transaction history
  router.get("/:id/transactions", async (req, res) => {
    try {
      const restaurantId = req.user.restaurant_id;
      const supplierId = toFiniteNumber(req.params?.id);
      if (!supplierId) {
        return res.status(400).json({ error: "Invalid supplier id" });
      }

      const result = await pool.query(
        `
        SELECT *
        FROM transactions
        WHERE restaurant_id = $1
          AND supplier_id = $2
        ORDER BY COALESCE(delivery_date, created_at, NOW()) DESC, id DESC
        `,
        [restaurantId, supplierId]
      );

      res.json(result.rows);
    } catch (err) {
      console.error("❌ Error fetching supplier transactions:", err);
      res.status(500).json({ error: "Database error" });
    }
  });

  // GET /suppliers/:id/ingredients - tenant-safe supplier ingredient list
  router.get("/:id/ingredients", async (req, res) => {
    try {
      const restaurantId = req.user.restaurant_id;
      const supplierId = toFiniteNumber(req.params?.id);
      if (!supplierId) {
        return res.status(400).json({ error: "Invalid supplier id" });
      }

      const result = await pool.query(
        `
        SELECT DISTINCT ON (LOWER(BTRIM(name)), LOWER(BTRIM(unit)))
          id,
          name,
          unit,
          supplier_id,
          COALESCE(price_per_unit, 0) AS price_per_unit,
          quantity
        FROM stock
        WHERE restaurant_id = $1
          AND supplier_id = $2
        ORDER BY LOWER(BTRIM(name)), LOWER(BTRIM(unit)), id DESC
        `,
        [restaurantId, supplierId]
      );

      res.json(result.rows);
    } catch (err) {
      const missingPricePerUnit =
        String(err?.code || "") === "42703" ||
        String(err?.message || "").toLowerCase().includes("price_per_unit");
      if (missingPricePerUnit) {
        try {
          const fallback = await pool.query(
            `
            SELECT DISTINCT ON (LOWER(BTRIM(name)), LOWER(BTRIM(unit)))
              id,
              name,
              unit,
              supplier_id,
              0::numeric AS price_per_unit,
              quantity
            FROM stock
            WHERE restaurant_id = $1
              AND supplier_id = $2
            ORDER BY LOWER(BTRIM(name)), LOWER(BTRIM(unit)), id DESC
            `,
            [restaurantId, supplierId]
          );
          return res.json(fallback.rows);
        } catch (fallbackErr) {
          console.error("❌ Error fetching supplier-specific ingredients fallback:", fallbackErr);
        }
      }
      console.error("❌ Error fetching supplier-specific ingredients:", err);
      res.status(500).json({ error: "Database error" });
    }
  });

  // POST /suppliers - tenant-safe
  router.post("/", async (req, res) => {
    try {
      const { name, phone, email, address, tax_number, id_number, notes } =
        req.body;
      const result = await pool.query(
        `INSERT INTO suppliers (restaurant_id, name, phone, email, address, tax_number, id_number, notes, total_due)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0)
         RETURNING id, name, total_due`,
        [
          req.user.restaurant_id,
          name,
          phone,
          email,
          address,
          tax_number,
          id_number,
          notes,
        ]
      );
      res.json(result.rows[0]);
    } catch (error) {
      console.error("❌ Error adding supplier:", error);
      res.status(500).json({ error: "Database error" });
    }
  });

  // PUT /suppliers/:id/pay - record a supplier payment and reduce outstanding due
  router.put("/:id/pay", async (req, res) => {
    const supplierId = toFiniteNumber(req.params?.id);
    const paymentAmount = toFiniteNumber(req.body?.payment);
    const requestedTotalDue = toFiniteNumber(req.body?.total_due);
    const paymentMethod = String(req.body?.payment_method || "Cash").trim() || "Cash";
    const restaurantId = req.user.restaurant_id;

    if (!supplierId) {
      return res.status(400).json({ error: "Invalid supplier id" });
    }

    if (!(paymentAmount > 0)) {
      return res.status(400).json({ error: "Payment amount must be greater than 0" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const supplierRes = await client.query(
        `SELECT id, name, total_due
           FROM suppliers
          WHERE restaurant_id = $1 AND id = $2
          FOR UPDATE`,
        [restaurantId, supplierId]
      );

      if (supplierRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Supplier not found" });
      }

      const supplier = supplierRes.rows[0];
      const currentDue = Number(supplier?.total_due) || 0;
      const dueBasis =
        requestedTotalDue !== null ? Math.max(currentDue, requestedTotalDue) : currentDue;
      const newDue = Math.max(0, dueBasis - paymentAmount);

      const paymentTx = await client.query(
        `INSERT INTO transactions
           (
             restaurant_id,
             supplier_id,
             ingredient,
             quantity,
             unit,
             total_cost,
             amount_paid,
             due_after,
             payment_method,
             delivery_date,
             expiry_date,
             receipt_url,
             items
           )
         VALUES ($1,$2,'Payment',0,NULL,0,$3,$4,$5,NOW(),NULL,NULL,NULL)
         RETURNING *`,
        [restaurantId, supplierId, paymentAmount, newDue, paymentMethod]
      );

      await client.query(
        `UPDATE suppliers
            SET total_due = $1
          WHERE restaurant_id = $2 AND id = $3`,
        [newDue, restaurantId, supplierId]
      );

      await client.query("COMMIT");

      io.emit("supplier-updated", { supplier_id: supplierId });

      return res.json({
        success: true,
        message: "Payment recorded successfully",
        supplier: {
          id: supplierId,
          name: supplier.name,
          total_due: newDue,
        },
        transaction: paymentTx.rows[0],
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Error recording supplier payment:", error);
      return res.status(500).json({ error: "Database error" });
    } finally {
      client.release();
    }
  });

  // ---------------- TRANSACTIONS ----------------

// POST /suppliers/transactions
// POST /suppliers/transactions — upload receipt + update stock + supplier due
	  router.post("/transactions", upload.array("receipt"), async (req, res) => {
	    try {
	    const restaurantId = req.user.restaurant_id;
	    let { supplier_id, rows, payment_method, amount_paid } = req.body;

	    const parsedJsonOriginal = parseOptionalJson(req.body?.parsed_json_original);
	    const parsedJsonCleaned = parseOptionalJson(req.body?.parsed_json_cleaned);
	    const sourceFileMeta = parseOptionalJson(req.body?.source_file_meta);
	    const correctionsMeta = parseOptionalJson(req.body?.corrections_meta);
	    const trainingOptIn =
	      typeof correctionsMeta?.trainingOptIn === "boolean"
	        ? correctionsMeta.trainingOptIn
	        : true;
	    const ocrRawTextOriginal =
	      req.body?.ocr_raw_text_original !== undefined &&
	      req.body?.ocr_raw_text_original !== null
	        ? String(req.body.ocr_raw_text_original)
	        : null;
	    const ocrRawTextEdited =
	      req.body?.ocr_raw_text_edited !== undefined &&
	      req.body?.ocr_raw_text_edited !== null
	        ? String(req.body.ocr_raw_text_edited)
	        : null;
	    const hasReceiptImportPayload = Boolean(
	      parsedJsonOriginal ||
	      parsedJsonCleaned ||
	      sourceFileMeta ||
	      correctionsMeta ||
	      (ocrRawTextOriginal && ocrRawTextOriginal.trim()) ||
	      (ocrRawTextEdited && ocrRawTextEdited.trim())
	    );

    if (!rows) return res.status(400).json({ error: "No rows provided" });
    rows = JSON.parse(rows); // expect array of { ingredient, quantity, unit, total_cost }

    let totalCost = 0;
    const itemDetails = [];
    let earliestExpiry = null;

    // 🔹 Compile receipt rows
    for (const r of rows) {
      const quantity = parseFloat(r.quantity) || 0;
      const total = parseFloat(r.total_cost) || 0;
      const discountRate = parseFloat(r.discount_rate) || 0;
      const discountAmount = parseFloat(r.discount_amount) || 0;
      const taxRate = parseFloat(r.tax ?? r.vat_rate ?? r.tax_rate) || 0;
      const normalizedExpiry = normalizeExpiryDate(r.expiry_date);
      totalCost += total;
      const isCleaning =
        r.is_cleaning_supply === true ||
        String(r.is_cleaning_supply).toLowerCase() === "true";
        const countedLeftRaw = r.counted_stock ?? r.stock_left ?? r.counted_left;
        const countedLeft = (() => {
          if (countedLeftRaw === null || countedLeftRaw === undefined || countedLeftRaw === "") return null;
          const normalized = String(countedLeftRaw).replace(",", ".").trim();
          const val = Number(normalized);
          return Number.isFinite(val) ? val : null;
        })();
      itemDetails.push({
        ingredient: r.ingredient?.trim(),
        quantity,
        unit: r.unit?.trim(),
        koli: Number.isFinite(Number(r.koli)) ? Number(r.koli) : null,
        amount_per_koli: Number.isFinite(Number(r.amount_per_koli)) ? Number(r.amount_per_koli) : null,
        discount_rate: discountRate,
        discount_amount: discountAmount,
        tax: taxRate,
        vat_rate: taxRate,
        total_cost: total,
        expiry_date: normalizedExpiry,
        price_per_unit: quantity > 0 ? total / quantity : 0,
        is_cleaning_supply: isCleaning,
        counted_left: countedLeft,
      });
      if (normalizedExpiry) {
        const candidate = new Date(normalizedExpiry).getTime();
        if (!Number.isNaN(candidate)) {
          if (
            !earliestExpiry ||
            candidate < new Date(earliestExpiry).getTime()
          ) {
            earliestExpiry = normalizedExpiry;
          }
        }
      }
    }

    // 🔹 Validate supplier
    const supplierRes = await pool.query(
      "SELECT total_due, name FROM suppliers WHERE restaurant_id=$1 AND id=$2",
      [restaurantId, supplier_id]
    );
    if (supplierRes.rowCount === 0)
      return res.status(404).json({ error: "Supplier not found" });

    const supplierName = supplierRes.rows[0]?.name || "";
    let currentDue = parseFloat(supplierRes.rows[0].total_due) || 0;
    
    // Parse amount_paid from request (default to 0 if not provided)
    const paidAmount = parseFloat(amount_paid) || 0;
    
    // Calculate new due: current_due + total_cost - amount_paid
    const newDue = Math.max(0, currentDue + totalCost - paidAmount);

    // 🔹 Optional receipt upload
    const receiptUrl = req.files?.[0]
      ? `/uploads/receipts/${req.files[0].filename}`
      : null;

    // 🔹 Save transaction
	    const result = await pool.query(
	      `INSERT INTO transactions
	       (restaurant_id, supplier_id, ingredient, quantity, unit, total_cost, amount_paid, due_after, payment_method, delivery_date, expiry_date, receipt_url, items)
       VALUES ($1,$2,'Compiled Receipt',0,NULL,$3,$4,$5,$6,NOW(),$7,$8,$9)
       RETURNING *`,
      [
        restaurantId,
        supplier_id,
        totalCost,
        paidAmount,
        newDue,
        payment_method || "Due",
        earliestExpiry,
        receiptUrl,
        JSON.stringify(itemDetails),
	      ]
	    );

	    if (hasReceiptImportPayload && result?.rows?.[0]?.id) {
	      try {
	        await pool.query(
	          `INSERT INTO receipt_imports
	             (
	               restaurant_id,
	               supplier_id,
	               transaction_id,
	               training_opt_in,
	               parsed_json_original,
	               parsed_json_cleaned,
	               ocr_raw_text_original,
	               ocr_raw_text_edited,
	               source_file_meta,
	               corrections_meta
	             )
	           VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9::jsonb,$10::jsonb)
	           ON CONFLICT (transaction_id)
	           DO UPDATE SET
	             training_opt_in = EXCLUDED.training_opt_in,
	             parsed_json_original = EXCLUDED.parsed_json_original,
	             parsed_json_cleaned = EXCLUDED.parsed_json_cleaned,
	             ocr_raw_text_original = EXCLUDED.ocr_raw_text_original,
	             ocr_raw_text_edited = EXCLUDED.ocr_raw_text_edited,
	             source_file_meta = EXCLUDED.source_file_meta,
	             corrections_meta = EXCLUDED.corrections_meta,
	             updated_at = NOW()`,
	          [
	            restaurantId,
	            supplier_id,
	            result.rows[0].id,
	            trainingOptIn,
	            parsedJsonOriginal ? JSON.stringify(parsedJsonOriginal) : null,
	            parsedJsonCleaned ? JSON.stringify(parsedJsonCleaned) : null,
	            ocrRawTextOriginal,
	            ocrRawTextEdited,
	            sourceFileMeta ? JSON.stringify(sourceFileMeta) : null,
	            correctionsMeta ? JSON.stringify(correctionsMeta) : null,
	          ]
	        );
	      } catch (importStoreErr) {
	        if (isMissingReceiptImportsSchemaError(importStoreErr)) {
	          console.warn(
	            "⚠️ receipt_imports table/columns not available yet. Skipping receipt training metadata persist."
	          );
	        } else {
	          throw importStoreErr;
	        }
	      }
	    }

	    // 🔹 Update supplier balance
	    await pool.query(
      "UPDATE suppliers SET total_due=$1 WHERE restaurant_id=$2 AND id=$3",
      [newDue, restaurantId, supplier_id]
    );

    // ✅ NEW PART: Upsert ingredients into stock
    await ensureCleaningColumns();
    for (const item of itemDetails) {
      const { ingredient, quantity, unit, expiry_date } = item;
      const unitNorm = await resolveUnitForConflict(restaurantId, ingredient, unit || "piece"); // reuse existing unit when possible

      if (!ingredient || !quantity || !unit) continue;

      let stockUpsert;
      const isCleaning = item.is_cleaning_supply === true;
      try {
        stockUpsert = await pool.query(
          `INSERT INTO stock (name, quantity, unit, supplier_id, restaurant_id, expiry_date, is_cleaning_supply)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (name, unit, restaurant_id)
           DO UPDATE SET
             quantity = stock.quantity + EXCLUDED.quantity,
             supplier_id = EXCLUDED.supplier_id,
             expiry_date = CASE
               WHEN stock.expiry_date IS NULL THEN EXCLUDED.expiry_date
               WHEN EXCLUDED.expiry_date IS NULL THEN stock.expiry_date
               ELSE LEAST(stock.expiry_date, EXCLUDED.expiry_date)
             END,
             is_cleaning_supply = COALESCE(EXCLUDED.is_cleaning_supply, stock.is_cleaning_supply, FALSE)
           RETURNING id, expiry_date, is_cleaning_supply, quantity`,
          [ingredient, quantity, unitNorm, supplier_id, restaurantId, expiry_date, isCleaning]
        );
      } catch (stockErr) {
        const code = stockErr?.code;
        const msg = String(stockErr?.message || "");
        const missingConflictTarget =
          code === "42P10" ||
          code === "42704" ||
          msg.toLowerCase().includes("no unique or exclusion constraint") ||
          msg.toLowerCase().includes("constraint") && msg.toLowerCase().includes("does not exist");

        if (!missingConflictTarget) {
          throw stockErr;
        }

        const updated = await pool.query(
          `UPDATE stock
           SET quantity = stock.quantity + $1,
               supplier_id = $2,
               expiry_date = CASE
                 WHEN stock.expiry_date IS NULL THEN $3
                 WHEN $3 IS NULL THEN stock.expiry_date
                 ELSE LEAST(stock.expiry_date, $3)
               END,
               is_cleaning_supply = COALESCE($7, stock.is_cleaning_supply, FALSE)
           WHERE restaurant_id = $4
             AND LOWER(BTRIM(name)) = LOWER(BTRIM($5))
             AND LOWER(BTRIM(unit)) = LOWER(BTRIM($6))
           RETURNING id, expiry_date, is_cleaning_supply, quantity`,
          [quantity, supplier_id, expiry_date, restaurantId, ingredient, unitNorm, isCleaning]
        );

        if (updated.rowCount > 0) {
          stockUpsert = updated;
        } else {
          stockUpsert = await pool.query(
            `INSERT INTO stock (name, quantity, unit, supplier_id, restaurant_id, expiry_date, is_cleaning_supply)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, expiry_date, is_cleaning_supply, quantity`,
            [ingredient, quantity, unitNorm, supplier_id, restaurantId, expiry_date, isCleaning]
          );
        }
      }

      const stockRow = stockUpsert.rows[0];
      if (stockRow?.id) {
        await maybeEmitExpiryAlert(
          io,
          restaurantId,
          stockRow.id,
          ingredient,
          stockRow.expiry_date
        );

        // Keep products table in sync with cleaning flag (best effort, tenant-scoped)
        try {
          await pool.query(
            `UPDATE products
               SET is_cleaning_supply = $1
             WHERE restaurant_id = $2
               AND LOWER(BTRIM(name)) = LOWER(BTRIM($3))`,
            [isCleaning, restaurantId, ingredient]
          );
        } catch (prodErr) {
          console.warn("⚠️ Failed to sync is_cleaning_supply to products:", prodErr.message);
        }

        // Optional counted stock adjustment (audit-safe via stock_movements)
        if (Number.isFinite(item.counted_left)) {
          const countedVal = Number(item.counted_left);
          const currentQty = Number(stockRow.quantity || 0);
          const delta = Number((countedVal - currentQty).toFixed(6));
          if (delta !== 0) {
            // Idempotency: one movement per transaction_id+stock_id
            const txId = result.rows?.[0]?.id ? String(result.rows[0].id) : null;
            let exists = false;
            if (txId) {
              const { rowCount } = await pool.query(
                `SELECT 1
                   FROM stock_movements
                  WHERE restaurant_id = $1
                    AND stock_id = $2
                    AND meta ->> 'transaction_id' = $3
                  LIMIT 1`,
                [restaurantId, stockRow.id, txId]
              );
              exists = rowCount > 0;
            }

            if (!exists) {
              const movementType = delta < 0 ? "consume" : "adjustment_increase";
              const qty = Math.abs(delta);
              console.log(
                "[supplier-counted-adjust]",
                JSON.stringify(
                  {
                    restaurantId,
                    stock_id: stockRow.id,
                    ingredient,
                    delta,
                    currentQty,
                    countedVal,
                    movementType,
                    txId,
                  },
                  null,
                  2
                )
              );
              await pool.query(
                `INSERT INTO stock_movements
                   (restaurant_id, stock_id, movement_type, qty, unit, reason, notes, user_id, meta)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [
                  restaurantId,
                  stockRow.id,
                  movementType,
                  qty,
                  unitNorm,
                  "counted_adjustment",
                  `Counted stock after supplier receipt (tx ${result.rows?.[0]?.id || "n/a"})`,
                  req.user?.id || null,
                  {
                    source: "supplier_receipt_count",
                    transaction_id: txId,
                    counted_left: countedVal,
                    previous_qty: currentQty,
                  },
                ]
              );

              try {
                await pool.query(
                  `UPDATE stock
                     SET quantity = $1
                   WHERE id = $2 AND restaurant_id = $3`,
                  [countedVal, stockRow.id, restaurantId]
                );
                const verify = await pool.query(
                  `SELECT quantity FROM stock WHERE id = $1 AND restaurant_id = $2`,
                  [stockRow.id, restaurantId]
                );
                console.log(
                  "[supplier-counted-adjust] post-update",
                  JSON.stringify(
                    {
                      stock_id: stockRow.id,
                      new_quantity: verify.rows?.[0]?.quantity,
                    },
                    null,
                    2
                  )
                );
              } catch (adjErr) {
                console.warn("⚠️ Failed to apply counted stock delta:", adjErr.message);
              }
            }
          } else {
            console.log(
              "[supplier-counted-adjust]",
              JSON.stringify(
                {
                  restaurantId,
                  stock_id: stockRow.id,
                  ingredient,
                  delta: 0,
                  currentQty,
                  countedVal,
                  note: "delta_zero_no_movement",
                },
                null,
                2
              )
            );
          }
        } else if (item.counted_left !== null && item.counted_left !== undefined) {
          console.log(
            "[supplier-counted-adjust]",
            JSON.stringify(
              {
                restaurantId,
                stock_id: stockRow.id,
                ingredient,
                counted_left_raw: item.counted_left,
                note: "counted_left_not_finite",
              },
              null,
              2
            )
          );
        }

        // Track batch for FIFO + audit (best effort, tenant-safe)
        try {
          const parsedQty = Number(item.quantity) || 0;
          const parsedTotal = Number(item.total_cost) || 0;
          const batchCost =
            Number(item.price_per_unit) ||
            (parsedQty > 0 ? parsedTotal / parsedQty : null);

          if (!(parsedQty > 0)) {
            throw new Error("Batch quantity missing");
          }

          await pool.query(
            `INSERT INTO stock_batches
             (restaurant_id, stock_id, supplier_id, supplier_name, batch_ref, expiry_date, quantity, remaining_quantity, cost_price, total_cost, source_transaction_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10)`,
            [
              restaurantId,
              stockRow.id,
              supplier_id,
              supplierName,
              item.batch_ref || item.batch || null,
              item.expiry_date || null,
              parsedQty,
              batchCost || null,
              parsedTotal || (batchCost && parsedQty > 0 ? batchCost * parsedQty : null),
              result?.rows?.[0]?.id || null,
            ]
          );
        } catch (batchErr) {
          console.warn("⚠️ Failed to persist stock batch:", batchErr.message);
        }
      }
    }

    // ✅ Persist latest purchase price into ingredient_price_history
    // Keeps /ingredient-prices in sync when new supplier transactions are recorded.
    // Supports legacy DBs that don't have restaurant_id on ingredient_price_history.
    for (const item of itemDetails) {
      const ingredient = String(item?.ingredient || "").trim();
      const unit = String(item?.unit || "").trim();
      const price = Number(item?.price_per_unit) || 0;
      if (!ingredient || !unit || !(price > 0)) continue;

      try {
        await pool.query(
          `
          INSERT INTO ingredient_price_history
            (restaurant_id, ingredient_name, unit, price, changed_at, reason, supplier_name)
          VALUES ($1, $2, $3, $4, NOW(), $5, $6)
          `,
          [restaurantId, ingredient, unit, price, "From receipt", supplierName]
        );
      } catch (e) {
        // Legacy fallback: ingredient_price_history without restaurant_id
        const code = e?.code;
        const msg = String(e?.message || "");
        const looksLikeMissingTenantColumn =
          code === "42703" || msg.toLowerCase().includes("restaurant_id");
        if (!looksLikeMissingTenantColumn) {
          console.warn(
            "⚠️ Failed to write ingredient_price_history from supplier transaction:",
            msg
          );
          continue;
        }

        try {
          await pool.query(
            `
            INSERT INTO ingredient_price_history
              (ingredient_name, unit, price, changed_at, reason, supplier_name)
            VALUES ($1, $2, $3, NOW(), $4, $5)
            `,
            [ingredient, unit, price, "From receipt", supplierName]
          );
        } catch (e2) {
          console.warn(
            "⚠️ Failed to write legacy ingredient_price_history from supplier transaction:",
            String(e2?.message || e2)
          );
        }
      }
    }

    // 🔹 Emit updates to frontend
    io.emit("stock-updated");
    io.emit("supplier-updated", { supplier_id });
    io.emit("ingredient-prices-updated");

    res.json({
      success: true,
      transaction: result.rows[0],
      message: "Transaction saved and stock updated successfully",
    });
  } catch (err) {
    console.error("❌ Error compiling receipt:", err);
    res.status(500).json({ error: "Database error" });
  }
});

  // POST /suppliers/invoices/extract-items - Extract product items from supplier invoice
  // Dedicated endpoint for OCR-based item extraction from invoice images
  router.post("/invoices/extract-items", upload.single("file"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const supplierId = toFiniteNumber(req.body?.supplier_id ?? req.query?.supplier_id);
    const filePath = req.file.path;
    let ocrPath = filePath;
    let converted = false;

    try {
      // Convert image to PNG for consistency
      try {
        const ext = path.extname(filePath).toLowerCase();
        const preprocessMaxSideCandidate = Number(process.env.SUPPLIER_OCR_PREPROCESS_MAX_SIDE);
        const preprocessMaxSide =
          Number.isFinite(preprocessMaxSideCandidate) && preprocessMaxSideCandidate >= 800
            ? preprocessMaxSideCandidate
            : 1600;
        // Always create a processed PNG file, regardless of input format
        const tmpPng = filePath.replace(/\.[^.]*$/, '') + '.ocr.png';
        
        console.log(`📸 Processing image: ${ext} → PNG`);
        await sharp(filePath)
          .rotate()
          .resize({
            width: preprocessMaxSide,
            height: preprocessMaxSide,
            fit: "inside",
            withoutEnlargement: true,
          })
          .grayscale()
          .png()
          .toFile(tmpPng);
        ocrPath = tmpPng;
        converted = true;
        console.log(`✅ Image preprocessed: ${tmpPng}`);
      } catch (convertErr) {
        console.warn("⚠️ Could not preprocess image, using original:", convertErr.message);
      }

      // Verify the image file exists before calling Python
      if (!fs.existsSync(ocrPath)) {
        console.error("❌ Image file does not exist:", ocrPath);
        console.error("   Original path:", filePath);
        console.error("   File exists:", fs.existsSync(filePath));
        return res.status(400).json({
          error: "Image file not found or preprocessing failed",
          details: `Expected file: ${ocrPath}`
        });
      }

      // Call Python script to extract items
      const pythonScript = path.join(__dirname, "..", "tools", "supplier_invoice_item_extractor.py");
      const pythonExe = process.env.OCR_PYTHON || "python3";
      const systemPathPrefix = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
      const runtimePath = process.env.PATH
        ? `${systemPathPrefix}:${process.env.PATH}`
        : systemPathPrefix;
      
      const runPythonExtractor = ({ timeoutMs, forceTesseract = false, forcePaddle = false }) =>
        new Promise((resolve, reject) => {
          const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180000;
          console.log(
            `📍 Starting OCR extraction with ${timeout / 1000}s timeout${forceTesseract ? " (forced tesseract)" : forcePaddle ? " (forced paddle)" : ""}`
          );
          const startTime = Date.now();
          const childEnv = {
            ...process.env,
            // Ensure system-installed binaries like tesseract are discoverable on EB
            PATH: runtimePath,
            // Force resilient defaults for primary pass; allow explicit overrides per retry strategy.
            SUPPLIER_OCR_MODE: forcePaddle ? "paddle" : "safe",
            SUPPLIER_OCR_ALLOW_PADDLE_FALLBACK: forceTesseract ? "false" : "true",
          };
          if (forceTesseract) {
            childEnv.SUPPLIER_OCR_FORCE_TESSERACT = "true";
            childEnv.SUPPLIER_OCR_ALLOW_PADDLE_FALLBACK = "false";
            childEnv.SUPPLIER_OCR_MODE = "safe";
          } else {
            childEnv.SUPPLIER_OCR_FORCE_TESSERACT = "false";
            if (forcePaddle) {
              childEnv.SUPPLIER_OCR_MODE = "paddle";
              childEnv.SUPPLIER_OCR_ALLOW_PADDLE_FALLBACK = "true";
            }
          }

          execFile(
            pythonExe,
            [pythonScript, ocrPath, String(supplierId || "0")],
            {
              maxBuffer: 10 * 1024 * 1024,
              timeout,
              cwd: path.dirname(pythonScript),
              env: childEnv,
            },
            (error, stdout, stderr) => {
              const duration = Date.now() - startTime;
              console.log(`⏱️ OCR extraction took ${duration}ms`);
              const stdoutText = String(stdout || "");
              const stderrText = String(stderr || "");
              const timedOut =
                Boolean(error?.killed) ||
                /timed out|etimedout/i.test(String(error?.message || "")) ||
                String(error?.code || "").toUpperCase() === "ETIMEDOUT";
              const processSummary = {
                duration_ms: duration,
                timeout_ms: timeout,
                timed_out: timedOut,
                exit_code: typeof error?.code === "number" ? error.code : null,
                signal: error?.signal || null,
                killed: Boolean(error?.killed),
                stdout_bytes: Buffer.byteLength(stdoutText, "utf8"),
                stderr_bytes: Buffer.byteLength(stderrText, "utf8"),
                python_executable: pythonExe,
                force_tesseract: forceTesseract,
                force_paddle: forcePaddle,
              };

              console.log("📊 OCR process summary:", processSummary);
              if (stderrText) {
                console.error("⚠️ Python stderr tail:", tailText(stderrText, 4000));
              }

              const parsed = parseJsonFromStdout(stdoutText);
              if (parsed) {
                if (parsed.error) {
                  console.error("❌ Python returned structured error:", {
                    error: parsed.error,
                    error_type: parsed.error_type,
                    engine: parsed.engine || null,
                  });
                  const extractionError = new Error(`Python extraction failed: ${parsed.error}`);
                  extractionError.python = {
                    ...processSummary,
                    stderr_tail: tailText(stderrText, 4000),
                    parsed_error: {
                      error: parsed.error,
                      error_type: parsed.error_type || null,
                      engine: parsed.engine || null,
                    },
                  };
                  return reject(extractionError);
                }

                if (error) {
                  console.warn("⚠️ Python process reported an error but returned valid JSON:", {
                    exit_code: processSummary.exit_code,
                    signal: processSummary.signal,
                    timed_out: processSummary.timed_out,
                  });
                }

                console.log(`✅ Extraction successful: ${parsed.item_count || 0} items found`);
                return resolve(parsed);
              }

              const stdoutPreview = stdoutText.slice(0, 500);
              console.error("Failed to parse Python output. First 500 chars:");
              console.error(stdoutPreview);
              const signalHint = error?.signal ? ` (signal: ${error.signal})` : "";
              const reason = timedOut
                ? `Python OCR timed out after ${timeout}ms`
                : error
                  ? `Python script failed${signalHint}: ${String(error.message || "Unknown process error")}`
                  : "Invalid JSON from Python output";
              const parseError = new Error(reason);
              parseError.python = {
                ...processSummary,
                stderr_tail: tailText(stderrText, 4000),
                stdout_preview: stdoutPreview,
              };
              reject(parseError);
            }
          );
        });

      const primaryTimeoutCandidate = Number(process.env.SUPPLIER_OCR_TIMEOUT_MS);
      const primaryTimeout =
        Number.isFinite(primaryTimeoutCandidate) && primaryTimeoutCandidate > 0
          ? primaryTimeoutCandidate
          : 180000; // 3 minutes for primary OCR path

      let ocrOutput;
      try {
        ocrOutput = await runPythonExtractor({ timeoutMs: primaryTimeout, forceTesseract: false });
      } catch (primaryErr) {
        const primaryErrorText = String(
          primaryErr?.python?.parsed_error?.error || primaryErr?.message || ""
        ).toLowerCase();
        const missingTesseract =
          primaryErrorText.includes("tesseract binary not found") ||
          primaryErrorText.includes("tesseract failed") ||
          primaryErrorText.includes("engine: 'tesseract'");

        if (missingTesseract) {
          console.warn("⚠️ Retrying OCR with forced Paddle due to missing/broken Tesseract", {
            reason: primaryErr?.message,
            python: primaryErr?.python,
          });
          try {
            ocrOutput = await runPythonExtractor({
              timeoutMs: primaryTimeout,
              forcePaddle: true,
            });
          } catch (paddleErr) {
            const combined = new Error(
              `OCR failed after forced Paddle retry. Primary: ${primaryErr?.message}. Paddle: ${paddleErr?.message}`
            );
            combined.python = {
              primary: primaryErr?.python || null,
              paddle: paddleErr?.python || null,
            };
            throw combined;
          }
        } else if (!shouldRetryWithForcedTesseract(primaryErr?.python)) {
          throw primaryErr;
        } else {
          const fallbackTimeoutCandidate = Number(process.env.SUPPLIER_OCR_TESSERACT_TIMEOUT_MS);
          const fallbackTimeout =
            Number.isFinite(fallbackTimeoutCandidate) && fallbackTimeoutCandidate > 0
              ? fallbackTimeoutCandidate
              : 90000;
          console.warn("⚠️ Retrying OCR with forced Tesseract fallback", {
            reason: primaryErr?.message,
            python: primaryErr?.python,
          });

          try {
            ocrOutput = await runPythonExtractor({
              timeoutMs: fallbackTimeout,
              forceTesseract: true,
            });
          } catch (fallbackErr) {
            const combined = new Error(
              `OCR failed after forced Tesseract fallback. Primary: ${primaryErr?.message}. Fallback: ${fallbackErr?.message}`
            );
            combined.python = {
              primary: primaryErr?.python || null,
              fallback: fallbackErr?.python || null,
            };
            throw combined;
          }
        }
      }

      const rawText = String(ocrOutput?.ocr?.text || "");
      const rawTextKey = normalizeTextKey(rawText);
      const likelyDenizDoc =
        rawTextKey.includes("deniz") &&
        (rawTextKey.includes("mesrubat") || rawTextKey.includes("mesruat"));
      const structuredFromText = rawText ? parseInvoiceTableItems(rawText) : { items: [], rejected: [] };
      const blockedNameTokens = [
        "fatura",
        "musteri",
        "vkn",
        "vergi",
        "iban",
        "banka",
        "odeme",
        "toplam",
        "kdv",
        "tarih",
        "saat",
      ];

      const inferUnitsPerCaseFromName = (name) => {
        const pack = String(name || "").match(/\b(\d+(?:[.,]\d+)?)\s*[xX]\s*(\d+(?:[.,]\d+)?)\b/);
        if (!pack) return null;
        const inferred = toFiniteNumber(parseOcrNumber(pack[2]));
        if (!Number.isFinite(inferred) || inferred <= 1 || inferred > 200) return null;
        return inferred;
      };

      const runTesseractTsv = async (targetPath, timeoutMs = 20000) => {
        const preferredLang = process.env.TESSERACT_LANG || process.env.SUPPLIER_OCR_TESSERACT_LANG || "tur+eng";
        const langCandidates = [...new Set([preferredLang, "tur+eng", "eng", "tur"].filter(Boolean))];
        const outputBase = `${targetPath}.tsv-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
        const tsvPath = `${outputBase}.tsv`;
        const cleanupTargets = [`${outputBase}.tsv`, `${outputBase}.txt`, `${outputBase}.osd`];
        const errors = [];

        const runExec = (args, langLabel, modeLabel) =>
          new Promise((resolve, reject) => {
            execFile(
              "tesseract",
              args,
              {
                timeout: timeoutMs,
                maxBuffer: 8 * 1024 * 1024,
                env: {
                  ...process.env,
                  PATH: runtimePath,
                  OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || "1",
                },
              },
              (err, stdout, stderr) => {
                if (err) {
                  const detail = String(stderr || err?.message || err).trim();
                  return reject(new Error(`${modeLabel}(${langLabel}): ${detail || "unknown tesseract error"}`));
                }
                return resolve(String(stdout || ""));
              }
            );
          });

        try {
          for (const lang of langCandidates) {
            const attempts = [
              {
                mode: "file-cfg",
                args: [
                  targetPath,
                  outputBase,
                  "-l",
                  lang,
                  "--oem",
                  "1",
                  "--psm",
                  "6",
                  "-c",
                  "tessedit_create_tsv=1",
                ],
              },
              {
                mode: "file-tsv",
                args: [targetPath, outputBase, "-l", lang, "--oem", "1", "--psm", "6", "tsv"],
              },
              {
                mode: "stdout-tsv",
                args: [targetPath, "stdout", "-l", lang, "--oem", "1", "--psm", "6", "tsv"],
              },
              {
                mode: "stdout-cfg",
                args: [
                  targetPath,
                  "stdout",
                  "-l",
                  lang,
                  "--oem",
                  "1",
                  "--psm",
                  "6",
                  "-c",
                  "tessedit_create_tsv=1",
                ],
              },
            ];

            for (const attempt of attempts) {
              try {
                const stdout = await runExec(attempt.args, lang, attempt.mode);
                if (fs.existsSync(tsvPath)) {
                  const fileText = String(fs.readFileSync(tsvPath, "utf8") || "");
                  if (fileText.includes("\t")) return fileText;
                }
                if (stdout.includes("\t")) return stdout;
              } catch (attemptErr) {
                errors.push(String(attemptErr?.message || attemptErr));
              }
            }
          }

          const compactErrors = errors.filter(Boolean).slice(0, 8).join(" | ");
          throw new Error(`Tesseract TSV failed: ${compactErrors || "all attempts returned empty TSV"}`);
        } finally {
          for (const target of cleanupTargets) {
            if (!target || !fs.existsSync(target)) continue;
            try {
              fs.unlinkSync(target);
            } catch {
              // best-effort temp cleanup
            }
          }
        }
      };

      const runTesseractPlainText = (targetPath, psm = 6, timeoutMs = 20000) =>
        new Promise((resolve, reject) => {
          const lang = process.env.TESSERACT_LANG || process.env.SUPPLIER_OCR_TESSERACT_LANG || "tur+eng";
          execFile(
            "tesseract",
            [targetPath, "stdout", "-l", lang, "--oem", "1", "--psm", String(psm)],
            {
              timeout: timeoutMs,
              maxBuffer: 12 * 1024 * 1024,
              env: {
                ...process.env,
                PATH: runtimePath,
                OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || "1",
              },
            },
            (err, stdout, stderr) => {
              if (err) {
                return reject(new Error(`Tesseract text failed: ${String(stderr || err?.message || err)}`));
              }
              const text = String(stdout || "").trim();
              if (!text) return reject(new Error("Tesseract text returned empty output"));
              return resolve(text);
            }
          );
        });

      const parseTsvWords = (tsvText) => {
        const out = [];
        const rows = String(tsvText || "")
          .split(/\r?\n/)
          .filter(Boolean);
        if (rows.length < 2) return out;
        const header = rows[0].split("\t");
        const idx = {
          left: header.indexOf("left"),
          top: header.indexOf("top"),
          width: header.indexOf("width"),
          height: header.indexOf("height"),
          conf: header.indexOf("conf"),
          text: header.indexOf("text"),
        };
        for (let i = 1; i < rows.length; i += 1) {
          const parts = rows[i].split("\t");
          if (parts.length <= idx.text || idx.text < 0) continue;
          const text = String(parts.slice(idx.text).join("\t") || "").trim();
          if (!text) continue;
          const conf = Number(parts[idx.conf]);
          if (Number.isFinite(conf) && conf < 0) continue;
          const left = Number(parts[idx.left]);
          const top = Number(parts[idx.top]);
          const width = Number(parts[idx.width]);
          const height = Number(parts[idx.height]);
          if (![left, top, width, height].every(Number.isFinite)) continue;
          out.push({
            text,
            conf: Number.isFinite(conf) ? conf : null,
            left,
            top,
            right: left + width,
            bottom: top + height,
            cx: left + width / 2,
            cy: top + height / 2,
          });
        }
        return out;
      };

              const clusterWordsToLines = (words) => {
              const sorted = [...(Array.isArray(words) ? words : [])].sort((a, b) => {
                if (a.cy !== b.cy) return a.cy - b.cy;
                return a.left - b.left;
              });
              const lines = [];
              const yTolerance = 12;
              for (const word of sorted) {
                const last = lines.length ? lines[lines.length - 1] : null;
                if (!last || Math.abs(word.cy - last.cy) > yTolerance) {
                  lines.push({
                    cy: word.cy,
                    words: [word]
                  });
                } else {
                  last.words.push(word);
                }
              }
              return lines;
            };
      
            return res.json({
              success: true,
              items: structuredFromText.items,
              rejected: structuredFromText.rejected,
              raw_text: rawText,
              source: "invoice_text_parser",
            });
          } catch (err) {
            console.error("❌ Error extracting invoice items:", err);
            res.status(500).json({
              error: "Failed to extract items from invoice",
              details: err?.message || String(err),
            });
          } finally {
            if (converted && fs.existsSync(ocrPath)) {
              try {
                fs.unlinkSync(ocrPath);
              } catch {
                // ignore cleanup errors
              }
            }
          }
        });
      
        return router;
      };
