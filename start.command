#!/bin/bash
# 시그널보드 대시보드 실행 스크립트 (macOS — Finder 에서 더블클릭)
cd "$(dirname "$0")"

echo ""
echo "  ==============================================="
echo "   시그널보드 — 실시간 증시 지표 대시보드"
echo "  ==============================================="
echo ""

# 1) Node.js 확인
if ! command -v node >/dev/null 2>&1; then
  echo "  [오류] Node.js 가 설치되어 있지 않습니다."
  echo "         https://nodejs.org 에서 LTS 설치 후 다시 실행하세요. (또는 brew install node)"
  read -r -p "  엔터를 누르면 종료"
  exit 1
fi

# 2) 최초 실행 시 의존성 설치
if [ ! -d node_modules ]; then
  echo "  최초 실행: 의존성 설치 중... (1분 내외)"
  if ! npm install; then
    echo "  [오류] npm install 실패. 네트워크를 확인하세요."
    read -r -p "  엔터를 누르면 종료"
    exit 1
  fi
fi

# 3) 서버 실행 (브라우저는 서버가 자동으로 엽니다. 이 창을 닫으면 종료)
echo "  서버 시작 → 브라우저가 자동으로 열립니다."
echo "  종료: 이 창에서 Ctrl+C"
echo ""
node server.js
