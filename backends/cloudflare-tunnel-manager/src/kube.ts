// The Kubernetes API calls the manager makes, in-cluster, with its own ServiceAccount:
//   - list TunnelRoutes in its namespace, and write their status;
//   - read its settings ConfigMap and the Cloudflare API token Secret (both by name);
//   - read and write ONE Secret: the cloudflared tunnel token, annotated with the tunnel id
//     (that annotation is how the manager knows a tunnel is already its own).
// RBAC (deploy/cloudflare-tunnel-manager.yaml in this repo) grants exactly that. The cluster CA is trusted
// via NODE_EXTRA_CA_CERTS; the ServiceAccount token is re-read per request (rotated).

import { readFileSync } from 'node:fs'
import type { Fetch } from './cloudflare.ts'
import type { RouteSpec, RouteStatus } from './plan.ts'
import { API_SECRET, API_SECRET_KEY, SETTINGS_CONFIGMAP } from './settings.ts'

export const GROUP = 'tunnel.risingtidegroup.github.io'
export const VERSION = 'v1alpha1'
/** On the cloudflared token Secret: the tunnel whose token it holds (= the tunnel this cluster owns). */
export const TUNNEL_ID_ANNOTATION = `${GROUP}/tunnel-id`

export interface KubeConfig {
  server: string
  namespace: string
  tokenFile: string
}

export function inClusterConfig(env: Record<string, string | undefined> = process.env): KubeConfig {
  const host = env.KUBERNETES_SERVICE_HOST
  const port = env.KUBERNETES_SERVICE_PORT ?? '443'
  if (!host) throw new Error('not running in a cluster (KUBERNETES_SERVICE_HOST unset)')
  const sa = '/var/run/secrets/kubernetes.io/serviceaccount'
  const namespace = env.POD_NAMESPACE ?? readFileSync(`${sa}/namespace`, 'utf8').trim()
  return { server: `https://${host.includes(':') ? `[${host}]` : host}:${port}`, namespace, tokenFile: `${sa}/token` }
}

export function makeKube(cfg: KubeConfig, doFetch: Fetch = (u, i) => fetch(u, i), readToken = () => readFileSync(cfg.tokenFile, 'utf8').trim()) {
  async function call<T>(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<{ status: number; body: T | null }> {
    const res = await doFetch(`${cfg.server}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${readToken()}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': contentType }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const parsed = (await res.json().catch(() => null)) as T | null
    if (!res.ok && res.status !== 404) {
      const msg = (parsed as { message?: string } | null)?.message ?? res.statusText
      throw new Error(`kube ${method} ${path} failed (${res.status}): ${msg}`)
    }
    return { status: res.status, body: parsed }
  }

  const ns = encodeURIComponent(cfg.namespace)
  const routesPath = `/apis/${GROUP}/${VERSION}/namespaces/${ns}/tunnelroutes`

  return {
    async listRoutes(): Promise<RouteSpec[]> {
      const r = await call<{ items?: { metadata: { name: string }; spec?: { hostname?: string; service?: string; path?: string } }[] }>(
        'GET',
        routesPath,
      )
      return (r.body?.items ?? []).map((i) => ({
        name: i.metadata.name,
        hostname: String(i.spec?.hostname ?? '').toLowerCase(),
        service: String(i.spec?.service ?? ''),
        ...(i.spec?.path ? { path: String(i.spec.path) } : {}),
      }))
    },

    async setStatus(name: string, status: RouteStatus): Promise<void> {
      await call(
        'PATCH',
        `${routesPath}/${encodeURIComponent(name)}/status`,
        { status: { ...status, lastReconciled: new Date().toISOString() } },
        'application/merge-patch+json',
      )
    },

    /** The settings ConfigMap's data, or null if it does not exist. */
    async readSettings(): Promise<Record<string, string> | null> {
      const r = await call<{ data?: Record<string, string> }>('GET', `/api/v1/namespaces/${ns}/configmaps/${SETTINGS_CONFIGMAP}`)
      return r.status === 404 ? null : (r.body?.data ?? {})
    },

    /** The Cloudflare API token, or null if its Secret or key is missing. Never logged. */
    async readApiToken(): Promise<string | null> {
      const r = await call<{ data?: Record<string, string> }>('GET', `/api/v1/namespaces/${ns}/secrets/${API_SECRET}`)
      const b64 = r.status === 404 ? undefined : r.body?.data?.[API_SECRET_KEY]
      const token = b64 ? Buffer.from(b64, 'base64').toString('utf8').trim() : ''
      return token || null
    },

    /** The tunnel id the cloudflared token Secret was written for, or null. */
    async ownedTunnelId(name: string): Promise<string | null> {
      const r = await call<{ metadata?: { annotations?: Record<string, string> } }>(
        'GET',
        `/api/v1/namespaces/${ns}/secrets/${encodeURIComponent(name)}`,
      )
      return r.status === 404 ? null : (r.body?.metadata?.annotations?.[TUNNEL_ID_ANNOTATION] ?? null)
    },

    /** Write the tunnel token (and its tunnel id) into the cloudflared Secret if either differs. True if it changed. */
    async ensureTokenSecret(name: string, token: string, tunnelId: string): Promise<boolean> {
      const path = `/api/v1/namespaces/${ns}/secrets/${encodeURIComponent(name)}`
      const cur = await call<{
        data?: Record<string, string>
        metadata?: { resourceVersion?: string; annotations?: Record<string, string> }
      }>('GET', path)
      const encoded = Buffer.from(token, 'utf8').toString('base64')
      if (cur.status !== 404 && cur.body?.data?.token === encoded && cur.body?.metadata?.annotations?.[TUNNEL_ID_ANNOTATION] === tunnelId) {
        return false
      }
      const secret = {
        apiVersion: 'v1',
        kind: 'Secret',
        type: 'Opaque',
        metadata: {
          name,
          namespace: cfg.namespace,
          labels: { 'app.kubernetes.io/managed-by': 'cloudflare-tunnel-manager' },
          annotations: { [TUNNEL_ID_ANNOTATION]: tunnelId },
          ...(cur.status !== 404 && cur.body?.metadata?.resourceVersion ? { resourceVersion: cur.body.metadata.resourceVersion } : {}),
        },
        data: { token: encoded },
      }
      if (cur.status === 404) await call('POST', `/api/v1/namespaces/${ns}/secrets`, secret)
      else await call('PUT', path, secret)
      return true
    },
  }
}

export type Kube = ReturnType<typeof makeKube>
