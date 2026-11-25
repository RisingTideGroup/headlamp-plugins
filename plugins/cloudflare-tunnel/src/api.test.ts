import { describe, expect, it } from 'vitest';
import {
  checkRule,
  createRule,
  deleteRule,
  getStatus,
  hostnameOf,
  listServices,
  parseServiceUrl,
  Request,
  routeName,
  saveSettings,
  saveToken,
  scaleConnector,
  serviceUrl,
  settingsData,
  splitHostname,
  toRoute,
  tunnelState,
  updateRule,
} from './api';

const zones = ['example.org', 'example.net'];
const ACCT = 'fb5d0e8640b72b5cf3da11b57995ec42';

function fake(responses: Record<string, any> = {}, notFound: string[] = []) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const request: Request = async (path, init) => {
    calls.push({ path, init });
    if (notFound.some(p => path === p && (init?.method ?? 'GET') === 'PATCH')) throw Object.assign(new Error('nf'), { status: 404 });
    return responses[path] ?? {};
  };
  return { request, calls, body: (i: number) => JSON.parse(String(calls[i].init!.body)) };
}

describe('manager API', () => {
  it('goes through the API server service proxy', async () => {
    const { request, calls } = fake();
    await getStatus(request);
    expect(calls[0].path).toBe('/api/v1/namespaces/cloudflare-tunnel/services/http:cloudflare-tunnel-manager:http/proxy/api/status');
  });
});

describe('settings and token', () => {
  it('maps the form: an existing tunnel clears the name; adopt only when asked', () => {
    expect(settingsData({ accountId: ACCT.toUpperCase(), tunnelId: 'D1DBFDC1-52a5-454f-8f75-e5a415db2289', tunnelName: 'x', adopt: false })).toEqual({
      CLOUDFLARE_ACCOUNT_ID: ACCT,
      TUNNEL_ID: 'd1dbfdc1-52a5-454f-8f75-e5a415db2289',
      TUNNEL_NAME: '',
      TUNNEL_ADOPT: '',
    });
    expect(settingsData({ accountId: ACCT, tunnelId: '', tunnelName: ' prod-nyc1 ', adopt: true }).TUNNEL_NAME).toBe('prod-nyc1');
  });

  it('patches the settings ConfigMap, and creates it on 404', async () => {
    const cm = '/api/v1/namespaces/cloudflare-tunnel/configmaps';
    const { request, calls, body } = fake({}, [`${cm}/cloudflare-tunnel-settings`]);
    await saveSettings(request, { accountId: ACCT, tunnelId: '', tunnelName: 'prod', adopt: false });
    expect(calls.map(c => `${c.init?.method} ${c.path}`)).toEqual([`PATCH ${cm}/cloudflare-tunnel-settings`, `POST ${cm}`]);
    expect(body(1).data.TUNNEL_NAME).toBe('prod');
  });

  it('writes the token without ever reading the Secret', async () => {
    const { request, calls, body } = fake();
    await saveToken(request, '  tok  ');
    expect(calls).toHaveLength(1);
    expect(calls[0].init!.method).toBe('PATCH');
    expect(body(0)).toEqual({ stringData: { CLOUDFLARE_API_TOKEN: 'tok' } });
    await expect(saveToken(request, '  ')).rejects.toThrow();
  });
});

