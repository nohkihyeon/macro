const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

async function scrapeNaverMarketCap() {
  try {
    const url = 'https://finance.naver.com/sise/sise_market_sum.naver?sosok=0&page=1';
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    // Decode EUC-KR
    const decoded = iconv.decode(res.data, 'EUC-KR');
    const $ = cheerio.load(decoded);
    
    const stocks = [];
    $('table.type_2 tbody tr').each((i, el) => {
      const codeLink = $(el).find('a.tltle');
      if (codeLink.length === 0) return; // skip headers
      
      const name = codeLink.text().trim();
      const href = codeLink.attr('href');
      const code = href.split('code=')[1];
      
      const tds = $(el).find('td.number');
      if (tds.length === 0) return;
      
      const price = $(tds[0]).text().trim();
      const changeRateText = $(tds[2]).text().trim().replace(/[\n\t%]/g, '');
      const changeRate = parseFloat(changeRateText);
      
      const marketCapText = $(tds[4]).text().trim().replace(/,/g, '');
      const marketCap = parseFloat(marketCapText); // 억원 단위
      
      stocks.push({ name, code, price, changeRate, marketCap });
    });
    
    console.log(`Successfully scraped ${stocks.length} stocks from KOSPI page 1.`);
    console.log('Top 5 stocks:', stocks.slice(0, 5));
  } catch (e) {
    console.error('Failed to fetch:', e.message);
  }
}

scrapeNaverMarketCap();
