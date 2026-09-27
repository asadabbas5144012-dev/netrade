const express = require('express');
const prisma = require('../prismaClient');
const router = express.Router();
const authMiddleware = require('../middlewares/auth');

// GET /api/referral/info — public endpoint: returns referral page content from platform settings
router.get('/info', async (req, res) => {
  try {
    const REFERRAL_KEYS = [
      'referral_title', 'referral_description', 'referral_terms',
      'referral_faq', 'referral_banner', 'referral_announcement'
    ];
    const rows = await prisma.platformSettings.findMany({ where: { key: { in: REFERRAL_KEYS } } });
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    res.json(obj);
  } catch (e) {
    res.json({});
  }
});

// GET /api/referral/dashboard — authenticated: returns user's referral stats, tree, and history
router.get('/dashboard', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: {
        id: true,
        email: true,
        referralCode: true,
        referralBalance: true,
        referrals: {
          select: {
            id: true,
            email: true,
            referralCode: true,
            balance: true,
            perpetualBalance: true,
            referralBalance: true,
            createdAt: true,
            referrals: {
              select: {
                id: true,
                email: true,
                referralCode: true,
                balance: true,
                perpetualBalance: true,
                referralBalance: true,
                createdAt: true,
                referrals: {
                  select: {
                    id: true,
                    email: true,
                    referralCode: true,
                    balance: true,
                    perpetualBalance: true,
                    referralBalance: true,
                    createdAt: true,
                    referrals: {
                      select: {
                        id: true,
                        email: true,
                        referralCode: true,
                        balance: true,
                        perpetualBalance: true,
                        referralBalance: true,
                        createdAt: true
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Flatten the referral tree into levels (up to 4 levels deep)
    const now = new Date();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000);

    // Build flat tree array with levels for frontend rendering
    const treeNodes = [];
    let totalDirect = 0;
    let totalIndirect = 0;
    let totalTeam = 0;
    let totalTeamDeposits = 0;
    let totalRewards = user.referralBalance || 0;
    let activeTeamMembers = 0;
    let newLast7 = 0;
    let newPrev7 = 0;
    let weekDeposits = 0;
    let weekEarnings = 0;

    function processNode(member, level, parentEmail) {
      const totalBal = (member.balance || 0) + (member.perpetualBalance || 0);
      const joinedAt = member.createdAt;
      const isActive = totalBal > 0;

      if (isActive) activeTeamMembers++;
      totalTeamDeposits += totalBal;
      totalTeam++;
      if (level === 1) totalDirect++;
      else totalIndirect++;

      const joinDate = new Date(joinedAt);
      if (joinDate >= sevenDaysAgo) newLast7++;
      else if (joinDate >= fourteenDaysAgo) newPrev7++;

      if (joinDate >= sevenDaysAgo && isActive) weekDeposits += totalBal;

      treeNodes.push({
        id: member.id,
        email: member.email,
        referralCode: member.referralCode,
        level,
        parentEmail: parentEmail || null,
        joinedAt: member.createdAt,
        totalDeposit: totalBal,
        rewardEarned: member.referralBalance || 0,
        children: []
      });

      if (member.referrals && level < 4) {
        member.referrals.forEach(child => processNode(child, level + 1, member.email));
      }
    }

    (user.referrals || []).forEach(m => processNode(m, 1, user.email));

    // Build levels summary (count + rewards per level)
    const levelStats = { 1: { count: 0, reward: 0 }, 2: { count: 0, reward: 0 }, 3: { count: 0, reward: 0 }, 4: { count: 0, reward: 0 } };
    treeNodes.forEach(n => {
      if (n.level >= 1 && n.level <= 4) {
        levelStats[n.level].count++;
      }
    });

    // Stats object matching frontend expectations
    const stats = {
      totalRewards,
      totalDirect,
      totalIndirect,
      activeTeamMembers,
      activeReferrals: activeTeamMembers,
      totalTeam,
      totalTeamDeposits,
      growth: { last7Days: newLast7, prev7Days: newPrev7 },
      thisWeek: { newMembers: newLast7, deposits: weekDeposits, earnings: weekEarnings }
    };

    res.json({
      referralCode: user.referralCode,
      stats,
      levels: levelStats,
      tree: treeNodes,
      history: [] // Referral reward transaction history — extend later if ReferralReward model added
    });
  } catch (e) {
    console.error('Referral dashboard error:', e);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

module.exports = router;
