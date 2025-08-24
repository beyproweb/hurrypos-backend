# Beypro Bridge Windows Installer (per-user; no admin needed)
# HOW TO RUN:
#   1) Extract the ZIP
#   2) Open Windows PowerShell (not Git Bash/WSL)
#   3) Set-ExecutionPolicy -Scope Process Bypass -Force
#   4) cd to the extracted folder
#   5) .\install-beyprobridge.ps1

$ErrorActionPreference = "Stop"

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "Script path: $Here"

# Try common names next to the script
$exe1 = Join-Path $Here "beypro-bridge-win-x64.exe"
$exe2 = Join-Path $Here "beypro-bridge.exe"
$SrcExe = if (Test-Path $exe1) { $exe1 } elseif (Test-Path $exe2) { $exe2 } else { $null }

# Fallback: ask user to browse for the EXE
if (-not $SrcExe) {
  try {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.InitialDirectory = $Here
    $dlg.Filter = "Executable (*.exe)|*.exe"
    $dlg.Title = "Locate the Beypro Bridge EXE"
    if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
      throw "No EXE selected."
    }
    $SrcExe = $dlg.FileName
  } catch {
    throw "Could not find the EXE. Make sure it's next to the PS1, then re-run."
  }
}

Write-Host "Found EXE: $SrcExe" -ForegroundColor Green

$AppDir = Join-Path $env:LOCALAPPDATA "BeyproBridge"
if (-not (Test-Path $AppDir)) {
  New-Item -ItemType Directory -Path $AppDir | Out-Null
}
$TargetExe = Join-Path $AppDir "beypro-bridge.exe"
Copy-Item -LiteralPath $SrcExe -Destination $TargetExe -Force
Write-Host "Copied to: $TargetExe" -ForegroundColor Green

# Create Startup shortcut (per-user)
$StartupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
if (-not (Test-Path $StartupDir)) { New-Item -ItemType Directory -Path $StartupDir | Out-Null }
$Lnk = Join-Path $StartupDir "Beypro Bridge.lnk"

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($Lnk)
$Shortcut.TargetPath = $TargetExe
$Shortcut.WorkingDirectory = $AppDir
$Shortcut.WindowStyle = 7
$Shortcut.Description = "Beypro Bridge (127.0.0.1:7777 → RAW :9100)"
$Shortcut.Save()

Write-Host "Startup shortcut: $Lnk"
Write-Host "✅ Done. It will auto-start on next login." -ForegroundColor Green
Write-Host "➡️ Start now (optional): & `"$TargetExe`""
