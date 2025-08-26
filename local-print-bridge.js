// bridge/local-print-bridge.js
const express = require("express");
const cors = require("cors");
const net = require("net");
const os = require("os");

const app = express();
app.use(cors());
app.use(express.json());

// Allow Private Network Access (HTTPS site -> http://127.0.0.1 requests)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  next();
});

app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.sendStatus(204);
});

const DEFAULT_HTTP_PORT = 7777;
// Common printer service ports
const DEFAULT_DISCOVER_PORTS = [9100, 9101, 9102, 515, 631];

/* ----------------------------- Net Helpers ----------------------------- */

function listIPv4Interfaces() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i && i.family === "IPv4" && !i.internal) {
        const octets = i.address.split(".");
        if (octets.length === 4) {
          out.push({
            name,
            address: i.address,
            netmask: i.netmask,
            base: `${octets[0]}.${octets[1]}.${octets[2]}`, // assume /24 for scan speed
          });
        }
      }
    }
  }
  return out;
}

// Heuristic "primary" = first active IPv4
function getPrimaryIPv4() {
  const list = listIPv4Interfaces();
  return list[0] || null;
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
    socket.connect(port, host, () => finish(true));
  });
}

/* ------------------------------ Endpoints ------------------------------ */

app.get("/ping", (_req, res) => res.json({
  ok: true,
  bridge: "beypro",
  ts: Date.now(),
  interfaces: listIPv4Interfaces()
}));

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
 * Probe one host across multiple ports.
 * GET /probe?host=192.168.1.50&ports=9100,515,631&timeoutMs=800
 */
app.get("/probe", async (req, res) => {
  try {
    const host = (req.query.host || "").trim();
    if (!host) return res.status(400).json({ error: "host is required" });
    const timeoutMs = Math.min(5000, Number(req.query.timeoutMs) || 800);
    const ports = String(req.query.ports || "")
      .split(",").map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n) && n > 0);
    const portList = ports.length ? ports : DEFAULT_DISCOVER_PORTS;

    const checks = await Promise.all(portList.map(p => tryConnect(host, p, timeoutMs)));
    const open = checks.filter(r => r.ok).map(r => ({ port: r.port }));
    const closed = checks.filter(r => !r.ok).map(r => ({ port: r.port, error: r.error }));
    const primary = getPrimaryIPv4();
    const primaryBase = primary?.base || null;
    const hostBase = host.split(".").slice(0,3).join(".");
    const sameSubnet = primaryBase ? (hostBase === primaryBase) : null;

    res.json({ ok: true, host, open, closed, sameSubnet, primaryBase });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * Discover printers:
 * - By default scans ONLY the primary interface's /24 (fast, customer-friendly)
 * - If all=1 is provided, scans ALL local IPv4 /24 subnets
 *
 * GET /discover
 * GET /discover?all=1
 *  Optional: &ports=9100,9101,515,631&timeoutMs=600&concurrency=64
 *
 * Response:
 * {
 *   ok: true,
 *   primaryBase: "192.168.1",
 *   networks: [{name, address, base}],
 *   results: [
 *     { host, ports:[9100], base:"192.168.1", sameSubnet:true }
 *   ],
 *   subnetMismatch: true|false  // true if found hosts but none on primaryBase
 * }
 */
app.get("/discover", async (req, res) => {
  const timeoutMs = Math.min(5000, Number(req.query.timeoutMs) || 600);
  const concurrency = Math.min(128, Number(req.query.concurrency) || 48);

  // Ports
  const portsParsed = String(req.query.ports || "")
    .split(",").map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0);
  const portList = portsParsed.length ? portsParsed : DEFAULT_DISCOVER_PORTS;

  // Interfaces
  const allIfs = listIPv4Interfaces();
  const primary = getPrimaryIPv4();
  const primaryBase = primary?.base || null;

  // Decide which bases to scan
  const scanAll = String(req.query.all || "0") === "1";
  const bases = scanAll
    ? Array.from(new Set(allIfs.map(x => x.base)))
    : (primaryBase ? [primaryBase] : []);

  // Build tasks: (host, port, base)
  const tasks = [];
  for (const base of bases) {
    for (let i = 1; i <= 254; i++) {
      const host = `${base}.${i}`;
      for (const p of portList) tasks.push({ host, port: p, base });
    }
  }

  const byHost = new Map();
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      const { host, port, base } = tasks[i];
      const r = await tryConnect(host, port, timeoutMs);
      if (r.ok) {
        const entry = byHost.get(host) || { host, ports: new Set(), base };
        entry.ports.add(port);
        byHost.set(host, entry);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  const results = Array.from(byHost.values())
    .map(({ host, ports, base }) => ({
      host,
      ports: Array.from(ports).sort((a,b) => a - b),
      base,
      sameSubnet: primaryBase ? (base === primaryBase) : null
    }))
    .sort((a, b) => a.host.localeCompare(b.host));

  const subnetMismatch = results.length > 0 && results.every(r => r.sameSubnet === false);

  res.json({
    ok: true,
    primaryBase,
    networks: allIfs.map(({ name, address, base }) => ({ name, address, base })),
    results,
    subnetMismatch
  });
});

app.listen(DEFAULT_HTTP_PORT, () => {
  console.log(`Beypro Bridge listening on http://127.0.0.1:${DEFAULT_HTTP_PORT}`);
});
