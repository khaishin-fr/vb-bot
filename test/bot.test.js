import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, MessageFlags, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { canConfigure, BLUE, WHITELISTED_USER_IDS } from '../config.js';
import { VoiceTracker } from '../src/tracker.js';
import { createRuntime } from '../src/bot.js';
import { MongoStore } from '../src/store.js';
import { renderLeaderboard } from '../src/leaderboard.js';
import { commands } from '../src/commands.js';

const G = '111111111111111111', H = '222222222222222222';
const V = '333333333333333333', W = '444444444444444444';
const U = '555555555555555555', B = '666666666666666666';
const human = (id = U) => ({ id, name: `User ${id}`, bot: false });
const permissions = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles, PermissionFlagsBits.Connect, PermissionFlagsBits.ReadMessageHistory,
]);

function fixture(options = {}) {
  const store = { data: { guilds: {} }, save: async () => {} };
  const tracker = new VoiceTracker(store);
  tracker.configure(G, V, V, 0);
  tracker.configure(H, W, W, 0, 'Second server alert');
  let time = 0;
  const sent = [];
  const guilds = new Map();
  for (const [id, channelId] of [[G, V], [H, W]]) {
    const channel = { id: channelId, guildId: id, name: 'Voice', type: ChannelType.GuildVoice,
      isSendable: () => true, permissionsFor: () => permissions,
      send: async payload => sent.push({ guildId: id, ...payload }) };
    const guild = { id, ownerId: id, name: `Guild ${id}`, shardId: 0, available: true,
      members: { me: {} }, voiceStates: { cache: new Map() },
      channels: { cache: new Map([[channelId, channel]]), fetch: async wanted => wanted === channelId ? channel : null } };
    guilds.set(id, guild);
  }
  const client = { guilds: { cache: guilds }, isReady: () => true };
  const runtime = createRuntime({ client, tracker, store, now: () => time, ...options });
  function members(guildId, list) {
    const guild = guilds.get(guildId);
    const channelId = tracker.config(guildId).voiceChannelId;
    guild.voiceStates.cache = new Map(list.map(member => [member.id, {
      id: member.id, channelId, member: { displayName: member.name, user: { bot: member.bot } },
    }]));
    runtime.syncGuild(guild);
  }
  function interaction(commandName, guildId = G, userId = guildId, values = {}) {
    const replies = [];
    const deferred = [];
    return { commandName, guild: guilds.get(guildId), user: { id: userId }, replies, deferred,
      appPermissions: permissions, isChatInputCommand: () => true, inGuild: () => true,
      options: { getString: name => values[name] ?? null, getChannel: name => values[name] ?? null },
      reply: async payload => replies.push(payload), editReply: async payload => replies.push(payload),
      deferReply: async payload => deferred.push(payload),
    };
  }
  return { store, tracker, runtime, guilds, sent, members, interaction, setTime: value => { time = value; } };
}

test('owner and whitelist authorization is scoped to the server owner', () => {
  assert.equal(canConfigure(G, G, []), true);
  assert.equal(canConfigure(G, H, []), false);
  assert.equal(canConfigure(U, H, [U]), true);
});

test('join/leave timing, bots excluded, and guild totals isolated', () => {
  const { tracker } = fixture();
  tracker.sync(G, [human(), { ...human(B), bot: true }], 1000);
  tracker.sync(H, [human()], 2000);
  tracker.sync(G, [], 3500);
  assert.equal(tracker.leaderboard(G, 8000)[0].totalMs, 2500);
  assert.equal(tracker.leaderboard(G, 8000).length, 1);
  assert.equal(tracker.leaderboard(H, 8000)[0].totalMs, 6000);
});

test('reconfiguring keeps channel histories separate and preserves custom text', () => {
  const { tracker } = fixture();
  tracker.config(G).alertMessage = 'Custom';
  tracker.sync(G, [human()], 0);
  tracker.configure(G, W, W, 1000);
  tracker.sync(G, [human()], 1000);
  assert.equal(tracker.leaderboard(G, 4000)[0].totalMs, 3000);
  tracker.configure(G, V, V, 4000);
  assert.equal(tracker.leaderboard(G, 4000)[0].totalMs, 1000);
  assert.equal(tracker.config(G).alertMessage, 'Custom');
});

