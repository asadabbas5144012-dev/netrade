const prisma = require('../prismaClient');

class SignalService {
  constructor(io, notificationService) {
    this.io = io;
    this.ns = notificationService;
    this.timers = new Map();
    this._restoreTimers();
  }

  async _restoreTimers() {
    try {
      const activeSignals = await prisma.signal.findMany({
        where: { status: 'ACTIVE' }
      });
      for (const signal of activeSignals) {
        const endTime = new Date(signal.entryTime).getTime() + (signal.duration * 1000);
        const delay = endTime - Date.now();
        if (delay <= 0) {
          this.completeSignal(signal.id);
        } else {
          this.timers.set(
            signal.id + '_end',
            setTimeout(() => this.completeSignal(signal.id), delay)
          );
        }
      }

      const pendingSignals = await prisma.signal.findMany({
        where: { status: 'PENDING' }
      });
      for (const signal of pendingSignals) {
        const delay = new Date(signal.entryTime).getTime() - Date.now();
        if (delay <= 0) {
          this.startSignal(signal.id);
        } else {
          this.timers.set(
            signal.id,
            setTimeout(() => this.startSignal(signal.id), delay)
          );
        }
      }
    } catch (e) {
      console.error('Failed to restore timers:', e.message);
    }
  }

  async createSignal(data) {
    const {
      pair, direction, marketType = 'FUTURES',
      entryTime, duration = 300, multiplier = 1.8,
      rewardPercentage = 80, delaySeconds,
      suggestedAmount, riskLevel = 'MEDIUM',
      visibilityTier = 1, growthTarget, targetUserId,
      targetUserIds, accessCode
    } = data;

    // Sending to N selected users used to create N duplicate Signal rows
    // (one per targetUserIds[i]) sharing the same entryTime/duration by
    // coincidence, not by design. Now it's a single Signal row plus one
    // SignalTarget row per recipient — one shared countdown, one row in
    // the admin signal list, still delivered to every recipient instantly.
    const targetIds = Array.isArray(targetUserIds) && targetUserIds.length > 0
      ? [...new Set(targetUserIds)]
      : (targetUserId ? [targetUserId] : []);

    if (!pair || !direction) throw new Error('Pair and direction required');
    let dir = direction.toUpperCase();
    if (dir === 'UP') dir = 'CALL';
    if (dir === 'DOWN') dir = 'PUT';
    if (!['CALL', 'PUT'].includes(dir)) throw new Error('Direction must be CALL or PUT');
    const mkt = (marketType || 'FUTURES').toUpperCase();

    const entry = entryTime
      ? new Date(entryTime)
      : new Date(Date.now() + (delaySeconds || 60) * 1000);

    // parseInt(visibilityTier) || 1 previously turned 0 (broadcast-to-all)
    // into 1, silently downgrading every "Send to ALL Users" signal to a
    // tier-1-only signal — 0 must be preserved, only a genuinely missing/
    // invalid value should fall back to 1.
    const parsedTier = parseInt(visibilityTier);
    const signal = await prisma.signal.create({
      data: {
        pair,
        direction: dir,
        marketType: mkt,
        entryTime: entry,
        duration: parseInt(duration),
        multiplier: parseFloat(multiplier),
        rewardPercentage: parseFloat(rewardPercentage),
        suggestedAmount: suggestedAmount ? parseFloat(suggestedAmount) : null,
        riskLevel: (riskLevel || 'MEDIUM').toUpperCase(),
        visibilityTier: Number.isNaN(parsedTier) ? 1 : parsedTier,
        growthTarget: growthTarget ? parseFloat(growthTarget) : null,
        // Kept for single-target callers (e.g. targetEmail) — multi-user
        // sends rely on SignalTarget rows below instead, since a single
        // nullable column can't reference more than one user.
        targetUserId: targetIds.length === 1 ? targetIds[0] : null,
        accessCode: accessCode ? accessCode.trim().toUpperCase() : null,
        status: 'PENDING'
      }
    });

    if (targetIds.length > 0) {
      await prisma.signalTarget.createMany({
        data: targetIds.map(userId => ({ signalId: signal.id, userId })),
        skipDuplicates: true
      });
    }

    const delay = entry.getTime() - Date.now();
    if (delay > 0) {
      this.timers.set(signal.id, setTimeout(() => this.startSignal(signal.id), delay));
    } else {
      this.startSignal(signal.id);
    }

    if (targetIds.length > 0) {
      // Targeted signal (single or bulk) — deliver instantly to every
      // recipient's own socket room, not a global broadcast.
      for (const uid of targetIds) this.io.to('user_' + uid).emit('new_signal', signal);
    } else {
      this.io.emit('new_signal', signal);
    }
    this._notifyEligibleUsers(signal, targetIds).catch(() => { });
    return signal;
  }

