import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { PAGINATION_PERMISSIONS } from './leaderboard-pagination.js';

export function createPersistentLeaderboards({ client, tracker, store, buildPayload, available,
  onPosted = async () => {}, beforeRemove = async () => {}, isBrowsing = () => false }) {
  const locks = new Map();

  function exclusive(guildId, action) {
    const operation = (locks.get(guildId) ?? Promise.resolve()).catch(() => {}).then(action);
    locks.set(guildId, operation);
    const clean = () => { if (locks.get(guildId) === operation) locks.delete(guildId); };
    operation.then(clean, clean);
    return operation;
  }

  async function destination(guild, channelId) {
    const channel = await guild.channels.fetch(channelId);
    if (!channel || channel.guildId !== guild.id
      || ![ChannelType.GuildText, ChannelType.GuildVoice].includes(channel.type)) {
      throw new Error('Choose an accessible text or voice channel in this server.');
    }
    const me = guild.members.me ?? await guild.members.fetchMe();
    if (!channel.permissionsFor(me)?.has([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles, ...PAGINATION_PERMISSIONS,
      ...(channel.type === ChannelType.GuildVoice ? [PermissionFlagsBits.Connect] : []),
    ])) {
      throw new Error('I need View Channel, Send Messages, Embed Links, Attach Files, Read Message History, Add Reactions, and Manage Messages there (plus Connect for voice-channel chat).');
    }
    return channel;
  }

  async function existing(channel, messageId) {
    try { return await channel.messages.fetch(messageId); } catch (error) {
      // Only a confirmed deleted message warrants replacement. Permission/network errors retry later.
      if (error.code === 10008) return null;
      throw error;
    }
  }

  async function update(guild, channelId, automatic = false) {
    if (!available(guild)) throw new Error('The server connection is recovering. Try again shortly.');
    const previous = tracker.config(guild.id)?.leaderboard;
    const channel = await destination(guild, channelId);
    const payload = await buildPayload(guild);
    const message = previous?.channelId === channelId ? await existing(channel, previous.messageId) : null;
    if (!available(guild)) return;
    if (automatic && previous && isBrowsing(previous.messageId)) return previous;
    if (message) {
      await beforeRemove(message.id);
      try { await message.delete(); } catch (error) {
        // A concurrent deletion is harmless; other failures must not leave duplicate boards.
        if (error.code !== 10008) throw error;
      }
    }
    const posted = await channel.send(payload);
    // Keep the new ID even if saving fails, so the next refresh can remove this message.
    const board = { channelId, messageId: posted.id };
    tracker.config(guild.id).leaderboard = board;
    await store.save();
    await onPosted(posted, payload);
    if (previous && previous.channelId !== channelId) {
      try {
        const oldChannel = await guild.channels.fetch(previous.channelId);
        const oldMessage = oldChannel && await existing(oldChannel, previous.messageId);
        await beforeRemove(previous.messageId);
        if (oldMessage) await oldMessage.delete();
      } catch (error) {
        console.error(`Could not remove the old leaderboard in server ${guild.id}:`, error.message);
      }
    }
    return board;
  }

  return {
    set(guild, channelId) { return exclusive(guild.id, () => update(guild, channelId)); },
    stop(guildId) {
      return exclusive(guildId, async () => {
        const config = tracker.config(guildId);
        if (config?.leaderboard) await beforeRemove(config.leaderboard.messageId);
        if (config) config.leaderboard = null;
        await store.save();
      });
    },
    async refresh() {
      const updates = [];
      for (const guild of client.guilds.cache.values()) {
        const board = tracker.config(guild.id)?.leaderboard;
        if (!board || !available(guild) || locks.has(guild.id) || isBrowsing(board.messageId)) continue;
        updates.push(exclusive(guild.id, () => update(guild, board.channelId, true)).catch(error => {
          console.error(`Leaderboard update failed in server ${guild.id}; retrying next interval:`, error.message);
        }));
      }
      await Promise.all(updates);
    },
  };
}
