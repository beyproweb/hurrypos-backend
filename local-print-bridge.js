// bridge/local-print-bridge.js
const express = require("express");
const cors = require("cors");
const net = require("net");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------------- Fix-Script Resolver & Embed ---------------------- */
/**
 * Tries common locations for fix-printer-ip.ps1. If not found, writes an
 * embedded copy into the system temp folder and returns that path.
 */
function resolveOrWriteFixScript() {
  const filename = "fix-printer-ip.ps1";
  const candidates = [
    path.join(__dirname, "tools", filename),                      // next to JS/EXE
    path.join(process.cwd(), "bridge", "tools", filename),        // repo: bridge/tools
    path.join(process.cwd(), "tools", filename),                   // repo: tools
    path.join(path.dirname(process.execPath), "tools", filename),  // alongside packaged exe (pkg)
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  // Not found on disk — write to temp:
  const tmp = path.join(os.tmpdir(), filename);
  try {
    fs.writeFileSync(tmp, FIX_PRINTER_PS1, "utf8");
    return tmp;
  } catch {
    return null;
  }
}

// Embedded PowerShell script (safe to run elevated). If you keep a real file
// at bridge/tools/fix-printer-ip.ps1 it will be preferred over this string.
const FIX_PRINTER_PS1 = `
<#
.SYNOPSIS
  Temporarily add a secondary IP on Windows so you can reach a LAN receipt printer
  stuck on a different subnet (e.g., 192.168.123.100), open its web UI, switch it
  to DHCP (or set a proper static in your main LAN), then remove the temp IP.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\\fix-printer-ip.ps1 -PrinterHost 192.168.123.100
#>

param(
  [Parameter(Mandatory=$false)][string]$PrinterHost = "192.168.123.100",
  [Parameter(Mandatory=$false)][string]$AdapterAlias,
  [Parameter(Mandatory=$false)][string]$TempIp,
  [Parameter(Mandatory=$false)][int]$PrefixLength = 24
)

function Write-Info($msg){ Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-OK($msg){ Write-Host "[ OK ] $msg" -ForegroundColor Green }
function Write-Err($msg){ Write-Host "[ERR] $msg" -ForegroundColor Red }

# --- Ensure admin ---
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)){
  Write-Info "Re-launching with Administrator rights…"
  $psi = @{
    FilePath = "powershell.exe"
    ArgumentList = "-NoProfile","-ExecutionPolicy","Bypass","-File",$PSCommandPath,"-PrinterHost",$PrinterHost
    Verb = "RunAs"
  }
  if($AdapterAlias){ $psi.ArgumentList += @("-AdapterAlias",$AdapterAlias) }
  if($TempIp){ $psi.ArgumentList += @("-TempIp",$TempIp) }
  $psi.ArgumentList += @("-PrefixLength",$PrefixLength)
  Start-Process @psi
  exit
}

# --- Helpers ---
function Get-PrimaryIPv4Adapter {
  if($AdapterAlias){
    $a = Get-NetAdapter -Name $AdapterAlias -ErrorAction SilentlyContinue
    if($a -and $a.Status -eq "Up"){ return $a }
    Write-Err "Adapter '$AdapterAlias' not found or not Up."
    exit 1
  }
  # Prefer adapter with a default gateway (active internet)
  $cfg = Get-NetIPConfiguration | Where-Object { $_.IPv4Address -and $_.IPv4DefaultGateway } | Select-Object -First 1
  if($cfg){ return (Get-NetAdapter -InterfaceIndex $cfg.InterfaceIndex) }
  # Fallback: first Up adapter with IPv4
  $a2 = Get-NetAdapter | Where-Object { $_.Status -eq "Up" } | Select-Object -First 1
  return $a2
}

function Get-SubnetBase([string]$ip){
  $parts = $ip.Split("."); if($parts.Length -ne 4){ return $null }
  return ("{0}.{1}.{2}" -f $parts[0],$parts[1],$parts[2])
}

function Pick-TempIp([string]$printerHost){
  if($TempIp){ return $TempIp }
  $base = Get-SubnetBase $printerHost
  if(-not $base){ Write-Err "Invalid PrinterHost '$printerHost'"; exit 1 }
  $candidates = 50..99 | ForEach-Object { "$base.$_" }
  foreach($ip in $candidates){
    $used = (Get-NetIPAddress -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $ip })
    if(-not $used){
      # quick ping check; if already responds, skip
      if(-not (Test-Connection -Quiet -Count 1 -TimeoutSeconds 1 -ErrorAction SilentlyContinue $ip)){
        return $ip
      }
    }
  }
  Write-Err "Couldn't find a free temp IP on $base. Try specifying -TempIp manually."
  exit 1
}

# --- Begin ---
Write-Info "Target printer: $PrinterHost"
$primary = Get-PrimaryIPv4Adapter
if(-not $primary){ Write-Err "No active IPv4 adapter found."; exit 1 }
Write-OK "Using adapter: $($primary.Name)"

$chosenTemp = Pick-TempIp $PrinterHost
Write-Info "Temporary IP candidate: $chosenTemp/$PrefixLength"

# Add temp IP
try{
  New-NetIPAddress -InterfaceAlias $primary.Name -IPAddress $chosenTemp -PrefixLength $PrefixLength -ErrorAction Stop | Out-Null
  Write-OK "Added secondary IP $chosenTemp to '$($primary.Name)'"
}catch{
  Write-Err "Failed to add temp IP: $($_.Exception.Message)"
  Write-Err "If this persists, ensure PowerShell is running as Administrator."
  exit 1
}

# Try connectivity to the printer host management port
try{
  $test = Test-NetConnection -ComputerName $PrinterHost -Port 80 -WarningAction SilentlyContinue
  if($test.TcpTestSucceeded){
    Write-OK "Port 80 reachable — opening printer web UI…"
  }else{
    Write-Info "Port 80 not reachable (some models use other mgmt ports). Will try to open HTTP anyway."
  }
}catch{}

# Open browser to printer UI
Start-Process ("http://{0}" -f $PrinterHost) | Out-Null
Write-Info "In the printer web UI, set IP mode to DHCP (recommended) or assign a static in your main LAN."
Write-Info "After saving & rebooting the printer, press ENTER here to remove the temp IP."
[void][System.Console]::ReadLine()

# Cleanup temp IP
try{
  Remove-NetIPAddress -InterfaceAlias $primary.Name -IPAddress $chosenTemp -Confirm:$false -ErrorAction Stop
  Write-OK "Removed temporary IP $chosenTemp from '$($primary.Name)'"
}catch{
  Write-Err "Failed to remove temp IP: $($_.Exception.Message)"
  Write-Info ("You can remove it later with:  Remove-NetIPAddress -InterfaceAlias ""{0}"" -IPAddress {1} -Confirm:$false" -f $primary.Name, $chosenTemp)
}

Write-OK "Done. Now the printer should be on your main LAN (same subnet as the PC)."
Write-Info "Tip: In Beypro, click 'Find Printers' and then 'Test Print'."
`;

/* ----------------------------- Net Helpers ------------------------------ */

const DEFAULT_HTTP_PORT = 7777;
const DEFAULT_DISCOVER_PORTS = [9100, 9101, 9102, 515, 631];

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

function ipBase(ip) {
  const parts = String(ip || "").trim().split(".");
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

function makeTempIPFromPrinter(printerIp) {
  const base = ipBase(printerIp);
  if (!base) return null;
  return `${base}.50`;
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

/* ------------------------ CORS / Private Network ------------------------ */

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

/* -------------------------------- Routes -------------------------------- */

// Health
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

// POST /assist/subnet/add
app.post("/assist/subnet/add", async (req, res) => {
  try {
    if (process.platform !== "win32") {
      return res.status(400).json({ error: "This assisted operation is only available on Windows." });
    }

    const { printerHost } = req.body || {};
    if (!printerHost) return res.status(400).json({ error: "printerHost is required" });

    const primary = getPrimaryIPv4();
    if (!primary) return res.status(500).json({ error: "No active IPv4 interface found" });

    const prefixLength = Number(req.body?.prefixLength) || 24;
    const adapterAlias = String(req.body?.adapterAlias || primary.name);
    const tempIp = String(req.body?.tempIp || makeTempIPFromPrinter(printerHost));
    if (!tempIp) return res.status(400).json({ error: "Could not compute temp IP from printerHost" });

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

// POST /assist/subnet/cleanup
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

// POST /assist/subnet/open
app.post("/assist/subnet/open", (req, res) => {
  try {
    const { printerHost } = req.body || {};
    if (!printerHost) return res.status(400).json({ error: "printerHost is required" });
    const url = `http://${printerHost}`;

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

/**
 * POST /assist/fix-printer
 * Body: { printerHost: "192.168.123.100", adapterAlias?: "Ethernet", tempIp?: "192.168.123.50" }
 * Launches fix-printer-ip.ps1 with elevation (UAC prompt). If the script file
 * isn't present on disk, it will be written to a temp file first.
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

    const scriptPath = resolveOrWriteFixScript();
    if (!scriptPath) {
      return res.status(500).json({ error: "Could not locate or write fix-printer-ip.ps1" });
    }

    // Elevate and run the script
    const psCommandPieces = [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command",
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
    child.on("close", (_code) => {
      // The parent often exits regardless of user action in the elevated shell.
      return res.json({ ok: true, launched: true, scriptPath, printerHost, adapterAlias, tempIp });
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/* ------------------------------- Listener -------------------------------- */

app.listen(DEFAULT_HTTP_PORT, () => {
  console.log(`Beypro Bridge listening on http://127.0.0.1:${DEFAULT_HTTP_PORT}`);
});
