const prisma = require('../prismaClient');

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

    const result = await prisma.$transaction([
      prisma.investment.create({ data: { userId, amount, status: 'ACTIVE' } }),
      prisma.user.update({ where: { id: userId }, data: { balance: { decrement: amount }, investments: { increment: amount } } })
    ]);

    if (this.ns) await this.ns.send(userId, 'Investment Created', `${amount} USDT invested successfully.`, 'INVESTMENT');
    return result[0];
  }
}

module.exports = WalletService;
