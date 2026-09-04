# SIGNAL DESK 서버 종료 (Windows)
# PID 파일 + 포트를 함께 훑어 start.ps1 로 띄운 서버를 남김없이 종료한다.
# (start.ps1 을 여러 번 돌리면 파이썬 서버가 같은 포트에 쌓일 수 있어 포트까지 본다.)
# 사용법: .\stop.ps1 [-Port 8137]
param(
    [int]$Port = 8137
)
$ErrorActionPreference = "SilentlyContinue"
$PidFile = Join-Path $env:TEMP "signal-desk.pid"

$targets = New-Object System.Collections.Generic.HashSet[int]

# 1) PID 파일에 적힌 프로세스
if (Test-Path $PidFile) {
    $recorded = (Get-Content $PidFile | Select-Object -First 1)
    if ($recorded) { $recorded = $recorded.Trim() }
    if ($recorded -match '^\d+$') { [void]$targets.Add([int]$recorded) }
}

# 2) 해당 포트를 LISTEN 하는 프로세스 (쌓인 잔여 서버까지)
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
    [void]$targets.Add([int]$c.OwningProcess)
}

if ($targets.Count -eq 0) {
    Write-Host "실행 중인 SIGNAL DESK 서버를 찾지 못했습니다 (포트 $Port)."
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    exit 0
}

foreach ($processId in $targets) {
    $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($proc) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        Write-Host "종료됨: PID $processId ($($proc.ProcessName))"
    }
}

Remove-Item $PidFile -ErrorAction SilentlyContinue
Write-Host "SIGNAL DESK 종료 완료 (포트 $Port)."
