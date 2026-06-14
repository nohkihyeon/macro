const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

async function testApi(name, url, parserFn) {
  console.log(`\n==========================================`);
  console.log(`🔄 테스트 시작: ${name}`);
  console.log(`🔗 호출 URL: ${url}`);
  console.log(`==========================================`);
  
  const startTime = Date.now();
  try {
    const config = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124'
      }
    };
    
    if (url.includes('naver.com')) {
      config.responseType = 'arraybuffer';
    }
    
    const res = await axios.get(url, config);
    const latency = Date.now() - startTime;
    console.log(`✅ 연결 성공! (상태 코드: ${res.status} | 지연 속도: ${latency}ms)`);
    
    let data = res.data;
    if (url.includes('naver.com')) {
      data = iconv.decode(res.data, 'EUC-KR');
    }
    
    parserFn(data);
    console.log(`✨ ${name} 테스트 결과: [성공]`);
    return true;
  } catch (e) {
    const latency = Date.now() - startTime;
    console.log(`❌ 연결 실패! (지연 속도: ${latency}ms)`);
    console.log(`🚨 에러 내용: ${e.message}`);
    console.log(`✨ ${name} 테스트 결과: [실패]`);
    return false;
  }
}

function parseYahooFinance(data) {
  const chart = data.chart.result[0];
  const symbol = chart.meta.symbol;
  const timestamps = chart.timestamp || [];
  const closes = chart.indicators.quote[0].close || [];
  
  console.log(`📊 수집된 지수: ${symbol}`);
  console.log(`📈 데이터 일수: ${timestamps.length}일`);
  if (timestamps.length > 0) {
    const lastDate = new Date(timestamps[timestamps.length - 1] * 1000).toISOString().split('T')[0];
    const lastPrice = closes[closes.length - 1];
    console.log(`📝 최근 종가 정보: 날짜=${lastDate}, 가격=${lastPrice.toFixed(2)}`);
  }
}

function parseNaverMarketCap(data) {
  const $ = cheerio.load(data);
  const stocks = [];
  $('table.type_2 tbody tr').each((i, el) => {
    const codeLink = $(el).find('a.tltle');
    if (codeLink.length === 0) return;
    const name = codeLink.text().trim();
    const href = codeLink.attr('href');
    const code = href.split('code=')[1];
    stocks.push({ code, name });
  });
  
  console.log(`📊 파싱된 종목 수: ${stocks.length}개`);
  if (stocks.length > 0) {
    console.log(`📝 시가총액 상위 5개 종목 샘플:`);
    stocks.slice(0, 5).forEach((s, idx) => {
      console.log(`   [${idx+1}] 종목코드: ${s.code} | 종목명: ${s.name}`);
    });
  }
}

function parseNaverInvestors(data) {
  const $ = cheerio.load(data);
  const dates = [];
  $('table.type_1 tr').each((i, el) => {
    const dateCell = $(el).find('td.date');
    if (dateCell.length === 0) return;
    dates.push(dateCell.text().trim());
  });
  
  console.log(`📊 파싱된 거래일 수: ${dates.length}일`);
  if (dates.length > 0) {
    console.log(`📝 최근 3거래일 수급 날짜 샘플:`);
    dates.slice(0, 3).forEach((d, idx) => {
      console.log(`   [${idx+1}] 날짜: ${d}`);
    });
  }
}

async function main() {
  console.log("🚀 실시간 주식 데이터 API 수집 테스트 스크립트 실행 (Node.js)");
  
  const tests = [
    { name: "Yahoo Finance (KOSPI 지수)", url: "https://query1.finance.yahoo.com/v8/finance/chart/^KS11?range=5d&interval=1d", parser: parseYahooFinance },
    { name: "Yahoo Finance (S&P 500 지수)", url: "https://query1.finance.yahoo.com/v8/finance/chart/^GSPC?range=5d&interval=1d", parser: parseYahooFinance },
    { name: "네이버 금융 (KOSPI 시가총액 리스트)", url: "https://finance.naver.com/sise/sise_market_sum.naver?sosok=0&page=1", parser: parseNaverMarketCap },
    { name: "네이버 금융 (투자자별 순매수 일별추이)", url: "https://finance.naver.com/sise/investorDealTrendDay.naver?page=1", parser: parseNaverInvestors },
  ];
  
  let successCount = 0;
  for (const t of tests) {
    const success = await testApi(t.name, t.url, t.parser);
    if (success) successCount++;
  }
  
  console.log(`\n==========================================`);
  console.log(`🏁 테스트 완료! (${successCount}/${tests.length} 성공)`);
  console.log(`==========================================`);
}

main();
