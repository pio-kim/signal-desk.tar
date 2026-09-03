#!/usr/bin/env bash
# SIGNAL DESK 서버 시작
# 사용법: ./start.sh [포트(기본 8137)]
set -euo pipefail

PORT="${1:-8137}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="/tmp/signal-desk.pid"
LOG_FILE="/tmp/signal-desk.log"

# 이 개발 PC의 bare `python3`는 Microsoft Store 스텁이라 "Python"만 찍고 즉시 종료된다
# (serve.py 가 아예 안 돌아간다). 실배포 대상(EC2 등)에선 bare python3 가 정상이므로
# 먼저 그걸 시도하고, 스텁으로 판명되면 이 PC에 실제로 설치된 인터프리터로 폴백한다.
find_python() {
  local candidates=(
    python3
    python
    "/c/Users/${USER:-${USERNAME:-}}/AppData/Local/Programs/Python/Python310/python.exe"
  )
  local c
  for c in "${candidates[@]}"; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then
      if "$c" -c "import sys; assert sys.version_info >= (3, 9)" >/dev/null 2>&1; then
        echo "$c"
        return 0
      fi
    fi
  done
  return 1
}

PYTHON="$(find_python)" || {
  echo "실행 가능한 Python 3.9+ 인터프리터를 찾지 못했습니다." >&2
  exit 1
}

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "이미 실행 중입니다 (PID $(cat "$PID_FILE")). 먼저 ./stop.sh 로 종료하세요."
  exit 1
fi

cd "$DIR"
# -u: 출력 버퍼링 없이 즉시 로그 파일에 기록(버퍼링되면 접속 주소 줄이 한참 늦게 보인다)
PYTHONIOENCODING=utf-8 nohup "$PYTHON" -u serve.py "$PORT" > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 1

if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "SIGNAL DESK 시작됨 (PID $(cat "$PID_FILE"))"
  echo "--- 로그 ---"
  cat "$LOG_FILE"
else
  echo "시작 실패. 로그를 확인하세요: $LOG_FILE" >&2
  cat "$LOG_FILE" >&2
  rm -f "$PID_FILE"
  exit 1
fi
