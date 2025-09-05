# installers/windows/install-beyprobridge.ps1
param(
  [string]$ZipUrl = "https://<YOUR_RENDER_HOST>/bridge/beypro-bridge-win-x64-v1.0.4.zip"
)

function Write-Info($m){ Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Write-OK($m){ Write-Host "[ OK ] $m" -ForegroundColor Green }
function Write-Err($m){ Write-Host "[ERR] $m" -ForegroundColor Red }

# Admin
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)){
  Write-Info "Re-launching with Administrator rights…"
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",$PSCommandPath,"-ZipUrl",$ZipUrl
  exit
}

$destDir = "$env:ProgramData\BeyproBridge"
$exePath = Join-Path $destDir "beypro-bridge-win-x64-v1.0.4.exe"
$startupLnk = "$env:AppData\Microsoft\Windows\Start Menu\Programs\Startup\Beypro USB Bridge.lnk"
$tmpZip = Join-Path $env:TEMP "beypro-bridge.zip"

# Kill old processes on port 7777 and any old exe paths
try {
  $conns = Get-NetTCPConnection -LocalPort 7777 -ErrorAction SilentlyContinue
  if ($conns) {
    foreach ($c in $conns) {
      try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
} catch {}

Get-Process | Where-Object { $_.Path -like "$destDir\*.exe" } | ForEach-Object {
  try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {}
}

# Remove old dir & shortcut
if (Test-Path $startupLnk) { Remove-Item $startupLnk -Force -ErrorAction SilentlyContinue }
if (Test-Path $destDir) { Remove-Item $destDir -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $destDir -Force | Out-Null

# Download latest zip
Write-Info "Downloading: $ZipUrl"
try {
  Invoke-WebRequest -Uri $ZipUrl -OutFile $tmpZip -UseBasicParsing -Headers @{"Cache-Control"="no-cache"}
  Write-OK "Downloaded bridge zip"
} catch {
  Write-Err "Failed to download zip: $($_.Exception.Message)"
  exit 1
}

# Extract
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($tmpZip, $destDir)
Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue

# Create startup shortcut
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($startupLnk)
$sc.TargetPath = $exePath
$sc.WorkingDirectory = $destDir
$sc.WindowStyle = 7
$sc.Description = "Beypro USB Print Bridge"
$sc.Save()
Write-OK "Startup shortcut created"

# Start now
Start-Process -FilePath $exePath -WindowStyle Hidden
Start-Sleep -Seconds 2

# Verify
try {
  $ping = Invoke-WebRequest -Uri "http://127.0.0.1:7777/ping" -UseBasicParsing -Headers @{"Cache-Control"="no-cache"}
  Write-OK "Bridge /ping: $($ping.Content)"
} catch {
  Write-Err "Bridge not responding on /ping. Check Windows Firewall or port 7777."
}

Write-OK "Install complete."
Write-Info "Open http://127.0.0.1:7777/win/printers or /usb/list to test."
