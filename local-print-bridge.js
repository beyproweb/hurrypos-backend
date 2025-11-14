// local-print-bridge.js
// Beypro Local Print Bridge — cross-platform with Windows spooler fallback
// v1.0.4

const BRIDGE_VERSION = "1.0.4";

const express = require("express");
const os = require("os");
const cors = require("cors");
const bodyParser = require("body-parser");
const net = require("net");

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "5mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// ----- USB via serialport (if available) -----
let SerialPort = null;
let usbEnabled = false;
let usbReason = "not loaded";
try {
  SerialPort = require("serialport"); // v12.x
  usbEnabled = !!(SerialPort && typeof SerialPort.list === "function");
  usbReason = usbEnabled ? "ok" : "serialport loaded but no list()";
} catch (e) {
  usbEnabled = false;
  usbReason = e && e.message ? e.message : String(e);
}

// ----- Health -----
app.get("/ping", (_req, res) => {
  res.json({
    ok: true,
    bridge: "beypro",
    version: BRIDGE_VERSION,
    platform: os.platform(),
    usb: usbEnabled,
    usb_reason: usbEnabled ? "ok" : usbReason,
    ts: Date.now(),
  });
});

// ----- USB list (never 404: returns JSON error if not available) -----
app.get("/usb/list", async (_req, res) => {
  if (!usbEnabled) {
    return res
      .status(501)
      .json({ ok: false, error: "USB not available: " + usbReason });
  }
  try {
    const ports = await SerialPort.list();
    res.json({ ok: true, ports });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ----- USB print raw/test (works only if serialport is available) -----
app.post("/usb/print-raw", async (req, res) => {
  if (!usbEnabled) {
    return res
      .status(501)
      .json({ ok: false, error: "USB not available: " + usbReason });
  }
  const { path, dataBase64, baudRate = 9600 } = req.body || {};
  if (!path || !dataBase64) {
    return res
      .status(400)
      .json({ ok: false, error: "path and dataBase64 are required" });
  }
  try {
    const data = Buffer.from(dataBase64, "base64");
    const port = new SerialPort.SerialPort({ path, baudRate });
    await new Promise((resolve, reject) => {
      port.on("open", () => {
        port.write(data, (err) => {
          if (err) return reject(err);
          port.drain(() => {
            port.close(() => resolve());
          });
        });
      });
      port.on("error", reject);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/usb/print-test", async (req, res) => {
  const { path, baudRate = 9600 } = req.body || {};
  if (!usbEnabled) {
    return res
      .status(501)
      .json({ ok: false, error: "USB not available: " + usbReason });
  }
  if (!path) return res.status(400).json({ ok: false, error: "path required" });
  const bytes = Buffer.from(
    [
      0x1b, 0x40, // init
      0x1b, 0x61, 0x01, // center
    ]
      .concat([...Buffer.from("BEYPRO USB TEST\r\n", "ascii")])
      .concat([0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x42, 0x00]),
  );
  const b64 = bytes.toString("base64");
  req.body.dataBase64 = b64;
  req.body.baudRate = baudRate;
  return app._router.handle(
    { ...req, url: "/usb/print-raw", method: "POST", body: req.body },
    res,
    () => {},
  );
});

// ----- TCP (LAN) printer raw send/test -----
// POST /tcp/print-raw  { host, port?: 9100, dataBase64 }
app.post("/tcp/print-raw", (req, res) => {
  const { host, port = 9100, dataBase64 } = req.body || {};
  if (!host || !dataBase64) {
    return res.status(400).json({ ok: false, error: "host and dataBase64 are required" });
  }
  const data = Buffer.from(dataBase64, "base64");
  const socket = new net.Socket();
  let done = false;
  const finish = (ok, error) => {
    if (done) return;
    done = true;
    try { socket.destroy(); } catch {}
    if (ok) return res.json({ ok: true });
    return res.status(500).json({ ok: false, error: error || "tcp send failed" });
  };
  socket.setTimeout(3000, () => finish(false, "timeout"));
  socket.once("error", (err) => finish(false, err?.message || "socket error"));
  socket.connect(Number(port) || 9100, host, () => {
    socket.write(data, (err) => {
      if (err) return finish(false, err.message);
      socket.end(() => finish(true));
    });
  });
});

// POST /tcp/print-test { host, port?: 9100 }
app.post("/tcp/print-test", (req, res) => {
  const { host, port = 9100 } = req.body || {};
  if (!host) return res.status(400).json({ ok: false, error: "host required" });
  const bytes = Buffer.from(
    [0x1b, 0x40, 0x1b, 0x61, 0x01] // init + center
      .concat([...Buffer.from("BEYPRO TCP TEST\r\n", "ascii")])
      .concat([0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x42, 0x00]),
  );
  const dataBase64 = bytes.toString("base64");
  req.body.dataBase64 = dataBase64;
  return app._router.handle(
    { ...req, url: "/tcp/print-raw", method: "POST", body: { host, port, dataBase64 } },
    res,
    () => {},
  );
});

// ===== Windows Spooler fallback (no serialport required) =====
const { execFile, spawn } = require("child_process");

// List installed Windows printers
app.get("/win/printers", (req, res) => {
  if (os.platform() !== "win32")
    return res.status(400).json({ ok: false, error: "Windows only endpoint" });

  execFile(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json",
    ],
    { windowsHide: true },
    (err, stdout, stderr) => {
      if (err) return res.status(500).json({ ok: false, error: stderr || err.message });
      let names;
      try {
        names = JSON.parse(stdout || "[]");
      } catch {
        names = [];
      }
      if (!Array.isArray(names)) names = [names].filter(Boolean);
      res.json({ ok: true, printers: names });
    },
  );
});

// RAW print via Windows spooler
// Body: { printerName: "XP-80C", dataBase64: "<base64>" }
app.post("/win/print-raw", (req, res) => {
  if (os.platform() !== "win32")
    return res.status(400).json({ ok: false, error: "Windows only endpoint" });

  const { printerName, dataBase64 } = req.body || {};
  if (!printerName || !dataBase64) {
    return res
      .status(400)
      .json({ ok: false, error: "printerName and dataBase64 are required" });
  }

  const psScript = `
Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }

  [DllImport("winspool.Drv", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

  public static bool SendBytesToPrinter(string printerName, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printerName, out h, IntPtr.Zero)) return false;
    var di = new DOCINFOA { pDocName = "Beypro RAW", pDataType = "RAW" };
    if (!StartDocPrinter(h, 1, di)) { ClosePrinter(h); return false; }
    if (!StartPagePrinter(h))      { EndDocPrinter(h); ClosePrinter(h); return false; }
    IntPtr p = Marshal.AllocHGlobal(bytes.Length);
    Marshal.Copy(bytes, 0, p, bytes.Length);
    int written = 0;
    bool ok = WritePrinter(h, p, bytes.Length, out written);
    Marshal.FreeHGlobal(p);
    EndPagePrinter(h);
    EndDocPrinter(h);
    ClosePrinter(h);
    return ok && written == bytes.Length;
  }
}
"@
$bytes = [Convert]::FromBase64String('${dataBase64}')
$ok = [RawPrinterHelper]::SendBytesToPrinter('${printerName}', $bytes)
if ($ok) { Write-Output '{"ok":true}' } else { Write-Output '{"ok":false,"error":"WritePrinter failed"}' }
`;

  const ps = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript],
    { windowsHide: true },
  );

  let out = "",
    err = "";
  ps.stdout.on("data", (d) => (out += d.toString()));
  ps.stderr.on("data", (d) => (err += d.toString()));
  ps.on("close", () => {
    if (err && !out)
      return res.status(500).json({ ok: false, error: err.trim() });
    try {
      const json = JSON.parse(out.trim());
      return res.status(json.ok ? 200 : 500).json(json);
    } catch (e) {
      return res
        .status(500)
        .json({ ok: false, error: "Unexpected spooler response", detail: out || err });
    }
  });
});

// Quick Windows test by printer name
// Body: { printerName: "XP-80C" }
app.post("/win/print-test", (req, res) => {
  if (os.platform() !== "win32")
    return res.status(400).json({ ok: false, error: "Windows only endpoint" });
  const { printerName } = req.body || {};
  if (!printerName) return res.status(400).json({ ok: false, error: "printerName required" });

  const bytes = Buffer.from(
    [
      0x1b, 0x40, // init
      0x1b, 0x61, 0x01, // center
    ]
      .concat([...Buffer.from("BEYPRO SPOOLER TEST\r\n", "ascii")])
      .concat([0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x42, 0x00]),
  );
  const b64 = bytes.toString("base64");
  req.body.dataBase64 = b64;
  return app._router.handle(
    { ...req, url: "/win/print-raw", method: "POST", body: { printerName, dataBase64: b64 } },
    res,
    () => {},
  );
});

const PORT = process.env.BRIDGE_PORT || 7777;
app.listen(PORT, () =>
  console.log(`Beypro Bridge v${BRIDGE_VERSION} on http://127.0.0.1:${PORT}`),
);
