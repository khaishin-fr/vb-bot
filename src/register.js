import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !/^\d{17,20}$/.test(CLIENT_ID ?? '')) {
  throw new Error('Set DISCORD_TOKEN and a valid CLIENT_ID in .env first.');
}
if (GUILD_ID && !/^\d{17,20}$/.test(GUILD_ID)) throw new Error('GUILD_ID must be a Discord server ID.');
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
const route = GUILD_ID
  ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
  : Routes.applicationCommands(CLIENT_ID);
await rest.put(route, { body: commands });
console.log(`Registered ${commands.length} commands ${GUILD_ID ? `in server ${GUILD_ID}` : 'globally'}.`);