test('disconnect gap is never counted', () => {
  const f = fixture();
  f.members(G, [human()]);
  f.setTime(5000);
  f.runtime.syncGuild(f.guilds.get(G));
  f.runtime.suspendShard(0);
  f.setTime(100000);
  f.runtime.resumeShard(0);
  assert.equal(f.tracker.leaderboard(G, 101000)[0].totalMs, 6000);
});

test('alerts use each server message as plain text and only once per solo stay', async () => {
  const f = fixture();
  f.members(G, [human(), { ...human(B), bot: true }]);
  f.members(H, [human()]);
  await f.runtime.tick();
  await f.runtime.tick();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].content, 'only one person in vc');
  assert.equal(f.sent[1].content, 'Second server alert');
  assert.equal(f.sent[0].embeds, undefined);
  f.members(G, [human(), human(B)]);
  await f.runtime.tick();
  assert.equal(f.sent.length, 2);
  f.members(G, [human()]);
  await f.runtime.tick();
  assert.equal(f.sent.length, 3);
  f.members(G, [human(B)]);
  await f.runtime.tick();
  assert.equal(f.sent.length, 4);
});

test('failed alert sends retry', async t => {
  const f = fixture();
  f.members(G, [human()]);
  const channel = f.guilds.get(G).channels.cache.get(V);
  const original = channel.send;
  channel.send = async () => { throw new Error('Missing permissions'); };
  t.mock.method(console, 'error', () => {});
  await f.runtime.tick();
  assert.ok(f.tracker.pendingAlert(G));
  channel.send = original;
  await f.runtime.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.tracker.pendingAlert(G), null);
});

test('async channel lookup rechecks occupancy before sending', async () => {
  const f = fixture();
  f.members(G, [human()]);
  const guild = f.guilds.get(G);
  guild.channels.fetch = async () => {
    f.members(G, [human(), human(B)]);
    return guild.channels.cache.get(V);
  };
  await f.runtime.tick();
  assert.equal(f.sent.length, 0);
});

test('overlapping ticks do not duplicate in-flight alerts', async () => {
  const f = fixture();
  f.members(G, [human()]);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const channel = f.guilds.get(G).channels.cache.get(V);
  channel.send = async payload => { f.sent.push(payload); await gate; };
  const first = f.runtime.tick();
  await new Promise(resolve => setImmediate(resolve));
  await f.runtime.tick();
  release();
  await first;
  assert.equal(f.sent.length, 1);
});

test('server owner can configure their server but not another', async () => {
  const f = fixture();
  const denied = f.interaction('configure', H, G, { 'voice-channel-id': W });
  await f.runtime.onInteraction(denied);
  assert.equal(denied.replies[0].embeds[0].data.title, 'Access denied');
  const allowed = f.interaction('configure', G, G, { 'voice-channel-id': V, message: 'Hello!' });
  await f.runtime.onInteraction(allowed);
  assert.equal(f.tracker.config(G).alertMessage, 'Hello!');
  assert.equal(f.tracker.config(H).alertMessage, 'Second server alert');
});

test('owners can customize only their own message and blank text is rejected', async () => {
  const f = fixture();
  await f.runtime.onInteraction(f.interaction('message', G, G, { text: 'Come hang out @everyone' }));
  await f.runtime.onInteraction(f.interaction('message', H, G, { text: 'Unauthorized' }));
  await f.runtime.onInteraction(f.interaction('message', G, G, { text: '  ' }));
  assert.equal(f.tracker.config(G).alertMessage, 'Come hang out @everyone');
  assert.equal(f.tracker.config(H).alertMessage, 'Second server alert');
  f.members(G, [human()]);
  await f.runtime.tick();
  assert.deepEqual(f.sent[0].allowedMentions, { parse: ['users'] });
});

test('code-whitelisted users can edit messages in another server', async () => {
  const f = fixture();
  WHITELISTED_USER_IDS.push(U);
  try {
    await f.runtime.onInteraction(f.interaction('message', H, U, { text: 'Whitelist message' }));
    assert.equal(f.tracker.config(H).alertMessage, 'Whitelist message');
  } finally { WHITELISTED_USER_IDS.pop(); }
});

