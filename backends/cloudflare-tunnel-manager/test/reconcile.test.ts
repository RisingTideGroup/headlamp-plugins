import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcile, TakeoverRefused } from '../src/reconcile.ts'
import { makeCloudflare, type Cloudflare } from '../src/cloudflare.ts'
import { makeKube, type Kube } from '../src/kube.ts'
import { MANAGED_COMMENT, type DnsRecord, type IngressRule, type RouteSpec, type RouteStatus } from '../src/plan.ts'

function fakes(opts: { tunnel?: boolean; routes: RouteSpec[]; dns?: DnsRecord[]; ingress?: IngressRule[]; owned?: string | null }) {
  const state = {
    tunnel: opts.tunnel ? { id: 't1', name: 'dev-cluster' } : null as null | { id: string; name: string },
    ingress: [...(opts.ingress ?? [])] as IngressRule[],
    dns: [...(opts.dns ?? [])],
    secret: null as string | null,
    owned: opts.owned === undefined ? (opts.tunnel ? 't1' : null) : opts.owned,
    statuses: {} as Record<string, RouteStatus>,
    writes: [] as string[],
  }
  const cf = {
    async findTunnel() { return state.tunnel },
    async getTunnel(id: string) { if (state.tunnel?.id !== id) throw new Error('404'); return state.tunnel },
    async createTunnel(name: string) { state.writes.push('createTunnel'); return (state.tunnel = { id: 't1', name }) },
    async tunnelToken() { return 'tok-1' },
    async getIngress() { return state.ingress },
    async putIngress(_id: string, ing: IngressRule[]) { state.writes.push('putIngress'); state.ingress = ing },
    async listZones() { return [{ id: 'z1', name: 'example.org' }, { id: 'z2', name: 'example.net' }] },
    async recordsByName(_z: string, n: string) { return state.dns.filter((d) => d.name === n) },
    async recordsPointingAt(_z: string, t: string) { return state.dns.filter((d) => d.content === t) },
    async createCname(z: string, name: string, t: string) { state.writes.push(`create ${name}`); state.dns.push({ id: name, zoneId: z, name, type: 'CNAME', content: t, comment: MANAGED_COMMENT }) },
    async deleteRecord(_z: string, id: string) { state.writes.push(`delete ${id}`); state.dns = state.dns.filter((d) => d.id !== id) },
  } as unknown as Cloudflare
  const kube = {
    async listRoutes() { return opts.routes },
    async setStatus(n: string, s: RouteStatus) { state.statuses[n] = s },
    async ownedTunnelId() { return state.owned },
    async ensureTokenSecret(_n: string, t: string, id: string) { if (state.secret === t && state.owned === id) return false; state.secret = t; state.owned = id; state.writes.push('secret'); return true },
  } as unknown as Kube
  return { cf, kube, state }
}

const CFG = { accountId: 'a'.repeat(32), tunnelId: '', tunnelName: 'dev-cluster', zones: ['example.org'], adopt: false, tokenSecretName: 'cloudflared-token' }
const ROUTES: RouteSpec[] = [
  { name: 'portal', hostname: 'portal.example.org', service: 'http://portal.apps.svc.cluster.local:3000' },
  { name: 'proxy', hostname: '*.example.org', service: 'http://proxy.apps.svc.cluster.local:8080' },
]

test('first pass: creates the tunnel, stores its token, routes and DNS; second pass changes nothing', async () => {
  const { cf, kube, state } = fakes({ routes: ROUTES })
  const r1 = await reconcile(CFG, cf, kube)
  assert.equal(r1.created, true)
  assert.equal(state.secret, 'tok-1')
  assert.deepEqual(state.ingress.map((i) => i.hostname ?? '*'), ['portal.example.org', '*.example.org', '*'])
  assert.deepEqual(r1.dnsCreated.sort(), ['*.example.org', 'portal.example.org'])
  assert.equal(state.statuses.portal!.state, 'Ready')

  state.writes.length = 0
  const r2 = await reconcile(CFG, cf, kube)
  assert.equal(r2.created, false)
  assert.deepEqual(state.writes, [], 'an unchanged cluster makes no writes')
})

test('removing a route removes its rule and its (managed) DNS record', async () => {
  const { cf, kube, state } = fakes({ tunnel: true, routes: ROUTES })
  await reconcile(CFG, cf, kube)
  const k2 = { ...kube, listRoutes: async () => [ROUTES[0]!] } as unknown as Kube
  const r = await reconcile(CFG, cf, k2)
  assert.deepEqual(r.dnsDeleted, ['*.example.org'])
  assert.deepEqual(state.ingress.map((i) => i.hostname ?? '*'), ['portal.example.org', '*'])
})

test('a hand-built record blocks its route and is never touched', async () => {
  const { cf, kube, state } = fakes({
    tunnel: true,
    routes: [{ name: 'n', hostname: 'legacy.example.org', service: 'http://x.y.svc.cluster.local:1' }],
    dns: [{ id: 'hand', zoneId: 'z1', name: 'legacy.example.org', type: 'CNAME', content: 'other.cfargotunnel.com' }],
  })
  await reconcile(CFG, cf, kube)
  assert.equal(state.statuses.n!.state, 'Conflict')
  assert.ok(state.dns.some((d) => d.id === 'hand'))
  assert.ok(!state.writes.some((w) => w.includes('legacy')))
})

