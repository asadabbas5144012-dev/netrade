const express = require('express');
const prisma = require('../prismaClient');
const router = express.Router();
const authMiddleware = require('../middlewares/auth');

// Cache tier thresholds — refreshed every 60s
// Tiers now live as a dynamic JSON array (PlatformSettings key
// "signal_tiers") instead of a fixed tier1_min..tier4_min set, so an admin
// can add/remove tiers freely. `list` is the authoritative, unlimited-length
// source; t1..t4 are kept populated too since several existing call sites
// (and the user-facing VIP tiers table) still read those specific keys.
let _tierCache = null;
let _tierCacheAt = 0;
async function getTierThresholds() {
  if (_tierCache && Date.now() - _tierCacheAt < 60000) return _tierCache;

  let list = null;
  const setting = await prisma.platformSettings.findUnique({ where: { key: 'signal_tiers' } });
  if (setting) {
    try { list = JSON.parse(setting.value); } catch { list = null; }
  }
  if (!Array.isArray(list) || !list.length) {
    const rows = await prisma.platformSettings.findMany({
      where: { key: { in: ['tier1_min', 'tier2_min', 'tier3_min', 'tier4_min'] } }
    });
    const map = {};
    rows.forEach(r => { map[r.key] = parseFloat(r.value); });
    const defaults = [500, 1000, 1500, 2000];
    list = defaults.map((d, i) => ({ level: i + 1, min: map['tier' + (i + 1) + '_min'] ?? d }));
  }
  list = list.slice().sort((a, b) => a.level - b.level);

  const result = { list };
  list.forEach(t => { result['t' + t.level] = t.min; });
  result.t1 = result.t1 ?? 500;
  result.t2 = result.t2 ?? 1000;
  result.t3 = result.t3 ?? 1500;
  result.t4 = result.t4 ?? 2000;

  _tierCache = result;
  _tierCacheAt = Date.now();
  return result;
}

// Server-side balance tier — Exchange (balance) + Perpetual only. Trade
// wallet has been removed; Exchange is deposit/withdrawal, Perpetual is
// trading.
async function getAccessTier(balance, perpetualBalance) {
  const total = (balance || 0) + (perpetualBalance || 0);
  const { list } = await getTierThresholds();
  let tier = 0;
  for (const t of list) {
    if (total >= t.min) tier = t.level;
  }
  return tier;
}


// GET /api/signals — returns signals the user qualifies for
// visibilityTier=0 = BROADCAST (all users, all tiers, no balance required)
// visibilityTier=1-4 = tiered (user must meet minimum balance for that tier)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const accessTier = await getAccessTier(user.balance, user.perpetualBalance);
    const tiers = await getTierThresholds();

    // 1. Signals targeted directly at this user — either the legacy
    // single-user targetUserId column, or a row in SignalTarget (signals
    // sent to a batch of selected users all share one Signal row).
    const targetedSignals = await prisma.signal.findMany({
      where: {
        status: { in: ['PENDING', 'ACTIVE'] },
        OR: [
          { targetUserId: user.id },
          { targets: { some: { userId: user.id } } }
        ]
      },
      orderBy: { entryTime: 'asc' }
    });

    // 2. Broadcast signals (visibilityTier=0) — visible to ALL users regardless of balance.
    // Excludes signals with explicit targets so a batch send to selected
    // users never also leaks out to everyone else via the public buckets.
    const broadcastSignals = await prisma.signal.findMany({
      where: { status: { in: ['PENDING', 'ACTIVE'] }, visibilityTier: 0, targetUserId: null, targets: { none: {} } },
      orderBy: { entryTime: 'asc' }
    });

    // 3. Tier-based public signals (only if user has balance)
    let tierSignals = [];
    if (accessTier > 0) {
      tierSignals = await prisma.signal.findMany({
        where: {
          status: { in: ['PENDING', 'ACTIVE'] },
          visibilityTier: { gte: 1, lte: accessTier },
          targetUserId: null,
          targets: { none: {} }
        },
        orderBy: [{ visibilityTier: 'asc' }, { entryTime: 'asc' }]
      });
    }

    // Merge all — deduplicate by id
    const seen = new Set();
    const signals = [...targetedSignals, ...broadcastSignals, ...tierSignals].filter(s => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });

    res.json({ signals, accessTier, balance: user.balance, tiers });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// GET /api/signals/my-trades
