// local-print-bridge.js — Beypro Bridge (USB + LAN + Windows Spooler)
// Cross‑platform helper to talk to thermal printers from localhost:7777
// Features:
//  - /ping (with version)
//  - /usb/list, /usb/print-test, /usb/print-raw  (USB‑Serial ESC/POS)
//  - /print-raw (LAN RAW :9100)
//  - /spooler/list, /spooler/print-test, /spooler/print-raw (Windows installed printers, raw ESC/POS)

const express = require("express");
const cors = require("cors");
const net = require("net");
const os = require("os");
const { spawn } = require("child_process");

const PORT = 7777;
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// --- USB support (graceful if not installed) ---
let SerialPort, listSerialPorts;
try {
  const sp = require("serialport");
  SerialPort = sp.SerialPort || sp;
  listSerialPorts = sp.list;
  console.log("[Bridge] USB enabled");
} catch (e) {
  console.warn("[Bridge] USB disabled — run: npm i serialport@12");
}

// ----------------------------- Helpers -----------------------------
function escposTestBuffer(title = "Beypro Test") {
  const ESC = Buffer.from([0x1b]);
  const GS = Buffer.from([0x1d]);
  const init = Buffer.from([0x1b, 0x40]);
  const center = Buffer.from([0x1b, 0x61, 0x01]);
  const normal = Buffer.from([0x1b, 0x21, 0x00]);
  const bold = Buffer.from([0x1b, 0x45, 0x01]);
  const boldOff = Buffer.from([0x1b, 0x45, 0x00]);
  const lf = Buffer.from("\n");
  const cut = Buffer.concat([GS, Buffer.from("V"), Buffer.from([66, 3])]);
  return Buffer.concat([
    init, center,
    bold, Buffer.from(String(title).toUpperCase(), "utf8"), boldOff, lf, lf,
    normal, Buffer.from(new Date().toLocaleString(), "utf8"), lf, lf,
    Buffer.from("Bridge OK ✅", "utf8"), lf, lf,
    cut
  ]);
}

function toEscposBuffer(content) {
  const GS = Buffer.from([0x1d]);
  const init = Buffer.from([0x1b, 0x40]);
  const lf = Buffer.from("\n");
  const cut = Buffer.concat([GS, Buffer.from("V"), Buffer.from([66, 3])]);
  const payload = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  return Buffer.concat([init, payload, lf, lf, cut]);
}

// ------------------------------- Routes ------------------------------
app.get("/ping", (_req, res) => {
  res.json({ ok: true, bridge: "beypro", version: "usb-lan-spooler-2025-09-05", platform: process.platform, ts: Date.now() });
});

