import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function deploymentEnv(env) {
  const fields = {
    DISCORD_TOKEN: env.DISCORD_TOKEN ?? '',
    CLIENT_ID: env.CLIENT_ID ?? '',
    GUILD_ID: env.GUILD_ID ?? '',
    MONGO_ROOT_USERNAME: env.MONGO_ROOT_USERNAME || 'voicebot',
    MONGO_ROOT_PASSWORD: env.MONGO_ROOT_PASSWORD ?? '',
    MONGODB_DATABASE: env.MONGODB_DATABASE || 'voice_bot',
  };
  const patterns = {
    DISCORD_TOKEN: /^[A-Za-z0-9_.-]+$/,
    CLIENT_ID: /^\d{17,20}$/,
    GUILD_ID: /^(?:\d{17,20})?$/,
    MONGO_ROOT_USERNAME: /^[A-Za-z0-9_-]+$/,
    // Compose embeds these credentials in a MongoDB URI. Keep them URI-safe.
    MONGO_ROOT_PASSWORD: /^[A-Za-z0-9]+$/,
    MONGODB_DATABASE: /^[A-Za-z0-9_-]+$/,
  };
  for (const [name, value] of Object.entries(fields)) {
    if (!patterns[name].test(value)) {
      // Report the key only: never put a secret value in the Actions log.
      throw new Error(`Missing or invalid ${name}. Check the GitHub Actions secrets/variables and README.`);
    }
  }
  return Object.entries(fields).map(([name, value]) => `${name}=${value}\n`).join('');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw new Error('Pass the runtime environment output path.');
    writeFileSync(process.argv[2], deploymentEnv(process.env), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
