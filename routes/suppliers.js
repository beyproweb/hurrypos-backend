module.exports = (io) => {

const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { emitAlert } = require("../utils/realtime");

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

// GET /suppliers - Get all suppliers
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM suppliers");
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching suppliers:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// POST /suppliers - Add a new supplier
router.post("/", async (req, res) => {
  try {
    const { name, phone, email, address, tax_number, id_number, notes } = req.body;
    const result = await pool.query(
      `INSERT INTO suppliers (name, phone, email, address, tax_number, id_number, notes, total_due)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0)
       RETURNING id, name, total_due`,
      [name, phone, email, address, tax_number, id_number, notes]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error("❌ Error adding supplier:", error);
    res.status(500).json({ error: "Database error" });
  }
});


// POST /suppliers/transactions - Add a new transaction and update stock if needed
// POST /suppliers/transactions - Add a new transaction and update stock if needed
router.post("/transactions", upload.single("receipt"), async (req, res) => {
  try {
    const {
      supplier_id, ingredient, quantity, unit,
      total_cost, amount_paid, payment_method, price_per_unit
    } = req.body;

    // Find supplier
    const supplierRes = await pool.query(
      "SELECT total_due, name FROM suppliers WHERE id = $1", [supplier_id]
    );
    let currentDue = supplierRes.rows.length > 0 ? parseFloat(supplierRes.rows[0].total_due) : 0;
    let supplierName = supplierRes.rows.length > 0 ? supplierRes.rows[0].name : "";
    let newDue = currentDue + parseFloat(total_cost) - parseFloat(amount_paid);
    if (newDue < 0) newDue = 0;

    const receiptUrl = req.file ? `/uploads/receipts/${req.file.filename}` : null;

    // Save transaction
    const transactionResult = await pool.query(
      `INSERT INTO transactions
       (supplier_id, ingredient, quantity, unit, total_cost, amount_paid, due_after, payment_method, delivery_date, price_per_unit, receipt_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10)
       RETURNING *`,
      [supplier_id, ingredient, quantity, unit, total_cost, amount_paid, newDue, payment_method, price_per_unit, receiptUrl]
    );

    await pool.query(`UPDATE suppliers SET total_due = $1 WHERE id = $2`, [newDue, supplier_id]);

    // Stock update (if not Payment)
    if (ingredient !== "Payment") {
      const normalizedName = ingredient.trim();
      const stockUpsert = await pool.query(
        `INSERT INTO stock (name, quantity, unit, supplier_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ((LOWER(name)), unit)
         DO UPDATE SET
           quantity = stock.quantity + EXCLUDED.quantity,
           supplier_id = EXCLUDED.supplier_id
         RETURNING *`,
        [normalizedName, quantity, unit, supplier_id]
      );

      const stockItem = stockUpsert.rows[0];

      if (stockItem.quantity > stockItem.critical_quantity && stockItem.auto_added_to_cart) {
        await pool.query("UPDATE stock SET auto_added_to_cart = FALSE WHERE id = $1", [stockItem.id]);
      }

      const ppu = parseFloat(total_cost) / parseFloat(quantity);

      // --- Price history logic ---
      // Get previous price (second newest, because we are about to insert new)
      const prevResult = await pool.query(
        `
        SELECT price
        FROM ingredient_price_history
        WHERE ingredient_name = $1 AND unit = $2 AND supplier_name = $3
        ORDER BY changed_at DESC
        LIMIT 1
        `,
        [ingredient, unit, supplierName]
      );

      const previous_price = prevResult.rows.length ? Number(prevResult.rows[0].price) : null;

      // LOGGING
      console.log("DEBUG price change check:", {
        ingredient,
        unit,
        supplierName,
        previous_price,
        new_ppu: ppu,
      });

      // Insert the new price history record
      await pool.query(
        `
        INSERT INTO ingredient_price_history
        (ingredient_name, unit, price, changed_at, reason, supplier_name)
        VALUES ($1, $2, $3, NOW(), $4, $5)
        `,
        [ingredient, unit, ppu, "New transaction", supplierName]
      );

      // Emit alert if price changed (with tolerance for floating point errors)
      if (
        previous_price !== null &&
        Math.abs(ppu - previous_price) > 0.001
      ) {
        const percent = previous_price
          ? (((ppu - previous_price) / previous_price) * 100).toFixed(1)
          : "-";
        const isUp = ppu > previous_price;
        const emoji = isUp ? "🔺" : "🟢";
        const upDown = isUp ? "up" : "down";

        // LOGGING
        console.log("📢 Emitting ingredient price alert:", {
          message: `${emoji} Price ${upDown}: ${ingredient} ₺${ppu.toFixed(2)} (${percent}%) from ${supplierName}`,
          previous_price,
          new_price: ppu,
          ingredient,
          unit,
          supplierName,
        });

        emitAlert(
          io,
          `${emoji} Price ${upDown}: ${ingredient} ₺${ppu.toFixed(2)} (${percent}%) from ${supplierName}`,
          null,
          "ingredient"
        );
      } else {
        // LOGGING
        console.log("ℹ️ No alert sent: previous_price", previous_price, "new price", ppu);
      }

      // Emit stock update event for UI refresh
      io.emit("stock-updated", { stockId: stockItem.id });
    }

    res.json({
      success: true,
      transaction: transactionResult.rows[0],
      supplier_due: newDue
    });

  } catch (error) {
    console.error("❌ Error uploading receipt or saving transaction:", error);
    res.status(500).json({ error: "Database error" });
  }
});




// GET /suppliers/:id - Get a single supplier
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM suppliers WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Supplier not found." });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("❌ Error fetching supplier by ID:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// PUT /suppliers/:id - Update supplier details
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, email, address, tax_number, id_number, notes } = req.body;
    const updateResult = await pool.query(
      `UPDATE suppliers
       SET name = $1, phone = $2, email = $3, address = $4, tax_number = $5, id_number = $6, notes = $7
       WHERE id = $8 RETURNING *`,
      [name, phone, email, address, tax_number, id_number, notes, id]
    );
    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: "Supplier not found." });
    }
    res.json(updateResult.rows[0]);
  } catch (error) {
    console.error("❌ Error updating supplier:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// DELETE /suppliers/:id
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM suppliers WHERE id = $1", [id]);
    res.status(200).json({ message: "Supplier deleted" });
  } catch (err) {
    console.error("❌ Error deleting supplier:", err);
    res.status(500).json({ error: "Failed to delete supplier" });
  }
});

