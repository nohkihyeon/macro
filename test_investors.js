const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

async function scrapeNaverInvestors() {
  try {
    const url = 'https://finance.naver.com/sise/investorDealTrendDay.naver?page=1';
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    // Decode EUC-KR
    const decoded = iconv.decode(res.data, 'EUC-KR');
    const $ = cheerio.load(decoded);
    
    const records = [];
    $('table.type_1 tr').each((i, el) => {
      const dateCell = $(el).find('td.date');
      if (dateCell.length === 0) return; // skip header/empty rows
      
      const date = dateCell.text().trim();
      
      // Numbers are in td.number
      const numbers = [];
      $(el).find('td.number').each((j, numEl) => {
        const valText = $(numEl).text().trim().replace(/,/g, '');
        numbers.push(parseInt(valText) || 0);
      });
      
      if (numbers.length >= 9) {
        records.push({
          date,
          individual: numbers[0],  // 개인
          foreigner: numbers[1],   // 외국인
          institution: numbers[2], // 기관합계
          pension: numbers[8]      // 연기금
        });
      }
    });
    
    console.log(`Successfully scraped ${records.length} days of investor data.`);
    console.log('Top 5 rows:', records.slice(0, 5));
  } catch (e) {
    console.error('Failed to fetch:', e.message);
  }
}

scrapeNaverInvestors();
