import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deploymentEnv } from '../deploy/write-env.js';

const values = { DISCORD_TOKEN: 'test.token-abc_123', CLIENT_ID: '123456789012345678', MONGO_ROOT_PASSWORD: 'TestPassword123456789' };

test('individual Actions secrets produce a runtime environment with safe defaults', () => {
  const output = deploymentEnv(values);
  assert.match(output, /DISCORD_TOKEN=test.token-abc_123\n/);
  assert.match(output, /GUILD_ID=\n/);
  assert.match(output, /MONGO_ROOT_USERNAME=voicebot\n/);
  assert.match(output, /MONGODB_DATABASE=voice_bot\n/);
});

test('invalid or missing secrets fail without exposing their contents', () => {
  for (const key of ['DISCORD_TOKEN', 'CLIENT_ID', 'MONGO_ROOT_PASSWORD']) {
    assert.throws(() => deploymentEnv({ ...values, [key]: '' }), new RegExp(key));
  }
  for (const value of ['Secret\nINJECTED=yes', 'Secret$EXPAND', 'Secret#comment', 'Secret@uri']) {
    assert.throws(() => deploymentEnv({ ...values, MONGO_ROOT_PASSWORD: value }), error =>
      error.message.includes('MONGO_ROOT_PASSWORD') && !error.message.includes(value));
  }
});

test('environment writer creates a private file and never prints secret values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vb-bot-env-'));
  const path = join(directory, 'runtime.env');
  try {
    const result = spawnSync(process.execPath, [resolve('deploy/write-env.js'), path], {
      env: { ...process.env, ...values, GUILD_ID: '', MONGO_ROOT_USERNAME: '', MONGODB_DATABASE: '' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, 'utf8'), deploymentEnv(values));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
