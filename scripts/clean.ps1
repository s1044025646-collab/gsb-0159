# Stops only node processes started by THIS project and removes project-local data.
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

Write-Host "Stopping node processes whose command line references $root ..."
$pidFile = Join-Path $root "data\server.pid"
if (Test-Path $pidFile) {
  $serverPid = [int](Get-Content $pidFile -Raw).Trim()
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid"
  if ($owner -and $owner.Name -eq "node.exe") {
    Write-Host "  stopping API server PID $serverPid"
    Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
  }
}
$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$root*") }
foreach ($proc in $procs) {
  Write-Host "  stopping PID $($proc.ProcessId)"
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500

Write-Host "Removing project-local data directory ..."
$data = Join-Path $root "data"
if (Test-Path $data) {
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      Remove-Item -LiteralPath $data -Recurse -Force -ErrorAction Stop
      break
    } catch {
      if ($attempt -eq 5) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
}
Write-Host "Clean complete."
