// Entrypoint: read config, reconcile every RECONCILE_SECONDS (default 30), serve /healthz.
//
// Config (env; the API token from a Secret, the rest from a ConfigMap):
//   CLOUDFLARE_API_TOKEN       Account: Cloudflare Tunnel Edit; Zone: Zone Read + DNS Edit
//   CLOUDFLARE_ACCOUNT_ID      the account the tunnel lives in
//   TUNNEL_NAME                the cluster's one tunnel, e.g. prod-nyc1 (unique per Cloudflare account: an existing tunnel of this name is ADOPTED)
//   TUNNEL_ZONES               comma-separated zones routes may use, e.g. example.com,example.net
//   TOKEN_SECRET_NAME          default cloudflared-token
//   RECONCILE_SECONDS          default 30
//   PORT                       health port, default 8080

import { createServer } from 'node:http'
import { makeCloudflare } from './cloudflare.ts'
import { inClusterConfig, makeKube } from './kube.ts'
import { reconcile } from './reconcile.ts'

function required(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) {
    console.error(`${name} is required`)
    process.exit(2)
  }
  return v
}

const cfg = {
  tunnelName: required('TUNNEL_NAME'),
  zones: required('TUNNEL_ZONES').split(',').map((z) => z.trim().toLowerCase()).filter(Boolean),
  tokenSecretName: process.env.TOKEN_SECRET_NAME?.trim() || 'cloudflared-token',
}
const cf = makeCloudflare({ token: required('CLOUDFLARE_API_TOKEN'), accountId: required('CLOUDFLARE_ACCOUNT_ID') })
const kube = makeKube(inClusterConfig())
const everyMs = Math.max(10, Number(process.env.RECONCILE_SECONDS) || 30) * 1000
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`)

let last = { ok: false, at: '', error: '' as string, tunnelId: '' }

async function pass(): Promise<void> {
  try {
    const r = await reconcile(cfg, cf, kube, log)
    const bad = Object.entries(r.statuses).filter(([, s]) => s.state !== 'Ready')
    for (const [name, s] of bad) log(`route ${name}: ${s.state} — ${s.message}`)
    last = { ok: true, at: new Date().toISOString(), error: '', tunnelId: r.tunnelId }
  } catch (e) {
    last = { ...last, ok: false, at: new Date().toISOString(), error: (e as Error).message }
    log(`reconcile failed: ${(e as Error).message}`)
  }
}

createServer((req, res) => {
  if (req.url === '/healthz') {
    // Liveness: the process is up and has completed at least one pass recently (the last
    // pass may have failed — that is reported, not a reason to restart).
    const fresh = last.at !== '' && Date.now() - Date.parse(last.at) < everyMs * 4
    res.writeHead(fresh || last.at === '' ? 200 : 503, { 'content-type': 'application/json' })
    res.end(JSON.stringify(last))
    return
  }
  res.writeHead(404).end()
}).listen(Number(process.env.PORT) || 8080)

log(`cloudflare-tunnel-manager: tunnel ${cfg.tunnelName}, zones ${cfg.zones.join(', ')}, every ${everyMs / 1000}s`)
await pass()
setInterval(() => void pass(), everyMs)
