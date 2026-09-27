const { TronWeb } = require('tronweb');

// Single platform-wide TRC20 (USDT on TRON) deposit address. Every account
// deposits to this same address — no per-user wallets are generated.
// It is read only from the server environment (TRC20_DEPOSIT_ADDRESS), never
// from request bodies or PlatformSettings, so no user or admin API call can
// change it.
const DEFAULT_TRC20_DEPOSIT_ADDRESS = 'TFk6S5zkJKuFAb1QjbHDVr2Lv95oSSCYLN';

function resolveAddress() {
  const fromEnv = (process.env.TRC20_DEPOSIT_ADDRESS || '').trim();
  if (!fromEnv) return DEFAULT_TRC20_DEPOSIT_ADDRESS;
  if (!TronWeb.isAddress(fromEnv)) {
    console.error(`[DepositAddress] TRC20_DEPOSIT_ADDRESS "${fromEnv}" is not a valid TRON address — using default ${DEFAULT_TRC20_DEPOSIT_ADDRESS}`);
    return DEFAULT_TRC20_DEPOSIT_ADDRESS;
  }
  return fromEnv;
}

const TRC20_DEPOSIT_ADDRESS = resolveAddress();

function getDepositAddress() {
  return TRC20_DEPOSIT_ADDRESS;
}

module.exports = { getDepositAddress, DEPOSIT_NETWORK: 'TRC20' };