test('configuration rejects another server’s channel and missing permissions', async () => {
  const f = fixture();
  const foreign = f.guilds.get(H).channels.cache.get(W);
  f.guilds.get(G).channels.fetch = async () => foreign;
  const other = f.interaction('configure', G, G, { 'voice-channel-id': W });
  await f.runtime.onInteraction(other);
  assert.equal(other.replies[0].embeds[0].data.title, 'Invalid voice channel');
  const channel = f.guilds.get(G).channels.cache.get(V);
  channel.permissionsFor = () => new PermissionsBitField();
  f.guilds.get(G).channels.fetch = async () => channel;
  const denied = f.interaction('configure', G, G, { 'voice-channel-id': V });
  await f.runtime.onInteraction(denied);
  assert.equal(denied.replies[0].embeds[0].data.title, 'Missing permissions');
});

test('leaderboard sends a real PNG attachment in a blue embed for regular users', async () => {
  const f = fixture();
  f.members(G, [human()]);
  f.setTime(6500);
  const interaction = f.interaction('leaderboard', G, U);
  await f.runtime.onInteraction(interaction);
  const payload = interaction.replies[0];
  assert.equal(payload.embeds[0].data.image.url, 'attachment://leaderboard.png');
  assert.equal(payload.files[0].attachment.subarray(1, 4).toString(), 'PNG');
});

test('renderer supports empty boards, long names, and a ten-row cap', async () => {
  const empty = await renderLeaderboard({ guildName: 'Test', channelName: 'Voice', entries: [] });
  assert.equal(empty.readUInt32BE(16), 1000);
  const full = await renderLeaderboard({ guildName: 'Long '.repeat(100), channelName: 'Voice',
    entries: Array.from({ length: 20 }, (_, i) => ({ name: 'Long name '.repeat(30), totalMs: (20 - i) * 1000 })) });
  assert.equal(full.readUInt32BE(20), 1000);
});

test('slash commands serialize with custom message length limits', () => {
  assert.deepEqual(commands.map(command => command.name), ['configure', 'message', 'alert-channel', 'leaderboard', 'leaderboard-channel', 'leaderboard-stop', 'mytime']);
  assert.equal(commands[1].options[0].max_length, 4000);
});

function fakeDatabase() {
  const collections = new Map();
  return { command: async () => ({ ok: 1 }), collection(name) {
    if (!collections.has(name)) {
      const docs = new Map();
      collections.set(name, { docs, createIndex: async () => {},
        find: () => ({ toArray: async () => structuredClone([...docs.values()]),
          async *[Symbol.asyncIterator]() { yield* structuredClone([...docs.values()]); } }),
        bulkWrite: async operations => {
          for (const { replaceOne } of operations) docs.set(replaceOne.filter._id, structuredClone(replaceOne.replacement));
        },
      });
    }
    return collections.get(name);
  } };
}

test('MongoDB store round trip preserves separate server settings and channel totals', async () => {
  const db = fakeDatabase();
  const store = new MongoStore(db);
  await store.load();
  const tracker = new VoiceTracker(store);
  tracker.configure(G, V, V, 0, 'First');
  tracker.configure(H, W, W, 0, 'Second');
  tracker.sync(G, [human()], 0);
  tracker.sync(H, [human()], 1000);
  tracker.checkpoint(G, 5000);
  tracker.checkpoint(H, 5000);
  await store.save();
  const restored = new MongoStore(db);
  await restored.load();
  const restarted = new VoiceTracker(restored);
  assert.equal(restarted.config(G).alertMessage, 'First');
  assert.equal(restarted.config(H).alertMessage, 'Second');
  assert.equal(restarted.leaderboard(G, 999999)[0].totalMs, 5000);
  assert.equal(restarted.leaderboard(H, 999999)[0].totalMs, 4000);
  assert.equal(restarted.sessions.size, 0);
});

test('MongoDB writes serialize, retry failures, and skip unchanged documents', async () => {
  const db = fakeDatabase();
  const store = new MongoStore(db);
  store.data = fixture().store.data;
  const collection = db.collection('guilds');
  const write = collection.bulkWrite;
  let writes = 0;
  let active = 0;
  let maxActive = 0;
  collection.bulkWrite = async operations => {
    writes++;
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (writes === 1) throw new Error('Temporary database outage');
    await write(operations);
  };
  await assert.rejects(store.save(), /outage/);
  await Promise.all([store.save(), store.save()]);
  assert.equal(maxActive, 1);
  assert.equal(writes, 2);
  store.data.guilds[G].alertMessage = 'Updated';
  await store.save();
  assert.equal(collection.docs.get(G).alertMessage, 'Updated');
});

