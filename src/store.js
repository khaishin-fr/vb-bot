import { MongoClient } from 'mongodb';

// One bot process owns its in-memory voice sessions; MongoDB persists each server separately.
export class MongoStore {
  constructor(db, client) {
    this.db = db;
    this.client = client;
    this.guilds = db.collection('guilds');
    this.totals = db.collection('voice_totals');
    this.channelTotals = db.collection('channel_totals');
    this.data = { guilds: {} };
    this.saved = new Map();
    this.pending = Promise.resolve();
  }

  static async connect(uri, databaseName) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
    try {
      await client.connect();
      const store = new MongoStore(client.db(databaseName), client);
      await store.load();
      return store;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async load() {
    await this.totals.createIndex({ guildId: 1, channelId: 1 });
    for (const doc of await this.guilds.find({}).toArray()) {
      const { _id, ...config } = doc;
      this.data.guilds[_id] = { ...config, channels: { [config.voiceChannelId]: { users: {} } } };
      this.saved.set(`guild:${_id}`, JSON.stringify(doc));
    }
    for await (const doc of this.totals.find({})) {
      const guild = this.data.guilds[doc.guildId];
      if (!guild) continue;
      const channel = guild.channels[doc.channelId] ??= { users: {} };
      channel.users[doc.userId] = { name: doc.name, totalMs: doc.totalMs, avatarUrl: doc.avatarUrl ?? null };
      this.saved.set(`total:${doc._id}`, JSON.stringify(doc));
    }
    for await (const doc of this.channelTotals.find({})) {
      const guild = this.data.guilds[doc.guildId];
      if (!guild) continue;
      const channel = guild.channels[doc.channelId] ??= { users: {} };
      channel.activeMs = doc.activeMs;
      channel.activityTrackedSince = doc.activityTrackedSince;
      this.saved.set(`channel:${doc._id}`, JSON.stringify(doc));
    }
  }

  save() {
    // Serialize writes so a slow older checkpoint cannot overwrite newer totals.
    // A failed write is retried from the newest in-memory state on the next save.
    const operation = this.pending.catch(() => {}).then(() => this.flush());
    this.pending = operation;
    return operation;
  }

  async flush() {
    // Check connectivity even if no statistics changed during this poll.
    await this.db.command({ ping: 1 });
    const guildOperations = [];
    const totalOperations = [];
    const channelOperations = [];
    const changes = new Map();
    const add = (kind, doc, operations) => {
      const key = `${kind}:${doc._id}`;
      const json = JSON.stringify(doc);
      if (this.saved.get(key) === json) return;
      changes.set(key, json);
      operations.push({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } });
    };
    for (const [guildId, guild] of Object.entries(this.data.guilds)) {
      add('guild', { _id: guildId, voiceChannelId: guild.voiceChannelId,
        alertChannelId: guild.alertChannelId, alertMessage: guild.alertMessage,
        leaderboard: guild.leaderboard ?? null }, guildOperations);
      for (const [channelId, channel] of Object.entries(guild.channels)) {
        add('channel', { _id: `${guildId}:${channelId}`, guildId, channelId,
          activeMs: channel.activeMs ?? 0, activityTrackedSince: channel.activityTrackedSince ?? null }, channelOperations);
        for (const [userId, user] of Object.entries(channel.users)) {
          add('total', { _id: `${guildId}:${channelId}:${userId}`, guildId, channelId, userId,
            name: user.name, totalMs: user.totalMs, avatarUrl: user.avatarUrl ?? null }, totalOperations);
        }
      }
    }
    if (guildOperations.length) await this.guilds.bulkWrite(guildOperations, { ordered: false });
    if (totalOperations.length) await this.totals.bulkWrite(totalOperations, { ordered: false });
    if (channelOperations.length) await this.channelTotals.bulkWrite(channelOperations, { ordered: false });
    for (const [key, json] of changes) this.saved.set(key, json);
  }

  async close() {
    try { await this.pending; } finally { await this.client?.close(); }
  }
}
