param(
  [string]$AppDir = "$env:LOCALAPPDATA\BeyproBridge",
  [string]$ExeTargetName = "beypro-bridge.exe"
)
$ErrorActionPreference = "Stop"
Write-Host "Installing Beypro Bridge..." -ForegroundColor Cyan
if (!(Test-Path $AppDir)) { New-Item -ItemType Directory -Path $AppDir | Out-Null }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcExe = Join-Path $here "..\..\dist\beypro-bridge-win-x64.exe"
if (!(Test-Path $srcExe)) {
  $alt = Join-Path (Get-Location) "beypro-bridge-win-x64.exe"
  if (Test-Path $alt) { $srcExe = $alt } else { Write-Host "ERROR: Cannot find dist\beypro-bridge-win-x64.exe" -ForegroundColor Red; exit 1 }
}
Copy-Item $srcExe (Join-Path $AppDir $ExeTargetName) -Force
$startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$lnkPath = Join-Path $startup "Beypro Bridge.lnk"
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($lnkPath)
$Shortcut.TargetPath = (Join-Path $AppDir $ExeTargetName)
$Shortcut.WorkingDirectory = $AppDir
$Shortcut.Description = "Beypro Bridge (127.0.0.1:7777)"
$Shortcut.Save()
Write-Host "✅ Installed to $AppDir"
Write-Host "✅ Auto-start enabled (Startup shortcut)."
