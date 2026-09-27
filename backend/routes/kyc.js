const express = require('express');
const { PrismaClient } = require('@prisma/client');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const prisma = require('../prismaClient');
const router = express.Router();
const authMiddleware = require('../middlewares/auth');

// UPLOADS_DIR lets this point at a Render persistent disk mount (e.g.
// /var/data/uploads) — without it, uploaded files live on the ephemeral
// container filesystem and are wiped on every deploy/restart.
const uploadDir = path.join(process.env.UPLOADS_DIR || path.join(__dirname, '../uploads'), 'kyc');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${req.user.userId}_${file.fieldname}_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|jpg|gif|webp)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

// server.js blocks /uploads/kyc/* entirely (403) to keep KYC documents from
// being publicly reachable by URL — but nothing ever replaced that with an
// authenticated route, so the admin panel's KYC thumbnails (which already
// call GET /api/kyc/file/:filename) always 404'd and never rendered any
// image. Admin-only, since only the admin panel ever needs to view these.
router.get('/file/:filename', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user || user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' });

    const filename = path.basename(req.params.filename); // strip any path traversal
    const filePath = path.join(uploadDir, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    res.sendFile(filePath);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/status', authMiddleware, async (req, res) => {
  try {
    const kyc = await prisma.kYC.findUnique({ where: { userId: req.user.userId } });
    res.json(kyc || { status: 'NONE' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/basic', authMiddleware, async (req, res) => {
  try {
    const { fullName, idNumber, country } = req.body;
    if (!fullName || !idNumber) return res.status(400).json({ error: 'Full name and ID number required' });
    const kyc = await prisma.kYC.upsert({
      where: { userId: req.user.userId },
      update: { fullName, idNumber, country: country || null, status: 'PENDING' },
      create: { userId: req.user.userId, fullName, idNumber, country: country || null, status: 'PENDING' }
    });
    res.json({ success: true, kyc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/upload', authMiddleware,
  upload.fields([{ name: 'selfie', maxCount: 1 }, { name: 'idFront', maxCount: 1 }, { name: 'idBack', maxCount: 1 }]),
  async (req, res) => {
    try {
      const files = req.files || {};
      const updateData = {};
      if (files.selfie?.[0]) updateData.selfieUrl = `/uploads/kyc/${files.selfie[0].filename}`;
      if (files.idFront?.[0]) updateData.idFrontUrl = `/uploads/kyc/${files.idFront[0].filename}`;
      if (files.idBack?.[0]) updateData.idBackUrl = `/uploads/kyc/${files.idBack[0].filename}`;
      if (!Object.keys(updateData).length) return res.status(400).json({ error: 'No files uploaded' });
      const kyc = await prisma.kYC.upsert({
        where: { userId: req.user.userId },
        update: { ...updateData, status: 'PENDING' },
        create: { userId: req.user.userId, ...updateData, status: 'PENDING' }
      });
      res.json({ success: true, kyc });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

module.exports = router;
