module.exports = (io) => {
const express = require("express");
const router = express.Router();
const { pool } = require("../db");


/*===============================
         Auto supplier orders
===============================*/
// POST /supplier-carts
router.post("/supplier-carts", async (req, res) => {
  try {
    const { supplier_id, scheduled_at, auto_confirm } = req.body;

    if (!supplier_id) {
      return res.status(400).json({ error: "Supplier ID is required" });
    }

    let cart;

    // ⚡ Try insert first, let conflict happen if any
    const result = await pool.query(
      `
      INSERT INTO supplier_carts (supplier_id, scheduled_at, auto_confirm)
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
      RETURNING *;
      `,
      [supplier_id, scheduled_at || null, auto_confirm || false]
    );

    if (result.rows.length > 0) {
      // ✅ New cart inserted
      cart = result.rows[0];
      console.log("🧾 Created new cart ID:", cart.id);
    } else {
      // 🔁 Conflict happened → fetch existing open cart
      const existing = await pool.query(
        `SELECT * FROM supplier_carts
         WHERE supplier_id = $1 AND confirmed = false AND archived = false
         LIMIT 1`,
        [supplier_id]
      );

      if (existing.rows.length === 0) {
        return res.status(500).json({ error: "Failed to fetch cart after conflict." });
      }

      cart = existing.rows[0];
      console.log("📦 Reusing existing cart ID:", cart.id);
    }

    res.json({ cart, message: "Cart created or reused." });

  } catch (error) {
    console.error("❌ Error creating supplier cart:", error);
    res.status(500).json({ error: "Database error creating cart." });
  }
});

// POST /supplier-cart-items
router.post("/supplier-cart-items", async (req, res) => {
  try {
    const { stock_id, product_name, quantity, unit, cart_id } = req.body;

    if (!stock_id || !product_name || !quantity || !unit || !cart_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ✅ LIVE check critical status from DB
    const stockRes = await pool.query(
      `SELECT quantity, critical_quantity FROM stock WHERE id = $1`,
      [stock_id]
    );

    const stock = stockRes.rows[0];
    if (!stock) return res.status(404).json({ error: "Stock item not found." });

    const currentQty = parseFloat(stock.quantity);
    const criticalQty = parseFloat(stock.critical_quantity);

    if (currentQty > criticalQty) {
      console.warn(`❌ REJECTED: ${product_name} (${currentQty} > ${criticalQty})`);
      return res.status(400).json({ error: "Stock is not below critical threshold." });
    }

    // ✅ Ensure cart exists and preserve existing scheduling info (DO NOT reset it!)
    // ✅ Ensure cart exists and preserve existing scheduling info
const cartCheck = await pool.query(
  `SELECT id FROM supplier_carts WHERE id = $1`,
  [cart_id]
);
if (cartCheck.rows.length === 0) {
  return res.status(404).json({ error: "Cart not found." });
}

// ✅ Confirm cart without resetting existing scheduled fields
await pool.query(
  `UPDATE supplier_carts SET confirmed = true WHERE id = $1`,
  [cart_id]
);


    // ✅ Proceed to upsert item
    const insertQuery = `
      INSERT INTO supplier_cart_items (stock_id, product_name, quantity, unit, cart_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (cart_id, product_name, unit)
      DO UPDATE SET quantity = supplier_cart_items.quantity + EXCLUDED.quantity
      RETURNING *;
    `;
    const values = [stock_id, product_name.trim(), parseFloat(quantity), unit.trim(), cart_id];
    const result = await pool.query(insertQuery, values);

    console.log("✅ Upserted cart item:", result.rows[0]);
    res.json(result.rows[0]);

  } catch (err) {
    console.error("❌ Error in /supplier-cart-items:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


// PUT /supplier-carts/:id/confirm
router.put("/supplier-carts/:id/confirm", async (req, res) => {
  try {
    const { id } = req.params;
    const { scheduled_at, repeat_type, repeat_days, auto_confirm } = req.body;

    if (!scheduled_at) {
      return res.status(400).json({ error: "Scheduled date/time is required." });
    }

    const currentRes = await pool.query(`SELECT * FROM supplier_carts WHERE id = $1`, [id]);
    const current = currentRes.rows[0];
    if (!current) return res.status(404).json({ error: "Cart not found." });

    // ✅ Preserve previous values if not sent from frontend
    const updatedRepeatType = Object.prototype.hasOwnProperty.call(req.body, "repeat_type")
      ? repeat_type
      : current.repeat_type;

    const updatedRepeatDays = Object.prototype.hasOwnProperty.call(req.body, "repeat_days")
      ? Array.isArray(repeat_days)
        ? repeat_days
        : []
      : Array.isArray(current.repeat_days)
      ? current.repeat_days
      : [];

    const updatedAutoConfirm = typeof auto_confirm === "boolean"
      ? auto_confirm
      : current.auto_confirm;

    const updateRes = await pool.query(
      `UPDATE supplier_carts
       SET confirmed = true,
           scheduled_at = $1,
           repeat_type = $2,
           repeat_days = $3,
           auto_confirm = $4
       WHERE id = $5
       RETURNING *`,
      [scheduled_at, updatedRepeatType, updatedRepeatDays, updatedAutoConfirm, id]
    );

    res.json({
      cart: updateRes.rows[0],
      message: "Cart confirmed and scheduled successfully.",
    });
  } catch (error) {
    console.error("❌ Error confirming supplier cart:", error);
    res.status(500).json({ error: "Database error confirming cart." });
  }
});


// POST /supplier-carts/:id/send
router.post("/supplier-carts/:id/send", async (req, res) => {
  try {
    const { id } = req.params;
    const { scheduled_at } = req.body;

    const cartRes = await pool.query(
      `SELECT sc.*, sp.name AS supplier_name, sp.phone, sp.email
       FROM supplier_carts sc
       INNER JOIN suppliers sp ON sc.supplier_id = sp.id
       WHERE sc.id = $1
       FOR UPDATE`,
      [id]
    );

    if (cartRes.rows.length === 0) {
      return res.status(404).json({ error: "Cart not found." });
    }

    const cart = cartRes.rows[0];
    const effectiveScheduledAt = scheduled_at || cart.scheduled_at;

    if (!cart.confirmed) {
      return res.status(400).json({ error: "Cart must be confirmed before sending." });
    }

    const itemsRes = await pool.query(
      `SELECT * FROM supplier_cart_items WHERE cart_id = $1`,
      [id]
    );

    const items = itemsRes.rows;
    if (items.length === 0) {
      return res.status(400).json({ error: "No items in cart to send." });
    }

    for (const item of items) {
      if (!item.stock_id || item.quantity <= 0) continue;

      const stockRes = await pool.query(
        `SELECT quantity, name FROM stock WHERE id = $1`,
        [item.stock_id]
      );
      const currentStock = stockRes.rows[0];
      if (!currentStock) continue;

      // ✅ Reset flags
      await pool.query(
        `UPDATE stock SET auto_added_to_cart = FALSE, last_auto_add_at = NULL WHERE id = $1`,
        [item.stock_id]
      );

      console.log(`🧹 Reset auto-add flags for ${currentStock.name} (${item.stock_id})`);
    }

    // ✅ Archive cart
    await pool.query(`UPDATE supplier_carts SET archived = true WHERE id = $1`, [id]);
    console.log(`📦 Archived cart ${id} after send`);

    const orderMessage = `
Supplier: ${cart.supplier_name}
Scheduled Date: ${effectiveScheduledAt ? new Date(effectiveScheduledAt).toLocaleString("tr-TR", { hour12: false }) : "Not Scheduled"}
Order Created: ${new Date(cart.created_at).toLocaleDateString()}

Products:
${items.map(item => `- ${item.product_name} (${item.quantity} ${item.unit})`).join("\n")}
    `.trim();

    // ✅ Send email if needed
    if (cart.email) {
      const subject = `📦 HurryPOS Supplier Order — ${cart.supplier_name}`;
      const htmlBody = `
        <h2>📦 New Supplier Order</h2>
        <p><strong>Supplier:</strong> ${cart.supplier_name}</p>
        <p><strong>Scheduled for:</strong> ${effectiveScheduledAt ? new Date(effectiveScheduledAt).toLocaleString("tr-TR", { hour12: false }) : "Not Scheduled"}</p>
        <p><strong>Created at:</strong> ${new Date(cart.created_at).toLocaleString("tr-TR", { hour12: false })}</p>
        <h3>📝 Products:</h3>
        <ul>
          ${items.map(item => `<li>${item.product_name} — ${item.quantity} ${item.unit}</li>`).join("")}
        </ul>
        <p style="margin-top:1.5em;">Best regards,<br><strong>HurryPOS</strong></p>
      `;
      await sendEmail(cart.email, subject, htmlBody, true);
    }

    console.log("✅ Order sent to:", cart.phone || "No phone", cart.email || "No email");
    res.json({ success: true, message: "Order sent successfully.", order: orderMessage });

  } catch (error) {
    console.error("❌ Error sending supplier cart:", error);
    res.status(500).json({ error: "Database error sending cart." });
  }
});

// GET /supplier-carts/items?supplier_id=... or ?cart_id=...
router.get("/supplier-carts/items", async (req, res) => {
  const { supplier_id, cart_id } = req.query;

  try {
    let targetCart;

    if (cart_id && !isNaN(Number(cart_id))) {
      // Fetch by cart ID
      const cartCheck = await pool.query(`SELECT * FROM supplier_carts WHERE id = $1`, [Number(cart_id)]);
      if (cartCheck.rows.length === 0) {
        return res.status(404).json({ error: "Cart not found." });
      }
      targetCart = cartCheck.rows[0];

    } else if (supplier_id && !isNaN(Number(supplier_id))) {
      // Fetch open cart by supplier
      const cartRes = await pool.query(
  `SELECT * FROM supplier_carts
   WHERE supplier_id = $1 AND confirmed = false AND archived = false
   ORDER BY created_at DESC
   LIMIT 1`,
  [Number(supplier_id)]
);

      if (cartRes.rows.length === 0) {
        return res.status(404).json({ error: "No open cart found for this supplier." });
      }
      targetCart = cartRes.rows[0];

    } else {
      return res.status(400).json({ error: "supplier_id or cart_id must be valid." });
    }

    const itemsRes = await pool.query(
      `SELECT * FROM supplier_cart_items WHERE cart_id = $1`,
      [targetCart.id]
    );

    res.json({
      cart_id: targetCart.id,
      items: itemsRes.rows || [],
      scheduled_at: targetCart.scheduled_at,
      repeat_type: targetCart.repeat_type,
      repeat_days: targetCart.repeat_days,
      auto_confirm: targetCart.auto_confirm
    });

  } catch (error) {
    console.error("❌ Error fetching cart items:", error);
    res.status(500).json({ error: "Database error fetching cart items." });
  }
});

// PATCH /stock/:id
router.patch("/stock/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, critical_quantity, reorder_quantity } = req.body;

    const currentRes = await pool.query(`SELECT * FROM stock WHERE id = $1`, [id]);
    const current = currentRes.rows[0];

    if (!current) return res.status(404).json({ error: "Stock not found." });

    const updateRes = await pool.query(
      `UPDATE stock
       SET quantity = COALESCE($1, quantity),
           critical_quantity = COALESCE($2, critical_quantity),
           reorder_quantity = COALESCE($3, reorder_quantity)
       WHERE id = $4
       RETURNING *`,
      [quantity, critical_quantity, reorder_quantity, id]
    );

    const updated = updateRes.rows[0];

    // ✅ Reset auto flags if restocked above critical
    if (
      typeof quantity === "number" &&
      quantity > (updated.critical_quantity || 0)
    ) {
      await pool.query(
        `UPDATE stock
         SET auto_added_to_cart = FALSE,
             last_auto_add_at = NULL
         WHERE id = $1`,
        [id]
      );
      updated.auto_added_to_cart = false;
      updated.last_auto_add_at = null;
      console.log(`🧹 Manually restocked ${updated.name} — cleared auto-add flags`);
    }

    // ✅ If still below critical, ensure system can re-trigger later
    if (
      typeof quantity === "number" &&
      quantity <= (updated.critical_quantity || 0) &&
      updated.last_auto_add_at
    ) {
      await pool.query(
        `UPDATE stock
         SET last_auto_add_at = NULL
         WHERE id = $1`,
        [id]
      );
      updated.last_auto_add_at = null;
      console.log(`🔁 ${updated.name} still below critical — cleared last_auto_add_at to re-trigger`);
    }

    io.emit("stock-updated", { stockId: id });

    res.json({ success: true, stock: updated });

  } catch (error) {
    console.error("❌ Error updating stock:", error);
    res.status(500).json({ error: "Database error updating stock." });
  }
});


// PATCH /stock/:id/flag-auto-added
router.patch("/stock/:id/flag-auto-added", async (req, res) => {
  const { id } = req.params;
  const { last_auto_add_at } = req.body;

  try {
    const result = await pool.query(
      `UPDATE stock SET last_auto_add_at = $1 WHERE id = $2 RETURNING *`,
      [last_auto_add_at, id]
    );
    res.json({ updated: result.rows[0] });
  } catch (err) {
    console.error("❌ Error updating last_auto_add_at:", err);
    res.status(500).json({ error: "Failed to update auto-add timestamp" });
  }
});


// GET /stock/:id
router.get("/stock/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM stock WHERE id = $1", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Stock item not found." });
    }

    res.json({ stock: result.rows[0] });
  } catch (error) {
    console.error("❌ Error fetching stock by ID:", error);
    res.status(500).json({ error: "Database error fetching stock." });
  }
});


// PATCH /supplier-cart-items/:id
router.patch("/supplier-cart-items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;

    if (!quantity || isNaN(quantity)) {
      return res.status(400).json({ error: "Invalid quantity." });
    }

    const updateRes = await pool.query(
      `UPDATE supplier_cart_items
       SET quantity = $1
       WHERE id = $2
       RETURNING *`,
      [quantity, id]
    );

    if (updateRes.rows.length === 0) {
      return res.status(404).json({ error: "Cart item not found." });
    }

    res.json(updateRes.rows[0]);
  } catch (error) {
    console.error("❌ Error updating cart item quantity:", error);
    res.status(500).json({ error: "Database error updating item." });
  }
});

