const database = require('./database');

class DuelManager {
    constructor(client, safeSay) {
        this.client = client;
        this.safeSay = safeSay;

    }

    async createDuel(challenger, opponent, amount, channel) {
        challenger = require('../utils/security').username(challenger);
        opponent = require('../utils/security').username(opponent);
        amount = require('../utils/security').amount(amount);
        if (challenger === opponent) {
            return `@${challenger} нельзя дуэлировать с самим собой.`;
        }

        const challengerPoints = await database.getUserPoints(challenger);
        if (challengerPoints < amount) {
            return `@${challenger} у вас недостаточно очков для дуэли.`;
        }

        const existing = await database.getPendingDuelByOpponent(opponent);
        if (existing) {
            return `@${challenger} для @${opponent} уже есть активная дуэль.`;
        }

        const expiresAt = new Date(Date.now() + 60 * 1000); 
        await database.createDuel(challenger, opponent, amount, expiresAt);

        const message = `@${opponent} вас вызывает на дуэль @${challenger} на ${amount} очков! Напишите !принять или !отклонить (60 секунд)`;
        await this.safeSay(channel, message);

        return null; 
    }

    async acceptDuel(opponent, channel) {
        const duel = await database.getPendingDuelByOpponent(opponent);
        if (!duel) {
            return `@${opponent} у вас нет активных вызовов на дуэль.`;
        }

        if (new Date(duel.expires_at) < new Date()) {
            await database.updateDuelStatus(duel.id, 'expired');
            return `@${opponent} срок принятия дуэли истёк.`;
        }

        const { challenger, amount } = duel;

        const opponentPoints = await database.getUserPoints(opponent);
        if (opponentPoints < amount) {
            return `@${opponent} у вас недостаточно очков для принятия дуэли.`;
        }

        const winner = Math.random() < 0.5 ? challenger : opponent;
        await database.settleDuel(duel.id, winner);

        return `🎉 @${winner} побеждает в дуэли и получает ${amount} очков от соперника!`;
    }

    async declineDuel(opponent, channel) {
        const duel = await database.getPendingDuelByOpponent(opponent);
        if (!duel) {
            return `@${opponent} у вас нет активных вызовов на дуэль.`;
        }
        await database.updateDuelStatus(duel.id, 'declined');
        return `@${opponent} отклонил(а) дуэль.`;
    }
}

module.exports = DuelManager;
