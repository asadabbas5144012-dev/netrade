const prisma = require('../prismaClient');
const { debit } = require('./ledger');

class WalletService {
  constructor(notificationService) {
    this.ns = notificationService;
  }

  async deposit(userId, amount, txHash, network) {
    const tx = await prisma.$transaction([
      prisma.transaction.create({
        data: { userId, type: 'DEPOSIT', amount, status: 'COMPLETED', txHash, network: network || 'TRC20' }
      }),
      prisma.user.update({ where: { id: userId }, data: { balance: { increment: amount } } })
    ]);
    if (this.ns) await this.ns.send(userId, 'Deposit Credited', `${amount} USDT has been added to your account.`, 'DEPOSIT');
    return tx;
  }

  async invest(userId, amount) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found');
    if (user.balance < amount) throw new Error('Insufficient balance');

    const investment = await prisma.$transaction(async (tx) => {
      if (!(await debit(tx, userId, 'balance', amount))) throw new Error('Insufficient balance');
      await tx.user.update({ where: { id: userId }, data: { investments: { increment: amount } } });
      return tx.investment.create({ data: { userId, amount, status: 'ACTIVE' } });
    });

    if (this.ns) await this.ns.send(userId, 'Investment Created', `${amount} USDT invested successfully.`, 'INVESTMENT');
    return investment;
  }
}

module.exports = WalletService;
