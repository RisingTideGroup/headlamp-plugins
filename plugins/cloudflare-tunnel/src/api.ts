// Everything the plugin asks the Kubernetes API, as plain functions over an injected
// `request` (Headlamp's ApiProxy.request in the plugin, a fake in tests). Every call runs
// with the signed-in person's own token and RBAC: the plugin holds no credential, and the
// Cloudflare API token never leaves the manager's Secret.
//
// Validation is the manager's own (backends/cloudflare-tunnel-manager/src/rules.ts, imported,
// not copied), so the form refuses exactly what the manager would mark Invalid. The CRD's
// patterns are the server-side backstop.

import { validateRoute, zoneFor } from '../../../backends/cloudflare-tunnel-manager/src/rules.ts';

export const GROUP = 'tunnel.risingtidegroup.github.io';
export const VERSION = 'v1alpha1';
export const NAMESPACE = 'cloudflare-tunnel';
export const MANAGER = 'cloudflare-tunnel-manager';
export const CONNECTOR = 'cloudflared';

export type Request = (path: string, init?: RequestInit) => Promise<any>;

export interface TunnelRoute {
  name: string;
  hostname: string;
  service: string;
  path?: string;
  state: 'Ready' | 'Invalid' | 'Conflict' | 'Pending';
  message: string;
  lastReconciled?: string;
}

export interface TunnelSettings {
  tunnelName: string;
  zones: string[];
}

export interface DeploymentState {
  /** Desired replicas (spec). */
  replicas: number;
  /** Ready replicas (status). */
  ready: number;
}

const routesPath = `/apis/${GROUP}/${VERSION}/namespaces/${NAMESPACE}/tunnelroutes`;
const deploymentPath = (name: string) => `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/${name}`;

const NAME_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export function toRoute(obj: any): TunnelRoute {
  const st = obj?.status ?? {};
  return {
    name: obj?.metadata?.name ?? '',
    hostname: obj?.spec?.hostname ?? '',
    service: obj?.spec?.service ?? '',
    ...(obj?.spec?.path ? { path: obj.spec.path } : {}),
    state: st.state === 'Ready' || st.state === 'Invalid' || st.state === 'Conflict' ? st.state : 'Pending',
    message: st.message ?? 'not reconciled yet',
    ...(st.lastReconciled ? { lastReconciled: st.lastReconciled } : {}),
  };
}

export async function listRoutes(request: Request): Promise<TunnelRoute[]> {
  const list = await request(routesPath);
  return ((list?.items ?? []) as any[]).map(toRoute).sort((a, b) => a.name.localeCompare(b.name));
}

/** TUNNEL_NAME and TUNNEL_ZONES from the manager's ConfigMap: the zones a route may use. */
export async function getSettings(request: Request): Promise<TunnelSettings> {
  const cm = await request(`/api/v1/namespaces/${NAMESPACE}/configmaps/${MANAGER}`);
  const data = cm?.data ?? {};
  return {
    tunnelName: data.TUNNEL_NAME ?? '',
    zones: String(data.TUNNEL_ZONES ?? '')
      .split(',')
      .map((z: string) => z.trim().toLowerCase())
      .filter(Boolean),
  };
}

export async function getDeployment(request: Request, name: string): Promise<DeploymentState> {
  const d = await request(deploymentPath(name));
  return { replicas: d?.spec?.replicas ?? 0, ready: d?.status?.readyReplicas ?? 0 };
}

export interface RouteInput {
  name: string;
  hostname: string;
  service: string;
  path?: string;
}

/** The manager's rules plus a DNS-1123 object name. Returns the problem, or null. */
export function checkRoute(input: RouteInput, zones: string[]): string | null {
  if (!NAME_RE.test(input.name)) {
    return 'name must be lowercase letters, digits and dashes (at most 63), starting and ending with a letter or digit';
  }
  const path = input.path?.trim();
  return validateRoute(
    { name: input.name, hostname: input.hostname.trim().toLowerCase(), service: input.service.trim(), ...(path ? { path } : {}) },
    zones
  );
}

export function routeObject(input: RouteInput) {
  const path = input.path?.trim();
  return {
    apiVersion: `${GROUP}/${VERSION}`,
    kind: 'TunnelRoute',
    metadata: { name: input.name, namespace: NAMESPACE },
    spec: {
      hostname: input.hostname.trim().toLowerCase(),
      service: input.service.trim(),
      ...(path ? { path } : {}),
    },
  };
}

export async function createRoute(request: Request, input: RouteInput, zones: string[]): Promise<void> {
  const problem = checkRoute(input, zones);
  if (problem) throw new Error(problem);
  await request(routesPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(routeObject(input)),
  });
}

export async function deleteRoute(request: Request, name: string): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error('bad route name');
  await request(`${routesPath}/${name}`, { method: 'DELETE' });
}

/** Start (n >= 1) or stop (0) the tunnel: scale the cloudflared connector. */
export async function scaleConnector(request: Request, replicas: number): Promise<void> {
  if (!Number.isInteger(replicas) || replicas < 0 || replicas > 10) {
    throw new Error('replicas must be a whole number from 0 to 10');
  }
  await request(`${deploymentPath(CONNECTOR)}/scale`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/merge-patch+json' },
    body: JSON.stringify({ spec: { replicas } }),
  });
}

/** The service URL for a cluster Service, as the manager requires it. */
export function serviceUrl(service: string, namespace: string, port: number, https = false): string {
  return `${https ? 'https' : 'http'}://${service}.${namespace}.svc.cluster.local:${port}`;
}

/** Which allowed zone a hostname falls in (shown next to the hostname field). */
export function zoneOf(hostname: string, zones: string[]): string | null {
  return zoneFor(hostname.trim().toLowerCase(), zones);
}

export type TunnelState = 'Running' | 'Starting' | 'Stopped' | 'Degraded';

export function tunnelState(connector: DeploymentState): TunnelState {
  if (connector.replicas === 0) return 'Stopped';
  if (connector.ready === 0) return 'Starting';
  if (connector.ready < connector.replicas) return 'Degraded';
  return 'Running';
}
