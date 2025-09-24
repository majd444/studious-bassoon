import 'dotenv/config'
import { REST, Routes, SlashCommandBuilder } from 'discord.js'

const token = process.env.DISCORD_TOKEN
const clientId = process.env.DISCORD_CLIENT_ID
const guildId = process.env.DISCORD_GUILD_ID // optional for per-guild registration during dev

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment')
  process.exit(1)
}

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Replies with Pong!'),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask the agent a question')
    .addStringOption(opt =>
      opt
        .setName('q')
        .setDescription('Your question')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('agent')
    .setDescription('Agent utilities')
    .addSubcommand((sub) =>
      sub
        .setName('id')
        .setDescription('Show current Agent ID')
    ),
].map((c) => c.toJSON())

const rest = new REST({ version: '10' }).setToken(token)

async function main() {
  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId!, guildId!), { body: commands })
      console.log('Registered guild commands')
    } else {
      await rest.put(Routes.applicationCommands(clientId!), { body: commands })
      console.log('Registered global commands (can take up to 1 hour to propagate)')
    }
  } catch (err) {
    console.error('Failed to register commands', err)
    process.exit(1)
  }
}

main()
