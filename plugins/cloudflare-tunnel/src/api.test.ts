import { describe, expect, it } from 'vitest';
import {
  checkRoute,
  createRoute,
  deleteRoute,
  getSettings,
  listRoutes,
  Request,
  routeObject,
  scaleConnector,
  toRoute,
  tunnelState,
} from './api';

const zones = ['example.org', 'example.net'];

function fakeRequest(responses: Record<string, any> = {}) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const request: Request = async (path, init) => {
    calls.push({ path, init });
    return responses[path] ?? {};
  };
  return { request, calls };
}

describe('checkRoute', () => {
  it('accepts a cluster service in an allowed zone', () => {
    expect(
      checkRoute({ name: 'portal', hostname: 'portal.example.org', service: 'http://portal.apps.svc.cluster.local:3000' }, zones)
    ).toBeNull();
    expect(checkRoute({ name: 'mcp', hostname: '*.example.org', service: 'http_status:404' }, zones)).toBeNull();
  });

  it('refuses outside origins, other zones and bad names', () => {
    expect(checkRoute({ name: 'x', hostname: 'a.example.org', service: 'http://evil.example.com:80' }, zones)).toMatch(/service/);
    expect(checkRoute({ name: 'x', hostname: 'a.example.com', service: 'http_status:404' }, zones)).toMatch(/zone/);
    expect(checkRoute({ name: 'Bad_Name', hostname: 'a.example.org', service: 'http_status:404' }, zones)).toMatch(/name/);
  });
});

describe('API calls', () => {
  it('lists routes sorted, with Pending for unreconciled ones', async () => {
    const { request } = fakeRequest({
      '/apis/tunnel.risingtidegroup.github.io/v1alpha1/namespaces/cloudflare-tunnel/tunnelroutes': {
        items: [
          { metadata: { name: 'b' }, spec: { hostname: 'b.example.org', service: 'http_status:404' } },
          {
            metadata: { name: 'a' },
            spec: { hostname: 'a.example.org', service: 'http_status:404' },
            status: { state: 'Conflict', message: 'not ours' },
          },
        ],
      },
    });
    const routes = await listRoutes(request);
    expect(routes.map(r => [r.name, r.state])).toEqual([
      ['a', 'Conflict'],
      ['b', 'Pending'],
    ]);
  });

  it('reads the zones from the manager ConfigMap', async () => {
    const { request } = fakeRequest({
      '/api/v1/namespaces/cloudflare-tunnel/configmaps/cloudflare-tunnel-manager': {
        data: { TUNNEL_NAME: 'prod-nyc1', TUNNEL_ZONES: ' Example.org, example.net ,' },
      },
    });
    expect(await getSettings(request)).toEqual({ tunnelName: 'prod-nyc1', zones });
  });

  it('creates a normalized TunnelRoute and refuses an invalid one without calling the API', async () => {
    const { request, calls } = fakeRequest();
    await createRoute(request, { name: 'hl', hostname: ' HL.example.org ', service: 'http://headlamp.headlamp.svc.cluster.local:4466' }, zones);
    expect(calls[0]!.init!.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual(
      routeObject({ name: 'hl', hostname: 'hl.example.org', service: 'http://headlamp.headlamp.svc.cluster.local:4466' })
    );
    await expect(createRoute(request, { name: 'x', hostname: 'x.example.com', service: 'http_status:404' }, zones)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('deletes by name only when the name is valid', async () => {
    const { request, calls } = fakeRequest();
    await deleteRoute(request, 'hl');
    expect(calls[0]!.path).toMatch(/tunnelroutes\/hl$/);
    await expect(deleteRoute(request, '../secrets/x')).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('scales the connector through the scale subresource, 0..10 only', async () => {
    const { request, calls } = fakeRequest();
    await scaleConnector(request, 0);
    expect(calls[0]!.path).toBe('/apis/apps/v1/namespaces/cloudflare-tunnel/deployments/cloudflared/scale');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ spec: { replicas: 0 } });
    await expect(scaleConnector(request, 11)).rejects.toThrow();
    await expect(scaleConnector(request, 1.5)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe('state', () => {
  it('derives the tunnel state from the connector', () => {
    expect(tunnelState({ replicas: 0, ready: 0 })).toBe('Stopped');
    expect(tunnelState({ replicas: 2, ready: 0 })).toBe('Starting');
    expect(tunnelState({ replicas: 2, ready: 1 })).toBe('Degraded');
    expect(tunnelState({ replicas: 2, ready: 2 })).toBe('Running');
  });

  it('maps an object with no status to Pending', () => {
    expect(toRoute({ metadata: { name: 'x' }, spec: {} }).state).toBe('Pending');
  });
});