test('shutdown prevents a pending poll from posting and stops new tracking', async () => {
  const f = fixture();
  f.members(G, [human()]);
  let release;
  f.store.save = () => new Promise(resolve => { release = resolve; });
  const pending = f.runtime.tick();
  f.runtime.stop();
  release();
  await pending;
  await f.runtime.tick();
  assert.equal(f.sent.length, 0);
});

test('channel active time counts occupied intervals once and excludes bots and empty time', () => {
  const { tracker } = fixture();
  tracker.sync(G, [human()], 1000);
  tracker.sync(G, [human(), human(B)], 2000);
  tracker.sync(G, [human(B)], 4000);
  tracker.sync(G, [], 5000);
  tracker.sync(G, [{ ...human(), bot: true }], 8000);
  assert.equal(tracker.channelActivity(G, 10000).activeMs, 4000);
  assert.equal(tracker.leaderboard(G, 10000).reduce((sum, row) => sum + row.totalMs, 0), 6000);
  assert.equal(tracker.channelActivity(H, 10000).activeMs, 0);
});

test('activity excludes disconnected gaps, stays per channel, and includes live sessions', () => {
  const { tracker } = fixture();
  tracker.sync(G, [human()], 0);
  tracker.checkpoint(G, 1000);
  tracker.suspend(G);
  tracker.sync(G, [human()], 10000);
  tracker.configure(G, W, W, 12000);
  tracker.sync(G, [human(), human(B)], 12000);
  assert.equal(tracker.channelActivity(G, 15000).activeMs, 3000);
  tracker.configure(G, V, V, 15000);
  assert.equal(tracker.channelActivity(G, 15000).activeMs, 3000);
});

test('MongoDB persists avatars and channel activity without counting restart downtime', async () => {
  const db = fakeDatabase();
  const store = new MongoStore(db);
  const tracker = new VoiceTracker(store);
  tracker.configure(G, V, V, 1000);
  const avatarUrl = 'https://cdn.discordapp.com/avatars/123/example.png';
  tracker.sync(G, [{ ...human(), avatarUrl }, human(B)], 1000);
  tracker.checkpoint(G, 6000);
  await store.save();
  const restored = new MongoStore(db);
  await restored.load();
  const restarted = new VoiceTracker(restored);
  assert.equal(restarted.channelActivity(G, 100000).activeMs, 5000);
  assert.equal(restarted.channelActivity(G, 100000).activityTrackedSince, 1000);
  assert.equal(restarted.leaderboard(G, 100000).find(row => row.id === U).avatarUrl, avatarUrl);
});

test('legacy user totals are preserved but cannot reconstruct past channel activity', async () => {
  const db = fakeDatabase();
  db.collection('guilds').docs.set(G, { _id: G, voiceChannelId: V, alertChannelId: V, alertMessage: 'Hi' });
  const id = `${G}:${V}:${U}`;
  db.collection('voice_totals').docs.set(id, { _id: id, guildId: G, channelId: V, userId: U, name: 'User', totalMs: 50000 });
  const store = new MongoStore(db);
  await store.load();
  const tracker = new VoiceTracker(store);
  tracker.sync(G, [human()], 100000);
  assert.deepEqual(tracker.channelActivity(G, 101000), { activeMs: 1000, activityTrackedSince: 100000 });
  assert.equal(tracker.leaderboard(G, 101000)[0].totalMs, 51000);
});

test('leaderboard resolves member avatars and passes only individual times to the renderer', async () => {
  const f = fixture();
  f.members(G, [human()]);
  f.setTime(5000);
  const avatarUrl = 'https://cdn.discordapp.com/guilds/example/users/example/avatars/example.png';
  f.guilds.get(G).members.fetch = async () => ({ displayName: 'Server nickname', displayAvatarURL: () => avatarUrl });
  let rendered;
  const runtime = createRuntime({ client: { guilds: { cache: f.guilds } }, tracker: f.tracker, store: f.store,
    now: () => 5000, render: async payload => { rendered = payload; return Buffer.from('png'); } });
  await runtime.onInteraction(f.interaction('leaderboard', G, U));
  assert.equal(rendered.entries[0].avatarUrl, avatarUrl);
  assert.equal(rendered.entries[0].name, 'Server nickname');
  assert.equal(rendered.entries[0].totalMs, 5000);
  assert.equal('activeMs' in rendered, false);
});

