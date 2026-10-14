import { rmSync, statSync, writeFileSync } from 'node:fs';

export const HEALTH_FILE = '/tmp/vb-bot-heartbeat';
export const MAX_HEARTBEAT_AGE_MS = 90_000;
export function resetHeartbeat(path = HEALTH_FILE) {
  rmSync(path, { force: true });
}
export function heartbeat(path = HEALTH_FILE) {
  writeFileSync(path, 'ready\n', { mode: 0o600 });
}
export function isHealthy(path = HEALTH_FILE, now = Date.now()) {
  try {
    const age = now - statSync(path).mtimeMs;
    return age >= 0 && age < MAX_HEARTBEAT_AGE_MS;
  } catch { return false; }
}
