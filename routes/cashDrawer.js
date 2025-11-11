// routes/cashDrawer.js
// Opens ESC/POS cash drawers configured per restaurant register settings

const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
const { escpos, makeDevice, cleanErr } = require("../utils/printerHelpers");

router.use(authMiddleware);

async function loadRegisterSettings(restaurantId) {
  const { rows } = await pool.query(
    `
      SELECT register
      FROM settings
      WHERE restaurant_id = $1
        AND key = 'global'
      LIMIT 1
    `,
    [restaurantId]
  );

  const raw = rows[0]?.register;
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn("⚠️ Failed to parse register settings JSON:", err.message);
      return null;
    }
  }
  return raw;
}

async function resolvePrinterConfig(restaurantId, override) {
  if (override && typeof override === "object" && Object.keys(override).length) {
    return override;
  }

  const registerSettings = await loadRegisterSettings(restaurantId);
  return registerSettings?.cashDrawerPrinter || null;
}

router.post("/cashdrawer/open", async (req, res) => {
  const restaurantId = req.user?.restaurant_id || req.body?.restaurant_id;
  if (!restaurantId) {
    return res.status(400).json({ error: "Restaurant not resolved for cash drawer." });
  }

  try {
    const printerConfig = await resolvePrinterConfig(restaurantId, req.body?.printer);
    if (!printerConfig || !printerConfig.interface) {
      return res.status(400).json({
        error: "Cash drawer printer not configured. Update register settings first.",
      });
    }

    const device = makeDevice(printerConfig);
    const pin = Number(printerConfig.pin || printerConfig.cashdrawPin || 2);
    const encoding = printerConfig.encoding || "cp857";

    device.open((err) => {
      if (err) {
        return res
          .status(500)
          .json({ error: "Failed to open printer device: " + cleanErr(err) });
      }

      try {
        const printer = new escpos.Printer(device, { encoding });
        printer.cashdraw(pin);
        printer.close();
        return res.json({ success: true });
      } catch (printerErr) {
        console.error("❌ Cash drawer pulse failed:", printerErr);
        return res.status(500).json({
          error: "Pulse command failed: " + cleanErr(printerErr),
        });
      }
    });
  } catch (err) {
    console.error("❌ cashdrawer/open error:", err);
    return res
      .status(500)
      .json({ error: cleanErr(err) });
  }
});

module.exports = router;
