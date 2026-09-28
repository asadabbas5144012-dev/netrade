const https = require('https');
const { TronWeb } = require('tronweb');
const { getDepositAddress } = require('../config/depositAddress');

// Verifies a user-submitted TXID against the TRON chain: it must be a
// confirmed USDT (TRC20) Transfer to the single platform receiving address.
// Read-only public API calls — no private key or seed phrase involved.

const USDT_CONTRACT = {
  mainnet: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  shasta: 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs'
};
const USDT_DECIMALS = 6;

const network = process.env.TRON_NETWORK === 'shasta' ? 'shasta' : 'mainnet';
const baseHost = network === 'mainnet' ? 'api.trongrid.io' : 'api.shasta.trongrid.io';
const usdtContract = process.env.USDT_CONTRACT_ADDRESS || USDT_CONTRACT[network];

function getJson(path) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json' };
    if (process.env.TRON_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRON_API_KEY;
    const req = https.request({ hostname: baseHost, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        // Without TRON_API_KEY, TronGrid rate-limits aggressively (HTTP 429).
        if (res.statusCode === 429) return reject(new Error('Verification service is busy. Please try again in a minute.'));
        if (res.statusCode !== 200) return reject(new Error('Could not reach the TRON network. Please try again later.'));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid TronGrid response')); }
      });
    });
    req.on('error', () => reject(new Error('Could not reach the TRON network. Please try again later.')));
    req.setTimeout(10000, () => req.destroy());
    req.end();
  });
}

// TronGrid event results carry addresses as 0x-prefixed 20-byte hex.
function hexToBase58(hex) {
  return TronWeb.address.fromHex('41' + String(hex).replace(/^0x/, '').padStart(40, '0'));
}

function isTxHash(txHash) {
  return /^[0-9a-fA-F]{64}$/.test(txHash || '');
}

// Resolves to { txHash, fromAddress, amount } for a confirmed USDT transfer to
// the receiving address, or throws an Error with a user-facing message.
async function verifyUsdtDeposit(txHash) {
  if (!isTxHash(txHash)) throw new Error('Invalid transaction hash');
  const receivingAddress = getDepositAddress();

  const parsed = await getJson(`/v1/transactions/${txHash.toLowerCase()}/events?only_confirmed=true`);
  const events = Array.isArray(parsed.data) ? parsed.data : [];
  if (!events.length) throw new Error('Transaction not found or not yet confirmed. Please try again in a few minutes.');

  let amountRaw = 0n;
  let fromAddress = null;
  for (const ev of events) {
    if (ev.event_name !== 'Transfer' || ev.contract_address !== usdtContract || !ev.result) continue;
    if (hexToBase58(ev.result.to) !== receivingAddress) continue;
    amountRaw += BigInt(ev.result.value || '0');
    fromAddress = fromAddress || hexToBase58(ev.result.from);
  }
  if (amountRaw <= 0n) throw new Error('This transaction is not a USDT (TRC20) transfer to the platform deposit address.');

  return {
    txHash: txHash.toLowerCase(),
    fromAddress,
    amount: Number(amountRaw) / Math.pow(10, USDT_DECIMALS)
  };
}

module.exports = { verifyUsdtDeposit, isTxHash };
