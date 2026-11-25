// Entrypoint: reconcile every RECONCILE_SECONDS (default 30) and serve the plugin's API on PORT
// (default 8080). Settings (ConfigMap cloudflare-tunnel-settings) and the API token (Secret
// cloudflare-api) are read live from the cluster on every pass, so the manager starts, and
// stays up, unconfigured: it reports what is missing until the Headlamp plugin saves it.
//
// Env (set by the Deployment, not by people):
//   POD_NAMESPACE        the namespace of its TunnelRoutes, settings and Secrets
//   TOKEN_SECRET_NAME    default cloudflared-token
//   RECONCILE_SECONDS    default 30 (minimum 10)
//   PORT                 default 8080

import { createServer } from 'node:http'
import { makeCloudflare } from './cloudflare.ts'
import { inClusterConfig, makeKube, type KubeConfig } from './kube.ts'
import { reconcile } from './reconcile.ts'
import { makeHandler, type LastPass } from './server.ts'
import { parseSettings } from './settings.ts'

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`)

let kubeCfg: KubeConfig
try {
  kubeCfg = inClusterConfig()
} catch (e) {
  console.error(`cloudflare-tunnel-manager: ${(e as Error).message}`)
  process.exit(2)
}
const kube = makeKube(kubeCfg)
const tokenSecretName = process.env.TOKEN_SECRET_NAME?.trim() || 'cloudflared-token'
const everyMs = Math.max(10, Number(process.env.RECONCILE_SECONDS) || 30) * 1000

let last: LastPass | null = null
let lastProblem = ''

async function onePass(): Promise<void> {
  const at = new Date().toISOString()
  try {
    const parsed = parseSettings(await kube.readSettings())
    const token = await kube.readApiToken()
    const missing = [...(token ? [] : ['the Cloudflare API token']), ...(parsed.ok ? [] : parsed.missing)]
    if (missing.length || !token) {
      const why = `not configured: missing ${missing.join(', ')}`
      if (why !== lastProblem) log(why)
      lastProblem = why
      last = { at, ok: false, error: why, tunnel: null, zones: [], routes: 0 }
      return
    }
    const cf = makeCloudflare({ token, accountId: parsed.settings.accountId })
    const r = await reconcile({ ...parsed.settings, tokenSecretName }, cf, kube, log)
    for (const [name, s] of Object.entries(r.statuses)) if (s.state !== 'Ready') log(`route ${name}: ${s.state} — ${s.message}`)
    lastProblem = ''
    last = { at, ok: true, error: '', tunnel: r.tunnel, zones: r.zones, routes: Object.keys(r.statuses).length }
  } catch (e) {
    const why = (e as Error).message
    if (why !== lastProblem) log(`reconcile failed: ${why}`)
    lastProblem = why
    last = { at, ok: false, error: why, tunnel: last?.tunnel ?? null, zones: last?.zones ?? [], routes: last?.routes ?? 0 }
  }
}

// One pass at a time: a kick during a pass waits for it, then runs a fresh one.
let running: Promise<void> = Promise.resolve()
function pass(): Promise<void> {
  running = running.then(onePass, onePass)
  return running
}

createServer(makeHandler({ kube, tokenSecretName, lastPass: () => last, kick: pass })).listen(Number(process.env.PORT) || 8080)

log(`cloudflare-tunnel-manager: namespace ${kubeCfg.namespace}, every ${everyMs / 1000}s`)
await pass()
setInterval(() => void pass(), everyMs)
