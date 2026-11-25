// Everything the plugin asks the cluster, as plain functions over an injected `request`
// (Headlamp's ApiProxy.request in the plugin, a fake in tests). Every call runs with the
// signed-in person's own token and RBAC.
//
//   - Kubernetes objects: TunnelRoutes, the settings ConfigMap, the API-token Secret (written,
//     never read: the browser never holds a saved token), cloudflared's scale, Services.
//   - The manager's API (accounts, tunnels, zones, status), through the API server's service
//     proxy, because api.cloudflare.com does not answer browsers; the manager calls it with the
//     saved token.
//
// Route validation is the manager's own (backends/cloudflare-tunnel-manager/src/rules.ts,
// imported, not copied), so the form refuses exactly what the manager would mark Invalid.

import { validateRoute } from '../../../backends/cloudflare-tunnel-manager/src/rules.ts';

export const GROUP = 'tunnel.risingtidegroup.github.io';
export const VERSION = 'v1alpha1';
export const NAMESPACE = 'cloudflare-tunnel';
export const MANAGER = 'cloudflare-tunnel-manager';
export const CONNECTOR = 'cloudflared';
export const SETTINGS_CONFIGMAP = 'cloudflare-tunnel-settings';
export const API_SECRET = 'cloudflare-api';
export const DEFAULT_REPLICAS = 2;

export type Request = (path: string, init?: RequestInit) => Promise<any>;

const routesPath = `/apis/${GROUP}/${VERSION}/namespaces/${NAMESPACE}/tunnelroutes`;
const managerPath = `/api/v1/namespaces/${NAMESPACE}/services/http:${MANAGER}:http/proxy`;
const NAME_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

const json = (method: string, body: unknown, type = 'application/json'): RequestInit => ({
  method,
  headers: { 'Content-Type': type },
  body: JSON.stringify(body),
});
const isNotFound = (e: unknown) => (e as { status?: number })?.status === 404;

// --- the manager ------------------------------------------------------------------------

export interface ManagerStatus {
  configured: boolean;
  missing: string[];
  tokenSet: boolean;
  settings: { accountId: string; tunnelId: string; tunnelName: string; zones: string[]; adopt: boolean };
  lastPass: {
    at: string;
    ok: boolean;
    error: string;
    tunnel: { id: string; name: string; status?: string } | null;
    zones: string[];
    routes: number;
  } | null;
}
export interface Named {
  id: string;
  name: string;
}
export interface CfTunnel extends Named {
  status: string;
  /** Written by this cluster's manager already. */
  owned: boolean;
  /** Hostnames the tunnel routes today. */
  hostnames: string[];
}

export const getStatus = (r: Request): Promise<ManagerStatus> => r(`${managerPath}/api/status`);
export const listAccounts = (r: Request): Promise<Named[]> => r(`${managerPath}/api/accounts`);
export const listTunnels = (r: Request, account: string): Promise<CfTunnel[]> =>
  r(`${managerPath}/api/tunnels?account=${encodeURIComponent(account)}`);
export const listZones = (r: Request, account: string): Promise<Named[]> =>
  r(`${managerPath}/api/zones?account=${encodeURIComponent(account)}`);
export const reconcileNow = (r: Request): Promise<ManagerStatus> =>
  r(`${managerPath}/api/reconcile`, { method: 'POST' });

// --- settings and token -----------------------------------------------------------------

export interface SettingsInput {
  accountId: string;
  /** An existing tunnel … */
  tunnelId: string;
  /** … or a new one to create with this name. */
  tunnelName: string;
  /** Take over a tunnel that already has routes (they are replaced). */
  adopt: boolean;
}

/** Merge-patch an object; create it if it does not exist. */
async function upsert(r: Request, collection: string, name: string, object: Record<string, unknown>, patch: unknown) {
  try {
    await r(`${collection}/${name}`, json('PATCH', patch, 'application/merge-patch+json'));
  } catch (e) {
    if (!isNotFound(e)) throw e;
    await r(collection, json('POST', object));
  }
}

