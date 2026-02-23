const jwt = require("jsonwebtoken");
const OpenAI = require("openai");
const { pool } = require("../db");
const { loadLocalizationForRestaurant } = require("../utils/localization");

// Lazily create a single OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const OFFENSIVE_WORDS = [
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "bastard",
  "porn",
  "rape",
  "terror",
  "bomb",
];

async function ensureVoiceLogsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_logs (
      id SERIAL PRIMARY KEY,
      restaurant_id INT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      transcript TEXT NOT NULL,
      parsed_json JSONB,
      confirmed_json JSONB,
      confidence_score NUMERIC,
      language TEXT,
      order_type TEXT,
      table_id TEXT,
      source TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

function hasOffensiveContent(text = "") {
  const lower = String(text || "").toLowerCase();
  return OFFENSIVE_WORDS.some((w) => lower.includes(w));
}

async function resolveRestaurantId(req) {
  if (req.user?.restaurant_id) {
    return { restaurantId: req.user.restaurant_id, reason: "auth" };
  }

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded?.restaurant_id) {
        return { restaurantId: decoded.restaurant_id, reason: "qr-token" };
      }
    } catch (err) {
      // fall through — token might be a user JWT for another domain
    }
  }

  const bodyId = Number(req.body?.restaurant_id);
  if (Number.isFinite(bodyId) && bodyId > 0) {
    return { restaurantId: bodyId, reason: "payload" };
  }

  const identifier =
    req.body?.restaurant_identifier ||
    req.body?.identifier ||
    req.query?.identifier;

  if (identifier) {
    const { rows } = await pool.query(
      `SELECT id FROM restaurants WHERE id::text = $1 OR slug = $1 OR qr_code_id = $1 LIMIT 1`,
      [String(identifier).trim()]
    );
    if (rows.length) {
      return { restaurantId: rows[0].id, reason: "identifier" };
    }
  }

  return { restaurantId: null, reason: "missing" };
}

function normalizeExtras(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") {
        return { name: item, type: "add", value: item };
      }
      return item;
    })
    .filter(Boolean);
}

function normalizeModifiers(mods) {
  if (!Array.isArray(mods)) return [];
  return mods
    .map((m) => {
      if (!m) return null;
      if (typeof m === "string") {
        return { type: "add", value: m };
      }
      return { ...m, type: m.type || "add" };
    })
    .filter(Boolean);
}

function parseMaybeJson(value) {
  if (!value || typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return value;
  }
}

function buildMenuSketch(products = [], extrasGroups = []) {
  // Keep payload compact to reduce token usage
  const compactExtras = (product) => {
    if (!product) return [];
    const fromProduct = Array.isArray(product.extras)
      ? product.extras
      : parseMaybeJson(product.extras);

    return Array.isArray(fromProduct)
      ? fromProduct.map((ex) => ({ name: ex.name, price: ex.price ?? ex.extraPrice ?? 0 }))
      : [];
  };

  const groupById = new Map();
  extrasGroups.forEach((g) => {
    const items = Array.isArray(g.items) ? g.items : parseMaybeJson(g.items) || [];
    groupById.set(Number(g.id), items.map((it) => ({ name: it.name, price: it.price ?? it.extraPrice ?? 0 })));
  });

  return products.slice(0, 120).map((p) => {
    const groupIds = Array.isArray(p.selected_extras_group)
      ? p.selected_extras_group
      : parseMaybeJson(p.selected_extras_group) || [];
    const extras = compactExtras(p);
    groupIds.forEach((gid) => {
      const grp = groupById.get(Number(gid));
      if (Array.isArray(grp)) extras.push(...grp);
    });

    return {
      id: p.id,
      name: p.name,
      category: p.category,
      price: p.price,
      extras,
    };
  });
}

function levenshtein(a, b) {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const m = s.length;
  const n = t.length;
  if (!m) return n;
  if (!n) return m;
  const v0 = new Array(n + 1).fill(0);
  const v1 = new Array(n + 1).fill(0);
  for (let i = 0; i <= n; i++) v0[i] = i;
  for (let i = 0; i < m; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < n; j++) {
      const cost = s[i] === t[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= n; j++) v0[j] = v1[j];
  }
  return v1[n];
}

