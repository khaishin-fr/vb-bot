import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { createPersistentLeaderboards } from '../src/persistent-leaderboard.js';
import { LEADERBOARD_INTERVAL_MS } from '../config.js';

function fixture() {
  const configs = { one: {}, two: {} };
  const calls = { sends: [], edits: [], deletes: [], events: [], saves: 0 };
  const messages = new Map();
  const permissions = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AddReactions, PermissionFlagsBits.ManageMessages,
  ]);
  const channels = new Map();
  let counter = 0;
  function channel(id, guildId) {
    const value = { id, guildId, type: ChannelType.GuildText, permissionsFor: () => permissions,
      messages: { fetch: async messageId => {
        if (!messages.has(messageId)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return messages.get(messageId);
      } },
      send: async payload => {
        calls.events.push('send');
        calls.sends.push({ id, payload });
        const message = { id: String(++counter),
          edit: async updated => { calls.edits.push({ id: message.id, payload: updated }); return message; },
          delete: async () => { calls.events.push('delete'); calls.deletes.push(message.id); messages.delete(message.id); },
        };
        messages.set(message.id, message);
        return message;
      },
    };
    channels.set(id, value);
    return value;
  }
  channel('first', 'one');
  channel('second', 'one');
  channel('other', 'two');
  const guilds = new Map(['one', 'two'].map(id => [id, {
    id, members: { me: {} }, channels: { fetch: async channelId => channels.get(channelId) },
  }]));
  const store = { save: async () => { calls.saves++; } };
  const options = { client: { guilds: { cache: guilds } }, tracker: { config: id => configs[id] }, store,
    available: () => true, buildPayload: async guild => ({ embeds: [{ title: guild.id }], files: ['png'] }),
  };
  return { configs, calls, messages, channels, guilds, store, options, manager: createPersistentLeaderboards(options) };
}

test('persistent leaderboard deletes before reposting and saves the new ID every 30 seconds', async () => {
  const f = fixture();
  const guild = f.guilds.get('one');
  await f.manager.set(guild, 'first');
  assert.deepEqual(f.configs.one.leaderboard, { channelId: 'first', messageId: '1' });
  await f.manager.refresh();
  await f.manager.set(guild, 'first');
  assert.equal(f.calls.sends.length, 3);
  assert.equal(f.calls.edits.length, 0);
  assert.deepEqual(f.calls.events, ['send', 'delete', 'send', 'delete', 'send']);
  assert.deepEqual([...f.messages.keys()], ['3']);
  assert.equal(f.configs.one.leaderboard.messageId, '3');
  assert.equal(LEADERBOARD_INTERVAL_MS, 30000);
});

test('a restarted manager resumes the saved message and keeps servers separate', async () => {
  const f = fixture();
  await f.manager.set(f.guilds.get('one'), 'first');
  await f.manager.set(f.guilds.get('two'), 'other');
  const restarted = createPersistentLeaderboards(f.options);
  await restarted.refresh();
  assert.equal(f.calls.sends.length, 4);
  assert.deepEqual(f.calls.sends.slice(2).map(call => call.payload.embeds[0].title).sort(), ['one', 'two']);
  assert.deepEqual(f.calls.deletes.sort(), ['1', '2']);
  assert.equal(f.messages.size, 2);
});

test('deleted messages are recreated with a new saved ID', async () => {
  const f = fixture();
  await f.manager.set(f.guilds.get('one'), 'first');
  f.messages.delete('1');
  await f.manager.refresh();
  assert.equal(f.calls.sends.length, 2);
  assert.equal(f.configs.one.leaderboard.messageId, '2');
});

test('permission or network fetch errors never create duplicate messages', async t => {
  const f = fixture();
  await f.manager.set(f.guilds.get('one'), 'first');
  f.channels.get('first').messages.fetch = async () => { throw Object.assign(new Error('Missing access'), { code: 50001 }); };
  t.mock.method(console, 'error', () => {});
  await f.manager.refresh();
  assert.equal(f.calls.sends.length, 1);
  assert.equal(f.configs.one.leaderboard.messageId, '1');
});

test('moving the leaderboard removes the old bot message after saving the new location', async () => {
  const f = fixture();
  await f.manager.set(f.guilds.get('one'), 'first');
  await f.manager.set(f.guilds.get('one'), 'second');
  assert.equal(f.configs.one.leaderboard.channelId, 'second');
  assert.deepEqual(f.calls.deletes, ['1']);
});

