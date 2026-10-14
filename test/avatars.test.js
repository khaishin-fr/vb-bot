import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { loadAvatar, renderLeaderboard } from '../src/leaderboard.js';

const url = 'https://cdn.discordapp.com/avatars/123/avatar.png?size=128';
function avatar() {
  const canvas = createCanvas(48, 48);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 48, 48);
  return canvas;
}

test('Discord avatar downloads are bounded and missing/broken images fall back', async () => {
  const png = await avatar().encode('png');
  const image = await loadAvatar(url, async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, arrayBuffer: async () => png };
  });
  assert.equal(image.width, 48);
  assert.equal(await loadAvatar(url, async () => { throw new Error('timeout'); }), null);
  assert.equal(await loadAvatar(url, async () => ({ ok: false })), null);
  assert.equal(await loadAvatar(url, async () => ({ ok: true, arrayBuffer: async () => Buffer.from('invalid') })), null);
  assert.equal(await loadAvatar('https://example.com/avatar.png', () => { throw new Error('Must not fetch'); }), null);
});

test('renderer paints an avatar next to the name and tolerates failed avatar loads', async () => {
  const png = await renderLeaderboard({ guildName: 'Server', channelName: 'Voice',
    entries: [{ name: 'Member', totalMs: 1000, avatarUrl: url }, { name: 'Fallback', totalMs: 0 }] },
  { avatarLoader: async source => { if (source) return avatar(); throw new Error('Missing avatar'); } });
  const canvas = createCanvas(1000, 392);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(await loadImage(png), 0, 0);
  assert.deepEqual([...ctx.getImageData(140, 194, 1, 1).data], [255, 0, 0, 255]);
});
