// 테스트 공통: 실제 응답을 잘라 둔 fixtures 로 업스트림을 흉내 내는 fetch
const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');
const load = name => fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8');

const ROUTES = [
  [/realtime\/domestic\/index\//, 'domestic_indices'],
  [/realtime\/worldstock\/index\//, 'world_indices'],
  [/realtime\/domestic\/stock\//, 'stock_quotes'],
  [/marketIndex\/majors/, 'majors'],
  [/marketIndex\/prices/, 'marketindex_usdkrw'],
  [/\/api\/index\/[^/]+\/integration/, 'integration_kospi'],
  [/\/api\/stocks\/marketValue\//, 'market_value'],
  [/\/api\/stocks\/priceTop\//, 'price_top'],
  [/\/api\/stocks\/(high|low)52week\//, 'high52week'],
  [/\/api\/stocks\/industry/, 'industries'],
  [/\/api\/stocks\/theme/, 'themes'],
  [/\/api\/stock\/[^/]+\/integration/, 'stock_integration'],
  [/\/chart\/.*\/minute/, 'minute_kospi'],
  [/\/chart\//, 'chart_kospi_day'],
  [/market\/trend\/daily/, 'flows_kospi'],
  [/market\/trendDeposit/, 'deposit'],
  [/ac\.stock\.naver\.com/, 'autocomplete'],
  [/scanner\.tradingview\.com/, 'tradingview_vki'],
];

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });

// calls 에 요청 URL 이 쌓인다. override(url) 가 응답을 돌려주면 그것을 우선 사용
function fixtureFetch(override) {
  const calls = [];
  const fetch = async url => {
    calls.push(url);
    const custom = override && override(url);
    if (custom) return custom;
    const hit = ROUTES.find(([re]) => re.test(url));
    return hit ? response(200, load(hit[1])) : response(404, '{}');
  };
  fetch.calls = calls;
  return fetch;
}

module.exports = { fixtureFetch, response, load };