function findClosestProducts(products, target, limit = 3) {
  const scored = products.map((p) => {
    const distance = levenshtein(String(p.name || ""), String(target || ""));
    const maxLen = Math.max(String(p.name || "").length, String(target || "").length, 1);
    const score = 1 - distance / maxLen;
    return { id: p.id, name: p.name, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter((p) => p.score > 0.2);
}

function matchProductsToItems(rawItems, products) {
  const byName = new Map(
    products.map((p) => [String(p.name || "").toLowerCase(), p])
  );

  return rawItems.map((item) => {
    const normalizedName = String(item.product_name || item.name || "").trim();
    const direct = byName.get(normalizedName.toLowerCase()) || null;
    let resolved = direct;
    let matchScore = direct ? 1 : 0;

    if (!resolved) {
      const best = findClosestProducts(products, normalizedName, 1)[0];
      if (best) {
        resolved = products.find((p) => p.id === best.id) || null;
        matchScore = best.score;
      }
    }

    return {
      ...item,
      product_name: normalizedName,
      product_id: resolved?.id || null,
      product_match_score: matchScore,
    };
  });
}

async function loadSynonyms(restaurantId) {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM settings WHERE restaurant_id = $1 AND key = 'voice_synonyms' LIMIT 1`,
      [restaurantId]
    );
    if (!rows.length) return {};
    const parsed = parseMaybeJson(rows[0].value);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (err) {
    console.warn("⚠️ Failed to load voice synonyms:", err.message);
  }
  return {};
}

async function fetchMenu(restaurantId) {
  const [productsRes, extrasRes] = await Promise.all([
    pool.query(
      `SELECT id, name, price, category, description, image, extras, selected_extras_group
         FROM products
        WHERE restaurant_id = $1 AND COALESCE(visible, true) = true
        ORDER BY category, name` ,
      [restaurantId]
    ),
    pool.query(
      `SELECT id, group_name, items
         FROM extras_groups
        WHERE restaurant_id = $1
        ORDER BY id ASC` ,
      [restaurantId]
    ),
  ]);

  return { products: productsRes.rows || [], extrasGroups: extrasRes.rows || [] };
}

async function callOpenAiParser({ transcript, languageLabel, menuSketch, synonyms }) {
  const schema = {
    name: "voice_order_schema",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              product_name: { type: "string" },
              quantity: { type: "integer", minimum: 1 },
              size: { type: "string", nullable: true },
              modifiers: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["add", "remove", "substitute"] },
                    value: { type: "string" },
                  },
                  required: ["type", "value"],
                  additionalProperties: false,
                },
                nullable: true,
              },
            },
            required: ["product_name", "quantity", "size", "modifiers"],
          },
        },
        clarification_required: { type: "boolean" },
        clarification_question: { type: ["string", "null"] },
        confidence_score: { type: "number" },
      },
      required: [
        "items",
        "clarification_required",
        "clarification_question",
        "confidence_score",
      ],
    },
    strict: true,
  };

  const system = `You are a restaurant menu order parser. You ONLY return JSON that matches the provided schema. Never invent menu items. If unsure, ask a short clarification question and set clarification_required=true. Max 20 items.`;

  const user = `Language: ${languageLabel}
Transcript: "${transcript}"

Menu items (id, name, category, extras): ${JSON.stringify(menuSketch).slice(0, 6000)}
Synonyms map (per restaurant): ${JSON.stringify(synonyms)}

Rules:
- Do not guess items that are not in the menu list.
- If an item is unclear, set clarification_required=true and include a short clarification_question.
- Use modifiers to represent adds/removes (e.g., remove onion, add extra cheese).
- If beverage size is mentioned, put it in size.
- Max 20 total items.
- Return confidence_score between 0 and 1 (lower if unsure).
`;

  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_ORDER_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: schema },
    temperature: 0.2,
    max_tokens: 400,
  });

  const raw = response?.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      items: [],
      clarification_required: true,
      clarification_question: "Could you repeat the order?",
      confidence_score: 0,
    };
  }
  return parsed;
}

async function parseOrder(req, res) {
  try {
    const { transcript = "", table_id = null, order_type = "table", language = null } = req.body || {};

    if (!transcript || String(transcript).trim().length < 2) {
      return res.status(400).json({ error: "Transcript is required" });
    }

    if (hasOffensiveContent(transcript)) {
      return res.status(400).json({ error: "Offensive content detected" });
    }

    const { restaurantId } = await resolveRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: "Restaurant not resolved" });
    }

    await ensureVoiceLogsTable();

    const localization = await loadLocalizationForRestaurant(restaurantId);
    const languageCode = (language || localization?.language || "en").toLowerCase();
    const languageLabelMap = { tr: "Turkish", en: "English", de: "German", fr: "French" };
    const languageLabel = languageLabelMap[languageCode] || "English";

    const { products, extrasGroups } = await fetchMenu(restaurantId);
    const synonyms = await loadSynonyms(restaurantId);
    const menuSketch = buildMenuSketch(products, extrasGroups);

    if (menuSketch.length === 0) {
      return res.status(400).json({ error: "Menu is empty for this restaurant" });
    }

    const aiResult = await callOpenAiParser({ transcript, languageLabel, menuSketch, synonyms });
    const rawItems = Array.isArray(aiResult.items) ? aiResult.items.slice(0, 20) : [];
    const matchedItems = matchProductsToItems(rawItems, products).map((item) => ({
      ...item,
      modifiers: normalizeModifiers(item.modifiers || item.extras),
    }));

    let clarificationRequired = Boolean(aiResult.clarification_required);
    let clarificationQuestion = aiResult.clarification_question || null;

    const unresolved = matchedItems.filter((it) => !it.product_id);
    const suggestions = unresolved.map((it) => ({
      requested: it.product_name,
      suggestions: findClosestProducts(products, it.product_name, 3),
    }));

    if (unresolved.length > 0) {
      clarificationRequired = true;
      if (!clarificationQuestion) {
        clarificationQuestion = `Did you mean ${suggestions[0]?.suggestions?.map((s) => s.name).join(", ") || "which item"}?`;
      }
    }

    const confidence = Math.max(0, Math.min(1, Number(aiResult.confidence_score) || 0));

    const logInsert = await pool.query(
      `INSERT INTO voice_logs (restaurant_id, transcript, parsed_json, confidence_score, language, order_type, table_id, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        restaurantId,
        transcript,
        JSON.stringify({ ...aiResult, items: matchedItems }),
        confidence,
        languageCode,
        order_type || "table",
        table_id ? String(table_id) : null,
        req.user ? "pos" : "qr",
      ]
    );

    return res.json({
      items: matchedItems,
      clarification_required: clarificationRequired,
      clarification_question: clarificationQuestion,
      confidence_score: confidence,
      suggestions,
      log_id: logInsert.rows[0]?.id || null,
      language: languageCode,
    });
  } catch (err) {
    console.error("❌ voice parse-order failed:", err);
    return res.status(500).json({ error: "Voice parsing failed" });
  }
}

async function confirmLog(req, res) {
  try {
    const logId = Number(req.params.id);
    if (!Number.isFinite(logId)) {
      return res.status(400).json({ error: "Invalid log id" });
    }

    const { restaurantId } = await resolveRestaurantId(req);
    if (!restaurantId) return res.status(401).json({ error: "Restaurant not resolved" });

    const { confirmed_json, confidence_score } = req.body || {};
    await ensureVoiceLogsTable();

    const result = await pool.query(
      `UPDATE voice_logs
          SET confirmed_json = COALESCE($1::jsonb, confirmed_json),
              confidence_score = COALESCE($2, confidence_score)
        WHERE id = $3 AND restaurant_id = $4
        RETURNING id`,
      [confirmed_json ? JSON.stringify(confirmed_json) : null, confidence_score || null, logId, restaurantId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Log not found" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ voice log confirm failed:", err);
    return res.status(500).json({ error: "Failed to update voice log" });
  }
}

module.exports = {
  parseOrder,
  confirmLog,
};
