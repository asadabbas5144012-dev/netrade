const express = require('express');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const prisma = require('../prismaClient');
const router = express.Router();
const authMiddleware = require('../middlewares/auth');

// In-memory OTP store: email → { code, expiry }
const otpStore = new Map();

function genCode(len = 8) {
  return Math.random().toString(36).substring(2, 2 + len).toUpperCase();
}

function genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

const { getDepositAddress } = require('../config/depositAddress');
const { sendOtpEmail } = require('../services/mailer');

router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const code = genOtp();
    otpStore.set(email.toLowerCase(), { code, expiry: Date.now() + 10 * 60 * 1000 });
    await prisma.otpHistory.create({ data: { email: email.toLowerCase(), code } }).catch(() => {});
    
    // Send email
    const emailResult = await sendOtpEmail(email, code);
    
    if (emailResult.success) {
      res.json({ message: 'OTP sent to your email successfully' });
    } else {
      res.status(500).json({ error: 'Email Error: ' + emailResult.error });
    }
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/register', async (req, res) => {
  try {
    const { email, password, referralCode, otp, phone } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // Verify OTP
    if (!otp) return res.status(400).json({ error: 'Verification code required' });
    const stored = otpStore.get(email.toLowerCase());
    if (!stored || stored.code !== String(otp) || Date.now() > stored.expiry) {
      return res.status(400).json({ error: 'Invalid or expired verification code' });
    }
    otpStore.delete(email.toLowerCase());

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    let referredById = null;
    if (referralCode) {
      const referrer = await prisma.user.findUnique({ where: { referralCode: referralCode.trim().toUpperCase() } });
      if (referrer) referredById = referrer.id;
    }

    const hashed = await bcrypt.hash(password, 10);
    const myCode = genCode(8);

    const user = await prisma.user.create({
      data: {
        email,
        phone: phone || null,
        password: hashed,
        referralCode: myCode,
        referredById,
        isVerified: true,
      }
    });

    // No per-user wallet is generated — every account deposits to the one
    // fixed platform TRC20 address.
    const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, referralCode: user.referralCode, depositAddress: getDepositAddress() } });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log(`Login attempt for: ${email}`);
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    if (user.suspended) return res.status(403).json({ error: 'Account suspended: ' + (user.suspendedReason || 'Contact support') });

    const valid = await bcrypt.compare(password, user.password);
    console.log(`Password valid: ${valid}`);
    if (!valid) return res.status(400).json({ error: 'Incorrect password' });

    // Log login
    await prisma.loginHistory.create({
      data: {
        userId: user.id,
        ip: req.ip || req.headers['x-forwarded-for'] || 'unknown',
        userAgent: req.headers['user-agent'] || 'unknown'
      }
    }).catch(() => {});

    const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        referralCode: user.referralCode,
        balance: user.balance,
        profitBalance: user.profitBalance,
        referralBalance: user.referralBalance,
        isVerified: user.isVerified
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// Admin-only login — only accepts the hardcoded admin credentials from .env
router.post('/admin-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const adminEmail = process.env.ADMIN_EMAIL || '';
    const adminPass  = process.env.ADMIN_PASS || '';

    if (email.toLowerCase() !== adminEmail.toLowerCase() || password !== adminPass) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: 'admin', role: 'ADMIN', email: adminEmail }, process.env.JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: { id: 'admin', email: adminEmail, role: 'ADMIN' } });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.json({ message: 'If that email exists, a reset link was sent' });
    const token = genCode(16);
    await prisma.user.update({
      where: { id: user.id },
      data: { resetToken: token, resetTokenExpiry: new Date(Date.now() + 1800000) } // Expires in exactly 30 minutes
    });
    res.json({ message: 'Reset token generated', resetToken: token });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });
    const user = await prisma.user.findFirst({
      where: { resetToken: token, resetTokenExpiry: { gt: new Date() } }
    });
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset token' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashed, resetToken: null, resetTokenExpiry: null }
    });
    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── 2FA SETUP: generate secret + QR code ──
