# Samples TCP sockets every second until the stop file appears, one line per sample.
param([string]$Out, [string]$Stop)
while (-not (Test-Path $Stop)) {
  $all = Get-NetTCPConnection -ErrorAction SilentlyContinue
  $states = ($all | Group-Object State | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join " "
  $owners = ($all | Group-Object OwningProcess | Sort-Object Count -Descending | Select-Object -First 4 | ForEach-Object {
    $name = (Get-Process -Id $_.Name -ErrorAction SilentlyContinue).ProcessName; "$name/$($_.Name)=$($_.Count)" }) -join " "
  $udp = (Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Measure-Object).Count
  $handles = (Get-Process chrome, headless_shell, node -ErrorAction SilentlyContinue | Measure-Object HandleCount -Sum).Sum
  $pool = (Get-CimInstance Win32_PerfRawData_PerfOS_Memory).PoolNonpagedBytes
  "$((Get-Date).ToString('HH:mm:ss')) total=$($all.Count) $states udp=$udp handles=$handles nonpaged=$([math]::Round($pool/1MB))MB top: $owners" | Add-Content $Out
  Start-Sleep -Seconds 1
}