test('persistent leaderboard commands are restricted to the server owner or whitelist', async () => {
  const f = fixture();
  for (const name of ['leaderboard-channel', 'leaderboard-stop']) {
    const interaction = f.interaction(name, G, U);
    await f.runtime.onInteraction(interaction);
    assert.equal(interaction.replies[0].embeds[0].data.title, 'Access denied');
  }
});

test('persistent leaderboard IDs survive MongoDB reload and voice channel reconfiguration', async () => {
  const db = fakeDatabase();
  const store = new MongoStore(db);
  const tracker = new VoiceTracker(store);
  tracker.configure(G, V, V, 0);
  tracker.config(G).leaderboard = { channelId: V, messageId: B };
  await store.save();
  const restored = new MongoStore(db);
  await restored.load();
  const restarted = new VoiceTracker(restored);
  restarted.configure(G, W, W, 1000);
  assert.deepEqual(restarted.config(G).leaderboard, { channelId: V, messageId: B });
  await restored.save();
  assert.deepEqual(db.collection('guilds').docs.get(G).leaderboard, { channelId: V, messageId: B });
});

test('owner command posts a persistent PNG, runtime refresh reposts it, and stop disables it', async () => {
  const f = fixture();
  const channel = f.guilds.get(G).channels.cache.get(V);
  let sent;
  const events = [];
  const message = { id: B, delete: async () => { events.push('delete'); } };
  channel.send = async payload => { events.push('send'); sent = payload; return message; };
  channel.messages = { fetch: async () => message };
  const setup = f.interaction('leaderboard-channel', G, G, { channel });
  await f.runtime.onInteraction(setup);
  assert.equal(setup.replies[0].embeds[0].data.title, 'Live leaderboard enabled');
  assert.equal(sent.files[0].attachment.subarray(1, 4).toString(), 'PNG');
  assert.equal(f.tracker.config(G).leaderboard.messageId, B);
  await f.runtime.refreshLeaderboards();
  assert.deepEqual(events, ['send', 'delete', 'send']);
  assert.equal(sent.files[0].attachment.subarray(1, 4).toString(), 'PNG');
  await f.runtime.onInteraction(f.interaction('leaderboard-stop'));
  assert.equal(f.tracker.config(G).leaderboard, null);
});

test('/mytime is available to regular members, public, and includes saved plus current time', async () => {
  const f = fixture();
  f.tracker.config(G).channels[V].users[U] = { name: 'Member', totalMs: 60000 };
  f.tracker.config(G).channels[V].users[B] = { name: 'Other member', totalMs: 9999999 };
  f.members(G, [human()]);
  f.setTime(5000);
  const interaction = f.interaction('mytime', G, U);
  await f.runtime.onInteraction(interaction);
  assert.deepEqual(interaction.deferred, [{}]);
  const reply = interaction.replies[0].embeds[0].data;
  assert.equal(reply.title, 'Your voice time');
  assert.equal(reply.color, BLUE);
  assert.equal(reply.description, `Your total time in <#${V}> is **1m 5s**.`);
  assert.equal(reply.image.url, 'attachment://mytime.png');
  assert.equal(interaction.replies[0].files[0].attachment.subarray(1, 4).toString(), 'PNG');
  assert.equal(f.tracker.config(G).channels[V].users[U].totalMs, 65000);
});

test('/mytime shows zero for new members and only the current server and channel', async () => {
  const f = fixture();
  f.tracker.config(H).channels[W].users[U] = { name: 'Member', totalMs: 120000 };
  f.tracker.config(G).channels[W] = { users: { [U]: { name: 'Member', totalMs: 180000 } } };
  const local = f.interaction('mytime', G, U);
  await f.runtime.onInteraction(local);
  assert.equal(local.replies[0].embeds[0].data.description, `Your total time in <#${V}> is **0m 0s**.`);
  const other = f.interaction('mytime', H, U);
  await f.runtime.onInteraction(other);
  assert.equal(other.replies[0].embeds[0].data.description, `Your total time in <#${W}> is **2m 0s**.`);
});

