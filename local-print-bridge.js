// bridge/local-print-bridge.js
const express = require("express");
const cors = require("cors");
const net = require("net");
const os = require("os");
const { spawn } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json());
// at top with other requires:
const path = require("path");



/**
 * POST /assist/fix-printer
 * Body: { printerHost: "192.168.123.100", adapterAlias?: "Ethernet", tempIp?: "192.168.123.50" }
 * Launches tools/fix-printer-ip.ps1 with elevation (UAC prompt).
 * - The script handles: add temp IP -> open web UI -> wait -> cleanup.
 */
app.post("/assist/fix-printer", (req, res) => {
  try {
    if (process.platform !== "win32") {
      return res.status(400).json({ error: "Windows only operation." });
    }
    const printerHost = String(req.body?.printerHost || "").trim();
    const adapterAlias = req.body?.adapterAlias ? String(req.body.adapterAlias) : null;
    const tempIp = req.body?.tempIp ? String(req.body.tempIp) : null;

    if (!printerHost) {
      return res.status(400).json({ error: "printerHost is required" });
    }

    // script path (bundled next to bridge exe, under /tools)
    const scriptPath = path.join(__dirname, "tools", "fix-printer-ip.ps1");

    // Build argument list for elevated PowerShell:
    // We use Start-Process -Verb RunAs to trigger UAC elevation and pass our args through.
    const psCommandPieces = [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command",
      // Escape quotes carefully for Windows PowerShell
      `Start-Process powershell -Verb RunAs -ArgumentList `
      + `'\"-NoProfile\",\"-ExecutionPolicy\",\"Bypass\",\"-File\",\"${scriptPath}\",\"-PrinterHost\",\"${printerHost}\"`
      + (adapterAlias ? `,\"-AdapterAlias\",\"${adapterAlias}\"` : "")
      + (tempIp ? `,\"-TempIp\",\"${tempIp}\"` : "")
      + `,\"-PrefixLength\",\"24\"'`
    ];

    const child = spawn("powershell.exe", psCommandPieces, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => {
      return res.status(500).json({ error: "Failed to launch PowerShell.", details: String(e) });
    });
    child.on("close", (code) => {
      if (code === 0) {
        return res.json({ ok: true, launched: true, scriptPath, printerHost, adapterAlias, tempIp });
      } else {
        // Note: When elevation prompts, parent often closes with 0/1 regardless of user action.
        return res.json({ ok: true, launched: true, note: "UAC prompt should have appeared. Complete steps in the PowerShell window.", scriptPath, printerHost });
      }
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

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

function ipBase(ip) {
  const parts = String(ip || "").trim().split(".");
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

function makeTempIPFromPrinter(printerIp) {
  const base = ipBase(printerIp);
  if (!base) return null;
  // Pick a safe-looking host .50 by default
  return `${base}.50`;
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
    const hostBase = ipBase(host);
    const sameSubnet = primaryBase ? (hostBase === primaryBase) : null;

    res.json({ ok: true, host, open, closed, sameSubnet, primaryBase });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * Discover printers:
 * - Default: scans ONLY the primary interface's /24 (fast)
 * - If all=1: scan all local IPv4 /24 subnets
 *
 * GET /discover
 * GET /discover?all=1
 *  Optional: &ports=9100,9101,515,631&timeoutMs=600&concurrency=64
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

/* ---------------- Assisted Subnet (Windows) ----------------
   These endpoints help non-technical users when a printer is on a different subnet:
   - /assist/subnet/add    -> add a temporary secondary IP (e.g. 192.168.123.50)
   - /assist/subnet/cleanup-> remove the temporary IP
   - /assist/subnet/open   -> open the printer web UI in default browser
-------------------------------------------------------------- */

/**
 * POST /assist/subnet/add
 * Body: { printerHost: "192.168.123.100", adapterAlias?: "Ethernet", tempIp?: "192.168.123.50", prefixLength?: 24 }
 * Notes: Windows only; requires running the bridge with Administrator rights.
 */
app.post("/assist/subnet/add", async (req, res) => {
  try {
    if (process.platform !== "win32") {
      return res.status(400).json({ error: "This assisted operation is only available on Windows." });
    }

    const { printerHost } = req.body || {};
    if (!printerHost) return res.status(400).json({ error: "printerHost is required" });

    const printerBase = ipBase(printerHost);
    if (!printerBase) return res.status(400).json({ error: "Invalid printerHost" });

    const adapters = listIPv4Interfaces();
    const primary = getPrimaryIPv4();
    if (!primary) return res.status(500).json({ error: "No active IPv4 interface found" });

    const prefixLength = Number(req.body?.prefixLength) || 24;
    const adapterAlias = String(req.body?.adapterAlias || primary.name);
    const tempIp = String(req.body?.tempIp || makeTempIPFromPrinter(printerHost));

    if (!tempIp) return res.status(400).json({ error: "Could not compute temp IP from printerHost" });

    // Run PowerShell: New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 192.168.123.50 -PrefixLength 24
    const ps = `New-NetIPAddress -InterfaceAlias "${adapterAlias}" -IPAddress ${tempIp} -PrefixLength ${prefixLength}`;
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { windowsHide: true });

    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      if (code === 0) {
        return res.json({ ok: true, adapterAlias, tempIp, prefixLength, note: "Temporary IP added. Now open the printer UI and switch it to DHCP." });
      } else {
        return res.status(500).json({
          error: "Failed to add temporary IP. Try running the bridge as Administrator.",
          details: stderr.trim(),
          adapterAlias, tempIp, prefixLength
        });
      }
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * POST /assist/subnet/cleanup
 * Body: { adapterAlias?: "Ethernet", tempIp: "192.168.123.50" }
 * Remove the previously added temp IP.
 */
app.post("/assist/subnet/cleanup", async (req, res) => {
  try {
    if (process.platform !== "win32") {
      return res.status(400).json({ error: "This assisted operation is only available on Windows." });
    }

    const primary = getPrimaryIPv4();
    const adapterAlias = String(req.body?.adapterAlias || primary?.name || "");
    const tempIp = String(req.body?.tempIp || "");

    if (!adapterAlias || !tempIp) return res.status(400).json({ error: "adapterAlias and tempIp are required" });

    const ps = `Remove-NetIPAddress -InterfaceAlias "${adapterAlias}" -IPAddress ${tempIp} -Confirm:$false`;
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { windowsHide: true });

    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      if (code === 0) {
        return res.json({ ok: true, adapterAlias, tempIp, note: "Temporary IP removed." });
      } else {
        return res.status(500).json({
          error: "Failed to remove temporary IP. Try running the bridge as Administrator.",
          details: stderr.trim(),
          adapterAlias, tempIp
        });
      }
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * POST /assist/subnet/open
 * Body: { printerHost: "192.168.123.100" }
 * Opens the printer web UI in the default browser.
 */
app.post("/assist/subnet/open", (req, res) => {
  try {
    const { printerHost } = req.body || {};
    if (!printerHost) return res.status(400).json({ error: "printerHost is required" });
    const url = `http://${printerHost}`;

    // Windows 'start', macOS 'open', Linux 'xdg-open'
    let cmd, args;
    if (process.platform === "win32") {
      cmd = "cmd"; args = ["/c", "start", "", url];
    } else if (process.platform === "darwin") {
      cmd = "open"; args = [url];
    } else {
      cmd = "xdg-open"; args = [url];
    }

    const child = spawn(cmd, args, { windowsHide: true, detached: true, stdio: "ignore" });
    child.unref();

    res.json({ ok: true, url });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(DEFAULT_HTTP_PORT, () => {
  console.log(`Beypro Bridge listening on http://127.0.0.1:${DEFAULT_HTTP_PORT}`);
});
