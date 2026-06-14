const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

async function debug() {
  try {
    const url = 'https://finance.naver.com/sise/sise_market_sum.naver?sosok=0&page=1';
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const decoded = iconv.decode(res.data, 'EUC-KR');
    const $ = cheerio.load(decoded);
    
    // Get headers
    const headers = [];
    $('table.type_2 thead tr th').each((i, el) => {
      headers.push($(el).text().trim());
    });
    console.log('Headers:', headers);
    
    // Get first row values
    const firstRowTds = [];
    $('table.type_2 tbody tr').each((i, el) => {
      const codeLink = $(el).find('a.tltle');
      if (codeLink.length > 0 && firstRowTds.length === 0) {
        $(el).find('td').each((j, tdEl) => {
          firstRowTds.push({ index: j, text: $(tdEl).text().trim() });
        });
      }
    });
    console.log('First Row Cells:');
    firstRowTds.forEach(cell => {
      console.log(`Index ${cell.index}: "${cell.text}"`);
    });
  } catch (e) {
    console.error(e);
  }
}

debug();
