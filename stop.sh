#!/usr/bin/env bash
# SIGNAL DESK 서버 종료 (start.sh 로 띄운 프로세스를 PID 파일로 찾아 종료)
set -euo pipefail

PID_FILE="/tmp/signal-desk.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "PID 파일이 없습니다 (start.sh 로 띄우지 않았거나 이미 종료된 상태입니다)"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "SIGNAL DESK 종료됨 (PID $PID)"
else
  echo "PID $PID 프로세스가 이미 종료된 상태입니다"
fi

rm -f "$PID_FILE"
