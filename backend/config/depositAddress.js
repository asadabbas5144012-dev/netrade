const { TronWeb } = require('tronweb');

// Single platform-wide TRC20 (USDT on TRON) receiving address. Every account
// deposits to this same address — no wallets are generated, derived or
// assigned, and no private key or seed phrase is needed to receive.
// It is read only from the server environment (TRC20_RECEIVING_ADDRESS), never
// from request bodies or PlatformSettings, so no user or admin API call can
// change it. TRC20_DEPOSIT_ADDRESS is still accepted as a legacy alias.
const DEFAULT_TRC20_RECEIVING_ADDRESS = 'TFk6S5zkJKuFAb1QjbHDVr2Lv95oSSCYLN';

function resolveAddress() {
  const fromEnv = (process.env.TRC20_RECEIVING_ADDRESS || process.env.TRC20_DEPOSIT_ADDRESS || '').trim();
  if (!fromEnv) return DEFAULT_TRC20_RECEIVING_ADDRESS;
  if (!TronWeb.isAddress(fromEnv)) {
    console.error(`[DepositAddress] TRC20_RECEIVING_ADDRESS "${fromEnv}" is not a valid TRON address — using default ${DEFAULT_TRC20_RECEIVING_ADDRESS}`);
    return DEFAULT_TRC20_RECEIVING_ADDRESS;
  }
  return fromEnv;
}

const TRC20_RECEIVING_ADDRESS = resolveAddress();

function getDepositAddress() {
  return TRC20_RECEIVING_ADDRESS;
}

module.exports = { getDepositAddress, DEPOSIT_NETWORK: 'TRC20' };
