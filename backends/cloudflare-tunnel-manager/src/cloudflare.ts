// The Cloudflare API calls the manager makes, and nothing else. One account, one tunnel.
// The API token (Account: Cloudflare Tunnel Edit; Zone: Zone Read, DNS Edit — for the
// allowed zones only) stays in this process; it is never logged and never written
// anywhere. Outbound host: api.cloudflare.com only.

import { MANAGED_COMMENT, type DnsRecord, type IngressRule } from './plan.ts'

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

const BASE = 'https://api.cloudflare.com/client/v4'

export class CloudflareError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'CloudflareError'
    this.status = status
  }
}

export interface Tunnel {
  id: string
  name: string
}

export function makeCloudflare(cfg: { token: string; accountId: string }, doFetch: Fetch = (u, i) => fetch(u, i)) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean
      result?: T
      errors?: { code?: number; message?: string }[]
    }
    if (!res.ok || json.success === false) {
      const why = (json.errors ?? []).map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ')
      throw new CloudflareError(`Cloudflare ${method} ${path.split('?')[0]} failed (${res.status})${why ? `: ${why}` : ''}`, res.status)
    }
    return json.result as T
  }

  const acct = `/accounts/${encodeURIComponent(cfg.accountId)}`

  return {
    async findTunnel(name: string): Promise<Tunnel | null> {
      const list = await call<Tunnel[]>('GET', `${acct}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}`)
      return list.find((t) => t.name === name) ?? null
    },
    createTunnel(name: string): Promise<Tunnel> {
      // config_src=cloudflare: routes live in Cloudflare and are pushed to cloudflared, so
      // the pod needs only the token.
      return call<Tunnel>('POST', `${acct}/cfd_tunnel`, { name, config_src: 'cloudflare' })
    },
    tunnelToken(id: string): Promise<string> {
      return call<string>('GET', `${acct}/cfd_tunnel/${encodeURIComponent(id)}/token`)
    },
    async getIngress(id: string): Promise<IngressRule[]> {
      const r = await call<{ config?: { ingress?: IngressRule[] } } | null>(
        'GET',
        `${acct}/cfd_tunnel/${encodeURIComponent(id)}/configurations`,
      )
      return r?.config?.ingress ?? []
    },
    async putIngress(id: string, ingress: IngressRule[]): Promise<void> {
      await call('PUT', `${acct}/cfd_tunnel/${encodeURIComponent(id)}/configurations`, { config: { ingress } })
    },
    async zoneId(name: string): Promise<string | null> {
      const list = await call<{ id: string; name: string }[]>('GET', `/zones?name=${encodeURIComponent(name)}`)
      return list.find((z) => z.name === name)?.id ?? null
    },
    async recordsByName(zoneId: string, name: string): Promise<DnsRecord[]> {
      const list = await call<Omit<DnsRecord, 'zoneId'>[]>(
        'GET',
        `/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=100&name=${encodeURIComponent(name)}`,
      )
      return list.map((d) => ({ ...d, zoneId }))
    },
    async recordsPointingAt(zoneId: string, target: string): Promise<DnsRecord[]> {
      const list = await call<Omit<DnsRecord, 'zoneId'>[]>(
        'GET',
        `/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=500&type=CNAME&content=${encodeURIComponent(target)}`,
      )
      return list.map((d) => ({ ...d, zoneId }))
    },
    async createCname(zoneId: string, name: string, target: string): Promise<void> {
      await call('POST', `/zones/${encodeURIComponent(zoneId)}/dns_records`, {
        type: 'CNAME',
        name,
        content: target,
        proxied: true,
        comment: MANAGED_COMMENT,
      })
    },
    async deleteRecord(zoneId: string, id: string): Promise<void> {
      await call('DELETE', `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`)
    },
  }
}

export type Cloudflare = ReturnType<typeof makeCloudflare>
