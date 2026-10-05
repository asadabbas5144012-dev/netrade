const express = require('express');
const prisma = require('../prismaClient');
const QRCode = require('qrcode');
const router = express.Router();
const authMiddleware = require('../middlewares/auth');
const { getDepositAddress, DEPOSIT_NETWORK } = require('../config/depositAddress');
const { verifyUsdtDeposit, isTxHash } = require('../services/trc20Verifier');
const { debit, InsufficientBalance } = require('../services/ledger');

// ── TRC20 DEPOSIT ADDRESS + QR CODE ──
// Same fixed platform address for every account (see config/depositAddress.js).
router.get('/address', authMiddleware, async (req, res) => {
  try {
    const address = getDepositAddress();
    const qr = await QRCode.toDataURL(address);
    res.json({ address, network: DEPOSIT_NETWORK, qr_code_base64: qr });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── SUBMIT TRC20 DEPOSIT TXID ──
// Everyone shares one receiving address, so a deposit is matched to its user
// by the TXID they submit. The TXID is verified on-chain (confirmed USDT
// transfer to the receiving address) and recorded as pending_approval for the
// admin to approve; the unique txHash prevents the same transfer being
// claimed twice.
const MIN_DEPOSIT_USDT = 1;
router.post('/deposit/submit', authMiddleware, async (req, res) => {
  try {
    const txHash = String(req.body.txHash || '').trim().toLowerCase();
    if (!isTxHash(txHash)) return res.status(400).json({ error: 'Please enter a valid 64-character transaction hash (TXID).' });

    const existing = await prisma.deposit.findUnique({ where: { txHash } });
    if (existing) return res.status(409).json({ error: 'This transaction has already been submitted.' });

    let verified;
    try {
      verified = await verifyUsdtDeposit(txHash);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (verified.amount < MIN_DEPOSIT_USDT) {
      return res.status(400).json({ error: `Minimum deposit is ${MIN_DEPOSIT_USDT} USDT.` });
    }

    const deposit = await prisma.deposit.create({
      data: {
        userId: req.user.userId,
        txHash: verified.txHash,
        fromAddress: verified.fromAddress || '',
        amount: verified.amount,
        currency: 'USDT',
        status: 'pending_approval'
      }
    });
    res.json({ success: true, deposit: { id: deposit.id, amount: deposit.amount, status: deposit.status } });
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'This transaction has already been submitted.' });
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── BALANCE (balance + lockedBalance) ──
router.get('/balance', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { balance: true, exchangeBalance: true, perpetualBalance: true, lockedBalance: true }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ balance: user.balance, exchangeBalance: user.exchangeBalance, perpetualBalance: user.perpetualBalance, lockedBalance: user.lockedBalance });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── TRX DEPOSIT HISTORY ──
router.get('/deposits', authMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const deposits = await prisma.deposit.findMany({
      where: { userId: req.user.userId },
      orderBy: { detectedAt: 'desc' },
      skip: (page - 1) * 20,
      take: 20
    });
    res.json(deposits);
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── TRX WITHDRAWAL HISTORY ──
router.get('/withdrawals', authMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const withdrawals = await prisma.withdrawal.findMany({
      where: { userId: req.user.userId },
      orderBy: { requestedAt: 'desc' },
      skip: (page - 1) * 20,
      take: 20
    });
    res.json(withdrawals);
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── TRX WITHDRAWAL REQUEST ──
router.post('/withdraw', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.suspended) return res.status(403).json({ error: 'Account suspended: ' + (user.suspendedReason || 'Contact support') });
    if (!user.boundAddress) return res.status(400).json({ error: 'Please bind a withdrawal address first' });

    if (user.withdrawFreezeUntil && new Date() < new Date(user.withdrawFreezeUntil)) {
      const remaining = Math.ceil((new Date(user.withdrawFreezeUntil) - new Date()) / 3600000);
      return res.status(403).json({ error: `Withdrawals frozen for ${remaining} more hour(s) after address change.` });
    }
    // Sub-cent tolerance — Float storage/arithmetic drift (e.g. balance
    // stored as 355.529999999999996 for a "355.53" credit) can otherwise
    // make an exact/full-balance transfer falsely fail as "insufficient".
    if (user.balance < amt - 0.005) return res.status(400).json({ error: 'Insufficient balance' });

    // The admin panel's withdrawals table already had UI ready to show a
    // Fee/Send breakdown per row (handlingFeeAmount/handlingFeePct/
    // finalAmount), but nothing ever calculated or stored these — every
    // withdrawal showed just the raw amount with no fee breakdown at all.
    const feeSetting = await prisma.platformSettings.findUnique({ where: { key: 'withdrawal_handling_fee_pct' } });
    const feePct = parseFloat(feeSetting?.value ?? '8');
    const feeAmount = amt * (feePct / 100);
    const finalAmount = Math.max(0, amt - feeAmount);

    // Lock balance: move from balance → lockedBalance (pending admin approval).
    // The debit is conditional so simultaneous requests cannot overspend.
    let withdrawal;
    try {
      withdrawal = await prisma.$transaction(async (tx) => {
        if (!(await debit(tx, user.id, 'balance', amt))) throw new InsufficientBalance();
        await tx.user.update({ where: { id: user.id }, data: { lockedBalance: { increment: amt } } });
        return tx.withdrawal.create({
          data: {
            userId: user.id,
            toAddress: user.boundAddress,
            network: 'TRC20',
            amount: amt,
            handlingFeePct: feePct,
            handlingFeeAmount: feeAmount,
            finalAmount,
            status: 'pending'
          }
        });
      });
    } catch (e) {
      if (e instanceof InsufficientBalance) return res.status(400).json({ error: 'Insufficient balance' });
      throw e;
    }

    if (global.ns) await global.ns.send(req.user.userId, 'Withdrawal Submitted', `Your withdrawal of ${amt} USDT to ${user.boundAddress} is pending admin approval.`, 'WITHDRAWAL');
    res.json(withdrawal);
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── BIND WITHDRAWAL ADDRESS ──
router.get('/bound-address', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { boundAddress: true, boundAddressChain: true, withdrawFreezeUntil: true }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      address: user.boundAddress || null,
      chain: user.boundAddressChain || null,
      freezeUntil: user.withdrawFreezeUntil || null
    });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/bind-address', authMiddleware, async (req, res) => {
  try {
    const { address, chain } = req.body;
    if (!address || address.trim().length < 10) return res.status(400).json({ error: 'Valid wallet address required' });
    const chainType = chain || 'TRC20';
    const current = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { boundAddress: true } });
    if (!current) return res.status(404).json({ error: 'User not found' });
    const data = { boundAddress: address.trim(), boundAddressChain: chainType };
    // Replacing an already-bound address gets the same 24h withdrawal freeze
    // as unbinding, so the freeze cannot be skipped by binding over it.
    if (current.boundAddress && current.boundAddress !== address.trim()) {
      data.withdrawFreezeUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    }
    await prisma.user.update({ where: { id: req.user.userId }, data });
    res.json({ success: true, address: address.trim(), chain: chainType, freezeUntil: data.withdrawFreezeUntil || null });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/unbind-address', authMiddleware, async (req, res) => {
  try {
    const freezeUntil = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
    await prisma.user.update({
      where: { id: req.user.userId },
      data: { boundAddress: null, boundAddressChain: null, withdrawFreezeUntil: freezeUntil }
    });
    res.json({ success: true, freezeUntil });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── EXISTING ROUTES (kept for backward compatibility) ──

router.get('/info', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const addresses = { [DEPOSIT_NETWORK]: getDepositAddress() };
    res.json({
      balance: user.balance,
      exchangeBalance: user.exchangeBalance,
      perpetualBalance: user.perpetualBalance,
      lockedBalance: user.lockedBalance,
      profitBalance: user.profitBalance,
      referralBalance: user.referralBalance,
      email: user.email,
      addresses
    });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// "All Transactions" used to only read the legacy Transaction table (the
// old manual deposit/withdrawal-request flow + referral commissions).
// Real crypto deposits/withdrawals live in their own Deposit/Withdrawal
// models, admin balance credits/debits in BalanceAdjustment, and
// Exchange/Trade/Perpetual moves in WalletTransferLog — none of those
// ever showed up here. This merges all five sources into one normalized,
// date-sorted list instead.
router.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const page = parseInt(req.query.page) || 1;

    const depositStatusMap = { pending_approval: 'PENDING', confirmed: 'COMPLETED', rejected: 'FAILED' };
    const withdrawalStatusMap = { pending: 'PENDING', completed: 'COMPLETED', failed: 'FAILED', rejected: 'FAILED' };

    const [txs, deposits, withdrawals, adjustments, transfers] = await Promise.all([
      prisma.transaction.findMany({ where: { userId } }),
      prisma.deposit.findMany({ where: { userId } }),
      prisma.withdrawal.findMany({ where: { userId } }),
      prisma.balanceAdjustment.findMany({ where: { userId } }),
      prisma.walletTransferLog.findMany({ where: { userId } })
    ]);

    const merged = [
      ...txs.map(t => ({ id: t.id, type: t.type, amount: t.amount, status: t.status, createdAt: t.createdAt, note: t.note })),
      ...deposits.map(d => ({ id: d.id, type: 'DEPOSIT', amount: d.amount, status: depositStatusMap[d.status] || d.status.toUpperCase(), createdAt: d.detectedAt, note: `${d.currency || 'USDT'} deposit` })),
      ...withdrawals.map(w => ({ id: w.id, type: 'WITHDRAWAL', amount: w.amount, status: withdrawalStatusMap[w.status] || w.status.toUpperCase(), createdAt: w.requestedAt, note: 'To ' + w.toAddress })),
      ...adjustments.map(a => ({ id: a.id, type: 'ADJUSTMENT_' + (a.type || '').toUpperCase(), amount: a.amount, status: 'COMPLETED', createdAt: a.createdAt, note: a.reason })),
      ...transfers.map(w => ({ id: w.id, type: 'TRANSFER', amount: w.amount, status: 'COMPLETED', createdAt: w.createdAt, note: `${w.fromWallet} → ${w.toWallet}` }))
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const start = (page - 1) * 20;
    res.json(merged.slice(start, start + 20));
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/invest', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
    const result = await global.ws.invest(req.user.userId, amt);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/wallet/convert — move USDT to convertedBalance (total assets unchanged)
router.post('/convert', authMiddleware, async (req, res) => {
  try {
    const { fromAmount, toAsset, rate } = req.body;
    const amt = parseFloat(fromAmount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!toAsset || !rate) return res.status(400).json({ error: 'Missing asset or rate' });

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < amt - 0.005) return res.status(400).json({ error: 'Insufficient balance' });

    const toAmount = (amt / parseFloat(rate)).toFixed(8);

    const ok = await prisma.$transaction(async (tx) => {
      if (!(await debit(tx, user.id, 'balance', amt))) return false;
      await tx.user.update({ where: { id: user.id }, data: { convertedBalance: { increment: amt } } });
      return true;
    });
    if (!ok) return res.status(400).json({ error: 'Insufficient balance' });

    res.json({ success: true, fromAmount: amt, toAmount, toAsset });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── WALLET TRANSFER — Exchange <-> Perpetual only (Trade wallet removed) ──
// Exchange (balance) is for deposit/withdrawal; Perpetual is for trading.
// Free, instant transfer — no lock period or early-withdrawal penalty.
router.post('/transfer', authMiddleware, async (req, res) => {
  try {
    const { fromWallet, toWallet, amount } = req.body;
    let amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const validWallets = ['Exchange', 'Perpetual'];
    if (!validWallets.includes(fromWallet) || !validWallets.includes(toWallet) || fromWallet === toWallet) {
      return res.status(400).json({ error: 'Invalid transfer wallets' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const fromField = fromWallet === 'Exchange' ? 'balance' : 'perpetualBalance';
    const toField = toWallet === 'Exchange' ? 'balance' : 'perpetualBalance';

    // Sub-cent tolerance for Float storage/arithmetic drift — otherwise
    // transferring the exact displayed balance (e.g. "355.53" when the
    // stored value is really 355.529999999999996) falsely fails as
    // insufficient. Clamp to the real stored balance afterward so the
    // decrement below never dips the source wallet negative from float noise.
    if (user[fromField] < amt - 0.005) return res.status(400).json({ error: 'Insufficient balance in source wallet' });
    amt = Math.min(amt, user[fromField]);

    const ok = await prisma.$transaction(async (tx) => {
      if (!(await debit(tx, user.id, fromField, amt))) return false;
      await tx.user.update({ where: { id: user.id }, data: { [toField]: { increment: amt } } });
      await tx.walletTransferLog.create({
        data: {
          userId: user.id,
          fromWallet,
          toWallet,
          amount: amt,
          transferType: `${fromWallet}_TO_${toWallet}`
        }
      });
      return true;
    });
    if (!ok) return res.status(400).json({ error: 'Insufficient balance in source wallet' });

    res.json({ success: true, actualTransferAmt: amt, penaltyAmount: 0 });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

module.exports = router;
