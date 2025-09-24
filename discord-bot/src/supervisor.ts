import 'dotenv/config'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import pino from 'pino'
import { fetch as undiciFetch } from 'undici'
import http from 'http'

const log = pino({ level: process.env.LOG_LEVEL || 'info' })

const CONVEX_URL = (process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL || '').replace(/\/$/, '')
const DISCORD_BACKEND_KEY = process.env.DISCORD_BACKEND_KEY
if (!CONVEX_URL || !DISCORD_BACKEND_KEY) {
  log.fatal('Missing CONVEX_URL or DISCORD_BACKEND_KEY. Set them in Railway variables')
  process.exit(1)
}

// Whether we are running from built JS (production) or tsx (dev)
const IS_PROD = process.env.SUPERVISOR_MODE === 'prod'

// Track running bot processes keyed by agentId
const processes = new Map<string, ChildProcessWithoutNullStreams>()

async function fetchActiveConfigs(): Promise<Array<{ agentId: string; clientId: string }>> {
  try {
    const resp = await undiciFetch(`${CONVEX_URL}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'discord:listActiveConfigs', args: { key: DISCORD_BACKEND_KEY } }),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Convex listActiveConfigs failed: ${resp.status} ${resp.statusText} ${text}`)
    }
    const data: any = await resp.json()
    const list = (data?.value ?? data) as Array<any>
    return (list || []).map((c) => ({ agentId: String(c.agentId), clientId: String(c.clientId) }))
  } catch (err) {
    log.error({ err }, 'Failed to fetch active Discord configs from Convex')
    return []
  }
}

function spawnBot(agentId: string, clientId: string) {
  if (processes.has(agentId)) return
  const env = {
    ...process.env,
    AGENT_ID: agentId,
    DISCORD_CLIENT_ID: clientId,
    // Ensure token is fetched from Convex rather than coming from env
    DISCORD_TOKEN: '',
  }
  const cmd = IS_PROD ? 'node' : 'tsx'
  const args = IS_PROD ? ['dist/index.js'] : ['watch', 'src/index.ts']
  const child = spawn(cmd, args, { env, stdio: 'pipe' })
  processes.set(agentId, child)
  log.info({ agentId, clientId, pid: child.pid }, 'Spawned Discord bot process')

  child.stdout.on('data', (d) => process.stdout.write(`[bot:${agentId.substring(0,6)}] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`[bot:${agentId.substring(0,6)}] ${d}`))
  child.on('exit', (code, signal) => {
    log.warn({ agentId, code, signal }, 'Bot process exited')
    processes.delete(agentId)
  })
}

function stopMissing(desired: Set<string>) {
  for (const [agentId, child] of processes.entries()) {
    if (!desired.has(agentId)) {
      log.info({ agentId, pid: child.pid }, 'Stopping bot (no longer active)')
      child.kill('SIGTERM')
      processes.delete(agentId)
    }
  }
}

async function reconcile() {
  const configs = await fetchActiveConfigs()
  const desired = new Set<string>()
  for (const c of configs) {
    desired.add(c.agentId)
    spawnBot(c.agentId, c.clientId)
  }
  stopMissing(desired)
}

async function main() {
  log.info({ CONVEX_URL, IS_PROD }, 'Starting Discord supervisor')
  await reconcile()
  const intervalMs = Number(process.env.SUPERVISOR_POLL_MS || 30000)
  setInterval(reconcile, intervalMs)

  // Lightweight healthcheck HTTP server so PaaS (e.g., Railway) can mark us healthy
  const port = Number(process.env.PORT ?? 0) || 0
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, processes: Array.from(processes.keys()) }))
  })
  server.listen(port, () => {
    const addr = server.address()
    const p = typeof addr === 'object' && addr ? addr.port : port
    log.info({ port: p }, 'Supervisor healthcheck server listening')
  })
}

process.on('unhandledRejection', (reason) => log.error({ reason }, 'UnhandledRejection'))
process.on('uncaughtException', (err) => log.error({ err }, 'UncaughtException'))

main().catch((err) => {
  log.fatal({ err }, 'Supervisor crashed')
  process.exit(1)
})
