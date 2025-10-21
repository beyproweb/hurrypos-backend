// routes/suppliers.js
module.exports = (io) => {
  const express = require("express");
  const router = express.Router();
  const { pool } = require("../db");
  const multer = require("multer");
  const path = require("path");
  const fs = require("fs");
  const { emitAlert } = require("../utils/realtime");
  const authMiddleware = require("../middleware/authMiddleware");

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

  // ---------------- SUPPLIERS ----------------

  // GET /suppliers - tenant-safe
  router.get("/", async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM suppliers WHERE restaurant_id=$1 ORDER BY name",
        [req.user.restaurant_id]
      );
      res.json(result.rows);
    } catch (err) {
      console.error("❌ Error fetching suppliers:", err);
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

  // ---------------- TRANSACTIONS ----------------

// POST /suppliers/transactions
router.post("/transactions", upload.single("receipt"), async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    let {
      supplier_id,
      ingredient,
      quantity,
      unit,
      total_cost,
      amount_paid,
      payment_method,
    } = req.body;

    // ✅ Sanitize numbers
    quantity = parseFloat(quantity);
    if (isNaN(quantity) || quantity < 0) quantity = 0;

    total_cost = parseFloat(total_cost);
    if (isNaN(total_cost) || total_cost < 0) total_cost = 0;

    amount_paid = parseFloat(amount_paid);
    if (isNaN(amount_paid) || amount_paid < 0) amount_paid = 0;

    // ✅ Compute due and unit price safely
    const supplierRes = await pool.query(
      "SELECT total_due, name FROM suppliers WHERE restaurant_id=$1 AND id=$2",
      [restaurantId, supplier_id]
    );
    if (supplierRes.rowCount === 0) {
      return res.status(404).json({ error: "Supplier not found" });
    }

    let currentDue = parseFloat(supplierRes.rows[0].total_due) || 0;
    let newDue = currentDue + total_cost - amount_paid;
    if (newDue < 0) newDue = 0;

    const receiptUrl = req.file
      ? `/uploads/receipts/${req.file.filename}`
      : null;

    const pricePerUnit = quantity > 0 ? total_cost / quantity : 0;

    // ✅ Insert transaction
    const transactionResult = await pool.query(
      `INSERT INTO transactions
       (restaurant_id, supplier_id, ingredient, quantity, unit, total_cost, amount_paid, due_after, payment_method, delivery_date, price_per_unit, receipt_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,$11)
       RETURNING *`,
      [
        restaurantId,
        supplier_id,
        (ingredient || "").trim(),
        quantity,
        unit || null,
        total_cost,
        amount_paid,
        newDue,
        payment_method || "Cash",
        pricePerUnit,
        receiptUrl,
      ]
    );

    await pool.query(
      `UPDATE suppliers SET total_due=$1 WHERE restaurant_id=$2 AND id=$3`,
      [newDue, restaurantId, supplier_id]
    );
// ✅ Record ingredient price change into ingredient_price_history
if (ingredient && ingredient !== "Payment" && pricePerUnit > 0) {
  try {
    await pool.query(
  `INSERT INTO ingredient_price_history
   (restaurant_id, ingredient_name, unit, price, changed_at, reason, supplier_name)
   VALUES ($1, LOWER($2), $3, $4, NOW(), 'Purchase update',
           (SELECT name FROM suppliers WHERE id=$5 AND restaurant_id=$1 LIMIT 1))`,
  [restaurantId, ingredient.trim(), unit, pricePerUnit, supplier_id]
);

  } catch (err) {
    console.error("⚠️ Failed to record ingredient price:", err.message);
  }
}



    // ✅ Update stock if not a Payment record
    if (ingredient !== "Payment") {
      await pool.query(
        `INSERT INTO stock (restaurant_id, name, quantity, unit, supplier_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (restaurant_id,name,unit)
         DO UPDATE SET quantity=stock.quantity+EXCLUDED.quantity
         RETURNING *`,
        [restaurantId, ingredient.trim(), quantity, unit, supplier_id]
      );
      io.emit("stock-updated");
    }

    res.json({
      success: true,
      transaction: transactionResult.rows[0],
      supplier_due: newDue,
    });
  } catch (error) {
    console.error("❌ Error saving transaction:", error);
    res.status(500).json({ error: "Database error" });
  }
});



// ---------------- INGREDIENTS ----------------

