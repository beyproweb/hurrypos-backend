// routes/printer.js
// ESC/POS printer routes for Beypro backend
// Works with USB, Serial, and Network printers.
// Mounted in server.js as: app.use('/api/printer-settings', printerRoutes);

const express = require("express");
const router = express.Router();

const escpos = require("escpos");
try {
  escpos.USB = require("escpos-usb");
} catch (e) {
  // keep going; USB listing/printing will throw a helpful error later
}
escpos.Network = require("escpos-network");
escpos.Serial = require("escpos-serialport");

const { SerialPort } = require("serialport");

// ---------- helpers ----------
function toHex(n) {
  if (typeof n !== "number") return null;
  return "0x" + n.toString(16).padStart(4, "0");
}
function parseHex(h) {
  if (typeof h === "number") return h;
  if (typeof h !== "string") return null;
  const s = h.toLowerCase().replace(/^0x/, "");
  const v = parseInt(s, 16);
  return Number.isFinite(v) ? v : null;
}
function cleanErr(e) {
  return (e && (e.message || e.toString())) || "unknown";
}
function makeDevice({ iface, vendorId, productId, path, baudRate, host, port }) {
  if (iface === "usb") {
    if (!escpos.USB) throw new Error("USB support not available (install escpos-usb and libusb).");
    const v = parseHex(vendorId);
    const p = parseHex(productId);
    if (v == null || p == null) throw new Error("Provide vendorId and productId like '0x04b8' and '0x0e15'.");
    return new escpos.USB(v, p);
  }
  if (iface === "serial") {
    if (!path) throw new Error("Provide serial 'path' (e.g., /dev/ttyUSB0 or COM3).");
    return new escpos.Serial(path, { baudRate: baudRate || 9600 });
  }
  if (iface === "network") {
    if (!host) throw new Error("Provide network 'host' (printer IP).");
    return new escpos.Network(host, port || 9100);
  }
  throw new Error("Unsupported interface. Use one of: usb | serial | network");
}

// ---------- routes ----------

// Health
router.get("/status", (req, res) => {
  res.json({ ok: true, message: "Printer routes alive" });
});

// List printers (USB + Serial)
router.get("/printers", async (req, res) => {
  const out = { usb: [], serial: [], tips: [] };

  // USB
  try {
    if (!escpos.USB) {
      out.tips.push("USB module not loaded. Install 'escpos-usb' and system libusb.");
    } else {
      const list = escpos.USB.findPrinter?.() || [];
      out.usb = list.map((p, idx) => ({
        id: `usb-${idx}`,
        vendorId: toHex(p?.deviceDescriptor?.idVendor),
        productId: toHex(p?.deviceDescriptor?.idProduct),
      }));
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
        path: p.path,
        manufacturer: p.manufacturer || "",
        friendlyName: p.friendlyName || "",
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
    const usb = list.map((p, idx) => ({
      id: `usb-${idx}`,
      vendorId: toHex(p?.deviceDescriptor?.idVendor),
      productId: toHex(p?.deviceDescriptor?.idProduct),
    }));
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
