import 'dotenv/config'
import { Client, GatewayIntentBits, Partials, ActivityType, Events } from 'discord.js'
import pino from 'pino'
import http from 'http'
import { fetch as undiciFetch } from 'undici'

const log = pino({ level: process.env.LOG_LEVEL || 'info' })

const agentId = process.env.AGENT_ID || 'not-set'
const appClientId = process.env.DISCORD_CLIENT_ID || 'not-set'

async function resolveToken(): Promise<string> {
  const direct = process.env.DISCORD_TOKEN
  if (direct && direct.trim().length > 0) return direct

  const convexUrl = (process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL || '').replace(/\/$/, '')
  const backendKey = process.env.DISCORD_BACKEND_KEY
  if (!convexUrl || !backendKey || agentId === 'not-set') {
    log.fatal('Missing credentials. Provide DISCORD_TOKEN or set CONVEX_URL, DISCORD_BACKEND_KEY, and AGENT_ID')
    process.exit(1)
  }

  try {
    const resp = await undiciFetch(`${convexUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'discord:getBotConfig', args: { agentId, key: backendKey } }),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Convex query failed: ${resp.status} ${resp.statusText} ${text}`)
    }
    const data: any = await resp.json()
    const tok = data?.value?.token ?? data?.token
    if (typeof tok !== 'string' || tok.length < 10) throw new Error('No token returned from Convex')
    log.info({ agentId, appClientId }, 'Fetched Discord token from Convex')
    return tok
  } catch (err) {
    log.fatal({ err }, 'Failed to fetch Discord token from Convex')
    process.exit(1)
  }
}

let tokenPromise = resolveToken()
log.info({ agentId, appClientId }, 'Starting Discord bot (token will be resolved)')

// Basic client with necessary intents. Add more if your bot needs them.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // Removed MessageContent to avoid privileged intent requirement
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
})

client.once(Events.ClientReady, async (c) => {
  try {
    const guilds = await c.guilds.fetch()
    log.info({ tag: c.user.tag, id: c.user.id, guildCount: guilds.size, agentId }, 'Bot ready')
  } catch (e) {
    log.warn({ err: e }, 'Bot ready (failed to fetch guilds)')
  }
  c.user.setActivity({ name: `agent ${agentId}`, type: ActivityType.Listening })
})

client.on(Events.ShardDisconnect, (_, shardId) => {
  log.warn({ shardId }, 'Shard disconnected')
})

client.on(Events.Error, (err) => {
  log.error({ err }, 'Client error')
})

client.on(Events.Warn, (m) => log.warn(m))

// Handle slash commands
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return
  if (interaction.commandName === 'ping') {
    await interaction.reply({ content: 'Pong! 🏓', ephemeral: true })
    return
  }
  if (interaction.commandName === 'agent') {
    const sub = interaction.options.getSubcommand()
    if (sub === 'id') {
      const agentId = process.env.AGENT_ID || 'not-set'
      await interaction.reply({ content: `Agent ID: ${agentId}`, ephemeral: true })
      return
    }
  }
})

// Optional: react to messages (for quick sanity checks)
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot) return
    const content = msg.content?.trim() || ''

    // Health/simple checks
    if (content === '!ping') {
      await msg.reply('Pong! 🏓')
      return
    }

    // Decide whether to invoke LLM:
    // - Always in DMs
    // - Or if message mentions the bot
    // - Or if message starts with a simple prefix like !ask
    const mentionsBot = msg.mentions.users.has(client.user?.id || '')
    const startsWithAsk = content.toLowerCase().startsWith('!ask')
    const isDM = !msg.guild

    if (!(isDM || mentionsBot || startsWithAsk)) {
      // Optional friendly greeting fallback
      if (content.toLowerCase().includes('hello')) {
        await msg.reply('Hello! 👋')
      }
      return
    }

    // Prepare prompt (strip trigger words)
    const userMessage = startsWithAsk ? content.replace(/^!ask\s*/i, '') : content

    // Call Convex Discord respond HTTP endpoint (HTTP Actions live on convex.site)
    // Prefer CONVEX_HTTP_URL if provided. If only CONVEX_URL (.convex.cloud) is set,
    // convert to .convex.site automatically to hit HTTP Actions.
    const rawBase = (process.env.CONVEX_HTTP_URL || process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL || '').replace(/\/$/, '')
    const base = rawBase.includes('.convex.cloud')
      ? rawBase.replace('.convex.cloud', '.convex.site')
      : rawBase
    if (!base) {
      await msg.reply('Server is missing configuration (CONVEX_URL). Please notify the admin.')
      return
    }

    // Make the request
    if (String(process.env.DISCORD_DISABLE_HTTP_RELAY || '').toLowerCase() === '1' ||
        String(process.env.DISCORD_DISABLE_HTTP_RELAY || '').toLowerCase() === 'true') {
      const reply = userMessage && userMessage.length > 0
        ? 'Thanks for your message! How can I help you today?'
        : 'Thanks for your message! How can I help you today?'
      await msg.reply(reply)
      return
    }

    const res = await undiciFetch(`${base}/api/discord/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Source': 'discord' },
      body: JSON.stringify({
        agentId,
        userId: `discord_${msg.author.id}`,
        text: userMessage,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`LLM endpoint failed: ${res.status} ${res.statusText} ${text}`)
    }
    const data: any = await res.json().catch(() => ({}))
    const reply = data?.reply || data?.message || '...'
    await msg.reply(String(reply))
  } catch (err) {
    log.error({ err }, 'Failed to generate LLM reply')
    try {
      const fallback = 'Sorry, I had trouble generating a response. How can I help you today?'
      await msg.reply(fallback)
    } catch {}
  }
})

// Global error handlers
process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'UnhandledRejection')
})
process.on('uncaughtException', (err) => {
  log.error({ err }, 'UncaughtException')
})

;(async () => {
  const token = await tokenPromise
  client.login(token).catch((err) => {
    log.fatal({ err }, 'Failed to login to Discord')
    process.exit(1)
  })
})()

// Lightweight healthcheck HTTP server for individual bot workers.
// IMPORTANT: Do NOT bind to the platform PORT env (used by the supervisor/container).
// Use BOT_PORT if explicitly provided, otherwise 0 (random free port), to avoid EADDRINUSE when multiple bots spawn.
const port = Number(process.env.BOT_PORT ?? 0) || 0
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, agentId, appClientId }))
})
server.listen(port, () => {
  const addr = server.address()
  const p = typeof addr === 'object' && addr ? addr.port : port
  log.info({ port: p }, 'Healthcheck server listening')
})
