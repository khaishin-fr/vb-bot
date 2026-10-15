import { createCanvas, loadImage } from '@napi-rs/canvas';

export async function loadAvatar(url, fetchImage = fetch) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(parsed.hostname)) return null;
    const response = await fetchImage(parsed, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 2_000_000) return null;
    return await loadImage(bytes);
  } catch { return null; }
}

export function duration(ms) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

function fit(ctx, value, width) {
  const chars = Array.from(value.replace(/[\r\n\t]/g, ' '));
  if (ctx.measureText(chars.join('')).width <= width) return chars.join('');
  while (chars.length && ctx.measureText(`${chars.join('')}…`).width > width) chars.pop();
  return `${chars.join('')}…`;
}

export async function renderUserTime({ guildName, channelName, name, avatarUrl, totalMs },
  { avatarLoader = loadAvatar } = {}) {
  const avatar = await avatarLoader(avatarUrl).catch(() => null);
  const canvas = createCanvas(1000, 400);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 1000, 400);
  gradient.addColorStop(0, '#08152f');
  gradient.addColorStop(1, '#123a6a');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1000, 400);
  ctx.fillStyle = '#60a5fa';
  ctx.fillRect(40, 40, 6, 80);
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText('VOICE ACTIVITY  /  ALL TIME', 64, 54);
  ctx.fillStyle = '#eff6ff';
  ctx.font = 'bold 38px sans-serif';
  ctx.fillText('Your voice time', 64, 100);
  ctx.fillStyle = '#93c5fd';
  ctx.font = '18px sans-serif';
  ctx.fillText(fit(ctx, `${guildName}  /  ${channelName}`, 870), 64, 134);
  ctx.fillStyle = '#1d4e88';
  ctx.beginPath();
  ctx.roundRect(40, 162, 920, 174, 16);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(130, 249, 56, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#2563eb';
  ctx.fillRect(74, 193, 112, 112);
  if (avatar) {
    ctx.drawImage(avatar, 74, 193, 112, 112);
  } else {
    ctx.fillStyle = '#eff6ff';
    ctx.textAlign = 'center';
    ctx.font = 'bold 48px sans-serif';
    ctx.fillText(Array.from(name.trim())[0]?.toUpperCase() || '?', 130, 266);
  }
  ctx.restore();
  ctx.fillStyle = '#bfdbfe';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText(fit(ctx, name, 700), 218, 213);
  ctx.fillStyle = '#eff6ff';
  ctx.font = 'bold 52px sans-serif';
  ctx.fillText(fit(ctx, duration(totalMs), 700), 218, 274);
  ctx.fillStyle = '#93c5fd';
  ctx.font = '16px sans-serif';
  ctx.fillText('TOTAL TIME IN VOICE', 220, 307);
  ctx.font = '14px sans-serif';
  ctx.fillText('Connected time  •  Includes your current session', 40, 374);
  return canvas.encode('png');
}

export async function renderLeaderboard({ guildName, channelName, entries, page = 0, pageCount = 1 },
  { avatarLoader = loadAvatar } = {}) {
  const rows = entries.slice(0, 10);
  const avatars = await Promise.all(rows.map(entry => avatarLoader(entry.avatarUrl).catch(() => null)));
  const width = 1000;
  const height = 240 + Math.max(rows.length, 1) * 76;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#08152f');
  gradient.addColorStop(1, '#123a6a');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#60a5fa';
  ctx.fillRect(40, 40, 6, 80);
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText('VOICE ACTIVITY  /  ALL TIME', 64, 54);
  ctx.fillStyle = '#eff6ff';
  ctx.font = 'bold 38px sans-serif';
  ctx.fillText('The voice leaderboard', 64, 100);
  ctx.fillStyle = '#93c5fd';
  ctx.font = '18px sans-serif';
  ctx.fillText(fit(ctx, `${guildName}  /  ${channelName}`, 870), 64, 134);

  if (!rows.length) {
    ctx.fillStyle = '#bfdbfe';
    ctx.font = '22px sans-serif';
    ctx.fillText('Join the voice channel to start the leaderboard.', 64, 211);
  }
  rows.forEach((entry, index) => {
    const y = 162 + index * 76;
    ctx.fillStyle = index === 0 ? '#1d4e88' : '#142e50';
    ctx.beginPath();
    ctx.roundRect(40, y, 920, 64, 12);
    ctx.fill();
    ctx.fillStyle = '#93c5fd';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(String(page * 10 + index + 1).padStart(2, '0'), 62, y + 39);
    ctx.save();
    ctx.beginPath();
    ctx.arc(140, y + 32, 24, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#2563eb';
    ctx.fillRect(116, y + 8, 48, 48);
    if (avatars[index]) {
      ctx.drawImage(avatars[index], 116, y + 8, 48, 48);
    } else {
      ctx.fillStyle = '#eff6ff';
      ctx.textAlign = 'center';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText(Array.from(entry.name.trim())[0]?.toUpperCase() || '?', 140, y + 40);
    }
    ctx.restore();
    ctx.fillStyle = '#eff6ff';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(fit(ctx, entry.name, 500), 180, y + 30);
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(180, y + 45, Math.max(3, 490 * entry.totalMs / Math.max(rows[0].totalMs, 1)), 4);
    ctx.font = '20px sans-serif';
    ctx.fillStyle = '#bfdbfe';
    ctx.textAlign = 'right';
    ctx.fillText(duration(entry.totalMs), 934, y + 39);
    ctx.textAlign = 'left';
  });
  ctx.fillStyle = '#93c5fd';
  ctx.font = '14px sans-serif';
  ctx.fillText(`PAGE ${page + 1} / ${pageCount}  •  Connected time  •  Humans only`, 40, height - 30);
  return canvas.encode('png');
}
