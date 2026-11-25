// The manager's HTTP API, for the Headlamp plugin. The plugin reaches it only through the
// Kubernetes API server's service proxy, so every call is authorized by the caller's own RBAC
// (services/proxy on this Service); the NetworkPolicy admits nothing else.
//
//   GET  /healthz                      liveness
//   GET  /api/status                   settings (never the token), configured?, last pass
//   GET  /api/accounts                 accounts the saved token can act in
//   GET  /api/tunnels?account=<id>     that account's tunnels: status, routed hostnames, ours?
//   GET  /api/zones?account=<id>       that account's zones the token can see
//   POST /api/reconcile                run a pass now (after Save), then return the status
//
// Cloudflare is called with the token saved in Secret `cloudflare-api`; the browser never
// sees it and api.cloudflare.com (which does not allow browser calls) is reached from here.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { CloudflareError, makeCloudflare, type Cloudflare, type Fetch } from './cloudflare.ts'
import type { Kube } from './kube.ts'
import { routedHostnames } from './reconcile.ts'
import { isAccountId, parseSettings } from './settings.ts'

export interface LastPass {
  at: string
  ok: boolean
  error: string
  tunnel: { id: string; name: string; status?: string } | null
  zones: string[]
  routes: number
}

export interface Status {
  configured: boolean
  missing: string[]
  tokenSet: boolean
  settings: { accountId: string; tunnelId: string; tunnelName: string; zones: string[]; adopt: boolean }
  lastPass: LastPass | null
}

export interface ServerDeps {
  kube: Pick<Kube, 'readSettings' | 'readApiToken' | 'ownedTunnelId'>
  tokenSecretName: string
  lastPass: () => LastPass | null
  /** Runs a reconcile pass (waits for one already running) and resolves when done. */
  kick: () => Promise<void>
  fetch?: Fetch
  cloudflare?: (cfg: { token: string; accountId: string }) => Cloudflare
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function status(deps: ServerDeps): Promise<Status> {
  const parsed = parseSettings(await deps.kube.readSettings())
  const tokenSet = (await deps.kube.readApiToken()) !== null
  const missing = [...(tokenSet ? [] : ['the Cloudflare API token']), ...(parsed.ok ? [] : parsed.missing)]
  return { configured: missing.length === 0, missing, tokenSet, settings: parsed.settings, lastPass: deps.lastPass() }
}

export function makeHandler(deps: ServerDeps) {
  const cfFor = async (accountId: string): Promise<Cloudflare> => {
    const token = await deps.kube.readApiToken()
    if (!token) throw new HttpError(409, 'Save the Cloudflare API token first.')
    const make = deps.cloudflare ?? ((c) => makeCloudflare(c, deps.fetch))
    return make({ token, accountId })
  }
  const account = (url: URL): string => {
    const a = (url.searchParams.get('account') ?? '').trim().toLowerCase()
    if (!isAccountId(a)) throw new HttpError(400, 'account must be a Cloudflare account id (32 hex characters)')
    return a
  }

  async function route(method: string, url: URL): Promise<unknown> {
    const key = `${method} ${url.pathname}`
    switch (key) {
      case 'GET /api/status':
        return status(deps)
      case 'GET /api/accounts':
        return (await cfFor('')).listAccounts()
      case 'GET /api/zones':
        return (await (await cfFor(account(url))).listZones()).map((z) => ({ id: z.id, name: z.name }))
      case 'GET /api/tunnels': {
        const cf = await cfFor(account(url))
        const owned = await deps.kube.ownedTunnelId(deps.tokenSecretName)
        const tunnels = await cf.listTunnels()
        return Promise.all(
          tunnels.map(async (t) => ({
            id: t.id,
            name: t.name,
            status: t.status ?? '',
            owned: t.id === owned,
            hostnames: routedHostnames(await cf.getIngress(t.id).catch(() => [])),
          })),
        )
      }
      case 'POST /api/reconcile':
        await deps.kick()
        return status(deps)
      default:
        throw new HttpError(404, 'not found')
    }
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://manager')
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/healthz') {
      const last = deps.lastPass()
      // Liveness: the loop is alive. A failed pass is reported, not a reason to restart.
      return send(200, { ok: true, lastPassAt: last?.at ?? null })
    }
    try {
      send(200, await route(req.method ?? 'GET', url))
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message })
      if (e instanceof CloudflareError) return send(502, { error: e.message })
      send(500, { error: 'internal error' })
    }
  }
}