test('/mytime explains when the server has not configured a voice channel', async () => {
  const f = fixture();
  delete f.store.data.guilds[G];
  const interaction = f.interaction('mytime', G, U);
  await f.runtime.onInteraction(interaction);
  assert.equal(interaction.replies[0].embeds[0].data.title, 'Not configured');
});

test('/mytime rejects DMs without accessing server statistics', async () => {
  const f = fixture();
  const interaction = f.interaction('mytime', G, U);
  interaction.inGuild = () => false;
  interaction.guild = null;
  await f.runtime.onInteraction(interaction);
  assert.equal(interaction.replies[0].embeds[0].data.title, 'Server only');
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
});

function addAlertChannel(f, overrides = {}) {
  const guild = f.guilds.get(G);
  const channel = { id: B, guildId: G, type: ChannelType.GuildText,
    permissionsFor: () => permissions, isSendable: () => true,
    send: async payload => f.sent.push({ channelId: B, ...payload }), ...overrides };
  guild.channels.cache.set(channel.id, channel);
  guild.channels.fetch = async id => guild.channels.cache.get(id) ?? null;
  return channel;
}

test('/alert-channel persists the destination, preserves tracking, and routes future alerts', async () => {
  const f = fixture();
  const db = fakeDatabase();
  const mongo = new MongoStore(db);
  mongo.data = f.store.data;
  f.store.save = () => mongo.save();
  f.members(G, [human()]);
  await f.runtime.tick();
  const channel = addAlertChannel(f);
  const interaction = f.interaction('alert-channel', G, G, { channel });
  await f.runtime.onInteraction(interaction);
  assert.equal(interaction.replies[0].embeds[0].data.title, 'Alert channel updated');
  assert.equal(interaction.replies[0].embeds[0].data.color, BLUE);
  assert.equal(interaction.deferred[0].flags, MessageFlags.Ephemeral);
  f.setTime(5000);
  await f.runtime.tick();
  assert.equal(f.sent.length, 1); // A delivered solo alert is not resent.
  assert.equal(f.tracker.userTime(G, U, 5000), 5000);
  f.members(G, []);
  f.members(G, [human()]);
  await f.runtime.tick();
  assert.equal(f.sent[1].channelId, B);
  const restored = new MongoStore(db);
  await restored.load();
  assert.equal(restored.data.guilds[G].alertChannelId, B);
  assert.equal(restored.data.guilds[G].voiceChannelId, V);
  assert.equal(restored.data.guilds[G].alertMessage, 'only one person in vc');
  assert.equal(restored.data.guilds[H].alertChannelId, W);
});

test('/alert-channel authorizes only the server owner or code whitelist', async () => {
  const f = fixture();
  const channel = addAlertChannel(f);
  for (const userId of [U, H]) {
    const denied = f.interaction('alert-channel', G, userId, { channel });
    await f.runtime.onInteraction(denied);
    assert.equal(denied.replies[0].embeds[0].data.title, 'Access denied');
    assert.equal(f.tracker.config(G).alertChannelId, V);
  }
  WHITELISTED_USER_IDS.push(U);
  try {
    await f.runtime.onInteraction(f.interaction('alert-channel', G, U, { channel }));
    assert.equal(f.tracker.config(G).alertChannelId, B);
  } finally { WHITELISTED_USER_IDS.pop(); }
});

test('/alert-channel rejects missing, foreign, unsupported, and inaccessible channels', async () => {
  for (const overrides of [
    { guildId: H }, { type: ChannelType.GuildCategory },
    { permissionsFor: () => new PermissionsBitField() },
    { type: ChannelType.GuildVoice, permissionsFor: () => new PermissionsBitField([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    ]) },
    null,
  ]) {
    const f = fixture();
    const channel = addAlertChannel(f, overrides ?? {});
    if (!overrides) f.guilds.get(G).channels.cache.delete(channel.id);
    const interaction = f.interaction('alert-channel', G, G, { channel });
    await f.runtime.onInteraction(interaction);
    assert.match(interaction.replies[0].embeds[0].data.title, /Invalid alert channel|Missing permissions/);
    assert.equal(f.tracker.config(G).alertChannelId, V);
  }
});

