const { pool } = require("../db");
const { getIO } = require("./socket");
const { emitAlert, emitStockUpdate } = require("./realtime");

const formatQuantity = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
};

// ✅ Update stock based on ingredients and extras
async function updateStockForOrder(orderItems, restaurantId, io) {
  const ioRef = io || getIO();
  console.log("🧾 Received order items:", orderItems);

  // Helper: resolve extras group amount/unit
  async function resolveExtraFromGroups(name) {
    const q = await pool.query(
      `SELECT amount, unit
       FROM extras_group_items
       WHERE LOWER(ingredient_name) = LOWER($1)
       ORDER BY id DESC
       LIMIT 1`,
      [name]
    );
    if (!q.rows.length) return null;
    const r = q.rows[0] || {};
    return { amount: Number(r.amount), unit: (r.unit || "").toLowerCase() };
  }

  // Helper: fallback unit from stock
  async function resolveUnitFromStock(name) {
    const q = await pool.query(
      `SELECT unit
       FROM stock
       WHERE restaurant_id = $1 AND LOWER(name) = LOWER($2)
       ORDER BY id DESC
       LIMIT 1`,
      [restaurantId, name]
    );
    if (!q.rows.length) return "";
    return (q.rows[0].unit || "").toLowerCase();
  }

  const extraByIdCache = new Map();
  async function resolveExtraById(extraId) {
    if (!extraId) return null;
    const cacheKey = Number(extraId);
    if (extraByIdCache.has(cacheKey)) return extraByIdCache.get(cacheKey);
    const q = await pool.query(
      `SELECT id, ingredient_name, amount, unit
       FROM extras_group_items
       WHERE restaurant_id = $1 AND id = $2
       LIMIT 1`,
      [restaurantId, cacheKey]
    );
    const row = q.rows[0] || null;
    extraByIdCache.set(cacheKey, row);
    return row;
  }

  for (const item of orderItems) {
    const quantityMultiplier = parseInt(item.quantity) || 1;

    const safeParseList = (value) => {
      if (Array.isArray(value)) return value;
      if (value === null || value === undefined || value === "") return [];
      if (typeof value === "object") return [value].flat().filter(Boolean);
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        console.warn("⚠️ Could not parse ingredients/extras JSON:", err?.message || err);
        return [];
      }
    };

    let ingredients = safeParseList(item.ingredients);
    const extras = safeParseList(item.extras);

    // 🚑 Fallback: fetch recipe ingredients from DB if none provided
    if ((!ingredients || ingredients.length === 0) && item.product_id) {
      try {
        const q = await pool.query(
          `SELECT ingredients
           FROM products
           WHERE restaurant_id = $1 AND id = $2`,
          [restaurantId, item.product_id]
        );
        if (q.rows[0]?.ingredients) {
          const parsed =
            typeof q.rows[0].ingredients === "string"
              ? JSON.parse(q.rows[0].ingredients)
              : q.rows[0].ingredients;
          if (Array.isArray(parsed)) {
            ingredients = parsed;
            console.log(`📦 Loaded ${parsed.length} ingredients for product_id=${item.product_id}`);
          }
        }
      } catch (e) {
        console.error("❌ Could not fetch fallback ingredients:", e);
      }
    }

    // 🔻 Deduct Ingredients
    for (const ing of ingredients) {
      let ingUnit = (ing.unit || "").toLowerCase();
      let amountPerUnit = parseFloat(ing.quantity) * quantityMultiplier;

      const stockRes = await pool.query(
        `SELECT id, unit
         FROM stock
         WHERE restaurant_id = $1 AND LOWER(name) = LOWER($2)
         LIMIT 1`,
        [restaurantId, ing.ingredient || ing.name]
      );

      if (stockRes.rows.length) {
        const stockUnit = (stockRes.rows[0].unit || "").toLowerCase();

        // Normalize units (g/kg, ml/l, piece/portion)
        if (ingUnit && ingUnit !== stockUnit) {
          if (ingUnit === "g" && stockUnit === "kg") {
            amountPerUnit /= 1000;
            ingUnit = stockUnit;
          } else if (ingUnit === "kg" && stockUnit === "g") {
            amountPerUnit *= 1000;
            ingUnit = stockUnit;
          } else if (ingUnit === "ml" && stockUnit === "l") {
            amountPerUnit /= 1000;
            ingUnit = stockUnit;
          } else if (ingUnit === "l" && stockUnit === "ml") {
            amountPerUnit *= 1000;
            ingUnit = stockUnit;
          } else if (
            (ingUnit === "piece" && stockUnit === "portion") ||
            (ingUnit === "portion" && stockUnit === "piece")
          ) {
            ingUnit = stockUnit;
          }
        }
      }

      console.log(`🔻 Deducting Ingredient: ${ing.ingredient || ing.name} -${amountPerUnit} ${ingUnit}`);

      const res = await pool.query(
        `UPDATE stock
         SET quantity = quantity - $1
         WHERE restaurant_id = $2 AND LOWER(name) = LOWER($3)
         RETURNING *`,
        [amountPerUnit, restaurantId, ing.ingredient || ing.name]
      );

      if (res.rowCount > 0) {
        const updatedStock = res.rows[0];
        const qtyText = formatQuantity(amountPerUnit);
        emitAlert(
          ioRef,
          restaurantId,
          `Stock deducted: ${updatedStock.name}${qtyText ? ` (-${qtyText} ${updatedStock.unit})` : ""}`,
          updatedStock.id,
          "stock",
          {
            event: "stock_deducted",
            stockId: updatedStock.id,
            stockName: updatedStock.name,
            quantity: amountPerUnit,
            unit: updatedStock.unit,
          }
        );
        emitStockUpdate(ioRef, updatedStock.id);

        if (updatedStock.quantity > updatedStock.critical_quantity && updatedStock.auto_added_to_cart) {
          await pool.query(
            "UPDATE stock SET auto_added_to_cart = FALSE WHERE restaurant_id = $1 AND id = $2",
            [restaurantId, updatedStock.id]
          );
        }

        if (updatedStock.critical_quantity && updatedStock.quantity <= updatedStock.critical_quantity) {
          emitAlert(
            ioRef,
            restaurantId,
            `🧂 Stock Low: ${updatedStock.name} (${updatedStock.quantity} ${updatedStock.unit})`,
            updatedStock.id,
            "stock",
            { stockId: updatedStock.id }
          );
        }
      }
    }

    // 🔻 Deduct Extras
    for (const ex of extras) {
      if (ex && (ex.matched === false || ex.skip_stock === true)) {
        continue;
      }
      let extraName = ex.name || ex.ingredient_name;
      let amountPerPortion = Number(ex.amount);
      let extraUnit = (ex.unit || "").toLowerCase();
      const portionsPicked = parseInt(ex.quantity) || 1;

      if ((!Number.isFinite(amountPerPortion) || amountPerPortion <= 0 || !extraUnit) && ex.beypro_extra_id) {
        const extraRow = await resolveExtraById(ex.beypro_extra_id);
        if (extraRow) {
          if (!extraName) extraName = extraRow.ingredient_name;
          if (!Number.isFinite(amountPerPortion) || amountPerPortion <= 0) {
            amountPerPortion = Number(extraRow.amount);
          }
          if (!extraUnit) {
            extraUnit = (extraRow.unit || "").toLowerCase();
          }
        }
      }

      if (!extraName) continue;

      if (!Number.isFinite(amountPerPortion) || amountPerPortion <= 0 || !extraUnit) {
        const grp = await resolveExtraFromGroups(extraName);
        if (grp) {
          amountPerPortion = grp.amount;
          extraUnit = grp.unit;
        }
      }

      const stockRes = await pool.query(
        `SELECT id, unit
         FROM stock
         WHERE restaurant_id = $1 AND LOWER(name) = LOWER($2)
         LIMIT 1`,
        [restaurantId, extraName]
      );

      if (stockRes.rows.length) {
        const stockUnit = (stockRes.rows[0].unit || "").toLowerCase();
        if (extraUnit && extraUnit !== stockUnit) {
          if (extraUnit === "g" && stockUnit === "kg") {
            amountPerPortion /= 1000;
            extraUnit = stockUnit;
          } else if (extraUnit === "kg" && stockUnit === "g") {
            amountPerPortion *= 1000;
            extraUnit = stockUnit;
          } else if (extraUnit === "ml" && stockUnit === "l") {
            amountPerPortion /= 1000;
            extraUnit = stockUnit;
          } else if (extraUnit === "l" && stockUnit === "ml") {
            amountPerPortion *= 1000;
            extraUnit = stockUnit;
          } else if (
            (extraUnit === "piece" && stockUnit === "portion") ||
            (extraUnit === "portion" && stockUnit === "piece")
          ) {
            extraUnit = stockUnit;
          }
        }
      }

      if (!extraUnit) {
        extraUnit = await resolveUnitFromStock(extraName);
      }

      if (!Number.isFinite(amountPerPortion) || amountPerPortion <= 0) {
        amountPerPortion = 1;
      }

      const usedQty = amountPerPortion * portionsPicked * quantityMultiplier;

      console.log(`🔻 Deducting Extra: ${extraName} -${usedQty} ${extraUnit}`);

      const res = await pool.query(
        `UPDATE stock
         SET quantity = quantity - $1
         WHERE restaurant_id = $2 AND LOWER(name) = LOWER($3)
         RETURNING *`,
        [usedQty, restaurantId, extraName]
      );

      if (res.rowCount > 0) {
        const updatedStock = res.rows[0];
        const qtyText = formatQuantity(usedQty);
        emitAlert(
          ioRef,
          restaurantId,
          `Stock deducted: ${updatedStock.name}${qtyText ? ` (-${qtyText} ${updatedStock.unit})` : ""}`,
          updatedStock.id,
          "stock",
          {
            event: "stock_deducted",
            stockId: updatedStock.id,
            stockName: updatedStock.name,
            quantity: usedQty,
            unit: updatedStock.unit,
          }
        );
        emitStockUpdate(ioRef, updatedStock.id);

        if (updatedStock.quantity > updatedStock.critical_quantity && updatedStock.auto_added_to_cart) {
          await pool.query(
            "UPDATE stock SET auto_added_to_cart = FALSE WHERE restaurant_id = $1 AND id = $2",
            [restaurantId, updatedStock.id]
          );
        }

        if (updatedStock.critical_quantity && updatedStock.quantity <= updatedStock.critical_quantity) {
          emitAlert(
            ioRef,
            restaurantId,
            `🧂 Stock Low: ${updatedStock.name} (${updatedStock.quantity} ${updatedStock.unit})`,
            updatedStock.id,
            "stock",
            { stockId: updatedStock.id }
          );
        }
      }
    }
  }
}

module.exports = { updateStockForOrder };
