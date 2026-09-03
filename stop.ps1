# SIGNAL DESK 서버 종료 (Windows) — start.ps1 로 띄운 프로세스를 PID 파일로 찾아 종료
$ErrorActionPreference = "Stop"
$PidFile = Join-Path $env:TEMP "signal-desk.pid"

if (-not (Test-Path $PidFile)) {
    Write-Host "PID 파일이 없습니다 (start.ps1 로 띄우지 않았거나 이미 종료된 상태입니다)"
    exit 0
}

$existingPid = Get-Content $PidFile
$proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
if ($proc) {
    Stop-Process -Id $existingPid -Force
    Write-Host "SIGNAL DESK 종료됨 (PID $existingPid)"
} else {
    Write-Host "PID $existingPid 프로세스가 이미 종료된 상태입니다"
}

Remove-Item $PidFile -ErrorAction SilentlyContinue