// GET /suppliers/:id/transactions
// GET /suppliers/:id/transactions
router.get("/:id/transactions", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT id, ingredient, quantity, unit, total_cost, amount_paid, due_after, payment_method, delivery_date, price_per_unit, receipt_url
       FROM transactions
       WHERE supplier_id = $1
       ORDER BY delivery_date DESC`,
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error fetching transactions:", error);
    res.status(500).json({ error: "Database error" });
  }
});



// DELETE /suppliers/:id/transactions
router.delete("/:id/transactions", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM transactions WHERE supplier_id = $1", [id]);
    await pool.query("UPDATE suppliers SET total_due = 0 WHERE id = $1", [id]);
    res.json({ message: "All transactions cleared." });
  } catch (error) {
    console.error("❌ Error clearing transactions:", error);
    res.status(500).json({ error: "Failed to clear transactions." });
  }
});

// PUT /suppliers/:id/pay
router.put("/:id/pay", async (req, res) => {
  try {
    const { id } = req.params;
    const { payment, payment_method } = req.body;

    const supplierQuery = await pool.query("SELECT total_due FROM suppliers WHERE id = $1", [id]);
    if (supplierQuery.rows.length === 0) {
      return res.status(404).json({ error: "Supplier not found" });
    }

    const currentDue = parseFloat(supplierQuery.rows[0].total_due);
    if (currentDue <= 0) {
      return res.status(400).json({ error: "No due amount to pay!" });
    }

    const newDue = Math.max(0, currentDue - payment);

    await pool.query(
      `INSERT INTO transactions
       (supplier_id, ingredient, quantity, unit, total_cost, amount_paid, due_after, payment_method, delivery_date)
       VALUES ($1, 'Payment', 0, NULL, 0, $2, $3, $4, NOW())`,
      [id, payment, newDue, payment_method]
    );

    await pool.query(
      `UPDATE suppliers
       SET total_due = $1
       WHERE id = $2`,
      [newDue, id]
    );

    res.json({ message: "Payment updated successfully!", total_due: newDue });
  } catch (error) {
    console.error("❌ Error processing payment:", error);
    res.status(500).json({ error: "Database error" });
  }
});

  return router;
};
