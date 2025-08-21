// bridge/local-print-bridge.js
// Start manually: ./beypro-bridge (after build) or: node local-print-bridge.js
const express = require("express");
const cors = require("cors");
const net = require("net");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

function sendRawToPrinter({ host, port = 9100, data, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;
    const fail = (err) => { if (done) return; done = true; try { socket.destroy(); } catch {} reject(err || new Error("Print failed")); };
    const ok   = () => { if (done) return; done = true; try { socket.end(); } catch {} resolve(); };

    socket.setTimeout(timeoutMs, () => fail(new Error("Printer timeout")));
    socket.once("error", fail);
    socket.connect(port, host, () => {
      const ESC = Buffer.from([0x1b]);
      const GS  = Buffer.from([0x1d]);
      const init = Buffer.from([0x1b, 0x40]); // ESC @
      const lf   = Buffer.from("\n");
      const cut  = Buffer.concat([GS, Buffer.from("V", "ascii"), Buffer.from([66, 3])]); // partial cut
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
      const toSend = Buffer.concat([init, payload, lf, lf, cut]);
      socket.write(toSend, (err) => { if (err) return fail(err); socket.once("close", ok); socket.end(); });
    });
  });
}

app.get("/ping", (_req, res) => res.json({ ok: true, bridge: "beypro", port: process.env.PORT || 7777 }));

app.post("/print-raw", async (req, res) => {
  try {
    const { host, port = 9100, content } = req.body || {};
    if (!host || !content) return res.status(400).json({ error: "host and content are required" });
    await sendRawToPrinter({ host, port: Number(port) || 9100, data: content });
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Local LAN print failed:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 7777;
app.listen(PORT, () => console.log(`🖨️ Beypro Bridge on http://127.0.0.1:${PORT}`));
