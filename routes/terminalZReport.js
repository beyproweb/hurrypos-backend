const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const pool = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
const { parseZReportText, normalizeText, parseAmount } = require("../utils/zreportParser");
const { runZReportOcr } = require("../utils/zreportOcr");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const router = express.Router();
router.use(authMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = new Set([
      "image/jpeg",
      "image/jpg",
      "image/png",
      "application/pdf",
      "application/octet-stream",
    ]);
    const ext = path.extname(file.originalname || "").toLowerCase();
    const extAllowed = [".jpg", ".jpeg", ".png", ".pdf"].includes(ext);
    if (!allowed.has(file.mimetype) && !extAllowed) {
      return cb(new Error("Unsupported file type"));
    }
    cb(null, true);
  },
});

const uploadToCloudinary = (buffer, filename) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "terminal-reports", public_id: filename },
      (error, result) => {
        if (error) return reject(error);
        if (!result?.secure_url) return reject(new Error("No URL returned"));
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });

const toNumberOrNull = (value) =>
  Number.isFinite(Number(value)) ? Number(value) : null;

const sumNullable = (rows, key) => {
  let hasAny = false;
  let total = 0;
  rows.forEach((r) => {
    const v = toNumberOrNull(r?.extracted?.[key]);
    if (v == null) return;
    hasAny = true;
    total += v;
  });
  return hasAny ? total : null;
};

const sumNullableInt = (rows, key) => {
  const v = sumNullable(rows, key);
  return v == null ? null : Math.round(v);
};

const aggregateOverallConfidence = (rows) => {
  if (!rows.length) return "low";
  const levels = rows.map((r) => r?.confidence?.overall).filter(Boolean);
  if (!levels.length) return "low";
  if (levels.every((l) => l === "high")) return "high";
  if (levels.some((l) => l === "high" || l === "medium")) return "medium";
  return "low";
};

const avgConfidence = (rows, key) => {
  const nums = rows
    .map((r) => Number(r?.confidence?.[key]))
    .filter((v) => Number.isFinite(v));
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
};

const collectIncomingFiles = (req) => {
  const filesByField = req.files && typeof req.files === "object" ? req.files : {};
  const direct = Array.isArray(req.files) ? req.files : [];
  const fromFile = Array.isArray(filesByField.file) ? filesByField.file : [];
  const fromFiles = Array.isArray(filesByField.files) ? filesByField.files : [];
  return [...direct, ...fromFile, ...fromFiles].filter(Boolean);
};

let ensuredReceiptCacheTable = false;
let ensuredLayoutCacheTable = false;
const LAYOUT_CACHE_ENABLED = String(process.env.ZREPORT_LAYOUT_CACHE || "") === "1";
const LAYOUT_CACHE_PARSER_VERSION = 1;
const ensureReceiptCacheTable = async () => {
  if (ensuredReceiptCacheTable) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zreport_receipt_cache (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL,
      file_hash TEXT NOT NULL,
      extracted JSONB,
      confidence JSONB,
      raw JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (restaurant_id, file_hash)
    )
  `);
  ensuredReceiptCacheTable = true;
};

const ensureLayoutCacheTable = async () => {
  if (ensuredLayoutCacheTable) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zreport_layout_cache (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL,
      layout_hash TEXT NOT NULL,
      parser_version INTEGER NOT NULL,
      hints JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      hit_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (restaurant_id, layout_hash, parser_version)
    )
  `);
  ensuredLayoutCacheTable = true;
};

const hashReceiptBuffer = (buffer) =>
  crypto.createHash("sha256").update(buffer || Buffer.alloc(0)).digest("hex");

