# SIGNAL DESK 서버 시작 (Windows)
# 사용법: .\start.ps1 [-Port 8137]
param(
    [int]$Port = 8137
)

$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidFile = Join-Path $env:TEMP "signal-desk.pid"
$LogFile = Join-Path $env:TEMP "signal-desk.log"
$ErrFile = Join-Path $env:TEMP "signal-desk.err.log"

function Find-Python {
    # 실제 파이썬을 실행해 검증하는 대신 경로만 본다 — 이 PC의 bare python3/python 은
    # Microsoft Store 실행 별칭(스텁)이라 항상 ...\WindowsApps\ 아래에 있고, 실행하면
    # "Python" 만 찍고 종료해 버린다(서브프로세스로 검증하면 이 환경에서 $LASTEXITCODE 가
    # 유실되는 문제가 있어 경로 필터링으로 대체).
    foreach ($c in @("python3", "python")) {
        $cmd = Get-Command $c -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source -notmatch '\\WindowsApps\\') {
            return $cmd.Source
        }
    }
    $fallback = "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe"
    if (Test-Path $fallback) { return $fallback }
    return $null
}

if (Test-Path $PidFile) {
    $existingPid = Get-Content $PidFile
    if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
        Write-Host "이미 실행 중입니다 (PID $existingPid). 먼저 .\stop.ps1 로 종료하세요."
        exit 1
    }
}

$python = Find-Python
if (-not $python) {
    Write-Error "실행 가능한 Python 3.9+ 인터프리터를 찾지 못했습니다."
    exit 1
}

$env:PYTHONIOENCODING = "utf-8"
$proc = Start-Process -FilePath $python `
    -ArgumentList @("-u", "serve.py", "$Port") `
    -WorkingDirectory $Dir `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $ErrFile `
    -WindowStyle Hidden `
    -PassThru

$proc.Id | Out-File -FilePath $PidFile -Encoding ascii
Start-Sleep -Seconds 1

if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
    Write-Host "SIGNAL DESK 시작됨 (PID $($proc.Id))"
    Write-Host "--- 로그 ---"
    Get-Content $LogFile -Encoding UTF8 -ErrorAction SilentlyContinue
    Get-Content $ErrFile -Encoding UTF8 -ErrorAction SilentlyContinue
} else {
    Write-Host "시작 실패. 로그를 확인하세요: $LogFile / $ErrFile"
    Get-Content $LogFile -Encoding UTF8 -ErrorAction SilentlyContinue
    Get-Content $ErrFile -Encoding UTF8 -ErrorAction SilentlyContinue
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    exit 1
}
