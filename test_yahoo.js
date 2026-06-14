const axios = require('axios');

async function test() {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/^GSPC?range=1y&interval=1d';
    const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const chart = res.data.chart.result[0];
    const timestamps = chart.timestamp;
    const close = chart.indicators.quote[0].close;
    console.log(`Success! Fetched ${timestamps.length} days of data for S&P 500.`);
    console.log('First data point:', new Date(timestamps[0] * 1000).toISOString(), close[0]);
    console.log('Last data point:', new Date(timestamps[timestamps.length - 1] * 1000).toISOString(), close[close.length - 1]);
  } catch (e) {
    console.error('Failed to fetch:', e.message);
  }
}

test();
