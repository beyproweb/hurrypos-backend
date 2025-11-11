// routes/printer.js
// ESC/POS printer routes for Beypro backend
// Works with USB, Serial, and Network printers.
// Mounted in server.js as: app.use('/api/printer-settings', printerRoutes);

const express = require("express");
const router = express.Router();

const { escpos, makeDevice, cleanErr, toHex } = require("../utils/printerHelpers");
const { SerialPort } = require("serialport");
const net = require("net");

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

    const probes = await Promise.all(
      allHosts.map(host => probeTcp(host, { port: Number(port) || 9100, timeout }))
    );

    res.json({ ok: true, printers: probes });
  } catch (err) {
    console.error("❌ LAN scan failed:", err);
    res.status(500).json({ error: cleanErr(err) });
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