describe('rules', () => {
  it('composes and splits hostnames against the zones', () => {
    expect(hostnameOf('Portal', 'example.org')).toBe('portal.example.org');
    expect(hostnameOf('', 'example.org')).toBe('example.org');
    expect(hostnameOf('*', 'example.org')).toBe('*.example.org');
    expect(splitHostname('a.b.example.org', zones)).toEqual({ subdomain: 'a.b', zone: 'example.org' });
    expect(splitHostname('example.net', zones)).toEqual({ subdomain: '', zone: 'example.net' });
  });

  it('names rules from their hostname, uniquely', () => {
    expect(routeName('*.example.org')).toBe('wildcard-example-org');
    expect(routeName('portal.example.org', ['portal-example-org'])).toBe('portal-example-org-2');
  });

  it('service URLs round-trip', () => {
    const u = serviceUrl('headlamp', 'headlamp', 4466);
    expect(u).toBe('http://headlamp.headlamp.svc.cluster.local:4466');
    expect(parseServiceUrl(u)).toEqual({ https: false, name: 'headlamp', namespace: 'headlamp', port: 4466 });
    expect(parseServiceUrl('http_status:404')).toBeNull();
  });

  it('uses the manager rules: cluster Services only, allowed zones only', () => {
    expect(checkRule({ hostname: 'a.example.org', service: serviceUrl('apps', 'portal', 3000) }, zones)).toBeNull();
    expect(checkRule({ hostname: 'a.example.org', service: 'http://evil.example.com:80' }, zones)).toMatch(/service/);
    expect(checkRule({ hostname: 'a.example.com', service: serviceUrl('apps', 'portal', 3000) }, zones)).toMatch(/zone/);
  });

  it('creates, updates (clearing a path) and deletes; invalid input never reaches the API', async () => {
    const { request, calls, body } = fake();
    const name = await createRule(request, { hostname: 'hl.example.org', service: serviceUrl('headlamp', 'headlamp', 4466) }, zones, []);
    expect(name).toBe('hl-example-org');
    expect(body(0).spec).toEqual({ hostname: 'hl.example.org', service: 'http://headlamp.headlamp.svc.cluster.local:4466' });
    await updateRule(request, name, { hostname: 'hl.example.org', service: serviceUrl('headlamp', 'headlamp', 4466), path: '' }, zones);
    expect(body(1)).toEqual({ spec: { hostname: 'hl.example.org', service: 'http://headlamp.headlamp.svc.cluster.local:4466', path: null } });
    await deleteRule(request, name);
    expect(calls[2].init!.method).toBe('DELETE');
    await expect(createRule(request, { hostname: 'x.example.com', service: 'http_status:404' }, zones, [])).rejects.toThrow();
    await expect(deleteRule(request, '../secrets/x')).rejects.toThrow();
    expect(calls).toHaveLength(3);
  });

  it('lists TCP ports of non-ExternalName Services, sorted', async () => {
    const { request } = fake({
      '/api/v1/services': {
        items: [
          { metadata: { namespace: 'z', name: 'b' }, spec: { ports: [{ port: 80, name: 'http' }, { port: 53, protocol: 'UDP' }] } },
          { metadata: { namespace: 'a', name: 'ext' }, spec: { type: 'ExternalName', ports: [{ port: 80 }] } },
          { metadata: { namespace: 'a', name: 'c' }, spec: { ports: [{ port: 4466 }] } },
        ],
      },
    });
    expect(await listServices(request)).toEqual([
      { namespace: 'a', name: 'c', ports: [{ name: '', port: 4466 }] },
      { namespace: 'z', name: 'b', ports: [{ name: 'http', port: 80 }] },
    ]);
  });

  it('maps an object with no status to Pending', () => {
    expect(toRoute({ metadata: { name: 'x' }, spec: {} }).state).toBe('Pending');
  });
});

describe('connector', () => {
  it('scales through the scale subresource, 0..10 only', async () => {
    const { request, calls, body } = fake();
    await scaleConnector(request, 0);
    expect(calls[0].path).toBe('/apis/apps/v1/namespaces/cloudflare-tunnel/deployments/cloudflared/scale');
    expect(body(0)).toEqual({ spec: { replicas: 0 } });
    await expect(scaleConnector(request, 11)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('derives the tunnel state', () => {
    expect(tunnelState({ replicas: 0, ready: 0 })).toBe('Stopped');
    expect(tunnelState({ replicas: 2, ready: 0 })).toBe('Starting');
    expect(tunnelState({ replicas: 2, ready: 1 })).toBe('Degraded');
    expect(tunnelState({ replicas: 2, ready: 2 })).toBe('Running');
  });
});
