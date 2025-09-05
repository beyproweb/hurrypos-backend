// routes/lan-printers.js — minimal LAN (TCP 9100) router for the web API
const router = require("express").Router();
const net = require("net");

// ESC/POS helpers
function toEscposBuffer(content) {
  const GS = Buffer.from([0x1d]);
  const init = Buffer.from([0x1b, 0x40]);
  const lf = Buffer.from("\n");
  const cut = Buffer.concat([GS, Buffer.from("V"), Buffer.from([66, 3])]);
  const payload = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  return Buffer.concat([init, payload, lf, lf, cut]);
}

function sendRawToLan({ host, port = 9100, data, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;
    const fail = (err) => { if (done) return; done = true; try { socket.destroy(); } catch {}; reject(err || new Error("Print failed")); };
    const ok = () => { if (done) return; done = true; try { socket.end(); } catch {}; resolve(); };
    socket.setTimeout(timeoutMs, () => fail(new Error("Printer timeout")));
    socket.once("error", fail);
    socket.connect(port, host, () => {
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
      socket.write(payload, (err) => {
        if (err) return fail(err);
        socket.once("close", ok);
        socket.end();
      });
    });
  });
}

// Simple health
router.get("/ping", (_req, res) => res.json({ ok: true, role: "lan-router" }));

// Print raw over TCP 9100
router.post("/print-raw", async (req, res) => {
  try {
    const { host, port = 9100, content } = req.body || {};
    if (!host || !content) return res.status(400).json({ error: "host and content are required" });
    const buf = toEscposBuffer(content);
    await sendRawToLan({ host, port: Number(port) || 9100, data: buf });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

module.exports = router;
