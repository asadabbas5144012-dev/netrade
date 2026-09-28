// One-time, idempotent safety step run in the build BEFORE `prisma db push`.
// The legacy per-user (child) wallet tables and Deposit sweep columns were
// removed from schema.prisma, so `db push --accept-data-loss` drops them.
// This copies any existing rows into PlatformSettings (key
// "legacy_wallet_archive") first, so no production data is lost silently.
// Exits non-zero on failure so the build stops before anything is dropped.
const { PrismaClient } = require('@prisma/client');

const ARCHIVE_KEY = 'legacy_wallet_archive';

async function tableExists(prisma, table) {
  const rows = await prisma.$queryRawUnsafe(`SELECT to_regclass('public."${table}"') IS NOT NULL AS "exists"`);
  return Boolean(rows[0] && rows[0].exists);
}

async function columnExists(prisma, table, column) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    table, column
  );
  return rows.length > 0;
}

async function main() {
  if (!/^postgres(ql)?:\/\//.test(process.env.DATABASE_URL || '')) {
    console.log('[archive-legacy-wallets] DATABASE_URL is not PostgreSQL — skipping');
    return;
  }
  const prisma = new PrismaClient();
  try {
    const archive = {};
    if (await tableExists(prisma, 'TronWallet')) {
      archive.tronWallets = await prisma.$queryRawUnsafe(`SELECT * FROM "TronWallet"`);
    }
    if (await tableExists(prisma, 'WalletAddress')) {
      archive.walletAddresses = await prisma.$queryRawUnsafe(`SELECT * FROM "WalletAddress"`);
    }
    if (await columnExists(prisma, 'Deposit', 'sweepStatus')) {
      archive.depositSweeps = await prisma.$queryRawUnsafe(
        `SELECT "id", "txHash", "sweepTxHash", "sweepStatus", "sweepError" FROM "Deposit"
         WHERE "sweepTxHash" IS NOT NULL OR "sweepError" IS NOT NULL OR "sweepStatus" <> 'pending'`
      );
    }

    const count = Object.values(archive).reduce((n, rows) => n + rows.length, 0);
    if (!Object.keys(archive).length) {
      console.log('[archive-legacy-wallets] No legacy wallet tables/columns found — nothing to archive');
      return;
    }
    if (count === 0) {
      console.log('[archive-legacy-wallets] Legacy wallet tables/columns are empty — nothing to archive');
      return;
    }
    if (!(await tableExists(prisma, 'PlatformSettings'))) {
      throw new Error('PlatformSettings table missing — refusing to continue so legacy rows are not dropped');
    }

    const existing = await prisma.platformSettings.findUnique({ where: { key: ARCHIVE_KEY } });
    const previous = existing ? JSON.parse(existing.value) : {};
    const value = JSON.stringify({ ...previous, ...archive, archivedAt: new Date().toISOString() });
    await prisma.platformSettings.upsert({
      where: { key: ARCHIVE_KEY },
      update: { value },
      create: { key: ARCHIVE_KEY, value }
    });
    console.log(`[archive-legacy-wallets] Archived ${count} legacy row(s) to PlatformSettings["${ARCHIVE_KEY}"]`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // Prisma messages start with blank lines; trim so the cause shows in build logs.
  console.error('[archive-legacy-wallets] FAILED — build stopped before db push:', String(err.message || err).trim());
  process.exit(1);
});
