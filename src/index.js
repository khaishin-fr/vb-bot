import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { LEADERBOARD_INTERVAL_MS, POLL_INTERVAL_MS } from '../config.js';
import { createRuntime, embed } from './bot.js';
import { MongoStore } from './store.js';
import { VoiceTracker } from './tracker.js';
import { heartbeat, resetHeartbeat } from './health.js';

resetHeartbeat();

const { DISCORD_TOKEN, MONGODB_URI, MONGODB_DATABASE = 'voice_bot' } = process.env;
if (!DISCORD_TOKEN || !MONGODB_URI) {
  throw new Error('Set DISCORD_TOKEN and MONGODB_URI before starting.');
}
const store = await MongoStore.connect(MONGODB_URI, MONGODB_DATABASE);
const tracker = new VoiceTracker(store);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const runtime = createRuntime({ client, tracker, store });
let interval;
let leaderboardInterval;
let stopping = false;

async function stop(code = 0, checkpoint = true) {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  clearInterval(leaderboardInterval);
  runtime.stop();
  try {
    if (checkpoint) {
      for (const guildId of tracker.sessions.keys()) tracker.checkpoint(guildId, Date.now());
    }
    client.destroy();
    await store.save();
  } catch (error) {
    client.destroy();
    console.error('Failed to save database:', error.message);
    code = 1;
  }
  try { await store.close(); } catch { code = 1; }
  process.exitCode = code;
}
function fatal(error) {
  console.error('Stopping after a tracking/storage failure:', error.message);
  stop(1, false);
}
async function poll() {
  if (await runtime.tick() && client.isReady() && !stopping) heartbeat();
}
client.once(Events.ClientReady, ready => {
  console.log(`Logged in as ${ready.user.tag}. Checking voice activity every 5 seconds.`);
  poll().catch(fatal);
  interval = setInterval(() => poll().catch(fatal), POLL_INTERVAL_MS);
  const refresh = () => runtime.refreshLeaderboards().catch(error => console.error('Leaderboard refresh failed:', error.message));
  refresh();
  leaderboardInterval = setInterval(refresh, LEADERBOARD_INTERVAL_MS);
});
client.on(Events.VoiceStateUpdate, (_oldState, state) => {
  try { runtime.syncGuild(state.guild); } catch (error) { fatal(error); }
});
client.on(Events.GuildUnavailable, guild => tracker.suspend(guild.id));
client.on(Events.GuildDelete, guild => tracker.suspend(guild.id));
client.on(Events.GuildAvailable, guild => runtime.syncGuild(guild));
client.on(Events.ShardDisconnect, (_event, id) => runtime.suspendShard(id));
client.on(Events.ShardReconnecting, id => runtime.suspendShard(id));
client.on(Events.ShardReady, id => runtime.resumeShard(id));
client.on(Events.ShardResume, id => runtime.resumeShard(id));
client.on(Events.Error, error => console.error('Discord client error:', error.message));
client.on(Events.InteractionCreate, interaction => {
  runtime.onInteraction(interaction).catch(async error => {
    console.error('Command failed:', error.message);
    const payload = { embeds: [embed('Something went wrong', 'The command could not finish. Check the bot logs and channel permissions, then try again.')] };
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    } catch (replyError) { console.error('Could not send command error:', replyError.message); }
  });
});
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
try { await client.login(DISCORD_TOKEN); } catch (error) { fatal(error); }
