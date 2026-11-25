// The pure core: given the TunnelRoutes and what Cloudflare has now, decide what the
// tunnel's ingress should be, which DNS records to create or delete, and each route's
// status. No I/O here — main.ts does the calls; everything that decides is testable.
//
// Rules:
//   - ONE tunnel per cluster. Every route goes through it.
//   - Order is decided here, never by creation time: exact hostnames before wildcards,
//     longer names first, a route with a path before the same host without one, and a
//     404 catch-all last. (A creation-order ingress lets a wildcard swallow every
//     newer hostname; this cannot.)
//   - Services must be cluster-internal (http(s)://<svc>.<ns>.svc.cluster.local:<port>) or
//     the http_status:404 sentinel: a route can never send traffic to an outside origin.
//   - Hostnames must fall in an allowed zone. (Both rules live in rules.ts, shared with the
//     Headlamp plugin.)
//   - DNS ownership: a record is created only where none exists; an existing record is
//     used only if it already points at THIS tunnel; anything else is a Conflict and left
//     alone (hand-built records stay invisible to automation). Deletion touches only
//     records carrying the manager's comment AND pointing at this tunnel.

import { validateRoute, zoneFor, type RouteSpec } from './rules.ts'

export { validateRoute, zoneFor, type RouteSpec }

export const MANAGED_COMMENT = 'managed-by: cloudflare-tunnel-manager'

export interface DnsRecord {
  id: string
  zoneId: string
  name: string
  type: string
  content: string
  comment?: string | null
}

export type RouteState = 'Ready' | 'Invalid' | 'Conflict'

export interface RouteStatus {
  state: RouteState
  message: string
}

export interface IngressRule {
  hostname?: string
  path?: string
  service: string
}

export interface Plan {
  ingress: IngressRule[]
  createDns: { zoneId: string; name: string }[]
  deleteDns: DnsRecord[]
  statuses: Record<string, RouteStatus>
}

const CATCH_ALL: IngressRule = { service: 'http_status:404' }

/** Exact before wildcard, longer before shorter, path before no path, then by name. */
export function orderRules(rules: IngressRule[]): IngressRule[] {
  const key = (r: IngressRule) => {
    const h = r.hostname ?? ''
    return [h.startsWith('*.') ? 1 : 0, -h.length, r.path ? 0 : 1, h, r.path ?? ''] as const
  }
  return [...rules].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    for (let i = 0; i < ka.length; i++) {
      if (ka[i]! < kb[i]!) return -1
      if (ka[i]! > kb[i]!) return 1
    }
    return 0
  })
}

export function planTunnel(input: {
  routes: RouteSpec[]
  zones: string[]
  /** <tunnel id>.cfargotunnel.com */
  target: string
  /** zone name -> zone id */
  zoneIds: Record<string, string>
  /** Existing records for every route hostname, plus every record pointing at the target. */
  dns: DnsRecord[]
}): Plan {
  const { routes, zones, target, zoneIds, dns } = input
  const statuses: Record<string, RouteStatus> = {}
  const rules: IngressRule[] = []
  const createDns: { zoneId: string; name: string }[] = []
  const wanted = new Set<string>()
  const seen = new Map<string, string>() // hostname+path -> route name

  for (const r of [...routes].sort((a, b) => a.name.localeCompare(b.name))) {
    const invalid = validateRoute(r, zones)
    if (invalid) {
      statuses[r.name] = { state: 'Invalid', message: invalid }
      continue
    }
    const dupKey = `${r.hostname} ${r.path ?? ''}`
    const prior = seen.get(dupKey)
    if (prior) {
      statuses[r.name] = { state: 'Invalid', message: `same hostname and path as route "${prior}"` }
      continue
    }
    const zone = zoneFor(r.hostname, zones)!
    const zoneId = zoneIds[zone]
    if (!zoneId) {
      statuses[r.name] = { state: 'Invalid', message: `zone ${zone} was not found with this API token` }
      continue
    }
    const existing = dns.filter((d) => d.name === r.hostname)
    const foreign = existing.find((d) => !(d.type === 'CNAME' && d.content === target))
    if (foreign) {
      statuses[r.name] = {
        state: 'Conflict',
        message: `DNS ${foreign.type} ${r.hostname} -> ${foreign.content} is not this tunnel's; left untouched`,
      }
      continue
    }
    seen.set(dupKey, r.name)
    wanted.add(r.hostname)
    if (existing.length === 0 && !createDns.some((c) => c.name === r.hostname)) {
      createDns.push({ zoneId, name: r.hostname })
    }
    rules.push({ hostname: r.hostname, ...(r.path ? { path: r.path } : {}), service: r.service })
    statuses[r.name] = { state: 'Ready', message: `${r.hostname} -> ${r.service}` }
  }

  const deleteDns = dns.filter(
    (d) => d.type === 'CNAME' && d.content === target && d.comment === MANAGED_COMMENT && !wanted.has(d.name),
  )

  return { ingress: [...orderRules(rules), CATCH_ALL], createDns, deleteDns, statuses }
}

/** Order-insensitive comparison is wrong here (order matters), so compare exactly. */
export function sameIngress(a: IngressRule[], b: IngressRule[]): boolean {
  const norm = (rs: IngressRule[]) =>
    JSON.stringify(rs.map((r) => ({ hostname: r.hostname ?? null, path: r.path || null, service: r.service })))
  return norm(a) === norm(b)
}
