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

  // Conditional on the status still being pending_approval, so a double
  // click or two admins approving at once credits the deposit only once.
  const credited = await prisma.$transaction(async (tx) => {
    const r = await tx.deposit.updateMany({
      where: { id: deposit.id, status: 'pending_approval' },
      data: { status: 'confirmed', approvedAt: new Date(), approvedBy: approvedByUserId }
    });
    if (r.count !== 1) return false;
    await tx.user.update({ where: { id: deposit.userId }, data: { balance: { increment: creditAmount } } });
    return true;
  });
  if (!credited) throw new Error('Deposit already processed');

  let notificationMsg = `Your deposit of ${deposit.amount} ${currency} has been credited to your account.`;
  if (currency === 'TRX') {
    notificationMsg = `Your deposit of ${deposit.amount} TRX (~${creditAmount.toFixed(4)} USDT) has been credited to your account.`;
  }
  if (global.ns) await global.ns.send(deposit.userId, 'Deposit Approved', notificationMsg, 'DEPOSIT');
}

module.exports = { approveDeposit };
