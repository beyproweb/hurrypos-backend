// routes/printer.js
// ESC/POS printer routes for Beypro backend
// Works with USB, Serial, and Network printers.
// Mounted in server.js as: app.use('/api/printer-settings', printerRoutes);

const express = require("express");
const router = express.Router();

const { escpos, makeDevice, cleanErr, toHex } = require("../utils/printerHelpers");
const { SerialPort } = require("serialport");
const net = require("net");
const { pool } = require("../db");
const authMiddleware = require("../middleware/authMiddleware");

async function ensureSettingsColumn() {
  try {
    // Check if settings column exists
    const settingsCheck = await pool.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'user_settings' AND column_name = 'settings'
      `
    );
    if (!settingsCheck.rows.length) {
      await pool.query(
        `
        ALTER TABLE user_settings
        ADD COLUMN settings jsonb DEFAULT '{}'::jsonb
        `
      );
      console.log("✅ Added missing user_settings.settings column");
    }

    // Check if section column exists
    const sectionCheck = await pool.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'user_settings' AND column_name = 'section'
      `
    );
    if (!sectionCheck.rows.length) {
      await pool.query(
        `
        ALTER TABLE user_settings
        ADD COLUMN section VARCHAR(50) DEFAULT 'general'
        `
      );
      console.log("✅ Added missing user_settings.section column");
    }

    // Ensure unique constraint on (user_id, restaurant_id, section)
    try {
      // Drop old index if it exists
      await pool.query(
        `
        DROP INDEX IF EXISTS user_settings_restaurant_section_idx
        `
      );
      
      // Check if the primary key is composite
      const pkCheck = await pool.query(
        `
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'user_settings' 
          AND constraint_type = 'PRIMARY KEY'
          AND constraint_name = 'user_settings_pkey'
        `
      );
      
      if (pkCheck.rows.length > 0) {
        // Try to check if it's composite
        const pkCols = await pool.query(
          `
          SELECT COUNT(*) as col_count
          FROM information_schema.key_column_usage
          WHERE table_name = 'user_settings'
            AND constraint_name = 'user_settings_pkey'
          `
        );
        
        if (pkCols.rows[0].col_count === 1) {
          // Primary key is only on user_id, need to fix it
          console.log("⚠️ Fixing user_settings primary key to be composite...");
          await pool.query(
            `
            ALTER TABLE user_settings 
            DROP CONSTRAINT user_settings_pkey
            `
          );
          await pool.query(
            `
            ALTER TABLE user_settings
            ADD CONSTRAINT user_settings_pkey PRIMARY KEY (user_id, restaurant_id, section)
            `
          );
          console.log("✅ Updated user_settings primary key to (user_id, restaurant_id, section)");
        }
      }
    } catch (constraintErr) {
      console.error("⚠️ Could not update primary key:", constraintErr.message);
    }

    // Check if updated_at column exists
    const updatedAtCheck = await pool.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'user_settings' AND column_name = 'updated_at'
      `
    );
    if (!updatedAtCheck.rows.length) {
      await pool.query(
        `
        ALTER TABLE user_settings
        ADD COLUMN updated_at TIMESTAMP DEFAULT NOW()
        `
      );
      // Create index for faster queries
      await pool.query(
        `
        CREATE INDEX IF NOT EXISTS user_settings_updated_at_idx 
        ON user_settings(updated_at DESC)
        `
      );
      console.log("✅ Added missing user_settings.updated_at column");
    }

    console.log("✅ Database schema verified for printer settings");
  } catch (err) {
    console.warn("⚠️ Could not ensure user_settings columns:", err.message);
  }
}

ensureSettingsColumn();

const DEFAULT_RECEIPT_LAYOUT = {
  logoUrl: "",
  showLogo: true,
  headerTitle: "Beypro POS · Hurrybey",
  headerSubtitle: "Your receipt, your brand",
  showHeader: true,
  showFooter: true,
  footerText: "Teşekkür ederiz! / Thank you!",
  showQr: true,
  qrText: "Scan for feedback",
  qrUrl: "https://hurrybey.com/feedback",
  alignment: "left",
  paperWidth: "80mm",
  spacing: 1.25,
  showTaxes: true,
  showDiscounts: true,
  taxLabel: "Tax",
  discountLabel: "Discount",
  showItemModifiers: true,
  showSku: false,
  taxRate: 0.18,
  discountRate: 0,
  margin: 12,
  itemFontSize: 14,
};

const getDefaultPrinterConfig = () => ({
  receiptPrinter: null,
  kitchenPrinter: null,
  layout: { ...DEFAULT_RECEIPT_LAYOUT },
  defaults: {
    cut: true,
    cashDrawer: false,
  },
  customLines: [],
  lastSynced: new Date().toISOString(),
});

// ---------- routes ----------

// Health
router.get("/status", (req, res) => {
  res.json({ ok: true, message: "Printer routes alive" });
});

// Quick network printer discovery (tries common default gateway subnet)
// GET /api/printer-settings/discover-network
router.get("/discover-network", async (req, res) => {
  try {
    // Attempt to detect local subnet from common patterns
    // In production, you'd want to detect this from the server's network interface
    const defaultSubnets = [
      "192.168.1",    // Most common home/small business
      "192.168.0",    // Alternative home network
      "10.0.0",       // Large private network
      "172.16.0",     // Another common range
    ];

    const results = {};
    
    for (const subnet of defaultSubnets) {
      const hosts = [];
      // Scan first 50 addresses (configurable, but avoid full scans)
      for (let i = 1; i <= 50; i++) {
        hosts.push(`${subnet}.${i}`);
      }
      
      const probes = await Promise.all(
        hosts.map(host => probeTcpWithFingerprint(host, { port: 9100, timeout: 800 }))
      );
      
      const found = probes.filter(p => p.ok && p.isEscpos);
      if (found.length > 0) {
        results[subnet] = found;
      }
    }

    res.json({
      ok: true,
      discovered: Object.values(results).flat(),
      subnetsScanned: defaultSubnets,
      message: `Scanned ${defaultSubnets.length} subnets`,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: cleanErr(err) });
  }
});

function serializeUsb(p, idx, now) {
  return {
    id: `usb-${idx}`,
    type: "usb",
    vendorId: toHex(p?.deviceDescriptor?.idVendor),
    productId: toHex(p?.deviceDescriptor?.idProduct),
    status: "ready",
    detectedAt: now,
  };
}

// List printers (USB + Serial)
router.get("/printers", async (req, res) => {
  const out = { usb: [], serial: [], tips: [] };
  const now = new Date().toISOString();

  // USB
  try {
    if (!escpos.USB) {
      out.tips.push("USB module not loaded. Install 'escpos-usb' and system libusb.");
    } else {
      const list = escpos.USB.findPrinter?.() || [];
      out.usb = list.map((p, idx) => serializeUsb(p, idx, now));
      if (out.usb.length === 0) {
        out.tips.push("No USB printers detected. On macOS/Linux, install/libusb and replug; on Windows, install the driver.");
      }
    }
  } catch (e) {
    out.tips.push("USB error: " + cleanErr(e));
  }

  // Serial
  try {
    const ports = await SerialPort.list();
    out.serial = ports
      .filter(p => /usb|serial|tty|COM/i.test([p.path, p.friendlyName, p.manufacturer].join(" ")))
      .map((p, idx) => ({
        id: `serial-${idx}`,
        type: "serial",
        path: p.path,
        manufacturer: p.manufacturer || "",
        friendlyName: p.friendlyName || "",
        status: "ready",
        detectedAt: now,
      }));
    if (out.serial.length === 0) {
      out.tips.push("No Serial ports detected. Many USB printers expose a serial interface on macOS (e.g. /dev/tty.usbserial-*).");
    }
  } catch (e) {
    out.tips.push("Serial error: " + cleanErr(e));
  }

  res.json({ ok: true, printers: out });
});

// Legacy alias to keep old clients alive (your previous bridge queried /usb/list)
router.get("/usb/list", async (req, res) => {
  try {
    if (!escpos.USB) throw new Error("USB module not loaded. Install 'escpos-usb' and libusb.");
    const list = escpos.USB.findPrinter?.() || [];
    const now = new Date().toISOString();
    const usb = list.map((p, idx) => serializeUsb(p, idx, now));
    res.json({ ok: true, usb });
  } catch (e) {
    res.status(500).json({ ok: false, error: cleanErr(e) });
  }
});

// Print
// Body:
// {
//   interface: "usb" | "serial" | "network",
//   vendorId?: "0x04b8", productId?: "0x0e15",   // USB
//   path?: "/dev/ttyUSB0" | "COM3", baudRate?: 9600, // Serial
//   host?: "192.168.1.50", port?: 9100,          // Network
//   content: "Your text\n",
//   encoding?: "cp857" | "cp437" | "gb18030" | "utf8",
//   align?: "lt" | "ct" | "rt",
//   cut?: true, cashdraw?: false
// }
router.post("/print", async (req, res) => {
  const {
    interface: iface,
    vendorId,
    productId,
    path,
    baudRate,
    host,
    port,
    content = "",
    encoding = "cp857", // default Turkish-friendly
    align = "lt",
    cut = true,
    cashdraw = false,
  } = req.body || {};

  if (!content || typeof content !== "string") {
    return res.status(400).json({ ok: false, error: "Missing 'content' string." });
  }

  let device;
  try {
    device = makeDevice({ iface, vendorId, productId, path, baudRate, host, port });
  } catch (e) {
    return res.status(400).json({ ok: false, error: cleanErr(e) });
  }

  device.open(err => {
    if (err) return res.status(500).json({ ok: false, error: "Failed to open device: " + cleanErr(err) });

    try {
      const printer = new escpos.Printer(device, { encoding });

      // Basic print
      printer.align(align).style("a").size(1, 1);
      printer.text(content.endsWith("\n") ? content : content + "\n");

      if (cashdraw) printer.cashdraw(2); // pin 2 is common
      if (cut) printer.cut();

      printer.close(); // this also closes the device
      return res.json({ ok: true });
    } catch (e2) {
      return res.status(500).json({ ok: false, error: "Print error: " + cleanErr(e2) });
    }
  });
});

// Enhanced TCP probe with ESC/POS fingerprinting
async function probeTcpWithFingerprint(host, { port = 9100, timeout = 1200 } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const started = Date.now();
    let done = false;
    let responseReceived = false;
    let responseTimeout; // Track timeout for cleanup

    const finish = (ok, error, details = {}) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      if (responseTimeout) clearTimeout(responseTimeout);
      resolve({
        host,
        port,
        ok,
        latency: Date.now() - started,
        error,
        manufacturer: details.manufacturer || null,
        model: details.model || null,
        isEscpos: details.isEscpos || false,
      });
    };

    // Overall socket timeout
    socket.setTimeout(timeout, () => {
      finish(false, `timeout (${timeout}ms) - no connection or response`);
    });

    socket.once("error", (err) => {
      finish(false, err?.message || "socket error");
    });

    socket.connect(port, host, () => {
      // Connection successful - now send ESC/POS status query (0x1D 0x72 0x01)
      const statusQuery = Buffer.from([0x1d, 0x72, 0x01]);

      socket.write(statusQuery, (err) => {
        if (err) {
          return finish(false, err.message);
        }

        // Set a listener for data response
        const dataHandler = (data) => {
          responseReceived = true;
          if (responseTimeout) clearTimeout(responseTimeout);
          // If we receive any data, it's likely responding to ESC/POS command
          const isLikelyEscpos = data && data.length > 0;
          finish(isLikelyEscpos, null, {
            isEscpos: isLikelyEscpos,
            manufacturer: "Network ESC/POS Printer",
            model: `Thermal Printer (${host}:${port})`,
          });
        };

        socket.once("data", dataHandler);

        // If no response within 800ms after command sent, assume port open but not ESC/POS
        responseTimeout = setTimeout(() => {
          if (!responseReceived && !done) {
            socket.removeListener("data", dataHandler);
            // Port is open but no ESC/POS response - might be different protocol
            finish(true, null, {
              isEscpos: false,
              manufacturer: "Unknown (port open)",
              model: `Device on ${host}:${port}`,
            });
          }
        }, 800);
      });
    });
  });
}

// Legacy function for backward compatibility (TCP connectivity check only)
function probeTcp(host, { port = 9100, timeout = 1200 } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const started = Date.now();
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve({ host, port, ok, latency: Date.now() - started, error });
    };
    socket.setTimeout(timeout, () => finish(false, "timeout"));
    socket.once("error", (err) => finish(false, err?.message || "socket error"));
    socket.connect(port, host, () => finish(true));
  });
}

router.post("/lan-scan", async (req, res) => {
  try {
    const {
      hosts = [],
      base,
      from = 1,
      to = 254,
      port = 9100,
      timeout = 1200,
      fingerprint = true, // NEW: enable ESC/POS fingerprinting by default
    } = req.body || {};

    const explicitHosts = Array.isArray(hosts)
      ? hosts.filter(Boolean)
      : typeof hosts === "string"
        ? hosts.split(",").map(h => h.trim()).filter(Boolean)
        : [];

    let generated = [];
    if (base) {
      const prefix = base.endsWith(".") ? base : `${base}.`;
      const start = Math.max(1, Math.min(254, Number(from)));
      const end = Math.max(start, Math.min(254, Number(to)));
      for (let i = start; i <= end; i++) {
        generated.push(`${prefix}${i}`);
      }
    }

    const allHosts = [...new Set([...explicitHosts, ...generated])].slice(0, 64);
    if (allHosts.length === 0) {
      return res.status(400).json({ error: "Provide hosts[] or base range" });
    }

    // Use fingerprinting if enabled, otherwise just check TCP connectivity
    const probeFn = fingerprint ? probeTcpWithFingerprint : probeTcp;
    const probes = await Promise.all(
      allHosts.map(host => probeFn(host, { port: Number(port) || 9100, timeout }))
    );

    res.json({ ok: true, printers: probes });
  } catch (err) {
    console.error("❌ LAN scan failed:", err);
    res.status(500).json({ error: cleanErr(err) });
  }
});

router.get("/sync", authMiddleware, async (req, res) => {
  const restaurantId = req.user?.restaurant_id;
  if (!restaurantId) {
    return res.status(400).json({ ok: false, error: "restaurant_id is required" });
  }

  try {
    const result = await pool.query(
      `
      SELECT settings
      FROM user_settings
      WHERE restaurant_id = $1 AND section = 'printers'
      `,
      [restaurantId]
    );

    const settings = result.rows[0]?.settings || getDefaultPrinterConfig();
    res.json({ ok: true, settings });
  } catch (err) {
    console.error("❌ Failed to fetch printer settings:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch printer settings" });
  }
});

router.post("/sync", authMiddleware, async (req, res) => {
  const restaurantId = req.user?.restaurant_id;
  const userId = req.user?.id; // Extract user_id from auth context
  const payload = req.body || {};
  const layoutOverride =
    payload.layout && typeof payload.layout === "object" ? payload.layout : {};

  if (!restaurantId) {
    return res.status(400).json({ ok: false, error: "restaurant_id is required" });
  }

  if (!userId) {
    return res.status(400).json({ ok: false, error: "user_id is required" });
  }

  const settings = {
    ...getDefaultPrinterConfig(),
    ...payload,
    layout: {
      ...DEFAULT_RECEIPT_LAYOUT,
      ...layoutOverride,
    },
    lastSynced: new Date().toISOString(),
  };

  try {
    await pool.query(
      `
      INSERT INTO user_settings (user_id, restaurant_id, section, settings)
      VALUES ($1, $2, 'printers', $3)
      ON CONFLICT (user_id, restaurant_id, section)
      DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()
      `,
      [userId, restaurantId, JSON.stringify(settings)]
    );

    res.json({ ok: true, settings });
  } catch (err) {
    console.error("❌ Failed to save printer settings:", err);
    console.error("Error details:", err.message);
    res.status(500).json({ ok: false, error: "Failed to save printer settings", details: err.message });
  }
});

// Quick test ticket
// Body (optional): { interface, vendorId, productId, path, baudRate, host, port }
router.post("/test", async (req, res) => {
  const body = req.body || {};
  body.content =
`*** BEYPRO TEST ***
ĞÜŞİÖÇ ğüşiöç (cp857)
-------------------------
Item A        2 × 50.00
Item B        1 × 99.90
-------------------------
TOTAL             199.90 TL

${new Date().toLocaleString()}
`;
  body.cut = true;
  body.encoding = body.encoding || "cp857";
  req.body = body;
  return router.handle({ ...req, url: "/print", method: "POST" }, res);
});

// 🔹 GET /api/printer-settings/:id (mock or DB fetch)
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  // Option 1: Static fallback layout if DB not yet implemented
  const defaultLayout = {
    fontSize: 14,
    lineHeight: 1.3,
    showLogo: true,
    showQr: true,
    showHeader: true,
    showFooter: true,
    headerText: "Beypro POS - HurryBey",
    footerText: "Thank you for your order! / Teşekkürler!",
    alignment: "left",
    shopAddress: "Your Shop Address\n123 Street Name, İzmir",
    extras: [
      { label: "Instagram", value: "@yourshop" },
      { label: "Tax No", value: "1234567890" },
    ],
    showPacketCustomerInfo: true,
    receiptWidth: "58mm",
    receiptHeight: "",
  };

  res.json({
    id: Number(id),
    name: "Default Printer",
    layout: defaultLayout,
  });
});

module.exports = router;
