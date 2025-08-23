<# Beypro Bridge Windows Installer (per-user; no admin needed)
   Place this script in the same folder as beypro-bridge-win-x64.exe (ZIP root).
   Run: Right-click → "Run with PowerShell"
   Or:  powershell -ExecutionPolicy Bypass -File .\install-beyprobridge.ps1
#>

param(
  [string]$AppDir = "$env:LOCALAPPDATA\BeyproBridge",
  [string]$ExeTargetName = "beypro-bridge.exe",
  [string]$ShortcutName = "Beypro Bridge.lnk"
)

$ErrorActionPreference = "Stop"
Write-Host "Installing Beypro Bridge..." -ForegroundColor Cyan

# Resolve paths relative to this script
$Here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$SrcExe = Join-Path $Here "beypro-bridge-win-x64.exe"

if (!(Test-Path $SrcExe)) {
  # Fallback: current working directory (in case user ran from another shell)
  $Alt = Join-Path (Get-Location) "beypro-bridge-win-x64.exe"
  if (Test-Path $Alt) { $SrcExe = $Alt } else {
    Write-Host "ERROR: Cannot find beypro-bridge-win-x64.exe next to the installer." -ForegroundColor Red
    exit 1
  }
}

# Ensure target directory
if (!(Test-Path $AppDir)) {
  New-Item -ItemType Directory -Path $AppDir | Out-Null
}

# Copy binary
Copy-Item $SrcExe (Join-Path $AppDir $ExeTargetName) -Force

# Create Startup shortcut (per-user)
$StartupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
if (!(Test-Path $StartupDir)) { New-Item -ItemType Directory -Path $StartupDir | Out-Null }

$LnkPath   = Join-Path $StartupDir $ShortcutName
$WshShell  = New-Object -ComObject WScript.Shell
$Shortcut  = $WshShell.CreateShortcut($LnkPath)
$Shortcut.TargetPath = (Join-Path $AppDir $ExeTargetName)
$Shortcut.WorkingDirectory = $AppDir
$Shortcut.WindowStyle = 7
$Shortcut.Description = "Beypro Bridge (127.0.0.1:7777 → RAW :9100)"
$Shortcut.Save()

Write-Host "✅ Installed to $AppDir"
Write-Host "✅ Auto-start enabled (Startup shortcut)."
Write-Host "➡️ It listens on http://127.0.0.1:7777"