const buildLayoutHash = (ocrText) => {
  const skeleton = normalizeText(ocrText || "")
    .split(/\n/)
    .map((line) =>
      line
        .replace(/\d/g, "#")
        .replace(/[.,:;*_/\\\-+]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .slice(0, 80)
    .join("\n");
  return crypto.createHash("sha256").update(skeleton).digest("hex");
};

const hasExtractedValue = (extracted) => {
  if (!extracted || typeof extracted !== "object") return false;
  const keys = ["card_total", "cash_total", "grand_total", "tx_count", "refund_total"];
  return keys.some((key) => extracted[key] !== null && extracted[key] !== undefined);
};

const extractAmountsFromLine = (line) => {
  const raw = String(line || "");
  const tokens = raw.match(/[-]?\d[\d.,]*\d/g) || [];
  return tokens
    .map((token) => parseAmount(token))
    .filter((value) => Number.isFinite(value));
};

const parseTxCountFromLine = (line) => {
  const text = normalizeText(line || "");
  const patterns = [
    /(\d{1,4})\s*(?:ADET|ISLEM|ISLEM ADET|FIS|TX|TRANSACTION|COUNT)\b/,
    /\b(?:ADET|ISLEM|FIS|COUNT|TX)\s*[:\-]?\s*(\d{1,4})\b/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && Number.isFinite(Number(m[1]))) return Number(m[1]);
  }
  return null;
};

const roughlyEqual = (a, b) => {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= Math.max(1, Math.abs(y) * 0.01);
};

const findAmountLineIndex = (lines, target) => {
  if (!Number.isFinite(Number(target))) return null;
  let bestIndex = null;
  for (let i = 0; i < lines.length; i += 1) {
    const amounts = extractAmountsFromLine(lines[i].original);
    if (amounts.some((value) => roughlyEqual(value, target))) {
      bestIndex = i;
      if (/(KART|CARD|TOPLAM|TOTAL|TL|TRY)/i.test(lines[i].normalized)) return i;
    }
  }
  return bestIndex;
};

const findTxLineIndex = (lines, targetTx) => {
  if (!Number.isFinite(Number(targetTx))) return null;
  for (let i = 0; i < lines.length; i += 1) {
    const tx = parseTxCountFromLine(lines[i].normalized);
    if (tx != null && tx === Number(targetTx)) return i;
  }
  return null;
};

const buildLayoutHintsFromParse = (ocrText, parseResult) => {
  const extracted = parseResult?.extracted || {};
  const normalizedLines = normalizeText(ocrText || "").split(/\n/);
  const originalLines = String(ocrText || "").split(/\n/);
  const lines = normalizedLines.map((line, index) => ({
    normalized: String(line || "").trim(),
    original: String(originalLines[index] || "").trim(),
  }));
  return {
    matched_label: parseResult?.raw?.matched_label || null,
    bank_name: extracted.bank_name || null,
    card_line_index: findAmountLineIndex(lines, extracted.card_total),
    cash_line_index: findAmountLineIndex(lines, extracted.cash_total),
    grand_line_index: findAmountLineIndex(lines, extracted.grand_total),
    refund_line_index: findAmountLineIndex(lines, extracted.refund_total),
    tx_line_index: findTxLineIndex(lines, extracted.tx_count),
  };
};

const pickAmountNearIndex = (lines, index, minValue = 0) => {
  if (index == null || index < 0) return null;
  for (let offset = 0; offset <= 2; offset += 1) {
    const row = lines[index + offset];
    if (!row) continue;
    const amounts = extractAmountsFromLine(row.original).filter((value) => value >= minValue);
    if (!amounts.length) continue;
    return Math.max(...amounts);
  }
  return null;
};

const parseWithLayoutHints = (ocrText, hints) => {
  if (!hints || typeof hints !== "object") return null;
  const normalizedLines = normalizeText(ocrText || "").split(/\n/);
  const originalLines = String(ocrText || "").split(/\n/);
  const lines = normalizedLines.map((line, index) => ({
    normalized: String(line || "").trim(),
    original: String(originalLines[index] || "").trim(),
  }));

  let cardTotal = pickAmountNearIndex(lines, hints.card_line_index, 1);
  const cashTotal = pickAmountNearIndex(lines, hints.cash_line_index, 0);
  let grandTotal = pickAmountNearIndex(lines, hints.grand_line_index, 1);
  const refundTotal = pickAmountNearIndex(lines, hints.refund_line_index, 0);
  let txCount =
    hints.tx_line_index != null ? parseTxCountFromLine(lines[hints.tx_line_index]?.normalized || "") : null;

  if (txCount == null && hints.card_line_index != null) {
    for (let offset = 0; offset <= 2; offset += 1) {
      txCount = parseTxCountFromLine(lines[hints.card_line_index + offset]?.normalized || "");
      if (txCount != null) break;
    }
  }
  if (cardTotal != null && grandTotal == null && cashTotal == null) {
    grandTotal = cardTotal;
  }
  if (grandTotal != null && cardTotal == null && cashTotal == null) {
    cardTotal = grandTotal;
  }

  const hasStrong = cardTotal != null && (grandTotal != null || txCount != null);
  if (!hasStrong) return null;

  return {
    extracted: {
      card_total: cardTotal,
      cash_total: cashTotal,
      grand_total: grandTotal,
      tx_count: txCount,
      refund_total: refundTotal,
      bank_name: hints.bank_name || null,
      currency: /(?:\bTL\b|₺|\bTRY\b)/i.test(ocrText || "") ? "TRY" : "TRY",
    },
    confidence: {
      overall: "medium",
      card_total: 0.7,
      tx_count: txCount != null ? 0.6 : 0,
    },
    raw: {
      text_excerpt: String(ocrText || "").slice(0, 1000),
      matched_label: hints.matched_label || null,
      bank_name: hints.bank_name || null,
      layout_hint_used: true,
    },
  };
};

const getCachedReceiptParse = async (restaurantId, fileHash) => {
  await ensureReceiptCacheTable();
  const { rows } = await pool.query(
    `
      SELECT extracted, confidence, raw
      FROM zreport_receipt_cache
      WHERE restaurant_id = $1 AND file_hash = $2
      LIMIT 1
    `,
    [restaurantId, fileHash]
  );
  const row = rows[0];
  if (!row || !hasExtractedValue(row.extracted)) return null;
  await pool.query(
    `UPDATE zreport_receipt_cache SET last_used_at = NOW() WHERE restaurant_id = $1 AND file_hash = $2`,
    [restaurantId, fileHash]
  ).catch(() => {});
  return row;
};

const getLayoutHints = async (restaurantId, layoutHash) => {
  await ensureLayoutCacheTable();
  const { rows } = await pool.query(
    `
      SELECT hints
      FROM zreport_layout_cache
      WHERE restaurant_id = $1 AND layout_hash = $2 AND parser_version = $3
      LIMIT 1
    `,
    [restaurantId, layoutHash, LAYOUT_CACHE_PARSER_VERSION]
  );
  const row = rows[0];
  if (!row?.hints) return null;
  await pool.query(
    `
      UPDATE zreport_layout_cache
      SET last_used_at = NOW(), hit_count = hit_count + 1
      WHERE restaurant_id = $1 AND layout_hash = $2 AND parser_version = $3
    `,
    [restaurantId, layoutHash, LAYOUT_CACHE_PARSER_VERSION]
  ).catch(() => {});
  return row.hints;
};

const upsertReceiptParse = async (restaurantId, fileHash, parseResult) => {
  if (!hasExtractedValue(parseResult?.extracted)) return;
  await ensureReceiptCacheTable();
  await pool.query(
    `
      INSERT INTO zreport_receipt_cache (restaurant_id, file_hash, extracted, confidence, raw)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (restaurant_id, file_hash)
      DO UPDATE SET
        extracted = EXCLUDED.extracted,
        confidence = EXCLUDED.confidence,
        raw = EXCLUDED.raw,
        last_used_at = NOW()
    `,
    [
      restaurantId,
      fileHash,
      parseResult?.extracted || null,
      parseResult?.confidence || null,
      parseResult?.raw || null,
    ]
  );
};

const upsertLayoutHints = async (restaurantId, layoutHash, hints) => {
  if (!hints || typeof hints !== "object") return;
  await ensureLayoutCacheTable();
  await pool.query(
    `
      INSERT INTO zreport_layout_cache (restaurant_id, layout_hash, parser_version, hints)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (restaurant_id, layout_hash, parser_version)
      DO UPDATE SET hints = EXCLUDED.hints, last_used_at = NOW()
    `,
    [restaurantId, layoutHash, LAYOUT_CACHE_PARSER_VERSION, hints]
  );
};

router.post(
  "/parse",
  upload.fields([
    { name: "file", maxCount: 10 },
    { name: "files", maxCount: 10 },
  ]),
  async (req, res) => {
  const restaurantId = req.user?.restaurant_id;
  if (!restaurantId) {
    return res.status(400).json({ error: "Restaurant not resolved" });
  }
  const incomingFiles = collectIncomingFiles(req);
  if (!incomingFiles.length) {
    return res.status(400).json({ error: "No file uploaded. Use field `file` or `files`." });
  }
  const debug = String(req.body?.debug || "") === "1" || process.env.ZREPORT_DEBUG === "1";
  const reports = [];

	  try {
	    for (const inputFile of incomingFiles) {
	      const fileHash = hashReceiptBuffer(inputFile.buffer);
	      const ext = path.extname(inputFile.originalname || "").toLowerCase() || ".bin";
	      const tempPath = path.join(
	        "/tmp",
        `zreport_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`
      );

      let reportUrl = null;
      let ocrText = "";
      let parseResult = null;
      let usedCache = false;
      let usedLayoutCache = false;

      try {
        await fs.promises.writeFile(tempPath, inputFile.buffer);
        reportUrl = await uploadToCloudinary(
          inputFile.buffer,
          `zreport_${Date.now()}_${Math.random().toString(36).slice(2)}`
        );

        try {
          const cachedParse = await getCachedReceiptParse(restaurantId, fileHash).catch(() => null);
          if (cachedParse) {
            usedCache = true;
            parseResult = {
              extracted: cachedParse.extracted || null,
              confidence: cachedParse.confidence || { overall: "low", card_total: 0, tx_count: 0 },
              raw: cachedParse.raw || { text_excerpt: "", matched_label: null },
            };
            if (debug) {
              console.log("🔎 [zreport] Cache hit:", { fileHash });
            }
          } else {
            ocrText = await runZReportOcr(tempPath);
            if (debug) {
              console.log("🔎 [zreport] OCR excerpt:", String(ocrText || "").slice(0, 400));
            }
            if (LAYOUT_CACHE_ENABLED) {
              const layoutHash = buildLayoutHash(ocrText);
              const layoutHints = await getLayoutHints(restaurantId, layoutHash).catch(() => null);
              if (layoutHints) {
                const hinted = parseWithLayoutHints(ocrText, layoutHints);
                if (hinted && hasExtractedValue(hinted.extracted)) {
                  usedLayoutCache = true;
                  parseResult = hinted;
                }
              }
              if (!parseResult) {
                parseResult = parseZReportText(ocrText, debug);
                if (hasExtractedValue(parseResult?.extracted)) {
                  const nextHints = buildLayoutHintsFromParse(ocrText, parseResult);
                  upsertLayoutHints(restaurantId, layoutHash, nextHints).catch(() => {});
                }
              }
            } else {
              parseResult = parseZReportText(ocrText, debug);
            }
            upsertReceiptParse(restaurantId, fileHash, parseResult).catch(() => {});
          }
          if (debug) {
            console.log("🔎 [zreport] Parse result:", {
              extracted: parseResult?.extracted,
              confidence: parseResult?.confidence,
              matched_label: parseResult?.raw?.matched_label,
            });
          }
        } catch (ocrErr) {
          parseResult = {
            extracted: {
              card_total: null,
              cash_total: null,
              grand_total: null,
              tx_count: null,
              refund_total: null,
              currency: "TRY",
            },
            confidence: { overall: "low", card_total: 0, tx_count: 0 },
            raw: {
              text_excerpt: "",
              matched_label: null,
              ocr_error: ocrErr?.message || "OCR_FAILED",
            },
          };
        }
      } finally {
        try {
          await fs.promises.unlink(tempPath);
        } catch {
          // ignore temp cleanup errors
        }
      }

		      reports.push({
		        file_name: inputFile.originalname || null,
		        report_url: reportUrl,
		        extracted: parseResult?.extracted || null,
		        confidence: parseResult?.confidence || { overall: "low", card_total: 0, tx_count: 0 },
		        raw: parseResult?.raw || { text_excerpt: "", matched_label: null },
            used_cache: usedCache,
            used_layout_cache: usedLayoutCache,
		      });
		    }
	  } catch (err) {
	    console.error("❌ Z report parse failed:", err);
	    return res.status(500).json({ error: "Failed to parse report" });
  }

  const extractedAggregate = {
    card_total: sumNullable(reports, "card_total"),
    cash_total: sumNullable(reports, "cash_total"),
    grand_total: sumNullable(reports, "grand_total"),
    tx_count: sumNullableInt(reports, "tx_count"),
    refund_total: sumNullable(reports, "refund_total"),
    currency: "TRY",
  };
  const confidenceAggregate = {
    overall: aggregateOverallConfidence(reports),
    card_total: avgConfidence(reports, "card_total"),
    tx_count: avgConfidence(reports, "tx_count"),
  };
  const firstReport = reports[0] || null;

  return res.json({
    report_url: firstReport?.report_url || null,
    report_urls: reports.map((r) => r.report_url).filter(Boolean),
    extracted: extractedAggregate,
    confidence: confidenceAggregate,
    raw: {
      text_excerpt: "",
      matched_label: null,
      reports_count: reports.length,
    },
    reports,
  });
});

module.exports = router;
