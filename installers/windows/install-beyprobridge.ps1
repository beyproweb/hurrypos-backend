# install-beypro-bridge.ps1
# Run as Admin: Right-click > Run with PowerShell
# Downloads & installs Beypro Bridge, auto-starts at login.

param(
  [string]$BridgeUrl = "https://pos.beypro.com/bridge/beypro-bridge-win-x64-v1.0.5.zip",
  [string]$InstallDir = "C:\Program Files\BeyproBridge",
  [int]$Port = 7777
)

function Write-Info($m){ Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Write-OK($m){ Write-Host "[ OK ] $m" -ForegroundColor Green }
function Write-Err($m){ Write-Host "[ERR] $m" -ForegroundColor Red }

# --- Admin check ---
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)){
  Write-Err "Please re-run PowerShell as Administrator."; exit 1
}

# --- Prep dirs ---
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$zip = Join-Path $env:TEMP "beypro-bridge.zip"

# --- Download ---
Write-Info "Downloading Bridge from $BridgeUrl"
try {
  Invoke-WebRequest -Uri $BridgeUrl -OutFile $zip
  Write-OK "Downloaded"
} catch {
  Write-Err "Download failed: $($_.Exception.Message)"; exit 1
}

# --- Unzip ---
Write-Info "Extracting to $InstallDir"
try {
  Expand-Archive -Path $zip -DestinationPath $InstallDir -Force
  Remove-Item $zip -Force
  Write-OK "Extracted"
} catch {
  Write-Err "Extract failed: $($_.Exception.Message)"; exit 1
}

# Find executable (bridge.exe)
$exe = Get-ChildItem -Path $InstallDir -Recurse -Filter "bridge.exe" | Select-Object -First 1
if(-not $exe){ Write-Err "bridge.exe not found in $InstallDir"; exit 1 }

# --- Firewall rule ---
$ruleName = "Beypro Bridge $Port"
if(-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)){
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
  Write-OK "Firewall rule added for TCP $Port"
} else {
  Write-Info "Firewall rule already exists"
}

# --- Scheduled Task (auto-start at logon) ---
$taskName = "BeyproBridge"
$act = New-ScheduledTaskAction -Execute $exe.FullName -Argument ""
$trg = New-ScheduledTaskTrigger -AtLogOn
$pri = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\INTERACTIVE" -RunLevel Highest
try {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false | Out-Null
  }
  Register-ScheduledTask -TaskName $taskName -Action $act -Trigger $trg -Principal $pri | Out-Null
  Write-OK "Scheduled Task '$taskName' created"
} catch {
  Write-Err "Task creation failed: $($_.Exception.Message)"; exit 1
}

# --- Desktop shortcut ---
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$([Environment]::GetFolderPath('Desktop'))\Beypro Bridge.lnk")
$Shortcut.TargetPath = $exe.FullName
$Shortcut.WorkingDirectory = $InstallDir
$Shortcut.IconLocation = "$($exe.FullName),0"
$Shortcut.Save()
Write-OK "Desktop shortcut created"

# --- Start now ---
Write-Info "Starting Bridge…"
Start-Process -FilePath $exe.FullName

Write-OK "Done! Bridge is running at http://127.0.0.1:$Port"
