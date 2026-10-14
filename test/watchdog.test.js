import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function watchdog({ state = 'running', health = 'healthy', missing = false, locked = false, command = 'watchdog' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vb-bot-watchdog-'));
  try {
    const bin = join(root, 'bin');
    const release = join(root, 'release');
    mkdirSync(bin);
    mkdirSync(release);
    symlinkSync(release, join(root, 'current'));
    const scripts = {
      flock: '#!/bin/sh\n[ "$MOCK_LOCKED" != true ]\n',
      readlink: '#!/bin/sh\nprintf "%s/release\\n" "$VB_BOT_ROOT"\n',
      docker: `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_LOG"
case "$*" in
  *" ps -a -q "*) [ "$MOCK_MISSING" = true ] || printf 'test-container\\n' ;;
  *".State.Status"*) printf '%s\\n' "$MOCK_STATE" ;;
  *".State.Health"*) printf '%s\\n' "$MOCK_HEALTH" ;;
esac
`,
    };
    for (const [name, script] of Object.entries(scripts)) writeFileSync(join(bin, name), script, { mode: 0o755 });
    const log = join(root, 'calls');
    writeFileSync(log, '');
    const result = spawnSync('bash', [resolve('deploy/control.sh'), command], { encoding: 'utf8', env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, VB_BOT_ROOT: root, VB_BOT_LOCK: join(root, 'lock'),
      MOCK_LOG: log, MOCK_STATE: state, MOCK_HEALTH: health, MOCK_MISSING: String(missing), MOCK_LOCKED: String(locked),
    } });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(log, 'utf8');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('watchdog leaves healthy containers running', () => {
  const calls = watchdog();
  assert.ok(!calls.includes(' restart '));
  assert.ok(!calls.includes(' up '));
});

test('watchdog restarts unhealthy or exited services', () => {
  for (const options of [{ health: 'unhealthy' }, { state: 'exited' }]) {
    const calls = watchdog(options);
    assert.match(calls, /restart --timeout 30 mongodb/);
    assert.match(calls, /restart --timeout 30 bot/);
  }
});

test('watchdog recreates missing services without pulling or rebuilding', () => {
  assert.match(watchdog({ missing: true }), /up -d --no-build --pull never --remove-orphans/);
});

test('watchdog skips recovery while deployment holds the lock', () => {
  assert.equal(watchdog({ locked: true }), '');
});

test('boot reconciliation waits for healthy services using existing images', () => {
  assert.match(watchdog({ command: 'up' }), /up -d --no-build --pull never --remove-orphans --wait --wait-timeout 180/);
});
