<#
.SYNOPSIS
  Setup Beypro LAN printer and USB print bridge on Windows

.DESCRIPTION
  1. Temporarily adds a secondary IP to access LAN printers (e.g. 192.168.123.100)
  2. Installs and runs the USB Print Bridge locally
  3. Sets up autostart on Windows boot
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

# --- Helper functions ---
function Get-PrimaryIPv4Adapter {
  if($AdapterAlias){
    $a = Get-NetAdapter -Name $AdapterAlias -ErrorAction SilentlyContinue
    if($a -and $a.Status -eq "Up"){ return $a }
    Write-Err "Adapter '$AdapterAlias' not found or not Up."
    exit 1
  }
  $cfg = Get-NetIPConfiguration | Where-Object { $_.IPv4Address -and $_.IPv4DefaultGateway } | Select-Object -First 1
  if($cfg){ return (Get-NetAdapter -InterfaceIndex $cfg.InterfaceIndex) }
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
      if(-not (Test-Connection -Quiet -Count 1 -TimeoutSeconds 1 -ErrorAction SilentlyContinue $ip)){
        return $ip
      }
    }
  }
  Write-Err "Couldn't find a free temp IP on $base. Try specifying -TempIp manually."
  exit 1
}

function Ensure-BeyproUsbBridge {
  $bridgeExe = "$env:ProgramData\BeyproBridge\beypro-bridge.exe"
  $bridgeZip = "beypro-bridge.zip"
  $startupLnk = "$env:AppData\Microsoft\Windows\Start Menu\Programs\Startup\Beypro USB Bridge.lnk"

  if (-not (Test-Path (Split-Path $bridgeExe))) {
    New-Item -ItemType Directory -Path (Split-Path $bridgeExe) -Force | Out-Null
  }

  if (-not (Test-Path $bridgeExe)) {
    if (-not (Test-Path $bridgeZip)) {
      Write-Err "Missing $bridgeZip — cannot install USB bridge."
      return
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($bridgeZip, (Split-Path $bridgeExe))
    Write-OK "Extracted USB Bridge to $bridgeExe"
  }

  if (-not (Test-Path $startupLnk)) {
    $ws = New-Object -ComObject WScript.Shell
    $shortcut = $ws.CreateShortcut($startupLnk)
    $shortcut.TargetPath = $bridgeExe
    $shortcut.WorkingDirectory = (Split-Path $bridgeExe)
    $shortcut.WindowStyle = 7
    $shortcut.Description = "Beypro USB Print Bridge"
    $shortcut.Save()
    Write-OK "Startup shortcut created for USB bridge"
  }

  $running = Get-Process | Where-Object { $_.Path -eq $bridgeExe }
  if (-not $running) {
    Start-Process -FilePath $bridgeExe -WindowStyle Hidden
    Write-OK "Started Beypro USB Bridge"
  } else {
    Write-Info "USB Bridge is already running"
  }
}

# --- MAIN EXECUTION ---

Write-Info "Target printer: $PrinterHost"
$primary = Get-PrimaryIPv4Adapter
if(-not $primary){ Write-Err "No active IPv4 adapter found."; exit 1 }
Write-OK "Using adapter: $($primary.Name)"

$chosenTemp = Pick-TempIp $PrinterHost
Write-Info "Temporary IP candidate: $chosenTemp/$PrefixLength"

try {
  New-NetIPAddress -InterfaceAlias $primary.Name -IPAddress $chosenTemp -PrefixLength $PrefixLength -ErrorAction Stop | Out-Null
  Write-OK "Added secondary IP $chosenTemp to '$($primary.Name)'"
} catch {
  Write-Err "Failed to add temp IP: $($_.Exception.Message)"
  exit 1
}

try {
  $test = Test-NetConnection -ComputerName $PrinterHost -Port 80 -WarningAction SilentlyContinue
  if($test.TcpTestSucceeded){
    Write-OK "Port 80 reachable — opening printer web UI…"
  } else {
    Write-Info "Port 80 not reachable. Will try to open printer UI anyway."
  }
} catch {}

Start-Process "http://$PrinterHost" | Out-Null
Write-Info "Set DHCP or assign static IP in the printer UI. Press ENTER when done to clean up."
[void][System.Console]::ReadLine()

try {
  Remove-NetIPAddress -InterfaceAlias $primary.Name -IPAddress $chosenTemp -Confirm:$false -ErrorAction Stop
  Write-OK "Removed temporary IP $chosenTemp from '$($primary.Name)'"
} catch {
  Write-Err "Failed to remove temp IP: $($_.Exception.Message)"
}

# ✅ Ensure USB Bridge is installed and running
Ensure-BeyproUsbBridge

Write-OK "Setup complete. Beypro USB Bridge is installed and running."
Write-Info "You can now detect USB printers from your browser at http://127.0.0.1:7777/usb/list"
