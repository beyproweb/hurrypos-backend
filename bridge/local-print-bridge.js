// bridge/local-print-bridge.js
const express = require("express");
const cors = require("cors");
const net = require("net");
const os = require("os");

const app = express();
app.use(cors()); // allow browser fetch from POS
app.use(express.json());

const DEFAULT_PORT = 7777;

// --- helpers ---
function getLocalBase() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        const parts = iface.address.split(".");
        if (parts.length === 4) return parts.slice(0, 3).join(".");
      }
    }
  }
  return "192.168.1";
}

function tryConnect(host, port = 9100, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (ok, error) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve({ ok, host, port, error });
    };

    socket.setTimeout(timeoutMs, () => finish(false, "timeout"));
    socket.once("error", (e) => finish(false, String(e.code || e.message || e)));
    socket.connect(port, host, () => {
      // If we can connect, assume JetDirect RAW is present
      finish(true);
    });
  });
}

// --- endpoints ---
app.get("/ping", (_req, res) => res.json({ ok: true, bridge: "beypro", ts: Date.now() }));

app.post("/print-raw", async (req, res) => {
  try {
    const { host, port = 9100, content, timeoutMs = 15000 } = req.body || {};
    if (!host || !content) return res.status(400).json({ error: "host and content are required" });

    const socket = new net.Socket();
    await new Promise((resolve, reject) => {
      let done = false;
      const fail = (err) => { if (!done) { done = true; try { socket.destroy(); } catch {} reject(err); } };
      const ok = () => { if (!done) { done = true; try { socket.end(); } catch {} resolve(); } };

      socket.setTimeout(timeoutMs, () => fail(new Error(`Printer timeout after ${timeoutMs}ms`)));
      socket.setNoDelay(true);
      socket.once("error", fail);
      socket.connect(Number(port) || 9100, host, () => {
        const ESC = Buffer.from([0x1b]);
        const GS = Buffer.from([0x1d]);
        const init = Buffer.from([0x1b, 0x40]); // ESC @
        const lf = Buffer.from("\n");
        const cut = Buffer.concat([GS, Buffer.from("V"), Buffer.from([66, 3])]);

        const payload = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
        const toSend = Buffer.concat([init, payload, lf, lf, cut]);

        socket.write(toSend, (err) => {
          if (err) return fail(err);
          socket.once("close", ok);
          socket.end();
        });
      });
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// NEW: discover printers on LAN by scanning base.X from start..end for port 9100
app.get("/discover", async (req, res) => {
  const port = Number(req.query.port) || 9100;
  const base = (req.query.base || getLocalBase()).trim();    // e.g. "192.168.1"
  const start = Math.max(1, Number(req.query.start) || 1);
  const end = Math.min(254, Number(req.query.end) || 254);
  const timeoutMs = Math.min(5000, Number(req.query.timeoutMs) || 600);
  const concurrency = Math.min(64, Number(req.query.concurrency) || 48);

  const hosts = [];
  for (let i = start; i <= end; i++) hosts.push(`${base}.${i}`);

  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < hosts.length) {
      const i = idx++;
      const host = hosts[i];
      const r = await tryConnect(host, port, timeoutMs);
      if (r.ok) results.push({ host, port });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  results.sort((a, b) => a.host.localeCompare(b.host));
  res.json({ ok: true, base, port, results });
});

app.listen(DEFAULT_PORT, () => {
  console.log(`Beypro Bridge listening on http://127.0.0.1:${DEFAULT_PORT}`);
});