export function settingsData(s: SettingsInput): Record<string, string> {
  return {
    CLOUDFLARE_ACCOUNT_ID: s.accountId.trim().toLowerCase(),
    TUNNEL_ID: s.tunnelId.trim().toLowerCase(),
    TUNNEL_NAME: s.tunnelId ? '' : s.tunnelName.trim(),
    TUNNEL_ADOPT: s.adopt ? 'replace' : '',
  };
}

export async function saveSettings(r: Request, s: SettingsInput): Promise<void> {
  const data = settingsData(s);
  await upsert(
    r,
    `/api/v1/namespaces/${NAMESPACE}/configmaps`,
    SETTINGS_CONFIGMAP,
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: SETTINGS_CONFIGMAP, namespace: NAMESPACE, labels: { 'app.kubernetes.io/managed-by': 'headlamp-cloudflare-tunnel' } },
      data,
    },
    { data }
  );
}

/** Write-only: the token goes to the Secret and is never read back into the browser. */
export async function saveToken(r: Request, token: string): Promise<void> {
  const t = token.trim();
  if (!t) throw new Error('Enter the API token.');
  await upsert(
    r,
    `/api/v1/namespaces/${NAMESPACE}/secrets`,
    API_SECRET,
    {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: { name: API_SECRET, namespace: NAMESPACE, labels: { 'app.kubernetes.io/managed-by': 'headlamp-cloudflare-tunnel' } },
      stringData: { CLOUDFLARE_API_TOKEN: t },
    },
    { stringData: { CLOUDFLARE_API_TOKEN: t } }
  );
}

// --- the connector (start / stop) -----------------------------------------------------------

export interface DeploymentState {
  replicas: number;
  ready: number;
}

export async function getConnector(r: Request): Promise<DeploymentState> {
  const d = await r(`/apis/apps/v1/namespaces/${NAMESPACE}/deployments/${CONNECTOR}`);
  return { replicas: d?.spec?.replicas ?? 0, ready: d?.status?.readyReplicas ?? 0 };
}

export async function scaleConnector(r: Request, replicas: number): Promise<void> {
  if (!Number.isInteger(replicas) || replicas < 0 || replicas > 10) throw new Error('replicas must be 0–10');
  await r(
    `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/${CONNECTOR}/scale`,
    json('PATCH', { spec: { replicas } }, 'application/merge-patch+json')
  );
}

export type TunnelState = 'Running' | 'Starting' | 'Stopped' | 'Degraded';
export function tunnelState(c: DeploymentState): TunnelState {
  if (c.replicas === 0) return 'Stopped';
  if (c.ready === 0) return 'Starting';
  if (c.ready < c.replicas) return 'Degraded';
  return 'Running';
}

// --- cluster Services (the rule's target) ------------------------------------------------

export interface ServiceRef {
  namespace: string;
  name: string;
  ports: { name: string; port: number }[];
}

export async function listServices(r: Request): Promise<ServiceRef[]> {
  const list = await r('/api/v1/services');
  return ((list?.items ?? []) as any[])
    .filter(s => s?.spec?.type !== 'ExternalName' && (s?.spec?.ports ?? []).length > 0)
    .map(s => ({
      namespace: s.metadata.namespace,
      name: s.metadata.name,
      ports: (s.spec.ports as any[])
        .filter(p => (p.protocol ?? 'TCP') === 'TCP')
        .map(p => ({ name: p.name ?? '', port: p.port })),
    }))
    .filter(s => s.ports.length > 0)
    .sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
}

export function serviceUrl(namespace: string, name: string, port: number, https = false): string {
  return `${https ? 'https' : 'http'}://${name}.${namespace}.svc.cluster.local:${port}`;
}

const SVC_URL_RE = /^(https?):\/\/([a-z0-9-]+)\.([a-z0-9-]+)\.svc\.cluster\.local:(\d{1,5})$/;
export function parseServiceUrl(url: string): { https: boolean; name: string; namespace: string; port: number } | null {
  const m = SVC_URL_RE.exec(url);
  return m ? { https: m[1] === 'https', name: m[2], namespace: m[3], port: Number(m[4]) } : null;
}

