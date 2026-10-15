import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLeaderboardPagination, PAGE_ARROWS, PAGE_WINDOW_MS } from '../src/leaderboard-pagination.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(pageCount = 3) {
  const manager = createLeaderboardPagination();
  const calls = { arrows: [], pages: [], removed: [], cleanups: 0 };
  const collector = new EventEmitter();
  let ended = false;
  collector.stop = () => { if (!ended) { ended = true; collector.emit('end'); } };
  let options;
  const message = { id: 'board',
    createReactionCollector: value => { options = value; return collector; },
    react: async arrow => calls.arrows.push(arrow),
    reactions: { removeAll: async () => { calls.cleanups++; } },
    edit: async payload => { calls.pages.push(payload.page); assert.deepEqual(payload.attachments, []); },
  };
  const start = () => manager.start(message, { pageCount, buildPage: async page => ({ page }) });
  function click(emoji, bot = false) {
    const reaction = { emoji: { name: emoji }, users: { remove: async id => calls.removed.push(id) } };
    const user = { id: 'user', bot };
    if (!ended && options.filter(reaction, user)) collector.emit('collect', reaction, user);
  }
  return { manager, message, collector, calls, start, click, options: () => options };
}

test('arrows wrap both directions, serialize clicks, ignore bots and unrelated emoji', async () => {
  const f = fixture();
  await f.start();
  assert.deepEqual(f.calls.arrows, PAGE_ARROWS);
  assert.equal(f.options().time, 300000);
  assert.equal(PAGE_WINDOW_MS, 300000);
  f.click('◀'); f.click('▶'); f.click('▶️'); f.click('▶️'); f.click('▶️');
  f.click('▶️', true); f.click('🙂');
  await settle();
  assert.deepEqual(f.calls.pages, [2, 0, 1, 2, 0]);
  assert.equal(f.calls.removed.length, 5);
  assert.equal(f.manager.isBrowsing('board'), true);
  await f.manager.stopAll();
});

test('expiry removes reactions and rejects further clicks, including queued renders', async () => {
  const f = fixture();
  await f.start();
  f.click('▶️');
  f.collector.stop('time');
  await settle();
  f.click('▶️');
  assert.deepEqual(f.calls.pages, []);
  assert.equal(f.calls.cleanups, 1);
  assert.equal(f.manager.isBrowsing('board'), false);
});

test('empty and single-page boards loop to page one', async () => {
  const f = fixture(1);
  await f.start();
  f.click('◀️'); f.click('▶️');
  await settle();
  assert.deepEqual(f.calls.pages, [0, 0]);
  await f.manager.stopAll();
});

test('failed edits do not advance the current page or disable future clicks', async t => {
  const f = fixture();
  t.mock.method(console, 'error', () => {});
  await f.start();
  const edit = f.message.edit;
  f.message.edit = async () => { throw new Error('Network'); };
  f.click('▶️');
  await settle();
  f.message.edit = edit;
  f.click('▶️');
  await settle();
  assert.deepEqual(f.calls.pages, [1]);
  await f.manager.stopAll();
});

test('partial setup failure removes arrows and releases the session', async () => {
  const f = fixture();
  f.message.react = async arrow => { if (arrow === '▶️') throw new Error('Missing permissions'); };
  await assert.rejects(f.start(), /Missing permissions/);
  assert.equal(f.calls.cleanups, 1);
  assert.equal(f.manager.isBrowsing('board'), false);
});

test('expiry during arrow setup cleans up after the in-flight reaction completes', async () => {
  const f = fixture();
  let release;
  f.message.react = () => new Promise(resolve => { release = resolve; });
  const starting = f.start();
  f.collector.stop('time');
  release();
  await starting;
  await settle();
  assert.equal(f.calls.cleanups, 1);
  assert.equal(f.manager.isBrowsing('board'), false);
});
