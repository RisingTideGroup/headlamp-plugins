// One reconcile pass: ensure the cluster's tunnel exists, keep its token in the cloudflared
// Secret, make its ingress and DNS match the TunnelRoutes, and report each route's status.
// Idempotent: a pass with nothing to change makes only reads.

import type { Cloudflare } from './cloudflare.ts'
import type { Kube } from './kube.ts'
import { planTunnel, sameIngress, zoneFor, type DnsRecord, type RouteStatus } from './plan.ts'

export interface ReconcileConfig {
  tunnelName: string
  zones: string[]
  tokenSecretName: string
}

export interface ReconcileResult {
  tunnelId: string
  created: boolean
  tokenChanged: boolean
  ingressChanged: boolean
  dnsCreated: string[]
  dnsDeleted: string[]
  statuses: Record<string, RouteStatus>
}

export async function reconcile(cfg: ReconcileConfig, cf: Cloudflare, kube: Kube, log: (m: string) => void = () => {}): Promise<ReconcileResult> {
  let tunnel = await cf.findTunnel(cfg.tunnelName)
  let created = false
  if (!tunnel) {
    tunnel = await cf.createTunnel(cfg.tunnelName)
    created = true
    log(`created tunnel ${tunnel.name} (${tunnel.id})`)
  }
  const target = `${tunnel.id}.cfargotunnel.com`

  const tokenChanged = await kube.ensureTokenSecret(cfg.tokenSecretName, await cf.tunnelToken(tunnel.id))
  if (tokenChanged) log(`wrote the tunnel token to Secret ${cfg.tokenSecretName}`)

  const routes = await kube.listRoutes()

  // Zone ids for every allowed zone a route uses (and for cleanup, every allowed zone).
  const zoneIds: Record<string, string> = {}
  for (const z of cfg.zones) {
    const id = await cf.zoneId(z)
    if (id) zoneIds[z] = id
  }

  // What DNS already has: each route hostname's records, and every record pointing at us.
  const dns: DnsRecord[] = []
  const seenIds = new Set<string>()
  const add = (rs: DnsRecord[]) => {
    for (const r of rs) if (!seenIds.has(r.id)) (seenIds.add(r.id), dns.push(r))
  }
  for (const r of routes) {
    const zone = zoneFor(r.hostname, cfg.zones)
    const zid = zone ? zoneIds[zone] : undefined
    if (zid) add(await cf.recordsByName(zid, r.hostname))
  }
  for (const zid of Object.values(zoneIds)) add(await cf.recordsPointingAt(zid, target))

  const plan = planTunnel({ routes, zones: cfg.zones, target, zoneIds, dns })

  let ingressChanged = false
  if (!sameIngress(await cf.getIngress(tunnel.id), plan.ingress)) {
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

  return { tunnelId: tunnel.id, created, tokenChanged, ingressChanged, dnsCreated, dnsDeleted, statuses: plan.statuses }
}
