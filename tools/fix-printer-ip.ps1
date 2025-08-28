<#
.SYNOPSIS
  Temporarily add a secondary IP on Windows so you can reach a LAN receipt printer
  stuck on a different subnet (e.g., 192.168.123.100), open its web UI, switch it
  to DHCP (or set a proper static in your main LAN), then remove the temp IP.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\fix-printer-ip.ps1 -PrinterHost 192.168.123.100

.OPTIONAL
  -AdapterAlias "Ethernet"
  -TempIp 192.168.123.50
  -PrefixLength 24
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

Write-Info "Target printer: $PrinterHost"
$primary = Get-PrimaryIPv4Adapter
if(-not $primary){ Write-Err "No active IPv4 adapter found."; exit 1 }
Write-OK "Using adapter: $($primary.Name)"

$chosenTemp = Pick-TempIp $PrinterHost
Write-Info "Temporary IP candidate: $chosenTemp/$PrefixLength"

try{
  New-NetIPAddress -InterfaceAlias $primary.Name -IPAddress $chosenTemp -PrefixLength $PrefixLength -ErrorAction Stop | Out-Null
  Write-OK "Added secondary IP $chosenTemp to '$($primary.Name)'"
}catch{
  Write-Err "Failed to add temp IP: $($_.Exception.Message)"
  Write-Err "If this persists, ensure PowerShell is running as Administrator."
  exit 1
}

try{
  $test = Test-NetConnection -ComputerName $PrinterHost -Port 80 -WarningAction SilentlyContinue
  if($test.TcpTestSucceeded){
    Write-OK "Port 80 reachable — opening printer web UI…"
  }else{
    Write-Info "Port 80 not reachable (some models use other mgmt ports). Will try to open HTTP anyway."
  }
}catch{}

Start-Process "http://$PrinterHost" | Out-Null
Write-Info "In the printer web UI, set IP mode to DHCP (or assign a static in your main LAN)."
Write-Info "After saving & rebooting the printer, press ENTER here to remove the temp IP."
[void][System.Console]::ReadLine()

try{
  Remove-NetIPAddress -InterfaceAlias $primary.Name -IPAddress $chosenTemp -Confirm:$false -ErrorAction Stop
  Write-OK "Removed temporary IP $chosenTemp from '$($primary.Name)'"
}catch{
  Write-Err "Failed to remove temp IP: $($_.Exception.Message)"
  Write-Info "You can remove it later with:"
  Write-Host "  Remove-NetIPAddress -InterfaceAlias `"$($primary.Name)`" -IPAddress $chosenTemp -Confirm:`$false" -ForegroundColor Yellow
}

Write-OK "Done. Now the printer should be on your main LAN (same subnet as the PC)."
Write-Info "Tip: In Beypro, click 'Find Printers' and then 'Test Print'."
