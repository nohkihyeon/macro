# 📊 시그널보드 (Signalboard)

> 실시간 국내·글로벌 증시 지표 대시보드 — 코스피·코스닥, 금리, 환율, 원자재, 수급, 시총 트리맵을 한 화면에서.

Node.js(Express) 백엔드가 **Yahoo Finance**와 **네이버 금융**에서 데이터를 수집해 JSON API로 제공하고, 정적 프론트엔드가 위젯 그리드로 시각화합니다. 라이브 데이터는 **LIVE** 배지, 합성 샘플은 **샘플** 배지로 구분됩니다.

---

## ✨ 주요 기능

- **시장** — 코스피 / 코스닥 / 코스피200, 업종별 등락, 시가총액 트리맵(코스피·코스닥)
- **금리** — 기준금리·콜금리·국고채(3·10년)·CD 91일·회사채 3년
- **환율** — 원/달러, 원/100엔, 원/유로
- **원자재** — WTI 원유, 금, 구리
- **수급** — 투자자별(개인·외국인·기관·연기금) 누적 순매수, 외국인 vs 코스피, 주간 수급 보드
- **심리** — VKOSPI(실현변동성), VIX, 자체 합성 공포·탐욕 지수
- **글로벌** — 주요 지수 10종 1년 정규화 비교
- 위젯 드래그 재배치 · 라이트/다크 테마 · 자동 갱신

---

## 🧱 기술 스택

| 영역 | 사용 |
|------|------|
| 백엔드 | Node.js, Express 5 |
| 스크래핑 | axios, cheerio, iconv-lite (네이버 EUC-KR 디코딩) |
| 프론트 | 정적 HTML/JSX + ApexCharts + Pretendard (별도 빌드 스텝 없음 — 정적 파일 그대로 서빙) |
| 데이터 소스 | Yahoo Finance API, 네이버 금융, TradingView 스캐너 |

---

## 🚀 로컬에서 실행 (한 줄)

> **사전 준비:** [Node.js](https://nodejs.org) 18 이상

### 가장 쉬운 방법 — 더블클릭

| 파일 | 설명 |
|------|------|
| **[start.bat](start.bat)** | 탐색기에서 더블클릭 → Node 확인 → (최초 1회) `npm install` → 서버 시작 → **브라우저 자동 오픈** |
| **[start.ps1](start.ps1)** | PowerShell 사용자용 (우클릭 → PowerShell에서 실행) |

### 명령줄

```powershell
npm install   # 최초 1회
npm start     # = node server.js → http://localhost:3000 자동 오픈
```

정상 실행 시:

```
===============================================
📊 시그널보드 대시보드 서버 시작!
👉 접속 주소: http://localhost:3000
===============================================
```

종료는 콘솔에서 `Ctrl+C`.

### 데이터 소스 점검 (서버 없이)

```powershell
npm run check        # 어떤 지표가 라이브로 들어오는지 표로 확인
npm run check:json   # JSON 출력 (CI/모니터링용)
```

---

## ☁️ 웹에 배포하기 (Render — 무료)

이 앱은 **백엔드 서버가 필요**합니다. 브라우저에서 Yahoo·네이버를 직접 호출하면 CORS에 막히기 때문에, `server.js`가 데이터를 대신 수집(프록시)합니다. 따라서 GitHub Pages 같은 정적 호스팅만으로는 실데이터가 들어오지 않으며, Node 서버를 띄울 수 있는 [Render](https://render.com) 같은 곳에 올립니다.

### 1) GitHub에 푸시

```powershell
git remote add origin https://github.com/<사용자명>/<레포명>.git
git branch -M main
git push -u origin main
```

### 2) Render에 연결

**방법 A — Blueprint (권장, 자동):**
1. [render.com](https://render.com) 가입 후 GitHub 계정 연동
2. **New +** → **Blueprint** → 이 레포 선택
3. 동봉된 [render.yaml](render.yaml)을 읽어 웹 서비스가 자동 생성됨 → **Apply**

**방법 B — 수동:**
1. **New +** → **Web Service** → 이 레포 선택
2. 설정값:
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** `Free`
3. **Create Web Service**

### 3) 완료

배포가 끝나면 `https://<서비스명>.onrender.com` 주소로 접속됩니다. 이후 `main` 브랜치에 push할 때마다 **자동 재배포**됩니다.

> ⚠️ **무료 플랜 참고**
> - 15분간 요청이 없으면 서버가 잠들고(sleep), 다음 첫 접속 시 깨어나는 데 약 30~50초가 걸립니다.
> - 디스크는 휘발성이라 [cache/](cache/) 의 일별 수급 캐시는 재배포 시 초기화됩니다(자동 재수집되므로 문제 없음).

---

## ⚙️ 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3000` | 서버 포트 (Render가 자동 주입) |
| `NO_OPEN` | — | `1`이면 브라우저 자동 오픈 비활성화 (서버/CI용) |
| `RENDER` | — | Render가 자동 주입 — 감지 시 브라우저 자동 오픈 생략 |

---

## 🔌 API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/api/series/:id?range=1w\|1m\|1y\|5y` | 단일 지표 시계열 |
| `GET` | `/api/quotes?ids=kospi,kosdaq,sp500,nasdaq` | KPI 배치 현재가/등락률 |
| `GET` | `/api/treemap?market=kospi&period=daily\|weekly` | 시총 상위 → 업종 트리맵 |
| `GET` | `/api/global?range=1y` | 글로벌 지수 정규화 비교 |
| `GET` | `/api/investors` | 투자자별 누적 순매수 + 외국인 vs 코스피 |
| `GET` | `/api/investors/weekly?weeks=104` | 주간 수급 집계 + 외국인 연속 매매 주 수 |
| `GET` | `/api/breadth?market=kospi` | 시장 폭(상승/하락/보합 종목 수) |
| `GET` | `/api/health` | 외부 소스(Yahoo·네이버) 생존 상태 |

전체 규격과 파싱 타깃은 **[api_spec.md](api_spec.md)** 참조.

---

## 📁 프로젝트 구조

```
macro/
├─ server.js              Express 백엔드 (API 엔드포인트 + 캐싱)
├─ pipeline/
│  ├─ sources.js          외부 소스 저수준 페처 (Yahoo·네이버·TradingView)
│  ├─ catalog.js          지표↔소스 매핑 · 업종 매핑 · 합성 시계열
│  └─ check.js            데이터 파이프라인 점검 CLI
├─ public/                프론트엔드 (정적 서빙)
│  ├─ index.html          셸 (테마 · ApexCharts · Pretendard)
│  ├─ app.jsx             앱 셸 (탭 · KPI · 드래그 · 자동갱신)
│  ├─ data.js             지표 카탈로그 · 포맷터 · 라이브 페치 + 폴백
│  ├─ charts.jsx          SVG 차트 + Apex 패널
│  └─ widgets.jsx         위젯 카드 + 추가 모달
├─ render.yaml            Render 배포 설정 (Blueprint)
├─ start.bat / start.ps1  로컬 실행 스크립트
├─ api_spec.md            API 규격서
└─ 실행방법.md            상세 실행 가이드
```

---

## 📝 참고

- 무료 시계열 소스가 없는 일부 지표(기준금리·국고채 10년·VKOSPI 라인 등)는 결정론적 **합성 샘플**로 대체되며 UI에 **샘플** 배지로 표시됩니다.
- 스크래핑은 네이버·Yahoo의 HTML/API 구조에 의존하므로, 소스 측 변경 시 일부 지표가 일시적으로 `unavailable`이 될 수 있습니다. `npm run check`로 상태를 확인하세요.
