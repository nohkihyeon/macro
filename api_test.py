import urllib.request
import json
import re
import time

def test_api(name, url, parser_fn):
    print(f"\n==========================================")
    print(f"🔄 테스트 시작: {name}")
    print(f"🔗 호출 URL: {url}")
    print(f"==========================================")
    
    start_time = time.time()
    try:
        req = urllib.request.Request(
            url,
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124'
            }
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            latency = (time.time() - start_time) * 1000
            status = response.status
            content_type = response.headers.get_content_charset() or 'utf-8'
            
            # Naver handles EUC-KR encoding
            if 'naver.com' in url:
                raw_data = response.read()
                # Try EUC-KR first, fallback to UTF-8
                try:
                    data = raw_data.decode('euc-kr')
                except UnicodeDecodeError:
                    data = raw_data.decode('utf-8', errors='ignore')
            else:
                data = response.read().decode(content_type, errors='ignore')
            
            print(f"✅ 연결 성공! (상태 코드: {status} | 지연 속도: {latency:.1f}ms)")
            
            # Parse and display sample
            parser_fn(data)
            print(f"✨ {name} 테스트 결과: [성공]")
            return True
            
    except Exception as e:
        latency = (time.time() - start_time) * 1000
        print(f"❌ 연결 실패! (지연 속도: {latency:.1f}ms)")
        print(f"🚨 에러 내용: {e}")
        print(f"✨ {name} 테스트 결과: [실패]")
        return False

# ==========================================
# PARSERS FOR TEST VALIDATION
# ==========================================

def parse_yahoo_finance(data):
    obj = json.loads(data)
    chart = obj['chart']['result'][0]
    symbol = chart['meta']['symbol']
    timestamps = chart.get('timestamp', [])
    closes = chart['indicators']['quote'][0].get('close', [])
    
    print(f"📊 수집된 지수: {symbol}")
    print(f"📈 데이터 일수: {len(timestamps)}일")
    if len(timestamps) > 0:
        last_date = time.strftime('%Y-%m-%d', time.localtime(timestamps[-1]))
        last_price = closes[-1]
        print(f"📝 최근 종가 정보: 날짜={last_date}, 가격={last_price:.2f}")

def parse_naver_market_cap(data):
    # Match links like: <a href="/item/main.naver?code=005930" class="tltle">삼성전자</a>
    pattern = r'href="/item/main\.naver\?code=(\d+)" class="tltle">([^<]+)</a>'
    matches = re.findall(pattern, data)
    
    print(f"📊 파싱된 종목 수: {len(matches)}개")
    if len(matches) > 0:
        print(f"📝 시가총액 상위 5개 종목 샘플:")
        for idx, (code, name) in enumerate(matches[:5]):
            print(f"   [{idx+1}] 종목코드: {code} | 종목명: {name}")

def parse_naver_investors(data):
    # Match dates like: <td class="date">26.06.09</td>
    date_pattern = r'<td class="date">([^<]+)</td>'
    dates = re.findall(date_pattern, data)
    
    print(f"📊 파싱된 거래일 수: {len(dates)}일")
    if len(dates) > 0:
        print(f"📝 최근 3거래일 수급 날짜 샘플:")
        for idx, date in enumerate(dates[:3]):
            print(f"   [{idx+1}] 날짜: {date}")

# ==========================================
# MAIN EXECUTION
# ==========================================

if __name__ == '__main__':
    print("🚀 실시간 주식 데이터 API 수집 테스트 스크립트 실행")
    
    tests = [
        ("Yahoo Finance (KOSPI 지수)", "https://query1.finance.yahoo.com/v8/finance/chart/^KS11?range=5d&interval=1d", parse_yahoo_finance),
        ("Yahoo Finance (S&P 500 지수)", "https://query1.finance.yahoo.com/v8/finance/chart/^GSPC?range=5d&interval=1d", parse_yahoo_finance),
        ("네이버 금융 (KOSPI 시가총액 리스트)", "https://finance.naver.com/sise/sise_market_sum.naver?sosok=0&page=1", parse_naver_market_cap),
        ("네이버 금융 (투자자별 순매수 일별추이)", "https://finance.naver.com/sise/investorDealTrendDay.naver?page=1", parse_naver_investors),
    ]
    
    success_count = 0
    for name, url, parser in tests:
        if test_api(name, url, parser):
            success_count += 1
            
    print("\n==========================================")
    print(f"🏁 테스트 완료! ({success_count}/{len(tests)} 성공)")
    print("==========================================")
