// routes/Autosuppliersorder.js
module.exports = (io) => {
  const express = require("express");
  const router = express.Router();
  const { pool } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
  /*===============================
           Auto supplier orders
  ===============================*/
  router.use(authMiddleware);
// Helper: normalize Postgres text[] to JS array
const normalizeArray = (val) => {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return val.replace(/[{}"]/g, "").split(",").filter(Boolean);
};

  // ✅ Create supplier cart
  router.post("/supplier-carts", async (req, res) => {
    try {
      const { supplier_id, scheduled_at, auto_confirm } = req.body;
      const restaurantId = req.user.restaurant_id;

      if (!supplier_id) {
        return res.status(400).json({ error: "Supplier ID is required" });
      }

      let cart;
      const result = await pool.query(
        `
        INSERT INTO supplier_carts (restaurant_id, supplier_id, scheduled_at, auto_confirm)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING
        RETURNING *;
        `,
        [restaurantId, supplier_id, scheduled_at || null, auto_confirm || false]
      );

      if (result.rows.length > 0) {
        cart = result.rows[0];
      } else {
        const existing = await pool.query(
          `SELECT * FROM supplier_carts
           WHERE restaurant_id=$1 AND supplier_id=$2
             AND confirmed=false AND archived=false
           LIMIT 1`,
          [restaurantId, supplier_id]
        );
        if (existing.rows.length === 0) {
          return res
            .status(500)
            .json({ error: "Failed to fetch cart after conflict." });
        }
        cart = existing.rows[0];
      }

      res.json({ cart, message: "Cart created or reused." });
    } catch (error) {
      console.error("❌ Error creating supplier cart:", error);
      res.status(500).json({ error: "Database error creating cart." });
    }
  });

  // ✅ Add item to supplier cart
  // ✅ Add item to supplier cart
router.post("/supplier-cart-items", async (req, res) => {
  try {
    const { stock_id, product_name, quantity, unit, cart_id } = req.body;
    const restaurantId = req.user.restaurant_id;

    if (!stock_id || !product_name || !quantity || !unit || !cart_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check critical status
    const stockRes = await pool.query(
      `SELECT quantity, critical_quantity
       FROM stock
       WHERE restaurant_id=$1 AND id=$2`,
      [restaurantId, stock_id]
    );
    const stock = stockRes.rows[0];
    if (!stock) return res.status(404).json({ error: "Stock item not found." });

    if (parseFloat(stock.quantity) > parseFloat(stock.critical_quantity)) {
      return res
        .status(400)
        .json({ error: "Stock is not below critical threshold." });
    }

    // Ensure cart exists
    const cartCheck = await pool.query(
      `SELECT id FROM supplier_carts WHERE restaurant_id=$1 AND id=$2`,
      [restaurantId, cart_id]
    );
    if (cartCheck.rows.length === 0) {
      return res.status(404).json({ error: "Cart not found." });
    }


    // Insert/Update item
    await pool.query(
      `INSERT INTO supplier_cart_items (restaurant_id, stock_id, product_name, quantity, unit, cart_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (cart_id, product_name, unit)
       DO UPDATE SET quantity=supplier_cart_items.quantity+EXCLUDED.quantity`,
      [restaurantId, stock_id, product_name.trim(), parseFloat(quantity), unit.trim(), cart_id]
    );

    // 🔄 Fetch full updated cart
    const itemsRes = await pool.query(
      `SELECT * FROM supplier_cart_items WHERE restaurant_id=$1 AND cart_id=$2`,
      [restaurantId, cart_id]
    );

    res.json({
      cart_id,
      items: itemsRes.rows,
    });
  } catch (err) {
    console.error("❌ Error in /supplier-cart-items:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


  // ✅ Confirm supplier cart
// ✅ Confirm supplier cart
router.put("/supplier-carts/:id/confirm", async (req, res) => {
  try {
    const { id } = req.params;
    const { scheduled_at, repeat_type, repeat_days, auto_confirm } = req.body;
    const restaurantId = req.user.restaurant_id;

    if (!scheduled_at) {
      return res.status(400).json({ error: "Scheduled date/time is required." });
    }

    const currentRes = await pool.query(
      `SELECT * FROM supplier_carts WHERE restaurant_id=$1 AND id=$2`,
      [restaurantId, id]
    );
    const current = currentRes.rows[0];
    if (!current) return res.status(404).json({ error: "Cart not found." });

    // ✅ Properly cast JS array → Postgres text[]
    const repeatDaysArray = Array.isArray(repeat_days)
      ? repeat_days
      : normalizeArray(current.repeat_days);

    const updateRes = await pool.query(
      `UPDATE supplier_carts
       SET confirmed = true,
           scheduled_at = $1,
           repeat_type = $2,
           repeat_days = $3::text[],
           auto_confirm = $4
       WHERE restaurant_id = $5 AND id = $6
       RETURNING *`,
      [
        scheduled_at,
        repeat_type ?? current.repeat_type,
        repeatDaysArray,
        typeof auto_confirm === "boolean" ? auto_confirm : current.auto_confirm,
        restaurantId,
        id,
      ]
    );

    res.json({
      cart: updateRes.rows[0],
      message: "Cart confirmed and scheduled.",
    });
  } catch (error) {
    console.error("❌ Error confirming supplier cart:", error);
    res.status(500).json({ error: "Database error confirming cart." });
  }
});



  // ✅ Send supplier cart
  router.post("/supplier-carts/:id/send", async (req, res) => {
    try {
      const { id } = req.params;
      const { scheduled_at } = req.body;
      const restaurantId = req.user.restaurant_id;

      const cartRes = await pool.query(
        `SELECT sc.*, sp.name AS supplier_name, sp.phone, sp.email
         FROM supplier_carts sc
         INNER JOIN suppliers sp ON sc.supplier_id=sp.id
         WHERE sc.restaurant_id=$1 AND sc.id=$2
         FOR UPDATE`,
        [restaurantId, id]
      );
      if (cartRes.rows.length === 0) {
        return res.status(404).json({ error: "Cart not found." });
      }
      const cart = cartRes.rows[0];
      if (!cart.confirmed) {
        return res.status(400).json({ error: "Cart must be confirmed before sending." });
      }

      // Reset auto-add flags for all items
      const itemsRes = await pool.query(
        `SELECT * FROM supplier_cart_items WHERE cart_id=$1`,
        [id]
      );
      for (const item of itemsRes.rows) {
        await pool.query(
          `UPDATE stock
           SET auto_added_to_cart=FALSE, last_auto_add_at=NULL
           WHERE restaurant_id=$1 AND id=$2`,
          [restaurantId, item.stock_id]
        );
      }

      // Archive cart
      await pool.query(
        `UPDATE supplier_carts SET archived=true WHERE restaurant_id=$1 AND id=$2`,
        [restaurantId, id]
      );

      res.json({ success: true, message: "Order sent successfully." });
    } catch (error) {
      console.error("❌ Error sending supplier cart:", error);
      res.status(500).json({ error: "Database error sending cart." });
    }
  });

// ✅ Get cart items (tenant-safe, with fallback to scheduled)
router.get("/supplier-carts/items", async (req, res) => {
  const { supplier_id, cart_id } = req.query;
  const restaurantId = req.user.restaurant_id;

  try {
    let targetCart;

    if (cart_id) {
      // Try fetch specific cart
      const cartRes = await pool.query(
        `SELECT * FROM supplier_carts WHERE restaurant_id=$1 AND id=$2`,
        [restaurantId, cart_id]
      );

      if (cartRes.rows.length) {
        targetCart = cartRes.rows[0];
      } else {
        // 🔄 fallback: last confirmed scheduled cart for supplier
        const fallbackRes = await pool.query(
          `SELECT * FROM supplier_carts
           WHERE restaurant_id=$1 AND supplier_id=$2
             AND confirmed=true AND archived=false
           ORDER BY scheduled_at DESC
           LIMIT 1`,
          [restaurantId, supplier_id]
        );
        if (!fallbackRes.rows.length) {
          return res.status(404).json({ error: "Cart not found." });
        }
        targetCart = fallbackRes.rows[0];
      }
    } else if (supplier_id) {
      // 1. Try open cart (unconfirmed)
      let cartRes = await pool.query(
        `SELECT * FROM supplier_carts
         WHERE restaurant_id=$1 AND supplier_id=$2
           AND confirmed=false AND archived=false
         ORDER BY created_at DESC
         LIMIT 1`,
        [restaurantId, supplier_id]
      );

      // 2. Fallback → last confirmed scheduled
      if (cartRes.rows.length === 0) {
        cartRes = await pool.query(
          `SELECT * FROM supplier_carts
           WHERE restaurant_id=$1 AND supplier_id=$2
             AND confirmed=true AND archived=false
           ORDER BY scheduled_at DESC
           LIMIT 1`,
          [restaurantId, supplier_id]
        );
      }

      if (cartRes.rows.length) {
        targetCart = cartRes.rows[0];
      } else {
        // 3. If nothing at all → create fresh empty cart
        const insertRes = await pool.query(
          `INSERT INTO supplier_carts (restaurant_id, supplier_id, confirmed, archived)
           VALUES ($1, $2, false, false)
           RETURNING *`,
          [restaurantId, supplier_id]
        );
        targetCart = insertRes.rows[0];
        console.log(
          `🆕 Auto-created new supplier cart id=${targetCart.id} for supplier=${supplier_id}`
        );
      }
    }

    // Get items for the cart
    const itemsRes = await pool.query(
      `SELECT * FROM supplier_cart_items WHERE restaurant_id=$1 AND cart_id=$2`,
      [restaurantId, targetCart.id]
    );

    res.json({
      cart_id: targetCart.id,
      items: itemsRes.rows,
      scheduled_at: targetCart.scheduled_at || null,
 repeat_type: targetCart.repeat_type || "none",
 repeat_days: normalizeArray(targetCart.repeat_days) || [],
 auto_confirm: targetCart.auto_confirm === true, // always boolean
    });
  } catch (error) {
    console.error("❌ Error fetching cart items:", error);
    res.status(500).json({ error: "Database error fetching cart items." });
  }
});



  // ✅ Patch stock
  router.patch("/stock/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { quantity, critical_quantity, reorder_quantity } = req.body;
      const restaurantId = req.user.restaurant_id;

      const currentRes = await pool.query(
        `SELECT * FROM stock WHERE restaurant_id=$1 AND id=$2`,
        [restaurantId, id]
      );
      const current = currentRes.rows[0];

      if (!current) return res.status(404).json({ error: "Stock not found." });

      const updateRes = await pool.query(
        `UPDATE stock
         SET quantity = COALESCE($1, quantity),
             critical_quantity = COALESCE($2, critical_quantity),
             reorder_quantity = COALESCE($3, reorder_quantity)
         WHERE restaurant_id=$4 AND id=$5
         RETURNING *`,
        [quantity, critical_quantity, reorder_quantity, restaurantId, id]
      );

      const updated = updateRes.rows[0];

      // Reset flags if restocked
      if (
        typeof quantity === "number" &&
        quantity > (updated.critical_quantity || 0)
      ) {
        await pool.query(
          `UPDATE stock
           SET auto_added_to_cart = FALSE,
               last_auto_add_at = NULL
           WHERE restaurant_id=$1 AND id=$2`,
          [restaurantId, id]
        );
        updated.auto_added_to_cart = false;
        updated.last_auto_add_at = null;
      }

      if (
        typeof quantity === "number" &&
        quantity <= (updated.critical_quantity || 0) &&
        updated.last_auto_add_at
      ) {
        await pool.query(
          `UPDATE stock
           SET last_auto_add_at = NULL
           WHERE restaurant_id=$1 AND id=$2`,
          [restaurantId, id]
        );
        updated.last_auto_add_at = null;
      }

      io.emit("stock-updated", { stockId: id });
      res.json({ success: true, stock: updated });
    } catch (error) {
      console.error("❌ Error updating stock:", error);
      res.status(500).json({ error: "Database error updating stock." });
    }
  });

  // ✅ Flag auto-added
  router.patch("/stock/:id/flag-auto-added", async (req, res) => {
    const { id } = req.params;
    const { last_auto_add_at } = req.body;
    const restaurantId = req.user.restaurant_id;

    try {
      const result = await pool.query(
        `UPDATE stock SET last_auto_add_at=$1
         WHERE restaurant_id=$2 AND id=$3
         RETURNING *`,
        [last_auto_add_at, restaurantId, id]
      );
      res.json({ updated: result.rows[0] });
    } catch (err) {
      console.error("❌ Error updating last_auto_add_at:", err);
      res.status(500).json({ error: "Failed to update auto-add timestamp" });
    }
  });



// ✅ Update cart item quantity
router.patch("/supplier-cart-items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;
    const restaurantId = req.user.restaurant_id;

    if (!quantity || isNaN(quantity)) {
      return res.status(400).json({ error: "Invalid quantity." });
    }

    // Update item
    const updateRes = await pool.query(
      `UPDATE supplier_cart_items
       SET quantity=$1
       WHERE restaurant_id=$2 AND id=$3
       RETURNING cart_id`,
      [quantity, restaurantId, id]
    );

    if (updateRes.rows.length === 0) {
      return res.status(404).json({ error: "Cart item not found." });
    }

    const cart_id = updateRes.rows[0].cart_id;

    // Fetch full updated cart
    const itemsRes = await pool.query(
      `SELECT * FROM supplier_cart_items WHERE restaurant_id=$1 AND cart_id=$2`,
      [restaurantId, cart_id]
    );

    res.json({ cart_id, items: itemsRes.rows });
  } catch (error) {
    console.error("❌ Error updating cart item quantity:", error);
    res.status(500).json({ error: "Database error updating item." });
  }
});



  // ✅ History
router.get("/supplier-carts/history", async (req, res) => {
  const { supplier_id } = req.query;
  const restaurantId = req.user.restaurant_id;

  if (!supplier_id || isNaN(Number(supplier_id))) {
    return res.status(400).json({ error: "Valid supplier_id is required." });
  }

  try {
    const historyRes = await pool.query(
      `SELECT sc.*, sc.skipped, array_agg(json_build_object(
          'product_name', sci.product_name,
          'quantity', sci.quantity,
          'unit', sci.unit
        )) AS items
       FROM supplier_carts sc
       LEFT JOIN supplier_cart_items sci ON sci.cart_id=sc.id
       WHERE sc.restaurant_id=$1 AND sc.supplier_id=$2 AND sc.archived=true
       GROUP BY sc.id
       ORDER BY sc.scheduled_at DESC
       LIMIT 5`,
      [restaurantId, Number(supplier_id)]
    );

    const history = historyRes.rows.map((row) => ({
      ...row,
      repeat_days: normalizeArray(row.repeat_days), // ✅ normalize here
    }));

    res.json({ history });
  } catch (error) {
    console.error("❌ Error fetching supplier cart history:", error);
    res.status(500).json({ error: "Database error fetching history." });
  }
});


  // ✅ Scheduled
// ✅ Scheduled (always returns something: scheduled → open → new empty)
router.get("/supplier-carts/scheduled", async (req, res) => {
  const { supplier_id } = req.query;
  const restaurantId = req.user.restaurant_id;

  if (!supplier_id || isNaN(Number(supplier_id))) {
    return res.status(400).json({ error: "Valid supplier_id is required." });
  }

  try {
    // 1. Prefer last confirmed scheduled
    let cartRes = await pool.query(
      `SELECT * FROM supplier_carts
       WHERE restaurant_id=$1 AND supplier_id=$2
         AND confirmed=true AND archived=false
       ORDER BY scheduled_at DESC
       LIMIT 1`,
      [restaurantId, Number(supplier_id)]
    );

    let cart = cartRes.rows[0];

    // 2. If no scheduled → fallback to latest open (unconfirmed)
    if (!cart) {
      cartRes = await pool.query(
        `SELECT * FROM supplier_carts
         WHERE restaurant_id=$1 AND supplier_id=$2
           AND confirmed=false AND archived=false
         ORDER BY created_at DESC
         LIMIT 1`,
        [restaurantId, Number(supplier_id)]
      );
      cart = cartRes.rows[0];
    }

    // 3. If still nothing → create new empty cart
    if (!cart) {
      const insertRes = await pool.query(
        `INSERT INTO supplier_carts (restaurant_id, supplier_id, confirmed, archived)
         VALUES ($1, $2, false, false)
         RETURNING *`,
        [restaurantId, supplier_id]
      );
      cart = insertRes.rows[0];
      console.log(`🆕 Auto-created new supplier cart id=${cart.id} for supplier=${supplier_id}`);
    }

    // Fetch items for this cart
    const itemsRes = await pool.query(
      `SELECT * FROM supplier_cart_items WHERE restaurant_id=$1 AND cart_id=$2`,
      [restaurantId, cart.id]
    );

    res.json({
      cart_id: cart.id,
      items: itemsRes.rows,
      scheduled_at: cart.scheduled_at || null,
      repeat_type: cart.repeat_type || "none",
      repeat_days: normalizeArray(cart.repeat_days) || [],
      auto_confirm: cart.auto_confirm === true,
    });
  } catch (err) {
    console.error("❌ Error fetching scheduled cart:", err);
    res.status(500).json({ error: "Database error fetching scheduled cart." });
  }
});


// ✅ Get all pending scheduled (confirmed + not archived) orders for a supplier
router.get("/supplier-carts/pending", async (req, res) => {
  const { supplier_id } = req.query;
  const restaurantId = req.user.restaurant_id;

  if (!supplier_id || isNaN(Number(supplier_id))) {
    return res.status(400).json({ error: "Valid supplier_id is required." });
  }

  try {
    const { rows } = await pool.query(
      `SELECT * FROM supplier_carts
       WHERE restaurant_id=$1 AND supplier_id=$2
         AND confirmed=true AND archived=false
       ORDER BY scheduled_at ASC`,
      [restaurantId, Number(supplier_id)]
    );

    const carts = rows.map((cart) => ({
      ...cart,
      repeat_days: normalizeArray(cart.repeat_days),
    }));

    res.json({ pending: carts });
  } catch (err) {
    console.error("❌ Error fetching pending scheduled orders:", err);
    res.status(500).json({ error: "Database error fetching pending scheduled orders." });
  }
});

// ✅ Cancel a scheduled supplier cart (mark archived=true)
router.put("/supplier-carts/:id/cancel", async (req, res) => {
  try {
    const { id } = req.params;
    const restaurantId = req.user.restaurant_id;

    const updateRes = await pool.query(
      `UPDATE supplier_carts
       SET archived=true
       WHERE restaurant_id=$1 AND id=$2
       RETURNING *`,
      [restaurantId, id]
    );

    if (updateRes.rows.length === 0) {
      return res.status(404).json({ error: "Cart not found or already archived." });
    }

    res.json({ success: true, cart: updateRes.rows[0] });
  } catch (err) {
    console.error("❌ Error canceling scheduled order:", err);
    res.status(500).json({ error: "Database error canceling scheduled order." });
  }
});


  // ✅ Ingredient average prices
  router.get("/ingredients/average-prices", async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT DISTINCT ON (ingredient_name)
          ingredient_name AS name,
          unit,
          supplier_name AS supplier,
          price AS current_price,
          changed_at,
          reason
        FROM ingredient_price_history
        ORDER BY ingredient_name, changed_at DESC
      `);

      const historyMap = {};
      const { rows: history } = await pool.query(`
        SELECT ingredient_name, price, changed_at
        FROM ingredient_price_history
        ORDER BY ingredient_name, changed_at DESC
      `);

      for (const row of history) {
        const key = row.ingredient_name;
        if (!historyMap[key]) {
          historyMap[key] = [row];
        } else if (historyMap[key].length === 1) {
          historyMap[key].push(row);
        }
      }

      const result = rows.map((item) => {
        const h = historyMap[item.name] || [];
        const prev = h[1];
        return {
          ...item,
          previous_price: prev ? prev.price : null,
        };
      });

      res.json(result);
    } catch (err) {
      console.error("❌ Failed to fetch ingredient prices", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
