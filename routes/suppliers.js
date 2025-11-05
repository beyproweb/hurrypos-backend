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
// POST /suppliers/transactions (compile multiple rows into 1 receipt)
router.post("/transactions", upload.array("receipt"), async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    let { supplier_id, rows, payment_method } = req.body;

    if (!rows) return res.status(400).json({ error: "No rows provided" });
    rows = JSON.parse(rows); // expect array of { ingredient, quantity, unit, total_cost }

    let totalCost = 0;
    const itemDetails = [];

    for (const r of rows) {
      const quantity = parseFloat(r.quantity) || 0;
      const total = parseFloat(r.total_cost) || 0;
      totalCost += total;
      itemDetails.push({
        ingredient: r.ingredient,
        quantity,
        unit: r.unit,
        total_cost: total,
        price_per_unit: quantity > 0 ? total / quantity : 0,
      });
    }

    // get supplier and current due
    const supplierRes = await pool.query(
      "SELECT total_due, name FROM suppliers WHERE restaurant_id=$1 AND id=$2",
      [restaurantId, supplier_id]
    );
    if (supplierRes.rowCount === 0)
      return res.status(404).json({ error: "Supplier not found" });

    let currentDue = parseFloat(supplierRes.rows[0].total_due) || 0;
    const newDue = currentDue + totalCost;

    // optional receipt upload
    const receiptUrl = req.files?.[0]
      ? `/uploads/receipts/${req.files[0].filename}`
      : null;

    // insert compiled transaction
    const result = await pool.query(
      `INSERT INTO transactions
       (restaurant_id, supplier_id, ingredient, quantity, unit, total_cost, amount_paid, due_after, payment_method, delivery_date, receipt_url, items)
       VALUES ($1,$2,'Compiled Receipt',0,NULL,$3,0,$4,$5,NOW(),$6,$7)
       RETURNING *`,
      [
        restaurantId,
        supplier_id,
        totalCost,
        newDue,
        payment_method || "Due",
        receiptUrl,
        JSON.stringify(itemDetails),
      ]
    );

    // update supplier balance
    await pool.query(
      "UPDATE suppliers SET total_due=$1 WHERE restaurant_id=$2 AND id=$3",
      [newDue, restaurantId, supplier_id]
    );

    io.emit("stock-updated");
    res.json({ success: true, transaction: result.rows[0] });
  } catch (err) {
    console.error("❌ Error compiling receipt:", err);
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

// ✅ GET /suppliers/:id/transactions — include compiled receipt items
router.get("/:id/transactions", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        id, supplier_id, ingredient, quantity, unit, total_cost,
        amount_paid, due_after, payment_method, delivery_date,
        price_per_unit, receipt_url, items
      FROM transactions
      WHERE restaurant_id = $1
        AND supplier_id = $2
      ORDER BY delivery_date DESC
      `,
      [req.user.restaurant_id, id]
    );

    // ✅ Parse JSONB safely — some drivers return it as string
    const rows = result.rows.map((txn) => ({
      ...txn,
      items:
        typeof txn.items === "string"
          ? JSON.parse(txn.items)
          : Array.isArray(txn.items)
          ? txn.items
          : [],
    }));

    res.json(rows);
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

// ✅ /suppliers/:id/pay
router.put("/:id/pay", async (req, res) => {
  try {
    const { id } = req.params;
    const { payment, payment_method } = req.body;
    const restaurantId = req.user.restaurant_id;

    // Get current due from DB
    const supplierRes = await pool.query(
      "SELECT total_due FROM suppliers WHERE restaurant_id=$1 AND id=$2",
      [restaurantId, id]
    );

    if (supplierRes.rowCount === 0)
      return res.status(404).json({ error: "Supplier not found" });

    let currentDue = parseFloat(supplierRes.rows[0].total_due) || 0;

    // If no due, stop here
    if (currentDue <= 0)
      return res.status(400).json({ error: "No due amount to pay" });

    const paymentValue = parseFloat(payment) || 0;

    // ✅ Subtract payment from current due
    const newDue = Math.max(0, currentDue - paymentValue);

    // Record "Payment" transaction
    await pool.query(
      `INSERT INTO transactions
         (restaurant_id, supplier_id, ingredient, quantity, unit,
          total_cost, amount_paid, due_after, payment_method, delivery_date)
       VALUES ($1,$2,'Payment',0,NULL,0,$3,$4,$5,NOW())`,
      [restaurantId, id, paymentValue, newDue, payment_method || "Cash"]
    );

    // Update supplier’s due
    const updateRes = await pool.query(
      `UPDATE suppliers SET total_due=$1 WHERE restaurant_id=$2 AND id=$3
       RETURNING id, name, total_due`,
      [newDue, restaurantId, id]
    );

    // Emit realtime update
    io.emit("supplier-payment-updated", {
      supplier_id: id,
      old_due: currentDue,
      new_due: newDue,
      payment: paymentValue,
    });

    res.json({
      message: "Payment recorded successfully",
      total_due: newDue,
      supplier: updateRes.rows[0],
    });
  } catch (error) {
    console.error("❌ Error processing payment:", error);
    res.status(500).json({ error: "Database error" });
  }
});




  return router;
};
