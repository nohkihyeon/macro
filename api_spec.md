# 시그널보드 API 규격서

서버가 제공하는 엔드포인트와, 서버가 호출하는 업스트림(네이버 증권 등) 엔드포인트·파싱 규칙을 정리한 문서입니다.

> 구현: 업스트림 페처 [pipeline/sources/naver.js](pipeline/sources/naver.js) · [pipeline/sources/others.js](pipeline/sources/others.js), 수집·조립 [pipeline/collector.js](pipeline/collector.js), 라우트 [server.js](server.js). 소스 점검은 `npm run check`.

---

## 0. 서버 제공 엔드포인트

### 실시간

| 경로 | 설명 |
|------|------|
| `GET /api/stream?watch=005930,000660` | Server-Sent Events. 접속 직후 `snapshot`, 이후 바뀐 것만 푸시. `retry: 3000`, 15초마다 `: ping` |
| `GET /api/snapshot?watch=…` | 같은 내용의 전체 스냅샷 (ETag, 변경 없으면 304). SSE 를 쓸 수 없을 때 폴링용 |

SSE 이벤트

| event | data | 비고 |
|-------|------|------|
| `snapshot` | `{ meta, quotes, boards, treemap, movers, sectors, themes, insights, dollar, intraday, stocks, series }` | 접속 직후 1회 |
| `quotes` | `{ [id]: Quote }` | **바뀐 지표만** |
| `stocks` | `{ [code]: StockQuote }` | 이 접속자의 `watch` 종목 중 바뀐 것만 |
| `intraday` | `{ [id]: { date, from, points: [[HHMM, price], …] } }` | `from` 이후를 교체·추가 (`from: 0` 이면 전체) |
| `boards` · `treemap` · `movers` · `sectors` · `themes` · `insights` · `dollar` | 토픽 전체 | 내용이 바뀐 토픽만 |
| `series` | `{ version, score_history, correlation, last_dates }` | 히스토리 갱신 시. 버전이 바뀌면 REST 리소스를 다시 받는다 |
| `meta` | `{ generated_at, session:{krx, krx_label, us, us_label, refresh_seconds}, stale_sources, live_version, series_version }` | 매 갱신 (하트비트) |

Quote: `{ id, name, group, unit, dec, price, change, change_percent, open, high, low, as_of(거래소 현지 시각), day(거래일), market_status, delayed(분), stale, source, prev_session, note }`

### 히스토리·집계 (ETag 304)

| 경로 | 설명 |
|------|------|
| `GET /api/history/:id?range=1w\|1m\|3m\|6m\|1y\|3y\|5y` | `{ id, name, kind: line\|bars\|candle, unit, rows:[{date, close, open?, high?, low?}], source, stale }`. id = 지표(`kospi`, `usdkrw`, `ktb10` …) · 금리차(`uskr10y`, `kr-term`, `us-term`) · 수급(`flow-foreign`, `flow-inst`, `flow-retail`, `flow-pension`) · `credit` · `deposit` · `vkospi`(KOSPI 21일 실현변동성) · 6자리 종목코드(캔들) |
| `GET /api/intraday/:id` | 국내 지수(`kospi`, `kosdaq`, `kpi200`, `k200fut`) 마지막 거래일 1분봉 |
| `GET /api/flows?market=KOSPI\|KOSDAQ&days=30` | 투자자별 누적 순매수(조원) + 지수 종가 |
| `GET /api/flows/weekly?market=&weeks=104` | 주간 집계 `{ dates, net, cum, kospi, streak:{weeks, direction} }` |
| `GET /api/credit?days=120` | 신용융자·고객예탁금 요약 + 히스토리(억원) |
| `GET /api/global?range=1y` | 10개 지수 시작점=0% 정규화, 날짜 합집합(휴장일은 직전 값) |
| `GET /api/treemap?market=kospi&period=daily\|weekly` | 시총 상위 50(ETF 제외) → 네이버 업종 그룹. 주간 = 실시간가 ÷ 5거래일 전 종가 |

### 달러 (DollarScope 이식)

| 경로 | 설명 |
|------|------|
| `GET /api/dollar` | `{ price, score, label, tone, advice, groups, dollarscope:{status, avg3y, diff, diff_pct}, stats, components[], levels[], summary[], bank }` |
| `GET /api/dollar/status` | DollarScope `/api/status` 호환: `{ current_price, average_3yr, status: BUY\|WAIT, diff, diff_percent, last_updated, source }` |
| `GET /api/dollar/history?range=3y` | DollarScope `/api/history` 호환: `[{ date, value }]` |

### 종목·상태·예전 API

| 경로 | 설명 |
|------|------|
| `GET /api/stocks/quotes?codes=005930,0162Z0` | 1~30개, 업스트림 1회 호출 |
| `GET /api/stocks/search?q=삼성` | 자동완성 |
| `GET /api/health` | `{ status, uptime_seconds, live_version, series_version, live_age_seconds, refresh_seconds, subscribers, idle, failed, cache, sources[] }` |
| `GET /api/series/:id` · `/api/quotes` · `/api/investors` · `/api/investors/weekly` · `/api/breadth` | 예전 형식 호환 |

---

