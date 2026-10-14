import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heartbeat, isHealthy, resetHeartbeat, MAX_HEARTBEAT_AGE_MS } from '../src/health.js';

test('health requires a recent successful poll and resets across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vb-bot-health-'));
  const path = join(dir, 'heartbeat');
  try {
    assert.equal(isHealthy(path), false);
    heartbeat(path);
    const timestamp = statSync(path).mtimeMs;
    assert.equal(isHealthy(path, timestamp + 1000), true);
    assert.equal(isHealthy(path, timestamp + MAX_HEARTBEAT_AGE_MS), false);
    resetHeartbeat(path);
    assert.equal(isHealthy(path), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
