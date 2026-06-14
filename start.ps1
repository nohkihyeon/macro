# 시그널보드 대시보드 실행 스크립트 (PowerShell)
#   사용:  우클릭 → "PowerShell에서 실행"  또는  powershell -ExecutionPolicy Bypass -File start.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$Host.UI.RawUI.WindowTitle = '시그널보드 대시보드'

Write-Host ''
Write-Host '  ===============================================' -ForegroundColor Cyan
Write-Host '   시그널보드 — 실시간 증시 지표 대시보드' -ForegroundColor Cyan
Write-Host '  ===============================================' -ForegroundColor Cyan
Write-Host ''

# 1) Node.js 확인
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '  [오류] Node.js 가 설치되어 있지 않습니다.' -ForegroundColor Red
  Write-Host '         https://nodejs.org 에서 LTS 설치 후 다시 실행하세요.'
  Read-Host '  엔터를 누르면 종료'; exit 1
}

# 2) 최초 실행 시 의존성 설치
if (-not (Test-Path 'node_modules')) {
  Write-Host '  최초 실행: 의존성 설치 중... (1~2분 소요)' -ForegroundColor Yellow
  npm install
  if ($LASTEXITCODE -ne 0) { Write-Host '  [오류] npm install 실패. 네트워크를 확인하세요.' -ForegroundColor Red; Read-Host; exit 1 }
}

# 3) 서버 실행 (브라우저는 서버가 자동으로 엽니다. 이 창을 닫으면 종료)
Write-Host '  서버 시작 → 브라우저가 자동으로 열립니다.' -ForegroundColor Green
Write-Host '  종료: 이 창에서 Ctrl+C' -ForegroundColor DarkGray
Write-Host ''
node server.js
