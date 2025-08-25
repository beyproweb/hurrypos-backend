// bridge/local-print-bridge.js
const express = require("express");
const cors = require("cors");
const net = require("net");
const os = require("os");

const app = express();
app.use(cors()); // allow browser fetch from POS
app.use(express.json());

// Allow Private Network Access (HTTPS site -> http://127.0.0.1 requests)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Private-Network", "true"); // Chrome PNA
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  next();
});

// Handle preflight quickly
app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.sendStatus(204);
});

const DEFAULT_HTTP_PORT = 7777;
// Common printer service ports:
// 9100..9102  -> JetDirect RAW (ESC/POS & many LAN printers)
// 515        -> LPD
// 631        -> IPP
const DEFAULT_DISCOVER_PORTS = [9100, 9101, 9102, 515, 631];

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
      // If we can connect, assume the port is open
      finish(true);
    });
  });
}

// --- endpoints ---
app.get("/ping", (_req, res) => res.json({ ok: true, bridge: "beypro", ts: Date.now() }));

// Print raw ESC/POS (or text) to a host:port
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

/**
 * Probe a single host across multiple ports.
 * GET /probe?host=192.168.123.100&ports=9100,515,631&timeoutMs=800
 * -> { ok:true, host, open:[{port}], closed:[{port, error}] }
 */
app.get("/probe", async (req, res) => {
  try {
    const host = (req.query.host || "").trim();
    if (!host) return res.status(400).json({ error: "host is required" });
    const timeoutMs = Math.min(5000, Number(req.query.timeoutMs) || 800);
    const ports = String(req.query.ports || "")
      .split(",")
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n) && n > 0);
    const portList = ports.length ? ports : DEFAULT_DISCOVER_PORTS;

    const checks = await Promise.all(portList.map(p => tryConnect(host, p, timeoutMs)));
    const open = checks.filter(r => r.ok).map(r => ({ port: r.port }));
    const closed = checks.filter(r => !r.ok).map(r => ({ port: r.port, error: r.error }));
    res.json({ ok: true, host, open, closed });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * Discover printers on LAN by scanning base.X from start..end across MULTIPLE ports.
 * Example:
 *   /discover?base=192.168.123&start=1&end=254&ports=9100,9101,515,631&timeoutMs=600&concurrency=64
 * Response:
 *   { ok:true, base, ports:[...], results:[ {host, ports:[9100,515]} ] }
 */
app.get("/discover", async (req, res) => {
  const base = (req.query.base || getLocalBase()).trim(); // e.g. "192.168.123"
  const start = Math.max(1, Number(req.query.start) || 1);
  const end = Math.min(254, Number(req.query.end) || 254);
  const timeoutMs = Math.min(5000, Number(req.query.timeoutMs) || 600);
  const concurrency = Math.min(128, Number(req.query.concurrency) || 48);

  // Parse ports list (comma-separated); fallback to defaults
  const portsParsed = String(req.query.ports || "")
    .split(",")
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0);
  const portList = portsParsed.length ? portsParsed : DEFAULT_DISCOVER_PORTS;

  const hosts = [];
  for (let i = start; i <= end; i++) hosts.push(`${base}.${i}`);

  // Queue of (host, port) pairs to test
  const tasks = [];
  for (const h of hosts) {
    for (const p of portList) tasks.push({ host: h, port: p });
  }

  const byHost = new Map();
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      const { host, port } = tasks[i];
      const r = await tryConnect(host, port, timeoutMs);
      if (r.ok) {
        if (!byHost.has(host)) byHost.set(host, new Set());
        byHost.get(host).add(port);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  // Build results array sorted by IP
  const results = Array.from(byHost.entries())
    .map(([host, portsSet]) => ({ host, ports: Array.from(portsSet).sort((a, b) => a - b) }))
    .sort((a, b) => a.host.localeCompare(b.host));

  res.json({ ok: true, base, ports: portList, results });
});

app.listen(DEFAULT_HTTP_PORT, () => {
  console.log(`Beypro Bridge listening on http://127.0.0.1:${DEFAULT_HTTP_PORT}`);
});
