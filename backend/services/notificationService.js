const prisma = require('../prismaClient');

class NotificationService {
  constructor(io) {
    this.io = io;
  }

  async send(userId, title, message, type = 'ADMIN') {
    try {
      const notification = await prisma.notification.create({
        data: { userId, title, message, type }
      });

      this.io.to(`user_${userId}`).emit('notification', notification);
      return notification;
    } catch (err) {
      console.error('Failed to send notification:', err);
    }
  }

  async getUnread(userId) {
    return prisma.notification.findMany({
      where: { userId, read: false },
      orderBy: { createdAt: 'desc' }
    });
  }
}

module.exports = NotificationService;
