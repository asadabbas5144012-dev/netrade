const prisma = require('../prismaClient');

// Credits a pending_approval deposit to the user's balance. Used by the admin
// approve route. All deposits go to the single fixed platform TRC20 address
// (config/depositAddress.js), so there is no per-user wallet to sweep.
async function approveDeposit(depositId, approvedByUserId = null) {
  const deposit = await prisma.deposit.findUnique({ where: { id: depositId } });
  if (!deposit) throw new Error('Deposit not found');
  if (deposit.status !== 'pending_approval') throw new Error('Deposit already processed');

  const currency = deposit.currency || 'USDT';
  let creditAmount = deposit.amount;

  if (currency === 'TRX') {
    const trxPriceObj = global.ms ? global.ms.getPrice('TRX/USDT') : { price: 0 };
    const trxPrice = trxPriceObj.price || 0;
    if (trxPrice <= 0) throw new Error('Unable to fetch real-time TRX price');
    creditAmount = deposit.amount * trxPrice;
  }

  await prisma.$transaction([
    prisma.deposit.update({
      where: { id: deposit.id },
      data: { status: 'confirmed', approvedAt: new Date(), approvedBy: approvedByUserId }
    }),
    prisma.user.update({
      where: { id: deposit.userId },
      data: { balance: { increment: creditAmount } }
    })
  ]);

  let notificationMsg = `Your deposit of ${deposit.amount} ${currency} has been credited to your account.`;
  if (currency === 'TRX') {
    notificationMsg = `Your deposit of ${deposit.amount} TRX (~${creditAmount.toFixed(4)} USDT) has been credited to your account.`;
  }
  if (global.ns) await global.ns.send(deposit.userId, 'Deposit Approved', notificationMsg, 'DEPOSIT');
}

module.exports = { approveDeposit };
