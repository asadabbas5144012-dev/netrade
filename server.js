const express = require('express');
const http = require('http');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const hpp = require('hpp');
const xss = require('xss-clean');

dotenv.config({ path: path.join(__dirname, '.env') });

const NotificationService = require('./backend/services/notificationService');
const WalletService = require('./backend/services/walletService');
const SignalService = require('./backend/services/signalService');
const MarketService = require('./backend/services/marketService');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const allowedOrigins = [
  'http://localhost',
  'http://localhost:3000',
  'http://localhost:8080',
  'https://localhost',
  'capacitor://localhost',
  'http://127.0.0.1',
  'http://127.0.0.1:3000',
  'https://netrontrade.onrender.com'
];
if (process.env.APP_DOMAIN) {
  allowedOrigins.push(process.env.APP_DOMAIN);
  allowedOrigins.push(`https://${process.env.APP_DOMAIN}`);
}
app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Blocked by CORS policy'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

// --- HARD SECURITY LAYER ---
// Protect against tracing, cross-site scripting (XSS), and clickjacking
app.use(helmet({ 
  contentSecurityPolicy: false, // Disabled to allow external images/CDNs (like ui-avatars, MEXC)
  crossOriginEmbedderPolicy: false
})); 

// Prevent Multiple Link Attacks & Brute Force (Rate Limiting)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: 1200, // Limit each IP to 1200 requests per 15 minutes
  message: { error: 'Too many requests from this IP, please try again later.' },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});
app.use(limiter);

// Protect against HTTP Parameter Pollution attacks
app.use(hpp());

// Protect against Cross-Site Scripting (XSS) attacks
app.use(xss());
// ---------------------------

