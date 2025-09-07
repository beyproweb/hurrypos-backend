param(
  [string]$InstallDir = "C:\Program Files\BeyproBridge",
  [int]$Port = 7777
)

$taskName = "BeyproBridge"
$ruleName = "Beypro Bridge $Port"

try { Stop-Process -Name "bridge" -ErrorAction SilentlyContinue } catch {}
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false | Out-Null
}
if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
  Remove-NetFirewallRule -DisplayName $ruleName | Out-Null
}
Remove-Item -Recurse -Force "$([Environment]::GetFolderPath('Desktop'))\Beypro Bridge.lnk" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
Write-Host "Uninstalled."
