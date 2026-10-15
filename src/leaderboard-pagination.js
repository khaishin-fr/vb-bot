import { PermissionFlagsBits } from 'discord.js';

export const PAGE_WINDOW_MS = 5 * 60_000;
export const PAGE_ARROWS = ['◀️', '▶️'];
const arrowName = reaction => reaction.emoji.name?.replace(/\uFE0F/g, '');
export const PAGINATION_PERMISSIONS = [PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages];

export function createLeaderboardPagination() {
  const sessions = new Map();
  const report = error => {
    if (error.code !== 10008) console.error('Leaderboard pagination failed:', error.message);
  };

  async function start(message, { pageCount, buildPage }) {
    let page = 0;
    const session = { browsing: false, ended: false, queue: Promise.resolve(), cleanup: null };
    const collector = message.createReactionCollector({
      time: PAGE_WINDOW_MS,
      filter: (reaction, user) => !user.bot && ['◀', '▶'].includes(arrowName(reaction)),
    });
    session.collector = collector;
    sessions.set(message.id, session);
    collector.on('collect', (reaction, user) => {
      if (session.ended) return;
      session.browsing = true;
      session.queue = session.queue.then(async () => {
        if (session.ended) return;
        await reaction.users.remove(user.id);
        const next = (page + (arrowName(reaction) === '◀' ? -1 : 1) + pageCount) % pageCount;
        const payload = await buildPage(next);
        if (session.ended) return;
        await message.edit({ ...payload, attachments: [] });
        page = next;
      }).catch(report);
    });
    collector.on('end', () => {
      session.ended = true;
      session.cleanup = Promise.resolve(session.setup).catch(() => {}).then(() => session.queue)
        .then(() => message.reactions.removeAll()).catch(report).finally(() => {
        if (sessions.get(message.id) === session) sessions.delete(message.id);
      });
    });
    session.setup = (async () => {
      for (const arrow of PAGE_ARROWS) {
        if (session.ended) break;
        await message.react(arrow);
      }
    })();
    try {
      await session.setup;
    } catch (error) {
      collector.stop('setup-failed');
      await session.cleanup;
      throw error;
    }
  }

  async function stop(messageId) {
    const session = sessions.get(messageId);
    if (!session) return;
    session.collector.stop('stopped');
    await session.cleanup;
  }

  return {
    start, stop,
    isBrowsing: messageId => Boolean(sessions.get(messageId)?.browsing),
    stopAll: () => Promise.all([...sessions.keys()].map(stop)),
  };
}
