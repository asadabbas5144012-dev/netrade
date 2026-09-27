/**
 * One-time migration: Trade wallet has been removed from the app.
 * Moves every user's existing tradeBalance into perpetualBalance, then
 * zeroes tradeBalance. Safe to run more than once (a second run is a no-op
 * since tradeBalance will already be 0 for everyone).
 *
 * Run once, after deploying the code that removes Trade:
 *   node migrate-trade-to-perpetual.js
 */
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();
const p = new PrismaClient();

async function main() {
  const affected = await p.user.findMany({
    where: { tradeBalance: { gt: 0 } },
    select: { id: true, email: true, tradeBalance: true, perpetualBalance: true }
  });

  if (!affected.length) {
    console.log('No users have a non-zero tradeBalance — nothing to migrate.');
    return;
  }

  console.log(`Migrating ${affected.length} user(s): tradeBalance -> perpetualBalance\n`);

  for (const u of affected) {
    const newPerp = (u.perpetualBalance || 0) + u.tradeBalance;
    await p.user.update({
      where: { id: u.id },
      data: { perpetualBalance: newPerp, tradeBalance: 0 }
    });
    console.log(`  ${u.email}: tradeBalance ${u.tradeBalance.toFixed(2)} -> perpetualBalance ${newPerp.toFixed(2)}`);
  }

  console.log('\nDone. Every user\'s tradeBalance is now 0; funds moved to perpetualBalance.');
}

main().catch(console.error).finally(() => p.$disconnect());
