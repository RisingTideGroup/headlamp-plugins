// One reconcile pass: find (or create) the cluster's tunnel, keep its token in the cloudflared
// Secret, make its ingress and DNS match the TunnelRoutes, and report each route's status.
// Idempotent: a pass with nothing to change makes only reads.
//
// Takeover guard: a tunnel this cluster has never written (no matching tunnel-id annotation on
// the cloudflared token Secret) that already has routes belongs to someone else (EasyPanel,
// another cluster, a hand-built tunnel). The manager refuses it, BEFORE writing its token, so
// no cloudflared of ours ever joins it, unless the settings say TUNNEL_ADOPT=replace.

import type { Cloudflare, Tunnel } from './cloudflare.ts'
import type { Kube } from './kube.ts'
import { planTunnel, sameIngress, zoneFor, type DnsRecord, type IngressRule, type RouteStatus } from './plan.ts'
import type { Settings } from './settings.ts'

export interface ReconcileConfig extends Settings {
  tokenSecretName: string
}

export interface ReconcileResult {
  tunnel: Tunnel
  zones: string[]
  created: boolean
  tokenChanged: boolean
  ingressChanged: boolean
  dnsCreated: string[]
  dnsDeleted: string[]
  statuses: Record<string, RouteStatus>
}

export class TakeoverRefused extends Error {
  constructor(tunnel: Tunnel, hostnames: string[]) {
    super(
      `tunnel "${tunnel.name}" (${tunnel.id}) already routes ${hostnames.length} hostname(s) ` +
        `(${hostnames.slice(0, 5).join(', ')}${hostnames.length > 5 ? ', …' : ''}) and was not created by this cluster; ` +
        `left untouched. Pick or create another tunnel, or allow replacing its routes (TUNNEL_ADOPT=replace).`,
    )
    this.name = 'TakeoverRefused'
  }
}

/** Hostname rules of an ingress (the catch-all has none). */
export function routedHostnames(ingress: IngressRule[]): string[] {
  return ingress.filter((r) => r.hostname).map((r) => r.hostname as string)
}

export async function reconcile(cfg: ReconcileConfig, cf: Cloudflare, kube: Kube, log: (m: string) => void = () => {}): Promise<ReconcileResult> {
  let tunnel: Tunnel | null = cfg.tunnelId ? await cf.getTunnel(cfg.tunnelId) : await cf.findTunnel(cfg.tunnelName)
  let created = false
  if (!tunnel) {
    tunnel = await cf.createTunnel(cfg.tunnelName)
    created = true
    log(`created tunnel ${tunnel.name} (${tunnel.id})`)
  }
  const target = `${tunnel.id}.cfargotunnel.com`

  const current = await cf.getIngress(tunnel.id)
  if (!created && (await kube.ownedTunnelId(cfg.tokenSecretName)) !== tunnel.id) {
    const foreign = routedHostnames(current)
    if (foreign.length > 0 && !cfg.adopt) throw new TakeoverRefused(tunnel, foreign)
    log(`taking over tunnel ${tunnel.name} (${tunnel.id})${foreign.length ? `, replacing ${foreign.length} existing route(s)` : ''}`)
  }

  const tokenChanged = await kube.ensureTokenSecret(cfg.tokenSecretName, await cf.tunnelToken(tunnel.id), tunnel.id)
  if (tokenChanged) log(`wrote the tunnel token to Secret ${cfg.tokenSecretName}`)

  const routes = await kube.listRoutes()

  // The zones routes may use: the allowlist if one is set, else every zone the token can see.
  const visible = await cf.listZones()
  const allowed = cfg.zones.length ? visible.filter((z) => cfg.zones.includes(z.name)) : visible
  const zones = allowed.map((z) => z.name)
  const zoneIds: Record<string, string> = Object.fromEntries(allowed.map((z) => [z.name, z.id]))

  // What DNS already has: each route hostname's records, and every record pointing at us.
  const dns: DnsRecord[] = []
  const seenIds = new Set<string>()
  const add = (rs: DnsRecord[]) => {
    for (const r of rs) if (!seenIds.has(r.id)) (seenIds.add(r.id), dns.push(r))
  }
  for (const r of routes) {
    const zone = zoneFor(r.hostname, zones)
    const zid = zone ? zoneIds[zone] : undefined
    if (zid) add(await cf.recordsByName(zid, r.hostname))
  }
  for (const zid of Object.values(zoneIds)) add(await cf.recordsPointingAt(zid, target))

  const plan = planTunnel({ routes, zones, target, zoneIds, dns })

  let ingressChanged = false
  if (!sameIngress(current, plan.ingress)) {
    await cf.putIngress(tunnel.id, plan.ingress)
    ingressChanged = true
    log(`tunnel ingress updated: ${plan.ingress.length - 1} route(s)`)
  }

  const dnsCreated: string[] = []
  for (const c of plan.createDns) {
    await cf.createCname(c.zoneId, c.name, target)
    dnsCreated.push(c.name)
    log(`DNS created: ${c.name} -> ${target}`)
  }
  const dnsDeleted: string[] = []
  for (const d of plan.deleteDns) {
    await cf.deleteRecord(d.zoneId, d.id)
    dnsDeleted.push(d.name)
    log(`DNS deleted (no route any more): ${d.name}`)
  }

  for (const [name, status] of Object.entries(plan.statuses)) {
    await kube.setStatus(name, status).catch((e: unknown) => log(`status for ${name} not written: ${(e as Error).message}`))
  }

  return { tunnel, zones, created, tokenChanged, ingressChanged, dnsCreated, dnsDeleted, statuses: plan.statuses }
}
