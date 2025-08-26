// routes/lan-printers.js
const express = require("express");
const net = require("net");
const router = express.Router();

// ---- RAW ESC/POS SENDER (JetDirect :9100) ----
function sendRawToPrinter({ host, port = 9100, data, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;

    const fail = (err) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      reject(err || new Error("Print failed"));
    };
    const ok = () => {
      if (done) return;
      done = true;
      try { socket.end(); } catch {}
      resolve();
    };

    socket.setTimeout(timeoutMs, () => fail(new Error("Printer timeout")));
    socket.once("error", fail);
    socket.connect(port, host, () => {
      // Write and cut
      const ESC = Buffer.from([0x1b]);
      const GS = Buffer.from([0x1d]);

      const init = Buffer.from([0x1b, 0x40]); // ESC @
      const cut = Buffer.concat([
        GS, Buffer.from("V", "ascii"), Buffer.from([66, 3]) // partial cut
      ]);
      const lf = Buffer.from("\n");

      const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
      const toSend = Buffer.concat([init, payload, lf, lf, cut]);

      socket.write(toSend, (err) => {
        if (err) return fail(err);
        socket.once("close", ok);
        socket.end();
      });
    });
  });
}

// (Optional) Simple health ping (for debugging)
router.get("/ping", (_req, res) => res.json({ ok: true }));

// POST /api/lan-printers/print-raw
// Body: { host: "192.168.1.50", port?: 9100, content: "text or escpos" }
router.post("/print-raw", async (req, res) => {
  try {
    const { host, port = 9100, content } = req.body || {};
    if (!host || !content) {
      return res.status(400).json({ error: "host and content are required" });
    }
    await sendRawToPrinter({ host, port: Number(port) || 9100, data: content });
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ LAN print failed:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// --- Pretty test receipt (ESC/POS) ---
router.post("/print-test", async (req, res) => {
  try {
    const { host, port = 9100, title = "Beypro Test" } = req.body || {};
    if (!host) return res.status(400).json({ error: "host is required" });

    // ESC/POS helpers
    const ESC = Buffer.from([0x1b]);
    const GS  = Buffer.from([0x1d]);

    const init   = Buffer.from([0x1b, 0x40]);              // ESC @
    const center = Buffer.from([0x1b, 0x61, 0x01]);         // ESC a 1 (center)
    const normal = Buffer.from([0x1b, 0x21, 0x00]);         // font normal
    const bold   = Buffer.from([0x1b, 0x45, 0x01]);         // bold on
    const boldOff= Buffer.from([0x1b, 0x45, 0x00]);         // bold off
    const lf     = Buffer.from("\n");
    const cut    = Buffer.concat([GS, Buffer.from("V"), Buffer.from([66, 3])]); // partial cut

    const lines = Buffer.concat([
      init,
      center,
      bold, Buffer.from(String(title).toUpperCase(), "utf8"), boldOff, lf, lf,
      normal, Buffer.from(new Date().toLocaleString(), "utf8"), lf, lf,
      Buffer.from("If you can read this, ESC/POS works ✅", "utf8"), lf, lf,
      cut
    ]);

    // Reuse existing raw sender in this router file:
    await sendRawToPrinter({ host, port: Number(port) || 9100, data: lines });
    res.json({ ok: true });
  } catch (err) {
    console.error("print-test failed:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

module.exports = router;