## 1. 업스트림 — 네이버 증권 (JSON)

모든 호출은 `User-Agent` 와 `Referer: https://m.stock.naver.com/` 를 붙인다. 숫자는 `'1,334.20'`, `'+6,217'`, `'-'` 같은 문자열이라 콤마·부호를 정리하고, 등락 부호는 `compareToPreviousPrice` / `fluctuationsType` 의 `RISING`·`FALLING` 으로 보정한다.

| 용도 | URL | 핵심 필드 |
|------|-----|----------|
| 국내 지수·선물 | `polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ,KPI200,FUT` | `datas[].itemCode, closePriceRaw, compareToPreviousClosePriceRaw, fluctuationsRatioRaw, marketStatus, localTradedAt` |
| 해외 지수 | `…/realtime/worldstock/index/.INX,.IXIC,.NDX,.SOX,.DJI,.N225,.SSEC,.HSI,.GDAXI,.BSESN,.VIX` | `datas[].reutersCode` 기준. 프리마켓(`PREOPEN`)엔 등락이 0 → 직전 거래일 등락으로 보정 |
| 종목 시세 | `…/realtime/domestic/stock/{코드,…}` | `marketValueFullRaw`(원), `accumulatedTradingValueRaw`(원) |
| 시장지표 일괄 | `m.stock.naver.com/front-api/marketIndex/majors` | `result.{exchange, exchangeWorld, bond, domesticInterest, energy, metals, standardInterest, transport}[]` — `reutersCode, closePrice, fluctuations, fluctuationsRatio, localTradedAt` |
| 시장지표 일별 | `…/front-api/marketIndex/prices?category=&reutersCode=&page=&pageSize=10~60` | 최신순 `result[].localTradedAt, closePrice`. 환율은 `cashBuyValue, cashSellValue, sendValue, receiveValue`(은행 고시) 포함. `standardInterest` 는 히스토리 없음(404) |
| 지수 종합 | `m.stock.naver.com/api/index/{KOSPI\|KOSDAQ}/integration` | `dealTrendInfo`(당일 수급, 억원) · `programTrendInfo` · `upDownStockInfo`(전 종목 등락수) · `totalInfos`(52주 고저·거래대금) |
| 순위 | `m.stock.naver.com/api/stocks/{marketValue\|priceTop\|high52week\|low52week}/{KOSPI\|KOSDAQ}?page=1&pageSize=` | `stocks[]`, `totalCount`(신고/신저가 종목 수). `stockEndType` 으로 ETF 제외 |
| 업종 · 테마 | `m.stock.naver.com/api/stocks/{industry\|theme}?page=1&pageSize=` | `groups[].no, name, changeRate, riseCount, fallCount, steadyCount` |
| 종목 업종 | `m.stock.naver.com/api/stock/{코드}/integration` | `industryCode` (트리맵 그룹, 30일 캐시) |
| 차트 | `api.stock.naver.com/chart/{domestic/index\|foreign/index\|domestic/item}/{코드}/{day\|week\|minute}?startDateTime=YYYYMMDD0000&endDateTime=YYYYMMDD2359` | 일봉 `localDate, open/high/low/closePrice` (5년 1회), 분봉 `localDateTime, currentPrice` (국내 지수만) |
| 투자자 수급 | `stock.naver.com/api/domestic/market/trend/daily?tradeType=KRX&marketType=KOSPI&startIdx={페이지}&pageSize=200` | `content[].bizdate, netAmounts[].investorGubun, diffValue(원)`. 개인 8000 · 외국인 9000+9001 · 기관계 1000~6000 · 연기금 6000 |
| 예탁금·신용 | `stock.naver.com/api/domestic/market/trendDeposit?startIdx={페이지}&pageSize=100` | `customerDeposit, creditLoan` (억원) |
| 자동완성 | `ac.stock.naver.com/ac?q=&target=stock` | `items[].code, name, typeCode` |

## 2. 보조 소스

| 소스 | 용도 | 비고 |
|------|------|------|
| TradingView `scanner.tradingview.com/symbol?symbol=KRX:VKI1!&fields=close,change,change_abs,update_mode` | V-KOSPI 선물 현재가 | 20분 지연 |
| KRX OpenAPI `data-dbg.krx.co.kr/svc/apis/idx/drvprod_dd_trd` | VKOSPI 지수(일별) | `KRX_API_KEY` 설정 시 |
| Yahoo `query1.finance.yahoo.com/v8/finance/chart/{티커}` | 히스토리 백업 | 네이버 전체 수집 실패 시에만, 자주 429 |

## 3. 계산 지표

- **MacroScore**: SOX 20일·원/달러 20일·외국인 20일 누적·KOSPI 60일선 이격·나스닥100 20일·미 10년물 20일 변화·VIX 를 1년 분포 대비 z-score → 정규분포 누적확률 가중평균 (미국 지표는 평가일 이전 값만)
- **공포·탐욕**: 시장 폭(전 종목) 25 · 52주 신고/신저가 20 · 125일선 이격 25 · 실현변동성 백분위 20 · 원/달러 20일 10
- **달러 매수 타이밍**: [지표정리.md](지표정리.md#달러-매수-타이밍) 참조
