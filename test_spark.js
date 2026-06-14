const axios = require('axios');

async function testSpark() {
  try {
    const symbols = ['005930.KS', '000660.KS'].join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols}&range=5d&interval=1d`;
    const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    
    const results = res.data.spark.result;
    results.forEach(r => {
      const symbol = r.symbol;
      const quote = r.response[0].indicators.quote[0];
      const close = quote.close;
      const first = close[0];
      const last = close[close.length - 1];
      const pct = ((last - first) / first) * 100;
      console.log(`Symbol: ${symbol} | Prices: ${JSON.stringify(close)} | Weekly Change: ${pct.toFixed(2)}%`);
    });
  } catch (e) {
    console.error(e.message);
  }
}

testSpark();