router.get('/my-trades', authMiddleware, async (req, res) => {
  try {
    const trades = await prisma.trade.findMany({
      where: { userId: req.user.userId },
      include: {
        signal: {
          select: {
            id: true, pair: true, direction: true, marketType: true,
            entryTime: true, duration: true, multiplier: true, status: true,
            result: true, rewardPercentage: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    let autoHealed = false;
    for (const trade of trades) {
      if (trade.outcome === 'PENDING' && trade.signal) {
        const signal = trade.signal;
        const entryTime = new Date(signal.entryTime).getTime();
        const endTime = entryTime + (signal.duration * 1000);
        // 2-second buffer to handle slight client/server clock desync
        const hasExpired = Date.now() >= endTime;

        if (signal.status === 'COMPLETED' || (signal.status === 'ACTIVE' && hasExpired)) {
          if (global.ss) {
            await global.ss.completeSignal(signal.id);
            autoHealed = true;
          }
        }
      }
    }

    if (autoHealed) {
      // Refetch after healing
      const healedTrades = await prisma.trade.findMany({
        where: { userId: req.user.userId },
        include: {
          signal: {
            select: {
              id: true, pair: true, direction: true, marketType: true,
              entryTime: true, duration: true, multiplier: true, status: true,
              result: true, rewardPercentage: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: 50
      });
      return res.json(healedTrades);
    }

    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// POST /api/signals/trade — balance tier validated server-side
router.post('/trade', authMiddleware, async (req, res) => {
  try {
    const { signalId, amount, direction, entryPrice, accessCode } = req.body;
    const amt = parseFloat(amount);
    if (!signalId || !amt || amt <= 0) {
      return res.status(400).json({ error: 'Signal ID and valid amount required' });
    }

    const [signal, user] = await Promise.all([
      prisma.signal.findUnique({ where: { id: signalId }, include: { _count: { select: { targets: true } } } }),
      prisma.user.findUnique({ where: { id: req.user.userId } })
    ]);

    if (!signal) return res.status(404).json({ error: 'Signal not found' });

    // A signal targeted at specific users (single targetUserId, or a batch
    // sent via SignalTarget) must only be tradeable by those users — the
    // generic visibilityTier check below isn't enough on its own, since a
    // targeted signal's visibilityTier can coincidentally match a tier any
    // other user also qualifies for.
    if (signal.targetUserId && signal.targetUserId !== user.id) {
      return res.status(403).json({ error: 'This signal is not available to you.' });
    }
    let isDirectTarget = !!signal.targetUserId;
    if (!signal.targetUserId && signal._count.targets > 0) {
      const isTargeted = await prisma.signalTarget.findUnique({
        where: { signalId_userId: { signalId: signal.id, userId: user.id } }
      });
      if (!isTargeted) return res.status(403).json({ error: 'This signal is not available to you.' });
      isDirectTarget = true;
    }

    // Allow trade if:
    // 1. Signal is ACTIVE, OR
    // 2. Signal is PENDING but entryTime has already passed (server may have slight delay flipping status)
    const now = new Date();
    const entryTimePassed = signal.entryTime && now >= new Date(signal.entryTime);
    const signalExpired = signal.entryTime && signal.duration
      ? now >= new Date(new Date(signal.entryTime).getTime() + signal.duration * 1000)
      : false;

    if (signalExpired) return res.status(400).json({ error: 'Signal has already expired. Wait for the next signal.' });
    if (signal.status === 'COMPLETED' || signal.status === 'CANCELLED') {
      return res.status(400).json({ error: 'Signal is no longer active.' });
    }
    if (signal.status === 'PENDING' && !entryTimePassed) {
      const secsLeft = Math.ceil((new Date(signal.entryTime) - now) / 1000);
      return res.status(400).json({ error: `Signal starts in ${secsLeft}s. Please wait.` });
    }

    // Access code validation — if signal has a code, user must provide it
    if (signal.accessCode && signal.accessCode.trim() !== '') {
      if (!accessCode || accessCode.trim().toUpperCase() !== signal.accessCode.trim().toUpperCase()) {
        return res.status(403).json({ error: 'Invalid access code. Please enter the correct signal code.' });
      }
    }
    if (!user) return res.status(404).json({ error: 'User not found' });
    const perpBal = user.perpetualBalance || 0;
    if (perpBal === 0) return res.status(400).json({ error: 'Please transfer funds to Perpetual wallet before trading.' });
    if (perpBal < amt - 0.005) return res.status(400).json({ error: 'Insufficient Perpetual wallet balance. Available: ' + perpBal.toFixed(2) + ' USDT' });

    // No fixed % cap — amount is already set by admin's Trade Allocation setting
    const totalBalance = (user.balance || 0) + (user.perpetualBalance || 0);

    // Server-side balance tier validation — cannot be bypassed from frontend.
    // Skipped for signals the admin sent directly to hand-picked users: the
    // admin's selection is itself the authorization, so a user below the
    // tier minimum must still be able to trade a signal targeted at them.
    const accessTier = await getAccessTier(user.balance, user.perpetualBalance);
    if (!isDirectTarget) {
      const { t1: tierMin } = await getTierThresholds();
      if (accessTier === 0) {
        return res.status(403).json({ error: `Minimum $${tierMin} Trade balance required to trade signals.` });
      }
      if (signal.visibilityTier > accessTier) {
        return res.status(403).json({ error: 'Your Trade balance tier does not grant access to this signal.' });
      }
    }

    // Prevent duplicate active trade on same signal
    const existing = await prisma.trade.findFirst({
      where: { userId: user.id, signalId, outcome: 'PENDING' }
    });
    if (existing) {
      return res.status(400).json({ error: 'You already have an active trade on this signal.' });
    }

    // Tier-based concurrent signal limit: Tier 1 = 1 signal, Tier 2 = 2 signals, Tier 3 = 3, etc.
    // Directly-targeted users below any tier (accessTier 0) still get 1 slot —
    // the tier count is otherwise meaningless for them.
    const concurrentLimit = isDirectTarget ? Math.max(accessTier, 1) : accessTier;
    const activeSignalTrades = await prisma.trade.count({
      where: { userId: user.id, outcome: 'PENDING', signalId: { not: null } }
    });
    if (activeSignalTrades >= concurrentLimit) {
      return res.status(403).json({
        error: `Tier ${accessTier} allows maximum ${concurrentLimit} active signal trade${concurrentLimit > 1 ? 's' : ''} at a time. Please wait for your current trade${concurrentLimit > 1 ? 's' : ''} to complete.`
      });
    }

    const [trade] = await prisma.$transaction([
      prisma.trade.create({
        data: {
          userId: user.id,
          signalId,
          amount: amt,
          direction: direction || signal.direction,
          outcome: 'PENDING',
          entryPrice: entryPrice ? parseFloat(entryPrice) : null
        }
      }),
      prisma.user.update({
        where: { id: user.id },
        data: { perpetualBalance: { decrement: amt } }
      })
    ]);

    res.json(trade);
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});


// MANUAL TRADING (NO SIGNAL)
router.post('/manual-trade', authMiddleware, async (req, res) => {
  try {
    const { pair, amount, direction, duration, entryPrice } = req.body;
    const amt = parseFloat(amount);
    if (!pair || !amt || amt <= 0) return res.status(400).json({ error: 'Invalid parameters' });

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    // This was checking tradeBalance while every branch below always
    // decrements perpetualBalance — a real pre-existing bug (a user with
    // plenty of Trade balance but none in Perpetual could pass this check
    // then get their Perpetual balance decremented into the negative).
    // Trade wallet is removed; Perpetual funds trades directly now.
    if (user.perpetualBalance < amt - 0.005) return res.status(400).json({ error: 'Insufficient Perpetual balance' });

    // INTERCEPT: Check if there's an ACTIVE signal for this user on this exact pair
    let cleanPair = pair.replace(/[\s\/]/g, '').replace('USDTUSDT', 'USDT').toUpperCase();
    if (cleanPair.includes(':')) cleanPair = cleanPair.split(':')[1]; // Strip BINANCE: or CRYPTO:
    
    const activeSignals = await prisma.signal.findMany({
      where: { status: 'ACTIVE' },
      include: {
        targets: { where: { userId: user.id }, select: { userId: true } },
        _count: { select: { targets: true } }
      }
    });

    let interceptedSignal = null;
    const accessTier = await getAccessTier(user.balance, user.perpetualBalance);
    for (const sig of activeSignals) {
      const sigPair = sig.pair.replace(/[\s\/]/g, '').replace('USDTUSDT', 'USDT').toUpperCase();
      if (sigPair === cleanPair) {
        if (sig.targetUserId === user.id) { interceptedSignal = sig; break; }
        if (sig.targetUserId) continue; // single-targeted at someone else — never intercept
        if (sig._count.targets > 0) {
          // Batch-targeted signal — sig.targets was queried pre-filtered to
          // this user's id, so non-empty here means they're a recipient;
          // empty means it was sent to other users, never intercept it.
          if (sig.targets.length > 0) { interceptedSignal = sig; break; }
          continue;
        }
        if (sig.visibilityTier <= accessTier) { interceptedSignal = sig; break; }
      }
    }

    let trade;
    if (interceptedSignal) {
      // Auto-map as Signal Trade
      const existing = await prisma.trade.findFirst({
        where: { userId: user.id, signalId: interceptedSignal.id, outcome: 'PENDING' }
      });
      if (existing) return res.status(400).json({ error: 'You already have an active trade on this signal.' });

      await prisma.user.update({
        where: { id: user.id },
        data: { perpetualBalance: { decrement: amt } }
      });
      trade = await prisma.trade.create({
        data: {
          userId: user.id,
          signalId: interceptedSignal.id,
          amount: amt,
          direction: direction || interceptedSignal.direction,
          outcome: 'PENDING',
          entryPrice: entryPrice ? parseFloat(entryPrice) : null
        }
      });
    } else {
      // Normal Manual Trade
      await prisma.user.update({
        where: { id: user.id },
        data: { perpetualBalance: { decrement: amt } }
      });
      trade = await prisma.trade.create({
        data: {
          userId: user.id,
          pair: pair,
          amount: amt,
          direction: direction,
          outcome: 'PENDING',
          duration: duration || 600, // typically 600 seconds (10 mins)
          signalId: null,
          entryPrice: entryPrice ? parseFloat(entryPrice) : null
        }
      });
    }

    res.json({ success: true, trade });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to place manual trade' });
  }
});

router.post('/manual-cancel', authMiddleware, async (req, res) => {
  try {
    const { tradeId } = req.body;
    const trade = await prisma.trade.findUnique({ where: { id: tradeId } });

    if (!trade || trade.userId !== req.user.userId || trade.outcome !== 'PENDING') {
      return res.status(400).json({ error: 'Trade not found or already closed' });
    }

    // Check if 10 minutes have passed
    const timeElapsed = Date.now() - new Date(trade.createdAt).getTime();
    if (timeElapsed >= trade.duration * 1000) {
      return res.status(400).json({ error: 'Time limit exceeded. Trade cannot be cancelled and will be resolved.' });
    }

    // Return balance
    await prisma.user.update({
      where: { id: req.user.userId },
      data: { perpetualBalance: { increment: trade.amount } }
    });

    // Mark as cancelled
    await prisma.trade.update({
      where: { id: tradeId },
      data: { outcome: 'CANCELLED', profit: 0 }
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to cancel trade' });
  }
});

router.post('/manual-resolve', authMiddleware, async (req, res) => {
  try {
    const { tradeId } = req.body;
    const trade = await prisma.trade.findUnique({ where: { id: tradeId } });

    if (!trade || trade.userId !== req.user.userId || trade.outcome !== 'PENDING') {
      return res.status(400).json({ error: 'Trade not found or already closed' });
    }

    // Generate a close price that forces a loss based on direction
    let closePrice = null;
    if (trade.entryPrice) {
      // Random change between 0.1% and 0.5%
      const changePct = 0.001 + Math.random() * 0.004;
      if (trade.direction === 'CALL') {
        closePrice = trade.entryPrice * (1 - changePct); // Goes down, loss for CALL
      } else {
        closePrice = trade.entryPrice * (1 + changePct); // Goes up, loss for PUT
      }
    }

    await prisma.$transaction([
      prisma.trade.update({
        where: { id: tradeId },
        data: { outcome: 'LOSS', profit: -trade.amount, closePrice: closePrice }
      }),
      prisma.user.update({
        where: { id: trade.userId },
        data: { profitBalance: { increment: -trade.amount } }
      })
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resolve trade' });
  }
});

module.exports = router;
