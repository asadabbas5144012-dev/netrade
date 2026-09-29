const express = require('express');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = require('../prismaClient');
const router = express.Router();
const authMiddleware = require('../middlewares/auth');
const { testSmtp } = require('../services/mailer');
const depositApproval = require('../services/depositApproval');
const { claim } = require('../services/ledger');

const adminMiddleware = (req, res, next) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' });
  next();
};

// ── USERS ──
router.get('/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { search, page = 1, limit } = req.query;
    const where = search ? {
      OR: [
        { email: { contains: search, mode: 'insensitive' } },
        { id: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { kycData: { idNumber: { contains: search, mode: 'insensitive' } } }
      ]
    } : {};
    // The targeted-signal user picker calls this with ?limit=5000 to load
    // every user for its plan-tab/balance filtering — the hardcoded take:20
    // silently limited it to the 20 most recently registered users only,
    // regardless of balance/tier, so most eligible users never appeared.
    const take = limit ? Math.min(parseInt(limit) || 20, 5000) : 20;
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include: { kycData: true },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * take,
        take
      }),
      prisma.user.count({ where })
    ]);
    res.json({ users, total });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.get('/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        kycData: true,
        transactions: { orderBy: { createdAt: 'desc' }, take: 20 },
        deposits: { orderBy: { detectedAt: 'desc' }, take: 20 },
        withdrawals: { orderBy: { requestedAt: 'desc' }, take: 20 },
        balanceAdjustments: { orderBy: { createdAt: 'desc' }, take: 20 },
        trades: { include: { signal: true }, orderBy: { createdAt: 'desc' }, take: 20 },
        loginHistory: { orderBy: { createdAt: 'desc' }, take: 10 },
        referrals: { select: { id: true, email: true, balance: true, investments: true, createdAt: true } },
        referredBy: { select: { id: true, email: true } }
      }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/users/:id/balance', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { amount, type = 'set', field = 'balance' } = req.body;
    const val = parseFloat(amount);
    if (isNaN(val)) return res.status(400).json({ error: 'Invalid amount' });
    const allowedFields = ['balance', 'profitBalance', 'referralBalance'];
    if (!allowedFields.includes(field)) return res.status(400).json({ error: 'Invalid field' });
    const data = type === 'increment' ? { [field]: { increment: val } } : { [field]: val };
    const user = await prisma.user.update({ where: { id: req.params.id }, data });
    res.json({ success: true, balance: user.balance, profitBalance: user.profitBalance, referralBalance: user.referralBalance });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/users/:id/suspend', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { reason } = req.body;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { suspended: true, suspendedReason: reason || 'Suspended by admin' }
    });
    if (global.ns) await global.ns.send(user.id, 'Account Suspended', reason || 'Your account has been suspended. Contact support.', 'SYSTEM');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/users/:id/unsuspend', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await prisma.user.update({ where: { id: req.params.id }, data: { suspended: false, suspendedReason: null } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/users/:id/reset-password', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: req.params.id }, data: { password: hashed } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.delete('/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const userId = req.params.id;
    await prisma.$transaction([
      prisma.loginHistory.deleteMany({ where: { userId } }),
      prisma.deposit.deleteMany({ where: { userId } }),
      prisma.withdrawal.deleteMany({ where: { userId } }),
      prisma.balanceAdjustment.deleteMany({ where: { userId } }),
      prisma.trade.deleteMany({ where: { userId } }),
      prisma.kYC.deleteMany({ where: { userId } }),
      prisma.transaction.deleteMany({ where: { userId } }),
      prisma.notification.deleteMany({ where: { userId } }),
      prisma.chatMessage.deleteMany({ where: { userId } }),
      prisma.investment.deleteMany({ where: { userId } }),
      prisma.walletTransferLog.deleteMany({ where: { userId } }),
      prisma.investmentLock.deleteMany({ where: { userId } }),
      prisma.user.updateMany({ where: { referredById: userId }, data: { referredById: null } }),
      prisma.signal.updateMany({ where: { targetUserId: userId }, data: { targetUserId: null } }),
      prisma.user.delete({ where: { id: userId } })
    ]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── BALANCE ADJUSTMENTS ──
router.post('/balance/adjust', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { user_id, amount, type, reason, walletDestination = "Exchange" } = req.body;
    if (!user_id || !amount || !type || !reason) return res.status(400).json({ error: 'user_id, amount, type, reason are required' });
    if (!['credit', 'debit'].includes(type)) return res.status(400).json({ error: 'type must be credit or debit' });
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const user = await prisma.user.findUnique({ where: { id: user_id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    let targetField = 'balance';
    if (walletDestination === 'Perpetual') targetField = 'perpetualBalance';
    
    if (type === 'debit' && user[targetField] < val) return res.status(400).json({ error: 'Insufficient balance to debit' });

    const balanceDelta = type === 'credit' ? val : -val;

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user_id },
        data: { [targetField]: { increment: balanceDelta } }
      }),
      prisma.balanceAdjustment.create({
        data: { userId: user_id, adminId: req.user.userId, amount: val, type, reason }
      })
    ]);

    if (global.ns) {
      const msg = type === 'credit'
        ? `${val} TRX has been credited to your account. Reason: ${reason}`
        : `${val} TRX has been debited from your account. Reason: ${reason}`;
      await global.ns.send(user_id, `Balance ${type === 'credit' ? 'Credited' : 'Debited'}`, msg, 'SYSTEM');
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.get('/balance/adjustments', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const [items, total] = await Promise.all([
      prisma.balanceAdjustment.findMany({
        include: {
          user: { select: { email: true, id: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * 50,
        take: 50
      }),
      prisma.balanceAdjustment.count()
    ]);
    res.json({ items, total });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── TRANSACTIONS (legacy) ──
router.get('/transactions', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { status = 'PENDING', page = 1, type } = req.query;
    const where = { status };
    if (type) where.type = type;
    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: { user: { select: { email: true, id: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * 20,
        take: 20
      }),
      prisma.transaction.count({ where })
    ]);
    res.json({ transactions, total });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/transactions/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const transaction = await prisma.transaction.findUnique({ where: { id: req.params.id }, include: { user: true } });
    if (!transaction) return res.status(404).json({ error: 'Transaction not found' });
    if (transaction.status !== 'PENDING') return res.status(400).json({ error: 'Transaction already processed' });

    // Only one request can move the transaction out of PENDING.
    if (!(await claim(prisma.transaction, req.params.id, 'status', 'PENDING', 'COMPLETED'))) {
      return res.status(400).json({ error: 'Transaction already processed' });
    }

    if (transaction.type === 'DEPOSIT') {
      await prisma.user.update({ where: { id: transaction.userId }, data: { balance: { increment: transaction.amount } } });
      const user = transaction.user;
      if (transaction.amount >= 300 && user.referredById) {
        const settings = await prisma.platformSettings.findUnique({ where: { key: 'referral_percentage' } });
        const pct = parseFloat(settings?.value || '5') / 100;
        const commission = transaction.amount * pct;
        await prisma.$transaction([
          prisma.user.update({ where: { id: user.referredById }, data: { balance: { increment: commission }, referralBalance: { increment: commission } } }),
          prisma.transaction.create({ data: { userId: user.referredById, type: 'REFERRAL_COMMISSION', amount: commission, status: 'COMPLETED', note: `Referral from ${user.email}` } })
        ]);
        if (global.ns) await global.ns.send(user.referredById, 'Referral Bonus!', `You earned ${commission.toFixed(2)} commission from ${user.email}.`, 'REFERRAL');
      }
      if (global.ns) await global.ns.send(transaction.userId, 'Deposit Approved', `Your deposit of ${transaction.amount} has been credited.`, 'DEPOSIT');
    } else if (transaction.type === 'WITHDRAWAL') {
      if (global.ns) await global.ns.send(transaction.userId, 'Withdrawal Approved', `Your withdrawal of ${transaction.amount} has been processed.`, 'WITHDRAWAL');
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/transactions/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { reason } = req.body;
    const transaction = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!transaction) return res.status(404).json({ error: 'Not found' });
    if (transaction.status !== 'PENDING') return res.status(400).json({ error: 'Already processed' });
    if (!(await claim(prisma.transaction, req.params.id, 'status', 'PENDING', 'FAILED'))) {
      return res.status(400).json({ error: 'Already processed' });
    }
    await prisma.transaction.update({ where: { id: req.params.id }, data: { note: reason } });
    if (transaction.type === 'WITHDRAWAL') {
      await prisma.user.update({ where: { id: transaction.userId }, data: { balance: { increment: transaction.amount } } });
    }
    if (global.ns) await global.ns.send(transaction.userId, `${transaction.type} Rejected`, reason || `Your ${transaction.type.toLowerCase()} was rejected.`, transaction.type);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// 📋 PENALTIES 📋
router.get('/penalties', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const [data, total] = await Promise.all([
      prisma.walletTransferLog.findMany({
        where: { penaltyAmount: { gt: 0 } },
        include: { user: { select: { email: true, id: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * 20,
        take: 20
      }),
      prisma.walletTransferLog.count({
        where: { penaltyAmount: { gt: 0 } }
      })
    ]);
    res.json({ data, total });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// 💰 TRON DEPOSITS 💰──
router.get('/deposits', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { page = 1, status = 'pending_approval' } = req.query;
    const where = status === 'all' ? { status: { not: 'deleted' } } : { status };
    const [deposits, total] = await Promise.all([
      prisma.deposit.findMany({
        where,
        include: { user: { select: { email: true, id: true } } },
        orderBy: { detectedAt: 'desc' },
        skip: (parseInt(page) - 1) * 20,
        take: 20
      }),
      prisma.deposit.count({ where })
    ]);
    res.json({ deposits, total });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.get('/deposits/pending', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const where = { status: 'pending_approval' };
    const [deposits, total] = await Promise.all([
      prisma.deposit.findMany({
        where,
        include: { user: { select: { email: true, id: true } } },
        orderBy: { detectedAt: 'desc' },
        skip: (parseInt(page) - 1) * 20,
        take: 20
      }),
      prisma.deposit.count({ where })
    ]);
    res.json({ deposits, total });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/deposits/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await depositApproval.approveDeposit(req.params.id, req.user.userId);
    res.json({ success: true, message: 'Deposit approved' });
  } catch (error) {
    res.status(400).json({ error: error.message || 'An internal server error occurred.' });
  }
});

router.post('/deposits/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { reason } = req.body;
    const deposit = await prisma.deposit.findUnique({ where: { id: req.params.id } });
    if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
    if (deposit.status !== 'pending_approval') return res.status(400).json({ error: 'Deposit already processed' });

    const r = await prisma.deposit.updateMany({
      where: { id: deposit.id, status: 'pending_approval' },
      data: { status: 'rejected', rejectionReason: reason || 'Rejected by admin', approvedBy: req.user.userId }
    });
    if (r.count !== 1) return res.status(400).json({ error: 'Deposit already processed' });

    if (global.ns) await global.ns.send(deposit.userId, 'Deposit Rejected', reason || 'Your deposit was rejected. Please contact support.', 'DEPOSIT');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.delete('/deposits/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const deposit = await prisma.deposit.findUnique({ where: { id: req.params.id } });
    if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
    
    await prisma.deposit.update({ where: { id: deposit.id }, data: { status: 'deleted' } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── TRON WITHDRAWALS ──
router.get('/withdrawals', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { page = 1, status = 'pending' } = req.query;
    const where = status === 'all' ? {} : { status };
    const [withdrawals, total] = await Promise.all([
      prisma.withdrawal.findMany({
        where,
        include: { user: { select: { email: true, id: true } } },
        orderBy: { requestedAt: 'desc' },
        skip: (parseInt(page) - 1) * 20,
        take: 20
      }),
      prisma.withdrawal.count({ where })
    ]);
    res.json({ withdrawals, total });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.get('/withdrawals/pending', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const where = { status: 'pending' };
    const [withdrawals, total] = await Promise.all([
      prisma.withdrawal.findMany({
        where,
        include: { user: { select: { email: true, id: true } } },
        orderBy: { requestedAt: 'desc' },
        skip: (parseInt(page) - 1) * 20,
        take: 20
      }),
      prisma.withdrawal.count({ where })
    ]);
    res.json({ withdrawals, total });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/withdrawals/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const withdrawal = await prisma.withdrawal.findUnique({
      where: { id: req.params.id },
      include: { user: true }
    });
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'Withdrawal already processed' });

    // Admin has manually sent funds. We just deduct the locked balance —
    // conditional on the withdrawal still being pending, so an approve and a
    // reject (or a double click) can never both apply.
    const done = await prisma.$transaction(async (tx) => {
      const r = await tx.withdrawal.updateMany({
        where: { id: withdrawal.id, status: 'pending' },
        data: { status: 'completed', txHash: 'Manual-Transfer', processedAt: new Date(), processedBy: req.user.userId }
      });
      if (r.count !== 1) return false;
      await tx.user.update({ where: { id: withdrawal.userId }, data: { lockedBalance: { decrement: withdrawal.amount } } });
      return true;
    });
    if (!done) return res.status(400).json({ error: 'Withdrawal already processed' });

    if (global.ns) await global.ns.send(withdrawal.userId, 'Withdrawal Completed', `Your withdrawal of ${withdrawal.amount} USDT has been manually approved and sent.`, 'WITHDRAWAL');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/withdrawals/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { reason } = req.body;
    const withdrawal = await prisma.withdrawal.findUnique({ where: { id: req.params.id } });
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'Withdrawal already processed' });

    const done = await prisma.$transaction(async (tx) => {
      const r = await tx.withdrawal.updateMany({
        where: { id: withdrawal.id, status: 'pending' },
        data: { status: 'rejected', rejectionReason: reason || 'Rejected by admin', processedAt: new Date(), processedBy: req.user.userId }
      });
      if (r.count !== 1) return false;
      await tx.user.update({
        where: { id: withdrawal.userId },
        data: { balance: { increment: withdrawal.amount }, lockedBalance: { decrement: withdrawal.amount } }
      });
      return true;
    });
    if (!done) return res.status(400).json({ error: 'Withdrawal already processed' });

    if (global.ns) await global.ns.send(withdrawal.userId, 'Withdrawal Rejected', reason || 'Your withdrawal request was rejected. Funds have been returned.', 'WITHDRAWAL');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── SIGNALS ──
router.get('/signals', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const fifteenHoursAgo = new Date(Date.now() - 15 * 60 * 60 * 1000);
    const signals = await prisma.signal.findMany({
      where: {
        OR: [
          { status: { in: ['PENDING', 'ACTIVE'] } },
          { createdAt: { gte: fifteenHoursAgo } }
        ]
      },
      include: { _count: { select: { trades: true, targets: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    res.json(signals);
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── Signal Access Tiers (dynamic — any number of tiers, not fixed at 4) ────
// Stored as one JSON array in PlatformSettings instead of the old fixed
// tier1_min..tier4_min keys, so the admin can add/remove tiers freely.
router.get('/signal-tiers', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const setting = await prisma.platformSettings.findUnique({ where: { key: 'signal_tiers' } });
    if (setting) {
      const tiers = JSON.parse(setting.value);
      if (Array.isArray(tiers) && tiers.length) return res.json(tiers);
    }
    // One-time fallback: migrate the old fixed keys if they were ever set,
    // otherwise fall back to the original hardcoded defaults.
    const legacy = await prisma.platformSettings.findMany({
      where: { key: { in: ['tier1_min', 'tier2_min', 'tier3_min', 'tier4_min'] } }
    });
    const map = {};
    legacy.forEach(r => { map[r.key] = parseFloat(r.value); });
    const defaults = [500, 1000, 1500, 2000];
    const tiers = defaults.map((d, i) => ({ level: i + 1, min: map['tier' + (i + 1) + '_min'] ?? d }));
    res.json(tiers);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post('/signal-tiers', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const tiers = req.body;
    if (!Array.isArray(tiers) || !tiers.length) return res.status(400).json({ error: 'Provide a non-empty array of tiers' });
    for (const t of tiers) {
      if (t.min === undefined || t.min === null || isNaN(parseFloat(t.min))) {
        return res.status(400).json({ error: 'Every tier needs a valid minimum balance' });
      }
    }
    // Re-number levels 1..N by ascending minimum so save order never matters
    const sorted = tiers
      .map(t => ({ min: parseFloat(t.min) }))
      .sort((a, b) => a.min - b.min)
      .map((t, i) => ({ level: i + 1, min: t.min }));
    await prisma.platformSettings.upsert({
      where: { key: 'signal_tiers' },
      update: { value: JSON.stringify(sorted) },
      create: { key: 'signal_tiers', value: JSON.stringify(sorted) }
    });
    res.json({ success: true, tiers: sorted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/bulk-signals/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const rows = await prisma.platformSettings.findMany({
      where: { key: { in: ['tier1_min', 'tier2_min', 'tier3_min', 'tier4_min'] } }
    });
    const map = {};
    rows.forEach(r => { map[r.key] = parseFloat(r.value); });
    const t1 = map['tier1_min'] ?? 500;
    const t2 = map['tier2_min'] ?? 1000;
    const t3 = map['tier3_min'] ?? 1500;
    const t4 = map['tier4_min'] ?? 2000;

    const users = await prisma.user.findMany({
      select: { id: true, email: true, balance: true, perpetualBalance: true }
    });

    const tiers = { t1: [], t2: [], t3: [], t4: [], t0: [] };
    users.forEach(u => {
      const tot = (u.balance||0) + (u.perpetualBalance||0);
      if (tot >= t4) tiers.t4.push(u);
      else if (tot >= t3) tiers.t3.push(u);
      else if (tot >= t2) tiers.t2.push(u);
      else if (tot >= t1) tiers.t1.push(u);
      else tiers.t0.push(u);
    });

    res.json({ tiers, thresholds: { t1, t2, t3, t4 } });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/signals', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (!global.ss) return res.status(500).json({ error: 'Signal service not ready' });
    const body = { ...req.body };
    
    if (body.targetUserIds && Array.isArray(body.targetUserIds) && body.targetUserIds.length > 0) {
      // One Signal row for the whole batch — however many users are
      // selected — instead of one duplicate row per user. All of them get
      // it delivered instantly (createSignal fans the socket emit + push
      // notification out to every id in the list) and all place trades
      // against the same shared entryTime/duration.
      const userIds = [...new Set(body.targetUserIds)];
      delete body.targetEmail;
      const signal = await global.ss.createSignal({ ...body, targetUserIds: userIds });
      return res.json({ success: true, count: userIds.length, signal });
    }

    if (body.targetEmail) {
      const target = await prisma.user.findUnique({ where: { email: body.targetEmail.trim() } });
      if (!target) return res.status(404).json({ error: `No user found with email: ${body.targetEmail}` });
      body.targetUserId = target.id;
      delete body.targetEmail;
    }
    delete body.targetUserIds;
    const signal = await global.ss.createSignal(body);
    // Same response shape as the branch above — the frontend's success
    // message always reads data.count, so a bare signal object here
    // rendered "Successfully sent to undefined users!", which looked like a
    // failure even when the signal was created correctly.
    res.json({ success: true, count: 1, signal });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.delete('/signals/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const signal = await prisma.signal.findUnique({ where: { id: req.params.id } });
    if (!signal) return res.status(404).json({ error: 'Signal not found' });

    if (global.ss) global.ss.cancelSignal(req.params.id);
    
    // Preserve pair and duration for user trade history
    await prisma.trade.updateMany({ 
      where: { signalId: req.params.id }, 
      data: { signalId: null, pair: signal.pair, duration: signal.duration } 
    });
    
    await prisma.signal.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// PATCH /api/admin/signals/:id/result — force WIN or LOSS outcome before signal completes
router.patch('/signals/:id/result', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { result } = req.body;
    if (!['WIN', 'LOSS'].includes(result)) return res.status(400).json({ error: 'result must be WIN or LOSS' });
    const signal = await prisma.signal.update({
      where: { id: req.params.id },
      data: { result }
    });
    res.json(signal);
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// GET /api/admin/signals/analytics — hit/miss stats and participation
router.get('/signals/analytics', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const [totalSignals, totalTrades, wins, losses, activeSignals, totalUsers] = await Promise.all([
      prisma.signal.count(),
      prisma.trade.count(),
      prisma.trade.count({ where: { outcome: 'WIN' } }),
      prisma.trade.count({ where: { outcome: 'LOSS' } }),
      prisma.signal.count({ where: { status: 'ACTIVE' } }),
      prisma.user.count({ where: { balance: { gte: 300 } } })
    ]);
    const winRate = 98;
    res.json({ totalSignals, totalTrades, wins, losses, winRate, activeSignals, eligibleUsers: totalUsers });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── NOTIFICATIONS ──
router.post('/notify', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userIds, title, message, type = 'ADMIN' } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
    let targets = userIds;
    if (!targets || targets === 'all') {
      const users = await prisma.user.findMany({ select: { id: true } });
      targets = users.map(u => u.id);
    }
    await Promise.all(targets.map(id => global.ns?.send(id, title, message, type)));
    res.json({ success: true, sent: targets.length });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── SETTINGS ──
router.get('/settings', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const settings = await prisma.platformSettings.findMany();
    const obj = {};
    settings.forEach(s => { obj[s.key] = s.value; });
    res.json(obj);
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/settings', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const updates = req.body;
    await Promise.all(Object.entries(updates).map(([key, value]) =>
      prisma.platformSettings.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) }
      })
    ));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/smtp/test', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { email } = req.body;
    const result = await testSmtp(email);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── DASHBOARD ──
router.get('/dashboard', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const [
      totalUsers,
      totalDeposits,
      totalWithdrawals,
      pendingTxs,
      activeSignals,
      totalTrades,
      recentUsers,
      pendingDeposits,
      pendingWithdrawals,
      pendingKycs,
      recentTransactions,
      activeSignalsList,
      activeUsers
    ] = await Promise.all([
      prisma.user.count(),
      prisma.deposit.aggregate({ where: { status: 'confirmed' }, _sum: { amount: true } }),
      prisma.withdrawal.aggregate({ where: { status: 'completed' }, _sum: { amount: true } }),
      prisma.transaction.count({ where: { status: 'PENDING' } }),
      prisma.signal.count({ where: { status: { in: ['ACTIVE', 'PENDING'] } } }),
      prisma.trade.count(),
      prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 7, select: { createdAt: true } }),
      prisma.deposit.count({ where: { status: 'pending_approval' } }),
      prisma.withdrawal.count({ where: { status: 'pending' } }),
      prisma.kYC.count({ where: { status: 'PENDING' } }),
      prisma.transaction.findMany({ orderBy: { createdAt: 'desc' }, take: 5, include: { user: { select: { email: true } } } }),
      prisma.signal.findMany({ where: { status: { in: ['ACTIVE', 'PENDING'] } }, orderBy: { createdAt: 'desc' }, take: 5 }),
      prisma.user.count({ where: { OR: [{ balance: { gt: 0 } }, { perpetualBalance: { gt: 0 } }] } })
    ]);

    const inactiveUsers = totalUsers - activeUsers;

    res.json({
      totalUsers,
      activeUsers,
      inactiveUsers,
      totalDeposits: totalDeposits._sum.amount || 0,
      totalWithdrawals: totalWithdrawals._sum.amount || 0,
      pendingTxs,
      activeSignals,
      totalTrades,
      recentUsers,
      pendingDeposits,
      pendingWithdrawals,
      pendingKycs,
      recentTransactions,
      activeSignalsList
    });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── ANALYTICS / DASHBOARD ──
router.get('/analytics', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const [
      totalUsers,
      totalDeposits,
      totalWithdrawals,
      pendingTxs,
      activeSignals,
      totalTrades,
      recentUsers,
      pendingDeposits,
      pendingWithdrawals,
      pendingKycs,
      activeUsers
    ] = await Promise.all([
      prisma.user.count(),
      prisma.deposit.aggregate({ where: { status: 'confirmed' }, _sum: { amount: true } }),
      prisma.withdrawal.aggregate({ where: { status: 'completed' }, _sum: { amount: true } }),
      prisma.transaction.count({ where: { status: 'PENDING' } }),
      prisma.signal.count({ where: { status: { in: ['ACTIVE', 'PENDING'] } } }),
      prisma.trade.count(),
      prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 7, select: { createdAt: true } }),
      prisma.deposit.count({ where: { status: 'pending_approval' } }),
      prisma.withdrawal.count({ where: { status: 'pending' } }),
      prisma.kYC.count({ where: { status: 'PENDING' } }),
      prisma.user.count({ where: { OR: [{ balance: { gt: 0 } }, { perpetualBalance: { gt: 0 } }] } })
    ]);

    const inactiveUsers = totalUsers - activeUsers;

    res.json({
      totalUsers,
      activeUsers,
      inactiveUsers,
      totalDeposits: totalDeposits._sum.amount || 0,
      totalWithdrawals: totalWithdrawals._sum.amount || 0,
      pendingTxs,
      activeSignals,
      totalTrades,
      recentUsers,
      pendingDeposits,
      pendingWithdrawals,
      pendingKycs
    });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── REFERRALS ──
router.get('/referrals', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { referredById: { not: null } },
      include: {
        referredBy: { select: { email: true, id: true } },
        transactions: { where: { type: 'DEPOSIT', status: 'COMPLETED' }, select: { amount: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── INVESTMENTS ──
router.get('/investments', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const investments = await prisma.investment.findMany({
      include: { user: { select: { email: true, id: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json(investments);
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── KYC MANAGEMENT ──
router.get('/kyc', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { status = 'PENDING' } = req.query;
    const where = status === 'ALL' ? {} : { status };
    const kycs = await prisma.kYC.findMany({
      where,
      include: { user: { select: { email: true, id: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json(kycs);
  } catch (error) { res.status(500).json({ error: 'An internal server error occurred.' }); }
});

// ── KYC APPROVE ──
router.post('/kyc/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const kyc = await prisma.kYC.update({
      where: { id: req.params.id },
      data: { status: 'APPROVED', rejectReason: null }
    });

    if (global.ns) await global.ns.send(kyc.userId, 'KYC Approved', 'Your identity verification has been approved!', 'SYSTEM');
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'An internal server error occurred.' }); }
});

router.post('/kyc/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { reason } = req.body;
    const kyc = await prisma.kYC.update({
      where: { id: req.params.id },
      data: { status: 'REJECTED', rejectReason: reason || 'Documents not clear' }
    });
    if (global.ns) await global.ns.send(kyc.userId, 'KYC Rejected', reason || 'Your verification was rejected. Please resubmit.', 'SYSTEM');
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'An internal server error occurred.' }); }
});

// ── User Referral Tree ───────────────────────────────────────────────────────
router.get('/users/:id/referral-tree', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // Flat list of { id, parentId, level, email, joinedAt, totalDeposited, rewardEarnedByRoot }
    // matching what the admin panel's renderReferralTree() expects.
    const nodes = [];
    let parentIds = [req.params.id];
    for (let level = 1; level <= 5 && parentIds.length > 0; level++) {
      const children = await prisma.user.findMany({
        where: { referredById: { in: parentIds } },
        select: { id: true, email: true, createdAt: true, referredById: true }
      });
      if (!children.length) break;

      for (const child of children) {
        const depositTotal = await prisma.deposit.aggregate({
          where: { userId: child.id, status: { in: ['confirmed', 'CONFIRMED'] } },
          _sum: { amount: true }
        });
        nodes.push({
          id: child.id,
          parentId: child.referredById,
          level,
          email: child.email,
          joinedAt: child.createdAt,
          totalDeposited: depositTotal._sum.amount || 0,
          rewardEarnedByRoot: 0 // per-referral reward attribution isn't tracked individually yet
        });
      }
      parentIds = children.map(c => c.id);
    }
    res.json({ tree: nodes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Trades ──────────────────────────────────────────────────────────────────
router.get('/trades', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const where = {};
    if (req.query.userId) where.userId = req.query.userId;
    if (req.query.result) where.outcome = req.query.result;
    const [trades, total] = await Promise.all([
      prisma.trade.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit, include: { user: { select: { email: true } } } }),
      prisma.trade.count({ where })
    ]);
    res.json({ trades, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/trades/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const trade = await prisma.trade.findUnique({ where: { id: req.params.id }, include: { user: { select: { email: true } } } });
    if (!trade) return res.status(404).json({ error: 'Not found' });
    res.json(trade);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Balance Adjustments list ─────────────────────────────────────────────────
router.get('/balance-adjustments', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      prisma.balanceAdjustment.findMany({ orderBy: { createdAt: 'desc' }, skip, take: limit, include: { user: { select: { email: true } } } }),
      prisma.balanceAdjustment.count()
    ]);
    res.json({ adjustments: items, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/balance-adjustments/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const item = await prisma.balanceAdjustment.findUnique({ where: { id: req.params.id } });
    res.json(item || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 24h Report ───────────────────────────────────────────────────────────────
router.get('/report/24h', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const until = req.query.until ? new Date(req.query.until) : now;
    const since = req.query.since ? new Date(req.query.since) : new Date(until.getTime() - 86400000);

    const [newUsers, newUsersList, deposits, withdrawals, trades, signalsCreated, signalsCompleted] = await Promise.all([
      prisma.user.count({ where: { createdAt: { gte: since, lte: until } } }),
      prisma.user.findMany({ where: { createdAt: { gte: since, lte: until } }, select: { email: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
      prisma.deposit.findMany({ where: { detectedAt: { gte: since, lte: until } }, select: { amount: true, status: true, detectedAt: true, userId: true, user: { select: { email: true } } } }),
      prisma.withdrawal.findMany({ where: { requestedAt: { gte: since, lte: until } }, select: { amount: true, status: true } }),
      prisma.trade.findMany({ where: { createdAt: { gte: since, lte: until } }, select: { amount: true, profit: true, outcome: true, userId: true } }),
      prisma.signal.count({ where: { createdAt: { gte: since, lte: until } } }),
      prisma.signal.count({ where: { createdAt: { gte: since, lte: until }, status: 'COMPLETED' } })
    ]);

    const confirmedDeps = deposits.filter(d => d.status === 'CONFIRMED' || d.status === 'confirmed');
    const approvedWds  = withdrawals.filter(w => w.status === 'APPROVED' || w.status === 'approved');
    const depTotal  = confirmedDeps.reduce((s, d) => s + (d.amount || 0), 0);
    const wdTotal   = approvedWds.reduce((s, w)  => s + (w.amount || 0), 0);
    const wins      = trades.filter(t => t.outcome === 'WIN').length;
    const losses    = trades.filter(t => t.outcome === 'LOSS').length;
    const pending   = trades.filter(t => t.outcome === 'PENDING' || !t.outcome).length;
    const decided   = wins + losses;
    const tradeVol  = trades.reduce((s, t) => s + (t.amount || 0), 0);
    const tradeProfit = trades.reduce((s, t) => s + (t.profit || 0), 0);
    const activeSet = new Set(trades.map(t => t.userId));
    confirmedDeps.forEach(d => { if (d.userId) activeSet.add(d.userId); });

    res.json({
      periodStart: since, periodEnd: until,
      newUsers,
      activeUsers: activeSet.size,
      deposits:    { count: confirmedDeps.length, total: depTotal },
      withdrawals: { count: approvedWds.length,   total: wdTotal  },
      netFlow: depTotal - wdTotal,
      signals: { created: signalsCreated, completed: signalsCompleted },
      trades: {
        total: trades.length, wins, losses, pending,
        winRate: decided > 0 ? (wins / decided) * 100 : 0,
        volume: tradeVol, netProfit: tradeProfit
      },
      referralRewards: { count: 0, total: 0 },
      newUsersList: newUsersList.map(u => ({ email: u.email, date: u.createdAt })),
      depositsList: confirmedDeps.map(d => ({ email: d.user?.email || '', amount: d.amount, currency: 'USDT', date: d.detectedAt })),
      referralList: []
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/report/24h/pdf', authMiddleware, adminMiddleware, async (req, res) => {
  res.status(501).json({ error: 'PDF export not configured on this server' });
});

// ── Integrity check (stub) ───────────────────────────────────────────────────
router.get('/integrity-check', authMiddleware, adminMiddleware, async (req, res) => {
  res.json({ issues: [], checkedAt: new Date().toISOString(), status: 'ok' });
});
router.post('/integrity-check/cleanup-master-deposits', authMiddleware, adminMiddleware, async (req, res) => {
  res.json({ cleaned: 0 });
});
router.post('/integrity-check/cleanup-duplicate-trades', authMiddleware, adminMiddleware, async (req, res) => {
  res.json({ cleaned: 0 });
});

// ── Deposit bonus slabs (stub) ───────────────────────────────────────────────
router.get('/deposit-bonus-slabs', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const setting = await prisma.platformSettings.findUnique({ where: { key: 'deposit_bonus_slabs' } });
    res.json(setting ? JSON.parse(setting.value) : []);
  } catch (e) { res.json([]); }
});
router.post('/deposit-bonus-slabs', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const slabs = req.body;
    await prisma.platformSettings.upsert({ where: { key: 'deposit_bonus_slabs' }, update: { value: JSON.stringify(slabs) }, create: { key: 'deposit_bonus_slabs', value: JSON.stringify(slabs) } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Promo banner (stub) ──────────────────────────────────────────────────────
router.get('/promo-banner', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const s = await prisma.platformSettings.findUnique({ where: { key: 'promo_banner' } });
    res.json(s ? JSON.parse(s.value) : { enabled: false, text: '', startDate: null, durationDays: 0 });
  } catch (e) { res.json({ enabled: false }); }
});
router.post('/promo-banner', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await prisma.platformSettings.upsert({ where: { key: 'promo_banner' }, update: { value: JSON.stringify(req.body) }, create: { key: 'promo_banner', value: JSON.stringify(req.body) } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin notify update ──────────────────────────────────────────────────────
router.post('/notify-update', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'title and message required' });
    const users = await prisma.user.findMany({ where: { role: 'USER' }, select: { id: true } });
    await prisma.notification.createMany({
      data: users.map(u => ({ userId: u.id, title, message, type: 'SYSTEM' }))
    });
    if (global.io) users.forEach(u => global.io.to(`user_${u.id}`).emit('notification', { title, message, type: 'SYSTEM' }));
    res.json({ success: true, count: users.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
