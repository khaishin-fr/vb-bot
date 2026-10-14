// Add Discord user IDs as strings, then restart the bot.
export const WHITELISTED_USER_IDS = [
  // '123456789012345678',
];

export const POLL_INTERVAL_MS = 5_000;
export const LEADERBOARD_INTERVAL_MS = 5 * 60_000;
export const BLUE = 0x3b82f6;
export const DEFAULT_ALERT_MESSAGE = 'only one person in vc';

export function canConfigure(userId, guildOwnerId, whitelist = WHITELISTED_USER_IDS) {
  return userId === guildOwnerId || whitelist.includes(userId);
}
