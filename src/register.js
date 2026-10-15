// Registers the slash commands without starting the bot (the bot also does this on start).
import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
const rest = new REST().setToken(DISCORD_TOKEN);
const route = GUILD_ID
  ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
  : Routes.applicationCommands(CLIENT_ID);
await rest.put(route, { body: commands });
console.log(`registered ${commands.length} commands (${GUILD_ID ? 'guild ' + GUILD_ID : 'global'})`);