// ---------- USB (Serial) ----------
app.get("/usb/list", async (_req, res) => {
  try {
    if (!listSerialPorts) return res.status(501).json({ error: "USB not installed. npm i serialport@12" });
    const ports = await listSerialPorts();
    const mapped = ports.map(p => ({
      path: p.path,
      manufacturer: p.manufacturer || null,
      serialNumber: p.serialNumber || null,
      vendorId: p.vendorId || null,
      productId: p.productId || null,
      friendlyName: [p.manufacturer, p.serialNumber].filter(Boolean).join(" ") || null,
    }));
    res.json({ ok: true, ports: mapped });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post("/usb/print-raw", async (req, res) => {
  try {
    if (!SerialPort) return res.status(501).json({ error: "USB not installed. npm i serialport@12" });
    const { path, baudRate = 9600, content } = req.body || {};
    if (!path || !content) return res.status(400).json({ error: "path and content are required" });
    const buf = toEscposBuffer(content);
    const port = new SerialPort({ path, baudRate, autoOpen: false });
    await new Promise((ok, err) => port.open(e => e ? err(e) : ok()));
    await new Promise((ok, err) => port.write(buf, e => e ? err(e) : ok()));
    await new Promise(ok => port.drain(() => ok()));
    await new Promise(ok => port.close(() => ok()));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post("/usb/print-test", async (req, res) => {
  try {
    if (!SerialPort) return res.status(501).json({ error: "USB not installed. npm i serialport@12" });
    const { path, baudRate = 9600, title = "Beypro USB Test" } = req.body || {};
    if (!path) return res.status(400).json({ error: "path is required" });
    const buf = escposTestBuffer(title);
    const port = new SerialPort({ path, baudRate, autoOpen: false });
    await new Promise((ok, err) => port.open(e => e ? err(e) : ok()));
    await new Promise((ok, err) => port.write(buf, e => e ? err(e) : ok()));
    await new Promise(ok => port.drain(() => ok()));
    await new Promise(ok => port.close(() => ok()));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- LAN RAW :9100 ----------
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

app.post("/print-raw", async (req, res) => {
  try {
    const { host, port = 9100, content } = req.body || {};
    if (!host || !content) return res.status(400).json({ error: "host and content are required" });
    const buf = toEscposBuffer(content);
    await sendRawToLan({ host, port: Number(port) || 9100, data: buf });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- Windows Spooler (installed printers, raw ESC/POS) ----------
function runPS(script, args = []) {
  return new Promise((resolve, reject) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", script, ...args], { windowsHide: true });
    let out = "", err = "";
    ps.stdout.on("data", d => out += d.toString());
    ps.stderr.on("data", d => err += d.toString());
    ps.on("close", code => code === 0 ? resolve(out.trim()) : reject(new Error(err || `PowerShell exited ${code}`)));
  });
}

const RAW_PRINTER_HELPER = `
Add-Type -Language CSharp @"
using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles; using System.Text;
public class RawPrinterHelper {
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA { public int pDocName; public int pOutputFile; public int pDataType; }
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int Level, [In] ref DOCINFOA pDocInfo);
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  public static bool SendBytesToPrinter(string szPrinterName, byte[] pBytes) {
    IntPtr hPrinter; IntPtr pUnmanagedBytes; int dwWritten = 0;
    if (!OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) return false;
    DOCINFOA di = new DOCINFOA();
    di.pDocName = Marshal.StringToHGlobalAnsi("Beypro Raw").ToInt32();
    di.pOutputFile = IntPtr.Zero.ToInt32();
    di.pDataType = Marshal.StringToHGlobalAnsi("RAW").ToInt32();
    if (!StartDocPrinter(hPrinter, 1, ref di)) { ClosePrinter(hPrinter); return false; }
    if (!StartPagePrinter(hPrinter)) { EndDocPrinter(hPrinter); ClosePrinter(hPrinter); return false; }
    pUnmanagedBytes = Marshal.AllocCoTaskMem(pBytes.Length);
    Marshal.Copy(pBytes, 0, pUnmanagedBytes, pBytes.Length);
    bool ok = WritePrinter(hPrinter, pUnmanagedBytes, pBytes.Length, out dwWritten);
    Marshal.FreeCoTaskMem(pUnmanagedBytes);
    EndPagePrinter(hPrinter); EndDocPrinter(hPrinter); ClosePrinter(hPrinter);
    return ok;
  }
}
"@
`;

app.get("/spooler/list", async (req, res) => {
  if (process.platform !== "win32") return res.status(501).json({ error: "Windows only" });
  try {
    const list = await runPS("Get-Printer | Select-Object Name,ShareName,PortName,DriverName | ConvertTo-Json");
    const json = JSON.parse(list);
    res.json({ ok: true, printers: Array.isArray(json) ? json : [json] });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post("/spooler/print-raw", async (req, res) => {
  if (process.platform !== "win32") return res.status(501).json({ error: "Windows only" });
  try {
    const { printerName, content } = req.body || {};
    if (!printerName || !content) return res.status(400).json({ error: "printerName and content are required" });
    const buf = toEscposBuffer(content);
    const b64 = buf.toString("base64");
    const script = `
${RAW_PRINTER_HELPER}
$bytes = [Convert]::FromBase64String('${b64}')
[RawPrinterHelper]::SendBytesToPrinter('${printerName.replace(/'/g, "''")}', $bytes) | Out-Null
`;
    await runPS(script);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post("/spooler/print-test", async (req, res) => {
  if (process.platform !== "win32") return res.status(501).json({ error: "Windows only" });
  try {
    const { printerName, title = "Beypro Spooler Test" } = req.body || {};
    if (!printerName) return res.status(400).json({ error: "printerName is required" });
    const buf = escposTestBuffer(title);
    const b64 = buf.toString("base64");
    const script = `
${RAW_PRINTER_HELPER}
$bytes = [Convert]::FromBase64String('${b64}')
[RawPrinterHelper]::SendBytesToPrinter('${printerName.replace(/'/g, "''")}', $bytes) | Out-Null
`;
    await runPS(script);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ------------------------------ Start ------------------------------
app.listen(PORT, () => {
  console.log(`Beypro Bridge listening on http://127.0.0.1:${PORT}`);
});