test('/alert-channel requires configuration and supports voice-channel chat', async () => {
  const f = fixture();
  const channel = addAlertChannel(f, { type: ChannelType.GuildVoice });
  await f.runtime.onInteraction(f.interaction('alert-channel', G, G, { channel }));
  assert.equal(f.tracker.config(G).alertChannelId, B);
  delete f.store.data.guilds[G];
  const interaction = f.interaction('alert-channel', G, G, { channel });
  await f.runtime.onInteraction(interaction);
  assert.equal(interaction.replies[0].embeds[0].data.title, 'Not configured');
});

test('changing alert destination during channel lookup skips the old destination', async () => {
  const f = fixture();
  const guild = f.guilds.get(G);
  const channel = addAlertChannel(f);
  const fetch = guild.channels.fetch;
  f.members(G, [human()]);
  guild.channels.fetch = async id => {
    if (id === V) await f.runtime.onInteraction(f.interaction('alert-channel', G, G, { channel }));
    return fetch(id);
  };
  await f.runtime.tick();
  assert.equal(f.sent.length, 0);
  await f.runtime.tick();
  assert.equal(f.sent[0].channelId, B);
});

test('/mytime renders the requesting member’s server profile and live time', async () => {
  let rendered;
  const f = fixture({ renderTime: async data => { rendered = data; return Buffer.from('image'); } });
  f.members(G, [human()]);
  f.setTime(5000);
  const interaction = f.interaction('mytime', G, U);
  interaction.member = { displayName: 'Server nickname', displayAvatarURL: () => 'server-avatar' };
  interaction.user.displayAvatarURL = () => 'global-avatar';
  await f.runtime.onInteraction(interaction);
  assert.deepEqual(rendered, { guildName: `Guild ${G}`, channelName: 'Voice', name: 'Server nickname',
    avatarUrl: 'server-avatar', totalMs: 5000 });
  delete interaction.member;
  interaction.user.username = 'Global name';
  await f.runtime.onInteraction(interaction);
  assert.equal(rendered.name, 'Global name');
  assert.equal(rendered.avatarUrl, 'global-avatar');
});

test('/mytime checks image permissions before rendering', async () => {
  const f = fixture({ renderTime: async () => { assert.fail('Must not render without permissions'); } });
  const interaction = f.interaction('mytime', G, U);
  interaction.appPermissions = new PermissionsBitField(PermissionFlagsBits.EmbedLinks);
  await f.runtime.onInteraction(interaction);
  assert.equal(interaction.replies[0].embeds[0].data.title, 'Missing permissions');
});

test('long plain-text alerts keep user mentions intact and retry only unsent parts', async t => {
  const f = fixture();
  const text = 'x'.repeat(1995) + `<@${U}> join @everyone <@&${B}> ` + 'y'.repeat(500);
  f.tracker.config(G).alertMessage = text;
  f.members(G, [human()]);
  const channel = f.guilds.get(G).channels.cache.get(V);
  const send = channel.send;
  let attempt = 0;
  channel.send = async payload => {
    if (++attempt === 2) throw new Error('Temporary failure');
    return send(payload);
  };
  t.mock.method(console, 'error', () => {});
  await f.runtime.tick();
  assert.equal(f.sent.length, 1);
  await f.runtime.tick();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent.map(payload => payload.content).join(''), text);
  assert.ok(f.sent[1].content.includes(`<@${U}>`));
  for (const payload of f.sent) {
    assert.ok(payload.content.length <= 2000);
    assert.equal(payload.embeds, undefined);
    assert.deepEqual(payload.allowedMentions, { parse: ['users'] });
  }
  await f.runtime.tick();
  assert.equal(f.sent.length, 2);
});

test('plain-text alert destinations do not require Embed Links', async () => {
  const f = fixture();
  const channel = addAlertChannel(f, { permissionsFor: () => new PermissionsBitField([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
  ]) });
  const interaction = f.interaction('alert-channel', G, G, { channel });
  await f.runtime.onInteraction(interaction);
  assert.equal(interaction.replies[0].embeds[0].data.title, 'Alert channel updated');
});
