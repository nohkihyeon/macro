# 수집 대상 주식 데이터 API 규격서

본 문서는 대시보드에 사용되는 실시간 및 역사적 주식 데이터 API 엔드포인트와 데이터 추출 방법을 정리한 문서입니다.

> 구현 위치: 외부 소스 페처는 [pipeline/sources.js](pipeline/sources.js), 지표↔소스 매핑·합성 폴백은 [pipeline/catalog.js](pipeline/catalog.js), 서버 엔드포인트는 [server.js](server.js)에 있습니다. 소스 상태 점검은 `node pipeline/check.js`.

---

## 0. 서버 제공 엔드포인트 (프론트엔드용)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/api/series/:id?range=1w\|1m\|1y\|5y` | 단일 지표 시계열. `{source:'live'\|'unavailable', kind, values, dates, quote}`. 라이브 소스가 없으면 프론트가 합성 샘플로 대체 |
| `GET` | `/api/quotes?ids=kospi,kosdaq,sp500,nasdaq,usdkrw` | 상단 KPI용 배치 현재가/등락률 |
| `GET` | `/api/treemap?market=kospi\|kosdaq&period=daily\|weekly` | 네이버 시총 상위 → 업종 그룹 트리맵 시리즈 |
| `GET` | `/api/global?range=1y` | 글로벌 지수(10종) 시작점=0% 정규화 멀티라인 |
| `GET` | `/api/investors` | 투자자별 누적 순매수(개인·외국인·기관·연기금, 조원) + 외국인 vs KOSPI 이중축 데이터 |
| `GET` | `/api/breadth?market=kospi` | 시장 폭 — 상승/하락/보합 종목 수 |
| `GET` | `/api/health` | 외부 소스(Yahoo·네이버) 생존 상태 요약 |

라이브 지표(Yahoo·네이버): 코스피/코스닥/코스피200·환율(USD·100엔·EUR)·원자재(WTI·금·구리)·업종등락·트리맵·글로벌비교·수급막대.
합성 샘플 지표(라이브 소스 없음): 기준금리·콜금리·국고채 3/10년·VKOSPI·공포탐욕지수.

---

## 1. 글로벌 지수 API (Yahoo Finance)
글로벌 증시 지수의 실시간 현재가 및 1년 단위의 역사적 데이터를 수집하기 위해 사용합니다.

*   **API 엔드포인트**: `https://query1.finance.yahoo.com/v8/finance/chart/{Ticker}?range={Range}&interval={Interval}`
*   **사용 파라미터**:
    *   `Ticker`: 지수 심볼 (KOSPI: `^KS11`, KOSDAQ: `^KQ11`, S&P 500: `^GSPC`, NASDAQ: `^IXIC`, Nikkei 225: `^N225`)
    *   `Range`: 기간 (실시간 갱신용: `5d`, 1년 차트용: `1y`)
    *   `Interval`: 데이터 주기 (`1d`)
*   **응답 데이터 형식**: `JSON`
*   **데이터 추출 경로**:
    *   타임스탬프 배열: `chart.result[0].timestamp` (Unix Epoch, 초 단위)
    *   종가(Close) 배열: `chart.result[0].indicators.quote[0].close` (소수점 포함)

---

## 2. KOSPI 트리맵용 상위 종목 데이터 (네이버 금융)
KOSPI 시가총액 상위 종목들의 크기(시가총액)와 색상(당일 등락률)을 시각화하기 위해 웹 스크래핑을 수행합니다.

*   **웹 페이지 URL**: `https://finance.naver.com/sise/sise_market_sum.naver?sosok={Market}&page={Page}`
*   **사용 파라미터**:
    *   `Market`: 시장 구분 (KOSPI: `0`, KOSDAQ: `1`)
    *   `Page`: 페이지 번호 (1페이지당 50종목 노출)
*   **응답 데이터 형식**: `HTML` (EUC-KR 인코딩)
*   **데이터 파싱 타겟**:
    *   종목 코드 및 이름: `<a href="/item/main.naver?code={6자리코드}" class="tltle">{종목명}</a>`
    *   당일 등락률: 각 종목 행(`tr`)의 `td.number` 중 3번째 요소 (예: `+1.15%`, `-2.30%`)
    *   시가총액: 각 종목 행(`tr`)의 `td.number` 중 5번째 요소 (단위: 억원)

---

## 3. 투자자별 수급 데이터 (네이버 금융)
KOSPI 시장의 주체별(개인, 외국인, 기관, 연기금) 매매 누적 추이를 분석하기 위해 사용합니다.

*   **웹 페이지 URL**: `https://finance.naver.com/sise/investorDealTrendDay.naver?page={Page}`
*   **사용 파라미터**:
    *   `Page`: 페이지 번호 (1페이지당 10거래일 노출)
*   **응답 데이터 형식**: `HTML` (EUC-KR 인코딩)
*   **데이터 파싱 타겟**:
    *   날짜: `<td class="date">{YY.MM.DD}</td>`
    *   주체별 순매수액 (단위: 억원): 각 행(`tr`)의 `td.number` 인덱스 순서
        1.  **개인**: 1번째 `td.number`
        2.  **외국인**: 2번째 `td.number`
        3.  **기관**: 3번째 `td.number`
        4.  **연기금**: 9번째 `td.number`

---

## 4. 국내금리 일별 (네이버 marketindex)

콜금리·국고채 3년·CD 91일·회사채 3년의 일별 시계열을 스크래핑합니다 (페이지당 ~7영업일).

*   **웹 페이지 URL**: `https://finance.naver.com/marketindex/interestDailyQuote.naver?marketindexCd={Code}&page={Page}`
*   **코드**: 콜금리 `IRR_CALL` · 국고채 3년 `IRR_GOVT03Y` · CD 91일 `IRR_CD91` · 회사채(AA-) 3년 `IRR_CORP03Y`
*   **파싱**: `table tr` 의 `td[0]`=날짜(`YYYY.MM.DD`), `td[1]`=금리(%). 1년치는 약 38페이지, 서버에서 1시간 캐시.
*   **미제공(합성 샘플로 대체)**: 기준금리·국고채 10년·VKOSPI — 무료 시계열 소스가 없어 결정론적 합성값 사용.

---

## 5. 공포·탐욕 지수 (자체 계산)

별도 소스 없이 보유 데이터로 합성하는 0~100 게이지 (높을수록 탐욕).

*   **breadth**(40%): 시총 상위 종목 상승/하락 비율 (`computeBreadth`)
*   **모멘텀**(35%): KOSPI 1개월 수익률을 −8%~+8% → 0~1 정규화
*   **변동성**(25%): Yahoo `^VIX` 를 10~38 → 1~0 역정규화
*   합산 후 1~99로 클램프. 5분 캐시. (`computeFearGreed` in [server.js](server.js))
