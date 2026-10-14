import { DEFAULT_ALERT_MESSAGE } from '../config.js';

export class VoiceTracker {
  constructor(store) {
    this.store = store;
    this.sessions = new Map();
    this.soloAlerts = new Map();
  }

  config(guildId) {
    return this.store.data.guilds[guildId];
  }

  configure(guildId, voiceChannelId, alertChannelId, now, alertMessage) {
    this.checkpoint(guildId, now);
    const previous = this.config(guildId);
    this.store.data.guilds[guildId] = {
      voiceChannelId, alertChannelId,
      alertMessage: alertMessage ?? previous?.alertMessage ?? DEFAULT_ALERT_MESSAGE,
      leaderboard: previous?.leaderboard ?? null,
      channels: previous?.channels ?? {},
    };
    this.config(guildId).channels[voiceChannelId] ??= { users: {}, activeMs: 0, activityTrackedSince: now };
    this.sessions.delete(guildId);
    this.soloAlerts.delete(guildId);
  }

  checkpoint(guildId, now) {
    const config = this.config(guildId);
    if (!config) return;
    const channel = config.channels[config.voiceChannelId];
    channel.activeMs ??= 0;
    channel.activityTrackedSince ??= now;
    const sessions = this.sessions.get(guildId);
    // Every session is checkpointed together. Count this interval once, not per member.
    const occupiedSince = sessions?.values().next().value?.since;
    if (occupiedSince !== undefined) channel.activeMs += Math.max(0, now - occupiedSince);
    const users = channel.users;
    for (const [userId, session] of sessions ?? []) {
      const user = users[userId] ??= { name: session.name, totalMs: 0 };
      user.name = session.name;
      user.avatarUrl = session.avatarUrl ?? user.avatarUrl ?? null;
      user.totalMs += Math.max(0, now - session.since);
      session.since = now;
    }
  }

  sync(guildId, members, now) {
    if (!this.config(guildId)) return;
    this.checkpoint(guildId, now);
    const humans = members.filter(member => !member.bot);
    this.sessions.set(guildId, new Map(humans.map(member => [member.id, {
      name: member.name, avatarUrl: member.avatarUrl, since: now,
    }])));
    const soloId = humans.length === 1 ? humans[0].id : null;
    const previous = this.soloAlerts.get(guildId);
    if (previous?.userId !== soloId) {
      this.soloAlerts.set(guildId, { userId: soloId, sent: false });
    }
  }

  // Drop uncheckpointed time when Discord disconnects: never count an unknown gap.
  suspend(guildId) {
    this.sessions.delete(guildId);
    this.soloAlerts.delete(guildId);
  }

  pendingAlert(guildId) {
    const alert = this.soloAlerts.get(guildId);
    return alert?.userId && !alert.sent ? alert : null;
  }

  leaderboard(guildId, now) {
    this.checkpoint(guildId, now);
    const config = this.config(guildId);
    if (!config) return [];
    return Object.entries(config.channels[config.voiceChannelId].users)
      .map(([id, user]) => ({ id, ...user }))
      .sort((a, b) => b.totalMs - a.totalMs || a.id.localeCompare(b.id));
  }

  userTime(guildId, userId, now) {
    this.checkpoint(guildId, now);
    const config = this.config(guildId);
    return config?.channels[config.voiceChannelId].users[userId]?.totalMs ?? 0;
  }

  channelActivity(guildId, now) {
    this.checkpoint(guildId, now);
    const config = this.config(guildId);
    const channel = config?.channels[config.voiceChannelId];
    return { activeMs: channel?.activeMs ?? 0, activityTrackedSince: channel?.activityTrackedSince ?? null };
  }
}
