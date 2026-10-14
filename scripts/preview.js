import { mkdirSync, writeFileSync } from 'node:fs';
import { renderLeaderboard } from '../src/leaderboard.js';
import { createCanvas } from '@napi-rs/canvas';

// Stand-in profile pictures for the offline preview, not real Discord members.
function sampleAvatar(index) {
  const canvas = createCanvas(128, 128);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = ['#2563eb', '#7c3aed', '#0891b2', '#0d9488', '#db2777'][index % 5];
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#dbeafe';
  ctx.beginPath();
  ctx.arc(64, 46, 25, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(64, 125, 45, 0, Math.PI * 2);
  ctx.fill();
  return canvas;
}

const directory = new URL('../preview/', import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL('leaderboard.png', directory), await renderLeaderboard({
  guildName: 'The Hangout', channelName: 'General Voice',
  entries: [
    { name: 'James', totalMs: 54_750_000, avatarUrl: 0 },
    { name: 'Aurora', totalMs: 41_100_000, avatarUrl: 1 },
    { name: 'Milo', totalMs: 28_800_000, avatarUrl: 2 },
    { name: 'Sky', totalMs: 16_950_000, avatarUrl: 3 },
    { name: 'Nova', totalMs: 7_440_000, avatarUrl: 4 },
    { name: 'Atlas', totalMs: 6_480_000, avatarUrl: 5 },
    { name: 'Luna', totalMs: 5_100_000, avatarUrl: 6 },
    { name: 'River', totalMs: 3_720_000, avatarUrl: 7 },
    { name: 'Sage', totalMs: 2_580_000, avatarUrl: 8 },
    { name: 'Finn', totalMs: 1_440_000, avatarUrl: 9 },
  ],
}, { avatarLoader: async index => sampleAvatar(index) }));
console.log('Created preview/leaderboard.png with sample data.');