// GET /supplier-carts/history?supplier_id=...
router.get("/supplier-carts/history", async (req, res) => {
  const { supplier_id } = req.query;

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
 LEFT JOIN supplier_cart_items sci ON sci.cart_id = sc.id
 WHERE sc.supplier_id = $1 AND sc.archived = true
 GROUP BY sc.id
 ORDER BY sc.scheduled_at DESC
 LIMIT 5`
,
      [Number(supplier_id)]
    );

    res.json({ history: historyRes.rows });
  } catch (error) {
    console.error("❌ Error fetching supplier cart history:", error);
    res.status(500).json({ error: "Database error fetching history." });
  }
});

// GET /supplier-carts/scheduled?supplier_id=...
router.get("/supplier-carts/scheduled", async (req, res) => {
  const { supplier_id } = req.query;

  if (!supplier_id || isNaN(Number(supplier_id))) {
    return res.status(400).json({ error: "Valid supplier_id is required." });
  }

  try {
    const cartRes = await pool.query(`
      SELECT * FROM supplier_carts
      WHERE supplier_id = $1 AND confirmed = true AND archived = false
      ORDER BY scheduled_at ASC
      LIMIT 1
    `, [Number(supplier_id)]);

    const cart = cartRes.rows[0];
    if (!cart) return res.status(404).json({ error: "No scheduled cart found." });

    const itemsRes = await pool.query(
      `SELECT * FROM supplier_cart_items WHERE cart_id = $1`,
      [cart.id]
    );

    res.json({
      cart_id: cart.id,
      items: itemsRes.rows,
      scheduled_at: cart.scheduled_at,
      repeat_type: cart.repeat_type,
      repeat_days: cart.repeat_days,
      auto_confirm: cart.auto_confirm,
    });

  } catch (err) {
    console.error("❌ Error fetching scheduled cart:", err);
    res.status(500).json({ error: "Database error fetching scheduled cart." });
  }
});

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

    // Fetch previous price per ingredient
    const { rows: history } = await pool.query(`
      SELECT ingredient_name, price, changed_at
      FROM ingredient_price_history
      ORDER BY ingredient_name, changed_at DESC
    `);

    for (const row of history) {
      const key = row.ingredient_name;
      if (!historyMap[key]) {
        historyMap[key] = [row]; // latest
      } else if (historyMap[key].length === 1) {
        historyMap[key].push(row); // previous
      }
    }

    const result = rows.map((item) => {
      const history = historyMap[item.name] || [];
      const prev = history[1];
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
}
