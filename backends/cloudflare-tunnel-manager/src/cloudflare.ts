// The Cloudflare API calls the manager makes, and nothing else. One account, one tunnel.
// The API token (Account: Cloudflare Tunnel Edit; Zone: Zone Read, DNS Edit) is read from
// its Secret per pass; it is never logged, never returned by the manager's own API and
// never written anywhere. Outbound host: api.cloudflare.com only.

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
  /** healthy | degraded | down | inactive (Cloudflare's view of the connectors). */
  status?: string
}

export interface Named {
  id: string
  name: string
}

export function makeCloudflare(cfg: { token: string; accountId: string }, doFetch: Fetch = (u, i) => fetch(u, i)) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await callFull<T>(method, path, body)).result
  }

  async function callFull<T>(method: string, path: string, body?: unknown): Promise<{ result: T; totalPages: number }> {
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
      result_info?: { total_pages?: number }
      errors?: { code?: number; message?: string }[]
    }
    if (!res.ok || json.success === false) {
      const why = (json.errors ?? []).map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ')
      throw new CloudflareError(`Cloudflare ${method} ${path.split('?')[0]} failed (${res.status})${why ? `: ${why}` : ''}`, res.status)
    }
    return { result: json.result as T, totalPages: json.result_info?.total_pages ?? 1 }
  }

  /** Every page of a paged list (per_page 50; at most 20 pages). */
  async function all<T>(path: string): Promise<T[]> {
    const out: T[] = []
    const sep = path.includes('?') ? '&' : '?'
    for (let page = 1; page <= 20; page++) {
      const r = await callFull<T[]>('GET', `${path}${sep}per_page=50&page=${page}`)
      out.push(...(r.result ?? []))
      if (page >= r.totalPages || (r.result ?? []).length === 0) break
    }
    return out
  }

  const acct = `/accounts/${encodeURIComponent(cfg.accountId)}`

  return {
    /** The accounts this token can act in. */
    async listAccounts(): Promise<Named[]> {
      return (await all<Named>('/accounts')).map((a) => ({ id: a.id, name: a.name }))
    },
    /** The account's live (not deleted) tunnels. */
    async listTunnels(): Promise<Tunnel[]> {
      return (await all<Tunnel>(`${acct}/cfd_tunnel?is_deleted=false`)).map((t) => ({ id: t.id, name: t.name, status: t.status }))
    },
    async getTunnel(id: string): Promise<Tunnel> {
      const t = await call<Tunnel>('GET', `${acct}/cfd_tunnel/${encodeURIComponent(id)}`)
      return { id: t.id, name: t.name, status: t.status }
    },
    /** The account's zones this token can see. */
    async listZones(): Promise<Named[]> {
      return (await all<Named>(`/zones?account.id=${encodeURIComponent(cfg.accountId)}`)).map((z) => ({ id: z.id, name: z.name }))
    },
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
