import { ChannelType, InteractionContextType, SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('configure')
    .setDescription('Set this server’s monitored voice channel (server owner or whitelist only).')
    .setContexts(InteractionContextType.Guild)
    .addStringOption(option => option.setName('voice-channel-id')
      .setDescription('Discord ID of the voice channel to monitor').setRequired(true))
    .addChannelOption(option => option.setName('alerts-channel')
      .setDescription('Where to post alerts; defaults to the voice channel chat')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice))
    .addStringOption(option => option.setName('message')
      .setDescription('Custom solo alert message for this server').setMinLength(1).setMaxLength(4000)),
  new SlashCommandBuilder()
    .setName('message')
    .setDescription('Change this server’s solo alert message (server owner or whitelist only).')
    .setContexts(InteractionContextType.Guild)
    .addStringOption(option => option.setName('text')
      .setDescription('Text to show in the blue alert embed').setRequired(true).setMinLength(1).setMaxLength(4000)),
  new SlashCommandBuilder()
    .setName('alert-channel')
    .setDescription('Change this server’s alert destination (server owner or whitelist only).')
    .setContexts(InteractionContextType.Guild)
    .addChannelOption(option => option.setName('channel')
      .setDescription('Where to send solo voice-channel alerts').setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice)),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the top 10 users by time in the configured voice channel.')
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName('leaderboard-channel')
    .setDescription('Post a leaderboard that reposts every 30 seconds (owner or whitelist only).')
    .setContexts(InteractionContextType.Guild)
    .addChannelOption(option => option.setName('channel')
      .setDescription('Where to keep this server’s live leaderboard').setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice)),
  new SlashCommandBuilder()
    .setName('leaderboard-stop')
    .setDescription('Stop automatic leaderboard updates (owner or whitelist only).')
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName('mytime')
    .setDescription('Show an image of your total time in this server’s configured voice channel.')
    .setContexts(InteractionContextType.Guild),
].map(command => command.toJSON());
