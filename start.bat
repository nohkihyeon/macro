@echo off
chcp 65001 >nul
title 시그널보드 대시보드
cd /d "%~dp0"

echo.
echo  ===============================================
echo   시그널보드 — 실시간 증시 지표 대시보드
echo  ===============================================
echo.

REM 1) Node.js 설치 확인
where node >nul 2>nul
if errorlevel 1 (
  echo  [오류] Node.js 가 설치되어 있지 않습니다.
  echo         https://nodejs.org 에서 LTS 버전 설치 후 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

REM 2) 최초 실행 시 의존성 설치
if not exist "node_modules" (
  echo  최초 실행: 의존성 설치 중... ^(1~2분 소요^)
  call npm install
  if errorlevel 1 (
    echo  [오류] npm install 실패. 네트워크를 확인하세요.
    pause
    exit /b 1
  )
)

REM 3) 서버 실행 (브라우저는 서버가 자동으로 엽니다. 이 창을 닫으면 종료)
echo  서버 시작 → 브라우저가 자동으로 열립니다.
echo  종료하려면 이 창에서 Ctrl+C 를 누르세요.
echo.
node server.js

pause