router.get("/ingredients", async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;

    const result = await pool.query(
      `
      SELECT
        s.name,
        s.unit,
        COALESCE((
          SELECT t.price_per_unit
          FROM transactions t
          WHERE t.restaurant_id = $1
            AND LOWER(t.ingredient) = LOWER(s.name)
            AND t.unit = s.unit
          ORDER BY t.delivery_date DESC
          LIMIT 1
        ), 0) AS price_per_unit
      FROM stock s
      WHERE s.restaurant_id = $1
        AND s.name IS NOT NULL
        AND s.name <> ''
      GROUP BY s.name, s.unit
      ORDER BY LOWER(s.name) ASC
      `,
      [restaurantId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching ingredients:", err.message);
    res.status(500).json({ error: "Database error" });
  }
});

  // ---------------- SINGLE SUPPLIER ----------------

  router.get("/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        "SELECT * FROM suppliers WHERE restaurant_id=$1 AND id=$2",
        [req.user.restaurant_id, id]
      );
      if (result.rowCount === 0)
        return res.status(404).json({ error: "Supplier not found" });
      res.json(result.rows[0]);
    } catch (error) {
      console.error("❌ Error fetching supplier by ID:", error);
      res.status(500).json({ error: "Database error" });
    }
  });

  router.put("/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { name, phone, email, address, tax_number, id_number, notes } =
        req.body;
      const result = await pool.query(
        `UPDATE suppliers
         SET name=$3, phone=$4, email=$5, address=$6, tax_number=$7, id_number=$8, notes=$9
         WHERE restaurant_id=$1 AND id=$2 RETURNING *`,
        [
          req.user.restaurant_id,
          id,
          name,
          phone,
          email,
          address,
          tax_number,
          id_number,
          notes,
        ]
      );
      if (result.rowCount === 0)
        return res.status(404).json({ error: "Supplier not found" });
      res.json(result.rows[0]);
    } catch (error) {
      console.error("❌ Error updating supplier:", error);
      res.status(500).json({ error: "Database error" });
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query(
        "DELETE FROM suppliers WHERE restaurant_id=$1 AND id=$2",
        [req.user.restaurant_id, id]
      );
      res.json({ message: "Supplier deleted" });
    } catch (err) {
      console.error("❌ Error deleting supplier:", err);
      res.status(500).json({ error: "Failed to delete supplier" });
    }
  });

  // ---------------- TRANSACTIONS BY SUPPLIER ----------------

  router.get("/:id/transactions", async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `SELECT id, ingredient, quantity, unit, total_cost, amount_paid, due_after, payment_method, delivery_date, price_per_unit, receipt_url
         FROM transactions
         WHERE restaurant_id=$1 AND supplier_id=$2
         ORDER BY delivery_date DESC`,
        [req.user.restaurant_id, id]
      );
      res.json(result.rows);
    } catch (error) {
      console.error("❌ Error fetching transactions:", error);
      res.status(500).json({ error: "Database error" });
    }
  });

  router.delete("/:id/transactions", async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query(
        "DELETE FROM transactions WHERE restaurant_id=$1 AND supplier_id=$2",
        [req.user.restaurant_id, id]
      );
      await pool.query(
        "UPDATE suppliers SET total_due=0 WHERE restaurant_id=$1 AND id=$2",
        [req.user.restaurant_id, id]
      );
      res.json({ message: "All transactions cleared" });
    } catch (error) {
      console.error("❌ Error clearing transactions:", error);
      res.status(500).json({ error: "Failed to clear transactions." });
    }
  });

  router.put("/:id/pay", async (req, res) => {
    try {
      const { id } = req.params;
      const { payment, payment_method } = req.body;

      const supplierRes = await pool.query(
        "SELECT total_due FROM suppliers WHERE restaurant_id=$1 AND id=$2",
        [req.user.restaurant_id, id]
      );
      if (supplierRes.rowCount === 0)
        return res.status(404).json({ error: "Supplier not found" });

      const currentDue = parseFloat(supplierRes.rows[0].total_due);
      if (currentDue <= 0)
        return res.status(400).json({ error: "No due amount to pay" });

      const newDue = Math.max(0, currentDue - payment);

      await pool.query(
        `INSERT INTO transactions
         (restaurant_id, supplier_id, ingredient, quantity, unit, total_cost, amount_paid, due_after, payment_method, delivery_date)
         VALUES ($1,$2,'Payment',0,NULL,0,$3,$4,$5,NOW())`,
        [req.user.restaurant_id, id, payment, newDue, payment_method]
      );

      await pool.query(
        "UPDATE suppliers SET total_due=$1 WHERE restaurant_id=$2 AND id=$3",
        [newDue, req.user.restaurant_id, id]
      );

      res.json({ message: "Payment updated successfully", total_due: newDue });
    } catch (error) {
      console.error("❌ Error processing payment:", error);
      res.status(500).json({ error: "Database error" });
    }
  });

  return router;
};