  async _notifyEligibleUsers(signal, targetIds = []) {
    const arrow = signal.direction === 'CALL' ? '↑' : '↓';
    const title = `New ${signal.marketType} Signal: ${signal.pair} ${arrow} ${signal.direction}`;
    const body = `${signal.riskLevel} risk · Suggested: $${signal.suggestedAmount || 'Flexible'} · Reward: ${signal.rewardPercentage}%`;

    if (targetIds.length > 0) {
      // Only notify the selected recipients, however many there are
      if (this.ns) {
        for (const uid of targetIds) await this.ns.send(uid, title, body, 'SIGNAL').catch(() => { });
      }
      return;
    }

    // Public signal — notify all eligible users by tier
    const tierRows = await prisma.platformSettings.findMany({
      where: { key: { in: ['tier1_min', 'tier2_min', 'tier3_min'] } }
    });
    const tm = {}; tierRows.forEach(r => { tm[r.key] = parseFloat(r.value); });
    const t1 = tm['tier1_min'] ?? 500, t2 = tm['tier2_min'] ?? 1000, t3 = tm['tier3_min'] ?? 1500;

    const users = await prisma.user.findMany({
      where: { suspended: false },
      select: { id: true, balance: true, perpetualBalance: true }
    });
    for (const user of users) {
      const total = (user.balance || 0) + (user.perpetualBalance || 0);
      const tier = total >= t3 ? 3 : total >= t2 ? 2 : total >= t1 ? 1 : 0;
      if (tier > 0 && signal.visibilityTier <= tier && this.ns) {
        await this.ns.send(user.id, title, body, 'SIGNAL').catch(() => { });
      }
    }
  }

  async startSignal(signalId) {
    try {
      const signal = await prisma.signal.update({
        where: { id: signalId },
        data: { status: 'ACTIVE' },
        include: { targets: { select: { userId: true } } }
      });
      if (signal.targetUserId || signal.targets.length > 0) {
        const uids = signal.targetUserId ? [signal.targetUserId] : signal.targets.map(t => t.userId);
        for (const uid of uids) this.io.to('user_' + uid).emit('signal_started', signal);
      } else {
        this.io.emit('signal_started', signal);
      }
      this.timers.set(
        signalId + '_end',
        setTimeout(() => this.completeSignal(signalId), signal.duration * 1000)
      );
    } catch (e) {
      console.error('startSignal error:', e.message);
    }
  }

  async completeSignal(signalId) {
    try {
      const signal = await prisma.signal.findUnique({
        where: { id: signalId },
        include: { trades: true }
      });
      if (!signal) return;

      const hasPending = signal.trades.some(t => t.outcome === 'PENDING');
      if (signal.status === 'COMPLETED' && !hasPending) return;

      const adminResult = signal.result;
      if (signal.status !== 'COMPLETED') {
        await prisma.signal.update({ where: { id: signalId }, data: { status: 'COMPLETED' } });
      }

      for (const trade of signal.trades) {
        if (trade.outcome !== 'PENDING') continue;

        try {
          let isWin;
          if (adminResult === 'WIN') isWin = true;
          else if (adminResult === 'LOSS') isWin = false;
          else isWin = (trade.direction === signal.direction);

          const profit = isWin ? trade.amount * (signal.rewardPercentage / 100) : -trade.amount;
          const payout = isWin ? trade.amount + profit : 0;

          await prisma.$transaction([
            prisma.trade.update({
              where: { id: trade.id },
              data: { outcome: isWin ? 'WIN' : 'LOSS', profit }
            }),
            prisma.user.update({
              where: { id: trade.userId },
              data: isWin
                ? { perpetualBalance: { increment: payout }, profitBalance: { increment: profit } }
                : { profitBalance: { increment: profit } }
            })
          ]);

          if (this.ns) {
            const msg = isWin
              ? `You won ${profit.toFixed(2)} USDT on ${signal.pair} ${signal.direction}! Total returned: ${payout.toFixed(2)} USDT`
              : `Your ${signal.pair} ${signal.direction} trade lost ${trade.amount.toFixed(2)} USDT.`;
            await this.ns.send(trade.userId, isWin ? 'Signal Win!' : 'Signal Loss', msg, 'SIGNAL').catch(() => { });
          }
        } catch (tradeError) {
          console.error(`Error completing trade ${trade.id} for signal ${signalId}:`, tradeError.message);
        }
      }

      this.io.emit('signal_completed', { signalId, result: adminResult || 'RESOLVED' });
      this._clearTimers(signalId);
    } catch (e) {
      console.error('completeSignal error:', e.message);
    }
  }

  cancelSignal(signalId) {
    this._clearTimers(signalId);
    this.io.emit('signal_cancelled', { signalId });
  }

  _clearTimers(signalId) {
    [signalId, signalId + '_end'].forEach(k => {
      const t = this.timers.get(k);
      if (t) { clearTimeout(t); this.timers.delete(k); }
    });
  }
}

module.exports = SignalService;