test('a tunnel with routes this cluster never wrote is refused before its token is written', async () => {
  const { cf, kube, state } = fakes({
    tunnel: true,
    owned: null,
    routes: ROUTES,
    ingress: [{ hostname: 'app.easypanel.example', service: 'http://app:80' }, { service: 'http_status:404' }],
  })
  await assert.rejects(reconcile(CFG, cf, kube), (e: Error) => e instanceof TakeoverRefused && /app\.easypanel\.example/.test(e.message))
  assert.deepEqual(state.writes, [], 'nothing written: no token, no ingress, no DNS')
  assert.equal(state.secret, null)
})

test('TUNNEL_ADOPT=replace takes such a tunnel over; afterwards it is owned', async () => {
  const { cf, kube, state } = fakes({
    tunnel: true,
    owned: null,
    routes: ROUTES,
    ingress: [{ hostname: 'app.easypanel.example', service: 'http://app:80' }, { service: 'http_status:404' }],
  })
  await reconcile({ ...CFG, adopt: true }, cf, kube)
  assert.equal(state.owned, 't1')
  assert.ok(!state.ingress.some((i) => i.hostname === 'app.easypanel.example'))
  await reconcile(CFG, cf, kube) // owned now: no adopt flag needed
})

test('an empty unowned tunnel is taken without the flag; TUNNEL_ID selects it; no zone list = every visible zone', async () => {
  const { cf, kube, state } = fakes({
    tunnel: true,
    owned: null,
    routes: [{ name: 'n', hostname: 'a.example.net', service: 'http://x.y.svc.cluster.local:1' }],
  })
  const r = await reconcile({ ...CFG, tunnelId: 't1', tunnelName: '', zones: [] }, cf, kube)
  assert.deepEqual(r.zones, ['example.org', 'example.net'])
  assert.equal(r.statuses.n!.state, 'Ready')
  assert.equal(state.owned, 't1')
})

// --- the HTTP clients ------------------------------------------------------------------

test('cloudflare client: bearer auth, Cloudflare errors surfaced without the token', async () => {
  const seen: { url: string; init: RequestInit }[] = []
  const cf = makeCloudflare({ token: 'SECRET-TOKEN', accountId: 'acct' }, async (url, init) => {
    seen.push({ url, init })
    if (url.includes('/configurations')) return new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: 'nope' }] }), { status: 403 })
    return new Response(JSON.stringify({ success: true, result: [{ id: 't1', name: 'dev-cluster' }] }))
  })
  assert.deepEqual(await cf.findTunnel('dev-cluster'), { id: 't1', name: 'dev-cluster' })
  assert.match(seen[0]!.url, /\/accounts\/acct\/cfd_tunnel\?is_deleted=false&name=dev-cluster$/)
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, 'Bearer SECRET-TOKEN')
  await assert.rejects(cf.getIngress('t1'), (e: Error) => /403/.test(e.message) && /nope/.test(e.message) && !e.message.includes('SECRET-TOKEN'))
})

test('kube client: creates the token Secret, updates it on change, leaves it when equal', async () => {
  let stored: { data: Record<string, string>; metadata: { resourceVersion: string; annotations?: Record<string, string> } } | null = null
  const calls: string[] = []
  const kube = makeKube({ server: 'https://k', namespace: 'cloudflare-tunnel', tokenFile: '/x' }, async (url, init) => {
    calls.push(`${init.method} ${url.replace('https://k', '')}`)
    if (init.method === 'GET') return stored ? new Response(JSON.stringify(stored)) : new Response('{}', { status: 404 })
    const body = JSON.parse(String(init.body)) as { data: Record<string, string>; metadata: { annotations: Record<string, string> } }
    stored = { data: body.data, metadata: { resourceVersion: '2', annotations: body.metadata.annotations } } as typeof stored
    return new Response(JSON.stringify(stored), { status: init.method === 'POST' ? 201 : 200 })
  }, () => 'sa-token')
  assert.equal(await kube.ensureTokenSecret('cloudflared-token', 'a', 't1'), true)
  assert.equal(await kube.ensureTokenSecret('cloudflared-token', 'a', 't1'), false)
  assert.equal(await kube.ensureTokenSecret('cloudflared-token', 'b', 't1'), true)
  assert.deepEqual(calls, [
    'GET /api/v1/namespaces/cloudflare-tunnel/secrets/cloudflared-token',
    'POST /api/v1/namespaces/cloudflare-tunnel/secrets',
    'GET /api/v1/namespaces/cloudflare-tunnel/secrets/cloudflared-token',
    'GET /api/v1/namespaces/cloudflare-tunnel/secrets/cloudflared-token',
    'PUT /api/v1/namespaces/cloudflare-tunnel/secrets/cloudflared-token',
  ])
  assert.equal(Buffer.from(stored!.data.token!, 'base64').toString(), 'b')
  assert.equal(stored!.metadata.annotations!['tunnel.risingtidegroup.github.io/tunnel-id'], 't1')
  assert.equal(await kube.ownedTunnelId('cloudflared-token'), 't1')
})