// PREVENT DOS ATTACKS: Lowered payload limits from 50mb to 5mb. 
// Hackers could crash the server by sending massive 50MB fake JSON bodies.
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
// Serve only safe public files (not source code)
const FRONTEND = path.join(__dirname, 'frontend');
const PUBLIC_FILES = ['index.html','style.css','app.js','manifest.json','sw.js','netrontrade-logo.svg','favicon.png','app-icon.png','netrontrade-icon-192.png','privacy-policy.html','netrontrade.apk'];
PUBLIC_FILES.forEach(f => {
  app.get('/' + f, (req, res) => res.sendFile(path.join(FRONTEND, f)));
});
app.use('/assets', express.static(path.join(FRONTEND, 'assets')));
app.use('/icons', express.static(path.join(FRONTEND, 'icons')));
// Block KYC uploads from public access — served only via auth routes
app.use('/uploads/kyc', (req, res) => res.status(403).json({ error: 'Forbidden' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Initialize Services
const notificationService = new NotificationService(io);
const walletService = new WalletService(notificationService);
const signalService = new SignalService(io, notificationService);
const marketService = new MarketService(io);

// Global access for routes
global.io = io;
global.ns = notificationService;
global.ws = walletService;
global.ss = signalService;
global.ms = marketService;

// All deposits go to one fixed platform TRC20 address (no per-user wallets).
console.log(`[DepositAddress] TRC20 deposit address: ${require('./backend/config/depositAddress').getDepositAddress()}`);

// Admin Panel Route
const adminPath = process.env.ADMIN_URL_PATH || '/94875Efn239120';
app.get(adminPath, (_req, res) => res.sendFile(path.join(__dirname, 'frontend', 'secure_admin_panel.html')));

// Public app settings endpoint (no auth) — about us, support links, etc.
app.get('/api/public/settings', async (_req, res) => {
  try {
    const prisma = require('./backend/prismaClient');
    const PUBLIC_KEYS = ['app_name','app_version','apk_download_url','app_description','app_website_url','app_twitter_url','app_telegram_url','support_email','support_telegram','support_faq_url','app_banners','rules_content_json','withdrawal_handling_fee_pct','promo_banner'];
    const rows = await prisma.platformSettings.findMany({ where: { key: { in: PUBLIC_KEYS } } });
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    res.json(obj);
  } catch (e) {
    res.json({});
  }
});

// Public ticker endpoint (no auth)
app.get('/api/ticker', async (_req, res) => {
  try {
    const prisma = require('./backend/prismaClient');
    const [tickerSetting, termsSetting] = await Promise.all([
      prisma.platformSettings.findUnique({ where: { key: 'ticker_text' } }),
      prisma.platformSettings.findUnique({ where: { key: 'penalty_terms_text' } })
    ]);
    res.json({
      text: tickerSetting ? tickerSetting.value : 'NETRONTRADE demonstrates commitment to secure and transparent digital asset operations.',
      penaltyTerms: termsSetting ? termsSetting.value : 'Please note that transferring principal funds from Trade back to Exchange before the lock period expires will incur an early withdrawal penalty.'
    });
  } catch (e) {
    res.json({
      text: 'NETRONTRADE demonstrates commitment to secure and transparent digital asset operations.',
      penaltyTerms: 'Please note that transferring principal funds from Trade back to Exchange before the lock period expires will incur an early withdrawal penalty.'
    });
  }
});

// Uploaded files served above (with KYC blocked)

// Attach io to every request so routes can emit events
app.use((req, _res, next) => { req.io = io; next(); });

// API Routes
app.use('/api/auth', require('./backend/routes/auth'));
app.use('/api/user', require('./backend/routes/user'));
app.use('/api/admin', require('./backend/routes/admin'));

// Admin referral management
app.get('/api/admin_referral/dashboard', async (req, res) => {
  try {
    const prisma = require('./backend/prismaClient');
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const referredWhere = { referredById: { not: null } };

    const [totalReferralUsers, activeReferrals, inactiveReferrals, newReferralsToday, newReferralsThisMonth, rewardAgg, topReferrersRaw, referredUsers] = await Promise.all([
      prisma.user.count({ where: referredWhere }),
      prisma.user.count({ where: { ...referredWhere, suspended: false } }),
      prisma.user.count({ where: { ...referredWhere, suspended: true } }),
      prisma.user.count({ where: { ...referredWhere, createdAt: { gte: startOfToday } } }),
      prisma.user.count({ where: { ...referredWhere, createdAt: { gte: startOfMonth } } }),
      prisma.user.aggregate({ _sum: { referralBalance: true } }),
      prisma.user.findMany({
        where: { referrals: { some: {} } },
        select: { email: true, _count: { select: { referrals: true } } },
        orderBy: { referrals: { _count: 'desc' } },
        take: 5
      }),
      prisma.user.findMany({ where: referredWhere, select: { id: true } })
    ]);

    const depositAgg = referredUsers.length
      ? await prisma.deposit.aggregate({ where: { userId: { in: referredUsers.map(u => u.id) }, status: 'confirmed' }, _sum: { amount: true } })
      : { _sum: { amount: 0 } };

    res.json({
      totalReferralUsers,
      totalRewardsPaid: rewardAgg._sum.referralBalance || 0,
      // No queued/pending commission state exists — commissions are credited
      // instantly on deposit approval (see admin.js /transactions/:id/approve).
      pendingRewards: 0,
      activeReferrals,
      inactiveReferrals,
      totalReferralDeposits: depositAgg._sum.amount || 0,
      newReferralsToday,
      newReferralsThisMonth,
      topReferrers: topReferrersRaw.map(u => ({ email: u.email, count: u._count.referrals }))
    });
  } catch (e) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});
app.get('/api/admin_referral/slabs', async (req, res) => {
  try { const prisma = require('./backend/prismaClient'); const s = await prisma.platformSettings.findUnique({ where: { key: 'referral_slabs' } }); res.json(s ? JSON.parse(s.value) : []); } catch (e) { res.json([]); }
});
app.post('/api/admin_referral/slabs', async (req, res) => {
  try { const prisma = require('./backend/prismaClient'); await prisma.platformSettings.upsert({ where: { key: 'referral_slabs' }, update: { value: JSON.stringify(req.body) }, create: { key: 'referral_slabs', value: JSON.stringify(req.body) } }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin_referral/content', async (req, res) => {
  try { const prisma = require('./backend/prismaClient'); const s = await prisma.platformSettings.findUnique({ where: { key: 'referral_content' } }); res.json(s ? JSON.parse(s.value) : {}); } catch (e) { res.json({}); }
});
app.post('/api/admin_referral/content', async (req, res) => {
  try { const prisma = require('./backend/prismaClient'); await prisma.platformSettings.upsert({ where: { key: 'referral_content' }, update: { value: JSON.stringify(req.body) }, create: { key: 'referral_content', value: JSON.stringify(req.body) } }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
// Each commission payout already exists as a Transaction row (type
// REFERRAL_COMMISSION, userId = the referrer who got paid) created in
// admin.js's /transactions/:id/approve — no separate reward log table.
// The depositor's email is only recorded in that transaction's free-text
// note ("Referral from x@y.com"), since there's no stored relation to it.
app.get('/api/admin_referral/history', async (req, res) => {
  try {
    const prisma = require('./backend/prismaClient');
    const page = parseInt(req.query.page) || 1;
    const { q, from, to } = req.query;
    const where = { type: 'REFERRAL_COMMISSION' };
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(new Date(to).getTime() + 86400000 - 1);
    }
    if (q) {
      where.OR = [
        { user: { email: { contains: q, mode: 'insensitive' } } },
        { note: { contains: q, mode: 'insensitive' } }
      ];
    }
    const [rows, total, pctSetting] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: { user: { select: { email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * 20,
        take: 20
      }),
      prisma.transaction.count({ where }),
      prisma.platformSettings.findUnique({ where: { key: 'referral_percentage' } })
    ]);
    const pct = parseFloat(pctSetting?.value || '5');
    const history = rows.map(t => {
      const m = /Referral from (.+)$/.exec(t.note || '');
      return {
        createdAt: t.createdAt,
        user: t.user,
        referrer: { email: m ? m[1] : 'Unknown' },
        level: 1, // flat single-level commission — no multi-level payout exists yet
        percentage: pct, // current rate; the rate at payout time isn't stored per-transaction
        amount: t.amount,
        status: t.status
      };
    });
    res.json({ history, total });
  } catch (e) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});
app.get('/api/admin_referral/report', (req, res) => res.json({ tree: [], summary: {} }));
app.get('/api/admin_referral/report/pdf', (req, res) => res.status(501).json({ error: 'PDF not configured' }));
app.use('/api/signals', require('./backend/routes/signals'));
app.use('/api/wallet', require('./backend/routes/wallet'));
app.use('/api/kyc', require('./backend/routes/kyc'));
app.use('/api/referral', require('./backend/routes/referral'));

// SPA Catch-all route to serve index.html for client-side routing (e.g. /register?ref=...)


// Proxy endpoint for MEXC to bypass browser CORS
app.get('/api/mexc/*', (req, res) => {
  const https = require('https');
  const proxyPath = req.originalUrl.replace('/api/mexc', '/api/v3').replace('interval=1h', 'interval=60m');
  const url = 'https://api.mexc.com' + proxyPath;
  https.get(url, (mexcRes) => {
    let data = '';
    mexcRes.on('data', chunk => data += chunk);
    mexcRes.on('end', () => {
      try { res.json(JSON.parse(data)); } catch (e) { res.status(500).json({ error: 'Parse error' }); }
    });
  }).on('error', (e) => res.status(500).json({ error: 'Network error' }));
});

app.get('*', (req, res) => {

  if (req.path.startsWith('/api/') || req.path === '/admin-secure-login-12345') {
    return res.status(404).json({ error: 'Not Found' });
  }
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});
// Socket.io Auth & Personal Rooms
io.on('connection', (socket) => {
  socket.on('authenticate', (token) => {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;
      socket.join(`user_${decoded.userId}`);
      
      // Send initial data
      socket.emit('market_init', marketService.prices);
    } catch (err) {}
  });
});

// Global Error Handler to ensure API never returns HTML errors
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'An internal server error occurred.' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Production server running on port ${PORT}`);
});
// Trigger redeploy
