// ===== WINDOWS PRINT SPOOLER FALLBACK (no serialport required) =====
const os = require('os');
const { execFile, spawn } = require('child_process');
const express = require('express');
const app = module.exports?.app || global.app || require('express')(); // if you already created app, ignore this line
app.use(express.json({ limit: '2mb' }));

// 1) List installed Windows printers (names only)
app.get('/win/printers', (req, res) => {
  if (os.platform() !== 'win32') {
    return res.status(400).json({ ok: false, error: 'Windows only endpoint' });
  }
  // Use PowerShell to list printer names as JSON
  const ps = execFile('powershell.exe',
    ['-NoProfile','-ExecutionPolicy','Bypass','-Command',
     'Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json'],
    { windowsHide: true },
    (err, stdout, stderr) => {
      if (err) return res.status(500).json({ ok: false, error: stderr || err.message });
      let names;
      try { names = JSON.parse(stdout || '[]'); } catch { names = []; }
      if (!Array.isArray(names)) names = [names].filter(Boolean);
      res.json({ ok: true, printers: names });
    });
});

// 2) RAW print via Windows Spooler (Base64 payload)
// Body: { printerName: "XP-80C", dataBase64: "..." }
app.post('/win/print-raw', (req, res) => {
  if (os.platform() !== 'win32') {
    return res.status(400).json({ ok: false, error: 'Windows only endpoint' });
  }
  const { printerName, dataBase64 } = req.body || {};
  if (!printerName || !dataBase64) {
    return res.status(400).json({ ok: false, error: 'printerName and dataBase64 are required' });
  }

  // We spawn PowerShell that compiles a tiny C# helper on-the-fly to send RAW bytes to the spooler.
  const psScript = `
Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }

  [DllImport("winspool.Drv", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

  [DllImport("winspool.Drv", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);

  [DllImport("winspool.Drv", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

  public static bool SendBytesToPrinter(string printerName, byte[] bytes) {
    IntPtr hPrinter;
    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) return false;
    DOCINFOA di = new DOCINFOA();
    di.pDocName = "Beypro RAW";
    di.pDataType = "RAW";
    if (!StartDocPrinter(hPrinter, 1, di)) { ClosePrinter(hPrinter); return false; }
    if (!StartPagePrinter(hPrinter))      { EndDocPrinter(hPrinter); ClosePrinter(hPrinter); return false; }

    IntPtr pUnmanagedBytes = Marshal.AllocHGlobal(bytes.Length);
    Marshal.Copy(bytes, 0, pUnmanagedBytes, bytes.Length);
    int dwWritten = 0;
    bool ok = WritePrinter(hPrinter, pUnmanagedBytes, bytes.Length, out dwWritten);
    Marshal.FreeHGlobal(pUnmanagedBytes);

    EndPagePrinter(hPrinter);
    EndDocPrinter(hPrinter);
    ClosePrinter(hPrinter);
    return ok && dwWritten == bytes.Length;
  }
}
"@

$bytes = [Convert]::FromBase64String('${dataBase64}')
$ok = [RawPrinterHelper]::SendBytesToPrinter('${printerName}', $bytes)
if ($ok) { Write-Output '{"ok":true}' } else { Write-Output '{"ok":false,"error":"WritePrinter failed"}' }
`;

  const ps = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command', psScript], { windowsHide: true });
  let out = '', err = '';
  ps.stdout.on('data', d => out += d.toString());
  ps.stderr.on('data', d => err += d.toString());
  ps.on('close', code => {
    if (err && !out) return res.status(500).json({ ok: false, error: err.trim() });
    try {
      const json = JSON.parse(out.trim());
      return res.status(json.ok ? 200 : 500).json(json);
    } catch(e) {
      return res.status(500).json({ ok: false, error: 'Unexpected spooler response', detail: out || err });
    }
  });
});

// 3) Simple test (ESC/POS) — Body: { printerName: "XP-80C" }
app.post('/win/print-test', (req, res) => {
  const { printerName } = req.body || {};
  if (os.platform() !== 'win32') {
    return res.status(400).json({ ok: false, error: 'Windows only endpoint' });
  }
  if (!printerName) return res.status(400).json({ ok: false, error: 'printerName required' });

  // ESC/POS: initialize, center, text, LF x3, cut
  const bytes = Buffer.from([
    0x1B,0x40,             // init
    0x1B,0x61,0x01,        // center
    // "BEYPRO TEST\n"
    ...Buffer.from('BEYPRO TEST\r\n', 'ascii'),
    0x0A,0x0A,0x0A,        // feed 3
    0x1D,0x56,0x42,0x00    // cut (partial)
  ]);
  const b64 = bytes.toString('base64');
  req.body.dataBase64 = b64;
  return app._router.handle(
    { ...req, url: '/win/print-raw', method: 'POST', body: { printerName, dataBase64: b64 } },
    res,
    () => {}
  );
});
