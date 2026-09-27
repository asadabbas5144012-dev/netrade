const WebSocket = require('ws');
const https = require('https');

const TARGET_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'ADAUSDT', 'DOGEUSDT', 'TRXUSDT', 'TONUSDT', 'LTCUSDT',
  'DASHUSDT', 'ZECUSDT', 'SHIBUSDT', 'LINKUSDT', 'YFIUSDT',
  'BCHUSDT', 'DOTUSDT', 'FILUSDT'
];

const COINGECKO_MAP = {
  'BTC/USDT': 'bitcoin', 'ETH/USDT': 'ethereum', 'BNB/USDT': 'binancecoin',
  'SOL/USDT': 'solana', 'XRP/USDT': 'ripple', 'ADA/USDT': 'cardano',
  'DOGE/USDT': 'dogecoin', 'TRX/USDT': 'tron', 'TON/USDT': 'toncoin', 'LTC/USDT': 'litecoin'
};

class MarketService {
  constructor(io) {
    this.io = io;
    this.prices = {};

    TARGET_SYMBOLS.forEach(sym => {
      const pair = sym.replace('USDT', '/USDT');
      this.prices[pair] = { price: 0, change: 0, close: 0, high: 0, low: 0, volume: 0 };
    });

    this.fetchMexcRest();
    setInterval(() => this.fetchMexcRest(), 2000);

    this.lastMexcSuccess = Date.now();
    setInterval(() => {
      if (Date.now() - this.lastMexcSuccess > 15000) {
        console.log('MEXC API delayed — fetching CoinGecko fallback...');
        this.fetchCoinGecko();
      }
    }, 15000);

    this.lastEmit = 0;
    setInterval(() => {
      if (Date.now() - this.lastEmit >= 1000) {
        this.io.emit('market_update', this.prices);
        this.lastEmit = Date.now();
      }
    }, 1000);
  }

  fetchMexcRest() {
    const options = {
      hostname: 'api.mexc.com',
      path: '/api/v3/ticker/24hr',
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) return;
          const tickers = JSON.parse(body);
          tickers.forEach(ticker => {
            if (TARGET_SYMBOLS.includes(ticker.symbol)) {
              const pair = ticker.symbol.replace('USDT', '/USDT');
              const currentPrice = parseFloat(ticker.lastPrice);
              const changePercent = parseFloat(ticker.priceChangePercent) * 100;
              this.prices[pair] = {
                price: currentPrice,
                change: changePercent,
                high: parseFloat(ticker.highPrice),
                low: parseFloat(ticker.lowPrice),
                volume: parseFloat(ticker.volume)
              };
            }
          });
          this.lastMexcSuccess = Date.now();
        } catch (e) {}
      });
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end();
  }

  fetchCoinGecko() {
    const ids = Object.values(COINGECKO_MAP).join(',');
    const path = '/api/v3/simple/price?ids=' + ids + '&vs_currencies=usd&include_24hr_change=true';
    const options = {
      hostname: 'api.coingecko.com',
      path,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) return;
          const data = JSON.parse(body);
          for (const [pair, cgId] of Object.entries(COINGECKO_MAP)) {
            const d = data[cgId];
            if (!d) continue;
            this.prices[pair] = {
              price: d.usd,
              change: d.usd_24h_change || 0,
              high: d.usd,
              low: d.usd,
              volume: 0
            };
          }
        } catch (e) {}
      });
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end();
  }

  getPrice(pair) {
    return this.prices[pair] || { price: 0, change: 0 };
  }
}

module.exports = MarketService;
