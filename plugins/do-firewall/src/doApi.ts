/**
 * DigitalOcean API calls, made straight from the browser with the signed-in
 * person's own token. api.digitalocean.com answers CORS for any origin with
 * Authorization + PUT allowed, so nothing goes through Headlamp's backend:
 * its /externalproxy forwards every request header (cookies, the Cloudflare
 * Access JWT) to the destination, which must not reach DO.
 *
 * Token scopes needed (custom-scoped token): kubernetes:read,
 * kubernetes:update, nat_gateway:read.
 */

const API = 'https://api.digitalocean.com/v2';

export interface DoCluster {
  id: string;
  name: string;
  region: string;
  vpc_uuid: string;
  endpoint: string;
  version: string;
  status?: { state?: string };
  control_plane_firewall?: {
    enabled?: boolean;
    allowed_addresses?: string[];
  } | null;
}

interface DoNatGateway {
  id: string;
  name: string;
  state: string;
  vpcs?: { vpc_uuid?: string }[];
  egresses?: { public_gateways?: { ipv4?: string }[] };
}

export interface NatEgress {
  ip: string;
  name: string;
}

export class DoApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    // No cookies or credentials of this origin go to DO; only the bearer token.
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    // DO error bodies are { id, message }; never echo the request (it holds the token).
    let message = `DigitalOcean API returned ${res.status}`;
    try {
      const body = await res.json();
      if (body?.message) message = `${message}: ${body.message}`;
    } catch {
      /* non-JSON error body; keep the status line */
    }
    if (res.status === 401)
      message = 'DigitalOcean rejected the token (expired, revoked, or mistyped).';
    if (res.status === 403)
      message =
        'The token lacks a required scope (kubernetes:read, kubernetes:update, nat_gateway:read).';
    throw new DoApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export async function listClusters(token: string): Promise<DoCluster[]> {
  const body = await call<{ kubernetes_clusters: DoCluster[] }>(
    token,
    '/kubernetes/clusters?per_page=200'
  );
  return body.kubernetes_clusters ?? [];
}

export async function getCluster(token: string, id: string): Promise<DoCluster> {
  const body = await call<{ kubernetes_cluster: DoCluster }>(
    token,
    `/kubernetes/clusters/${encodeURIComponent(id)}`
  );
  return body.kubernetes_cluster;
}

/** Public egress IPs of the ACTIVE NAT gateways attached to a VPC. */
export async function natEgressForVpc(token: string, vpcUuid: string): Promise<NatEgress[]> {
  const body = await call<{ vpc_nat_gateways: DoNatGateway[] }>(
    token,
    '/vpc_nat_gateways?per_page=200'
  );
  const out: NatEgress[] = [];
  for (const g of body.vpc_nat_gateways ?? []) {
    if (g.state !== 'ACTIVE') continue;
    if (!(g.vpcs ?? []).some(v => v.vpc_uuid === vpcUuid)) continue;
    for (const pg of g.egresses?.public_gateways ?? []) {
      if (pg.ipv4) out.push({ ip: pg.ipv4, name: g.name });
    }
  }
  return out;
}

/** Replaces the whole allowlist (DO has no add/remove of single entries). */
export async function updateFirewall(
  token: string,
  id: string,
  body: {
    name: string;
    control_plane_firewall: { enabled: boolean; allowed_addresses: string[] };
  }
): Promise<void> {
  await call(token, `/kubernetes/clusters/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}
