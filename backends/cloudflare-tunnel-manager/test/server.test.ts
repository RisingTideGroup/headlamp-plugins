import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CloudflareError, type Cloudflare } from '../src/cloudflare.ts'
import { makeHandler, type ServerDeps } from '../src/server.ts'

const ACCT = 'fb5d0e8640b72b5cf3da11b57995ec42'

async function serve(deps: ServerDeps): Promise<{ url: string; server: Server }> {
  const server = createServer(makeHandler(deps))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

function deps(opts: { token?: string | null; settings?: Record<string, string> | null; failCf?: boolean } = {}) {
  const seen: { token: string; accountId: string }[] = []
  let kicks = 0
  const d: ServerDeps = {
    tokenSecretName: 'cloudflared-token',
    kube: {
      async readSettings() { return opts.settings === undefined ? { CLOUDFLARE_ACCOUNT_ID: ACCT, TUNNEL_NAME: 'dev' } : opts.settings },
      async readApiToken() { return opts.token === undefined ? 'SECRET-TOKEN' : opts.token },
      async ownedTunnelId() { return 't-ours' },
    },
    lastPass: () => null,
    kick: async () => { kicks++ },
    cloudflare: (c) => {
      seen.push(c)
      return {
        async listAccounts() { if (opts.failCf) throw new CloudflareError('Cloudflare GET /accounts failed (403): Authentication error', 403); return [{ id: ACCT, name: 'NIS' }] },
        async listZones() { return [{ id: 'z1', name: 'example.org' }] },
        async listTunnels() { return [{ id: 't-ours', name: 'dev', status: 'healthy' }, { id: 't-easypanel', name: 'EasyPanel', status: 'healthy' }] },
        async getIngress(id: string) { return id === 't-easypanel' ? [{ hostname: 'a.example.org', service: 'http://x:80' }, { service: 'http_status:404' }] : [] },
      } as unknown as Cloudflare
    },
  }
  return { d, seen, kicks: () => kicks }
}

test('status: never contains the token; reports what is missing', async () => {
  const { d } = deps({ token: null, settings: null })
  const { url, server } = await serve(d)
  try {
    const text = await (await fetch(`${url}/api/status`)).text()
    assert.ok(!text.includes('SECRET-TOKEN'))
    const s = JSON.parse(text)
    assert.equal(s.configured, false)
    assert.equal(s.tokenSet, false)
    assert.deepEqual(s.missing, ['the Cloudflare API token', 'CLOUDFLARE_ACCOUNT_ID', 'TUNNEL_ID or TUNNEL_NAME'])
  } finally { server.close() }
})

test('accounts, zones and tunnels come from Cloudflare with the saved token; tunnels show ownership and existing routes', async () => {
  const { d, seen } = deps()
  const { url, server } = await serve(d)
  try {
    assert.deepEqual(await (await fetch(`${url}/api/accounts`)).json(), [{ id: ACCT, name: 'NIS' }])
    assert.deepEqual(await (await fetch(`${url}/api/zones?account=${ACCT}`)).json(), [{ id: 'z1', name: 'example.org' }])
    const tunnels = await (await fetch(`${url}/api/tunnels?account=${ACCT}`)).json()
    assert.deepEqual(tunnels, [
      { id: 't-ours', name: 'dev', status: 'healthy', owned: true, hostnames: [] },
      { id: 't-easypanel', name: 'EasyPanel', status: 'healthy', owned: false, hostnames: ['a.example.org'] },
    ])
    assert.ok(seen.every((c) => c.token === 'SECRET-TOKEN'))
  } finally { server.close() }
})

test('bad input, no token and Cloudflare errors map to 400 / 409 / 502 without the token', async () => {
  const { url, server } = await serve(deps().d)
  const noToken = await serve(deps({ token: null }).d)
  const cfFails = await serve(deps({ failCf: true }).d)
  try {
    assert.equal((await fetch(`${url}/api/zones?account=nis`)).status, 400)
    assert.equal((await fetch(`${url}/api/nope`)).status, 404)
    assert.equal((await fetch(`${noToken.url}/api/accounts`)).status, 409)
    const r = await fetch(`${cfFails.url}/api/accounts`)
    assert.equal(r.status, 502)
    assert.ok(!(await r.text()).includes('SECRET-TOKEN'))
  } finally { server.close(); noToken.server.close(); cfFails.server.close() }
})

test('POST /api/reconcile runs a pass; GET does not', async () => {
  const { d, kicks } = deps()
  const { url, server } = await serve(d)
  try {
    assert.equal((await fetch(`${url}/api/reconcile`)).status, 404)
    assert.equal((await fetch(`${url}/api/reconcile`, { method: 'POST' })).status, 200)
    assert.equal(kicks(), 1)
  } finally { server.close() }
})
