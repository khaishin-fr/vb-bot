import { AttachmentBuilder, ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { BLUE, canConfigure } from '../config.js';
import { duration, renderLeaderboard } from './leaderboard.js';
import { createPersistentLeaderboards } from './persistent-leaderboard.js';

export const embed = (title, description) => new EmbedBuilder()
  .setColor(BLUE).setTitle(title).setDescription(description)
  .setFooter({ text: 'Voice activity' }).setTimestamp();

export function createRuntime({ client, tracker, store, now = Date.now, render = renderLeaderboard }) {
  const sending = new Set();
  const suspendedShards = new Set();
  let stopped = false;

  function syncGuild(guild) {
    if (stopped) return;
    if (!guild.available || suspendedShards.has(guild.shardId)) {
      tracker.suspend(guild.id);
      return;
    }
    const config = tracker.config(guild.id);
    if (!config) return;
    const members = [...guild.voiceStates.cache.values()]
      .filter(state => state.channelId === config.voiceChannelId && state.member)
      .map(state => ({ id: state.id, name: state.member.displayName, bot: state.member.user.bot,
        avatarUrl: state.member.displayAvatarURL?.({ extension: 'png', size: 128 }) ?? null }));
    tracker.sync(guild.id, members, now());
  }

  function suspendShard(shardId) {
    suspendedShards.add(shardId);
    for (const guild of client.guilds.cache.values()) {
      if (guild.shardId === shardId) tracker.suspend(guild.id);
    }
  }

  function resumeShard(shardId) {
    suspendedShards.delete(shardId);
    for (const guild of client.guilds.cache.values()) {
      if (guild.shardId === shardId) syncGuild(guild);
    }
  }

  async function tick() {
    if (stopped || !client.isReady()) return;
    const alerts = [];
    for (const guild of client.guilds.cache.values()) {
      syncGuild(guild);
      const config = tracker.config(guild.id);
      const alert = tracker.pendingAlert(guild.id);
      if (config && alert) alerts.push({ guild, config, alert });
    }
    await store.save();
    if (stopped) return;
    await Promise.all(alerts.map(async ({ guild, config, alert }) => {
      if (sending.has(guild.id)) return;
      sending.add(guild.id);
      try {
        const channel = await guild.channels.fetch(config.alertChannelId);
        // Recheck after fetching: a user could have joined or configuration changed.
        if (stopped || tracker.config(guild.id) !== config || tracker.pendingAlert(guild.id) !== alert) return;
        if (!channel?.isSendable()) throw new Error('Alert channel is missing or cannot receive messages.');
        await channel.send({ embeds: [embed('Voice channel update', config.alertMessage)], allowedMentions: { parse: [] } });
        alert.sent = true;
      } catch (error) {
        console.error(`Alert failed in server ${guild.id}; will retry on the next poll:`, error.message);
      } finally {
        sending.delete(guild.id);
      }
    }));
    return true;
  }

  async function onInteraction(interaction) {
    if (stopped) return;
    if (!interaction.isChatInputCommand() || !['configure', 'message', 'leaderboard', 'leaderboard-channel', 'leaderboard-stop', 'mytime'].includes(interaction.commandName)) return;
    const reply = (title, description) => interaction.reply({
      embeds: [embed(title, description)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
    });
    if (!interaction.inGuild()) return reply('Server only', 'Run this command in your Discord server.');
    if (['configure', 'message', 'leaderboard-channel', 'leaderboard-stop'].includes(interaction.commandName)
      && !canConfigure(interaction.user.id, interaction.guild?.ownerId)) {
      return reply('Access denied', 'Only this server’s owner or a user listed in config.js can change its settings.');
    }
    await interaction.deferReply(['leaderboard', 'mytime'].includes(interaction.commandName) ? {} : { flags: MessageFlags.Ephemeral });
    const edit = (title, description) => interaction.editReply({ embeds: [embed(title, description)], allowedMentions: { parse: [] } });
    const guild = interaction.guild;
    if (!guild?.available || suspendedShards.has(guild.shardId)) {
      return edit('Temporarily unavailable', 'The server connection is recovering. Please try again shortly.');
    }
    if (interaction.commandName === 'configure') {
      const channelId = interaction.options.getString('voice-channel-id', true).trim();
      if (!/^\d{17,20}$/.test(channelId)) return edit('Invalid channel ID', 'Enter a Discord voice channel ID.');
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (channel?.type !== ChannelType.GuildVoice || channel.guildId !== guild.id) {
        return edit('Invalid voice channel', 'Choose a regular voice channel in this server that the bot can access.');
      }
      const alertOption = interaction.options.getChannel('alerts-channel');
      const alerts = alertOption ? await guild.channels.fetch(alertOption.id) : channel;
      if (!alerts || alerts.guildId !== guild.id || ![ChannelType.GuildText, ChannelType.GuildVoice].includes(alerts.type)) {
        return edit('Invalid alert channel', 'Choose a text or voice channel in this server.');
      }
      const me = guild.members.me ?? await guild.members.fetchMe();
      const canView = channel.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel);
      const canSend = alerts.permissionsFor(me)?.has([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
        ...(alerts.type === ChannelType.GuildVoice ? [PermissionFlagsBits.Connect] : []),
      ]);
      if (!canView || !canSend) {
        return edit('Missing permissions', 'I need View Channel on the voice channel, and View Channel, Send Messages, and Embed Links in the alert channel (plus Connect for voice-channel chat).');
      }
      const message = interaction.options.getString('message')?.trim();
      if (message !== undefined && !message) return edit('Invalid message', 'The alert message cannot be blank.');
      tracker.configure(guild.id, channel.id, alerts.id, now(), message);
      syncGuild(guild);
      await store.save();
      return edit('Voice channel configured', `Monitoring <#${channel.id}> every 5 seconds.\nAlerts: <#${alerts.id}>.\nConnected humans count, including muted users. One alert is sent per solo stay.`);
    }
    const config = tracker.config(guild.id);
    if (!config) return edit('Not configured', 'Ask this server’s owner or a whitelisted user to run /configure first.');
    if (interaction.commandName === 'mytime') {
      syncGuild(guild);
      const totalMs = tracker.userTime(guild.id, interaction.user.id, now());
      await store.save();
      return edit('Your voice time', `Your total time in <#${config.voiceChannelId}> is **${duration(totalMs)}**.`);
    }
    if (interaction.commandName === 'message') {
      const message = interaction.options.getString('text', true).trim();
      if (!message) return edit('Invalid message', 'The alert message cannot be blank.');
      config.alertMessage = message;
      await store.save();
      return edit('Alert message updated', message);
    }
    if (interaction.commandName === 'leaderboard-channel') {
      const channel = interaction.options.getChannel('channel', true);
      try {
        const board = await persistent.set(guild, channel.id);
        if (!board) return edit('Temporarily unavailable', 'Please try again after the connection recovers.');
        return edit('Live leaderboard enabled', `The leaderboard in <#${board.channelId}> updates every 5 minutes and resumes after restarts.`);
      } catch (error) {
        return edit('Could not set up the leaderboard', error.message);
      }
    }
    if (interaction.commandName === 'leaderboard-stop') {
      await persistent.stop(guild.id);
      return edit('Live leaderboard stopped', 'Automatic updates are disabled. The last leaderboard message remains in its channel.');
    }
    if (!interaction.appPermissions?.has([PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles])) {
      return edit('Missing permissions', 'I need Embed Links and Attach Files in this channel to send the leaderboard.');
    }
    await interaction.editReply(await buildLeaderboardPayload(guild));
  }

  async function buildLeaderboardPayload(guild) {
    const config = tracker.config(guild.id);
    syncGuild(guild);
    const entries = tracker.leaderboard(guild.id, now());
    await store.save();
    // Fetch at most ten members; server-specific avatars take priority over global ones.
    const rows = await Promise.all(entries.slice(0, 10).map(async entry => {
      let member = guild.members.cache?.get(entry.id);
      if (!member) {
        try { member = await guild.members.fetch?.({ user: entry.id }); } catch { /* Use saved avatar if they left. */ }
      }
      return { ...entry, name: member?.displayName ?? entry.name,
        avatarUrl: member?.displayAvatarURL?.({ extension: 'png', size: 128 }) ?? entry.avatarUrl };
    }));
    const channel = guild.channels.cache.get(config.voiceChannelId);
    const png = await render({ guildName: guild.name, channelName: channel?.name ?? 'Voice channel', entries: rows });
    return {
      embeds: [embed('Voice leaderboard', `Top 10 by total time in <#${config.voiceChannelId}>.`).setImage('attachment://leaderboard.png')],
      files: [new AttachmentBuilder(png, { name: 'leaderboard.png' })], allowedMentions: { parse: [] },
    };
  }
  const persistent = createPersistentLeaderboards({ client, tracker, store, buildPayload: buildLeaderboardPayload,
    available: guild => !stopped && client.isReady() && guild.available && !suspendedShards.has(guild.shardId) });
  return { refreshLeaderboards: () => persistent.refresh(), tick, syncGuild, onInteraction, suspendShard, resumeShard, stop: () => { stopped = true; } };
}