router.get('/2fa/setup', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Reuse existing secret if already generated but not yet enabled
    let secret = user.otpSecret;
    if (!secret) {
      const generated = speakeasy.generateSecret({ name: `Exchange (${user.email})`, length: 20 });
      secret = generated.base32;
      await prisma.user.update({ where: { id: user.id }, data: { otpSecret: secret } });
    }

    const otpauthUrl = speakeasy.otpauthURL({ secret, label: user.email, issuer: 'Exchange', encoding: 'base32' });
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);

    res.json({ secret, qr_code_base64: qrDataUrl, enabled: user.twoFaEnabled });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── 2FA ENABLE: verify code and activate ──
router.post('/2fa/enable', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code required' });

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user || !user.otpSecret) return res.status(400).json({ error: 'Setup 2FA first' });

    const valid = speakeasy.totp.verify({ secret: user.otpSecret, encoding: 'base32', token: String(code), window: 2 });
    if (!valid) return res.status(400).json({ error: 'Invalid verification code' });

    await prisma.user.update({ where: { id: user.id }, data: { twoFaEnabled: true } });
    res.json({ success: true, message: 'Google Authenticator linked successfully' });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── 2FA VERIFY: check a code against an already-enabled user's secret
// (used to gate sensitive actions like withdrawals) — does not change
// twoFaEnabled, unlike /2fa/enable which is the one-time setup flow ──
router.post('/2fa/verify', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code required' });

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user || !user.twoFaEnabled || !user.otpSecret) {
      return res.status(400).json({ error: '2FA is not enabled on this account' });
    }

    const valid = speakeasy.totp.verify({ secret: user.otpSecret, encoding: 'base32', token: String(code), window: 2 });
    if (!valid) return res.status(400).json({ error: 'Invalid verification code' });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── 2FA DISABLE (remove/change) — requires the account password, not just
// being logged in, since a stolen session token alone shouldn't be enough
// to silently swap out someone's 2FA method ──
router.post('/2fa/disable', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Incorrect password' });

    await prisma.user.update({
      where: { id: user.id },
      data: { twoFaEnabled: false, otpSecret: null }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── 2FA STATUS ──
router.get('/2fa/status', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { twoFaEnabled: true } });
    res.json({ enabled: user?.twoFaEnabled || false });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── REFERRAL QR CODE ──
router.get('/referral-qr', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { referralCode: true } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const referralUrl = `${req.protocol}://${req.get('host')}/register?ref=${user.referralCode}`;
    const qr = await QRCode.toDataURL(referralUrl, { width: 200, margin: 1 });
    res.json({ qr_code_base64: qr, referralCode: user.referralCode, referralUrl });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── ENVIRONMENT DEBUGGING ──
// Admin-only: previously unauthenticated and leaked env var names, the server
// path and part of SMTP_USER to anyone.
router.get('/debug-env', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Access denied' });
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(__dirname, '../.env');
    const envExists = fs.existsSync(envPath);
    res.json({
      cwd: process.cwd(),
      dirname: __dirname,
      envPath: envPath,
      envExists: envExists,
      envKeys: Object.keys(process.env).filter(k => !k.includes('PASS') && !k.includes('SECRET') && !k.includes('MNEMONIC')),
      smtpUser: process.env.SMTP_USER ? process.env.SMTP_USER.substring(0, 5) + '...' : null,
      smtpPassLength: process.env.SMTP_PASS ? process.env.SMTP_PASS.length : 0,
      PORT: process.env.PORT,
    });
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// ── ADMIN OTP VIEW ──
router.get('/admin/otps', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Access denied' });
    const history = await prisma.otpHistory.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100
    });
    const otps = history.map(h => ({
      email: h.email,
      code: h.code,
      expiry: h.createdAt
    }));
    res.json(otps);
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

module.exports = router;
