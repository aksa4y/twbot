const interactive = require('./interactive');
const {amount: parseAmount} = require('../utils/security');
function createUserHandlers({client, send, duelManager}) {
return {
        '7tv': async (channel, args, username) => {
            await send(channel, `@${username}, ${interactive.handle7tv()}`);
        },
        ping: async (channel, args, username) => {
            await send(channel, `@${username}, ${interactive.handlePing(Date.now())}`);
        },
        eh: async (channel, args, username) => {
            await send(channel, `@${username}, ${interactive.handleEh()}`);
        },
        tg: async (channel, args, username) => {
            await send(channel, `@${username}, ${interactive.handleTg()}`);
        },
        rules: async (channel, args, username) => {
            await send(channel, `@${username}, ${interactive.handleRules()}`);
        },
        iq: async (channel, args, username) => {
            try {
                const response = await interactive.handleIQ(username);
                await send(channel, `@${username}, ${response}`);
            } catch {
                await send(channel, `@${username}, ошибка IQ.`);
            }
        },
        game: async (channel, args, username) => {
            const response = await interactive.handleGame();
            await send(channel, `@${username}, ${response}`);
        },
        followage: async (channel, args, username, tags, isBroadcaster) => {
            try {
                const response = await interactive.handleFollowage(tags, isBroadcaster);
                await send(channel, `@${username}, ${response}`);
            } catch {
                await send(channel, `@${username}, ошибка followage.`);
            }
        },
        categories: async (channel, args, username) => {
            try {
                const response = await interactive.handleCategories(channel.replace('#', ''));
                await send(channel, `@${username}, ${response}`);
            } catch {
                await send(channel, `@${username}, ошибка категорий.`);
            }
        },
        addgift: async (channel, args, username, tags, isBroadcaster, isMod) => {
            if (!args.length) return;
            const response = interactive.addGift(args.join(' '), username, isBroadcaster, isMod);
            await send(channel, response);
        },
        gift: async (channel, args, username, tags, isBroadcaster, isMod) => {
            try {
                const response = await interactive.handleGift(username, client, channel, isBroadcaster, isMod);
                await send(channel, response);
            } catch {
                await send(channel, `@${username}, ошибка подарка.`);
            }
        },
        test: async (channel, args, username) => {
            if (!args.length) return;
            await send(channel, args.join(' '));
        },
        commands: async (channel, args, username) => {
            const response = interactive.handleCommands();
            await send(channel, `@${username}, ${response}`);
        },
        propose: async (channel, args, username) => {
            const response = await interactive.handleGameProposal(args, username);
            await send(channel, response);
        },
        vote: async (channel, args, username) => {
            const response = await interactive.handleVote(args, username);
            await send(channel, response);
        },
        stats: async (channel, args, username) => {
            const response = await interactive.handleStreamStats();
            await send(channel, response);
        },
        proverb: async (channel, args, username) => {
            const response = await interactive.handleProverb(args);
            await send(channel, response);
        },
        roulette: async (channel, args, username) => {
            const response = await interactive.handleRoulette(username);
            await send(channel, response);
        },
        points: async (channel, args, username) => {
            const response = await interactive.handlePoints(username);
            await send(channel, response);
        },
        resetgift: async (channel, args, username, tags, isBroadcaster, isMod) => {
            const response = interactive.handleResetGift(username, isBroadcaster);
            await send(channel, response);
        },
        addpoints: async (channel, args, username, tags, isBroadcaster, isMod) => {
            const response = await interactive.handleAddPoints(args, username, isBroadcaster, isMod);
            await send(channel, response);
        },
        joke: async (channel, args, username) => {
            const response = await interactive.handleJoke();
            await send(channel, response);
        },
        fortune: async (channel, args, username) => {
            const response = await interactive.handleFortune(username);
            await send(channel, response);
        },
        duel: async (channel, args, username) => {
            if (args.length < 2) return await send(channel, `@${username} укажите соперника и ставку. Пример: !дуэль @ник 100`);
            const opponent = args[0].replace('@', '');
            const amount = parseAmount(args[1]);
            if (isNaN(amount) || amount <= 0) return await send(channel, `@${username} укажите корректную ставку.`);
            const result = await duelManager.createDuel(username, opponent, amount, channel);
            if (result) await send(channel, result);
        },
        acceptduel: async (channel, args, username) => {
            const result = await duelManager.acceptDuel(username, channel);
            await send(channel, result);
        },
        declineduel: async (channel, args, username) => {
            const result = await duelManager.declineDuel(username, channel);
            await send(channel, result);
        },
        report: async (channel, args, username) => {
            const response = await interactive.handleReport(args, username);
            await send(channel, response);
        },
        transfer: async (channel, args, username) => {
            const response = await interactive.handleTransfer(args, username);
            await send(channel, response);
        },
        top: async (channel, args, username) => {
            const response = await interactive.handleTop(args);
            await send(channel, response);
        },
    };
}
module.exports = {createUserHandlers};