test('stop disables updates, leaving the last posted image intact', async () => {
  const f = fixture();
  await f.manager.set(f.guilds.get('one'), 'first');
  await f.manager.stop('one');
  await f.manager.refresh();
  assert.equal(f.configs.one.leaderboard, null);
  assert.equal(f.calls.edits.length, 0);
  assert.ok(f.messages.has('1'));
});

test('concurrent setup calls serialize instead of creating duplicates', async () => {
  const f = fixture();
  await Promise.all([f.manager.set(f.guilds.get('one'), 'first'), f.manager.set(f.guilds.get('one'), 'first')]);
  assert.equal(f.calls.sends.length, 2);
  assert.deepEqual(f.calls.deletes, ['1']);
  assert.equal(f.messages.size, 1);
});

test('unavailable guilds are skipped and cross-server destinations rejected', async () => {
  const f = fixture();
  await assert.rejects(f.manager.set(f.guilds.get('one'), 'other'), /in this server/);
  await f.manager.set(f.guilds.get('one'), 'first');
  const unavailable = createPersistentLeaderboards({ ...f.options, available: () => false });
  await unavailable.refresh();
  assert.equal(f.calls.edits.length, 0);
});

test('missing image/history permissions fail before creating a leaderboard', async () => {
  const f = fixture();
  f.channels.get('first').permissionsFor = () => new PermissionsBitField();
  await assert.rejects(f.manager.set(f.guilds.get('one'), 'first'), /Read Message History/);
  assert.equal(f.calls.sends.length, 0);
});

test('failed database save retains the posted ID for the next retry', async t => {
  const f = fixture();
  f.store.save = async () => { throw new Error('Database unavailable'); };
  await assert.rejects(f.manager.set(f.guilds.get('one'), 'first'), /Database unavailable/);
  t.mock.method(console, 'error', () => {});
  await f.manager.refresh();
  assert.equal(f.calls.sends.length, 2);
  assert.deepEqual(f.calls.deletes, ['1']);
  assert.equal(f.configs.one.leaderboard.messageId, '2');
  assert.equal(f.messages.size, 1);
});

test('delete failures leave the existing board intact without sending another', async t => {
  const f = fixture();
  await f.manager.set(f.guilds.get('one'), 'first');
  f.messages.get('1').delete = async () => { throw new Error('Missing access'); };
  t.mock.method(console, 'error', () => {});
  await f.manager.refresh();
  assert.equal(f.calls.sends.length, 1);
  assert.ok(f.messages.has('1'));
});

test('a failed send after deletion recovers on the next refresh with freshly generated content', async t => {
  const f = fixture();
  let generation = 0;
  const manager = createPersistentLeaderboards({ ...f.options,
    buildPayload: async () => ({ files: [`image-${++generation}`] }),
  });
  await manager.set(f.guilds.get('one'), 'first');
  const channel = f.channels.get('first');
  const send = channel.send;
  channel.send = async () => { throw new Error('Temporary network failure'); };
  t.mock.method(console, 'error', () => {});
  await manager.refresh();
  assert.equal(f.messages.size, 0);
  channel.send = send;
  await manager.refresh();
  assert.equal(f.messages.size, 1);
  assert.equal(f.configs.one.leaderboard.messageId, '2');
  assert.deepEqual(f.calls.sends[1].payload.files, ['image-3']);
});

test('a message deleted between lookup and delete still gets replaced', async () => {
  const f = fixture();
  await f.manager.set(f.guilds.get('one'), 'first');
  f.messages.get('1').delete = async () => {
    f.messages.delete('1');
    throw Object.assign(new Error('Unknown Message'), { code: 10008 });
  };
  await f.manager.refresh();
  assert.deepEqual([...f.messages.keys()], ['2']);
  assert.equal(f.configs.one.leaderboard.messageId, '2');
});

test('automatic reposts pause during browsing, resume on expiry, and stop clears controls', async () => {
  const f = fixture();
  let browsing = false;
  const started = [], stopped = [];
  const manager = createPersistentLeaderboards({ ...f.options,
    onPosted: async message => started.push(message.id),
    beforeRemove: async id => stopped.push(id),
    isBrowsing: () => browsing,
  });
  await manager.set(f.guilds.get('one'), 'first');
  browsing = true;
  await manager.refresh();
  assert.equal(f.calls.sends.length, 1);
  browsing = false;
  await manager.refresh();
  assert.deepEqual(started, ['1', '2']);
  assert.deepEqual(stopped, ['1']);
  await manager.stop('one');
  assert.deepEqual(stopped, ['1', '2']);
});