// --- rules (TunnelRoutes) -------------------------------------------------------------------

export interface TunnelRoute {
  name: string;
  hostname: string;
  service: string;
  path?: string;
  state: 'Ready' | 'Invalid' | 'Conflict' | 'Pending';
  message: string;
}

export function toRoute(obj: any): TunnelRoute {
  const st = obj?.status ?? {};
  return {
    name: obj?.metadata?.name ?? '',
    hostname: obj?.spec?.hostname ?? '',
    service: obj?.spec?.service ?? '',
    ...(obj?.spec?.path ? { path: obj.spec.path } : {}),
    state: st.state === 'Ready' || st.state === 'Invalid' || st.state === 'Conflict' ? st.state : 'Pending',
    message: st.message ?? 'waiting for the manager',
  };
}

export async function listRoutes(r: Request): Promise<TunnelRoute[]> {
  const list = await r(routesPath);
  return ((list?.items ?? []) as any[]).map(toRoute).sort((a, b) => a.hostname.localeCompare(b.hostname));
}

/** subdomain + zone -> hostname ("" = the zone apex, "*" = wildcard). */
export function hostnameOf(subdomain: string, zone: string): string {
  const sub = subdomain.trim().toLowerCase().replace(/\.+$/, '');
  return sub ? `${sub}.${zone}` : zone;
}

/** Split a hostname into subdomain + the longest matching zone. */
export function splitHostname(hostname: string, zones: string[]): { subdomain: string; zone: string } {
  const zone = [...zones].sort((a, b) => b.length - a.length).find(z => hostname === z || hostname.endsWith(`.${z}`));
  if (!zone) return { subdomain: hostname, zone: '' };
  return { subdomain: hostname === zone ? '' : hostname.slice(0, -(zone.length + 1)), zone };
}

/** A TunnelRoute object name from a hostname: *.a.b -> wildcard-a-b. */
export function routeName(hostname: string, taken: string[] = []): string {
  const base =
    hostname
      .toLowerCase()
      .replace(/^\*\./, 'wildcard.')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 55) || 'route';
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = `${base}-${i}`;
  return name;
}

export interface RuleInput {
  hostname: string;
  service: string;
  path?: string;
}

export function checkRule(rule: RuleInput, zones: string[]): string | null {
  const path = rule.path?.trim();
  return validateRoute(
    { name: 'x', hostname: rule.hostname.trim().toLowerCase(), service: rule.service.trim(), ...(path ? { path } : {}) },
    zones
  );
}

function spec(rule: RuleInput) {
  const path = rule.path?.trim();
  return { hostname: rule.hostname.trim().toLowerCase(), service: rule.service.trim(), ...(path ? { path } : {}) };
}

export async function createRule(r: Request, rule: RuleInput, zones: string[], taken: string[]): Promise<string> {
  const problem = checkRule(rule, zones);
  if (problem) throw new Error(problem);
  const name = routeName(rule.hostname, taken);
  await r(
    routesPath,
    json('POST', {
      apiVersion: `${GROUP}/${VERSION}`,
      kind: 'TunnelRoute',
      metadata: { name, namespace: NAMESPACE },
      spec: spec(rule),
    })
  );
  return name;
}

export async function updateRule(r: Request, name: string, rule: RuleInput, zones: string[]): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error('bad rule name');
  const problem = checkRule(rule, zones);
  if (problem) throw new Error(problem);
  // path: null removes a path that was cleared.
  const s = spec(rule);
  await r(
    `${routesPath}/${name}`,
    json('PATCH', { spec: { ...s, path: s.path ?? null } }, 'application/merge-patch+json')
  );
}

export async function deleteRule(r: Request, name: string): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error('bad rule name');
  await r(`${routesPath}/${name}`, { method: 'DELETE' });
}
