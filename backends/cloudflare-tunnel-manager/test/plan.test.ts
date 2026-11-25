import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MANAGED_COMMENT, orderRules, planTunnel, sameIngress, validateRoute, zoneFor, type DnsRecord } from '../src/plan.ts'

const ZONES = ['example.org', 'example.net']
const TARGET = 'tun-1.cfargotunnel.com'
const ZONE_IDS = { 'example.org': 'z-ops', 'example.net': 'z-net' }
const svc = (n: string, ns = 'apps', p = 3000) => `http://${n}.${ns}.svc.cluster.local:${p}`

test('zoneFor: longest allowed zone, wildcards, outsiders', () => {
  assert.equal(zoneFor('portal.example.org', ZONES), 'example.org')
  assert.equal(zoneFor('*.example.org', ZONES), 'example.org')
  assert.equal(zoneFor('cluster.example.net', [...ZONES, 'x.example.net']), 'example.net')
  assert.equal(zoneFor('a.x.example.net', [...ZONES, 'x.example.net']), 'x.example.net')
  assert.equal(zoneFor('evil-example.org', ZONES), null)
  assert.equal(zoneFor('example.com', ZONES), null)
})

test('validateRoute: services must be cluster-internal; hostnames valid and in a zone', () => {
  assert.equal(validateRoute({ name: 'a', hostname: 'portal.example.org', service: svc('portal') }, ZONES), null)
  assert.equal(validateRoute({ name: 'a', hostname: 'x.example.org', service: 'http_status:404' }, ZONES), null)
  for (const service of ['http://evil.example.com:80', 'http://portal:3000', 'http://169.254.169.254:80', 'ssh://portal.apps.svc.cluster.local:22', 'http://portal.apps.svc.cluster.local']) {
    assert.match(validateRoute({ name: 'a', hostname: 'p.example.org', service }, ZONES) ?? '', /svc\.cluster\.local/, service)
  }
  assert.match(validateRoute({ name: 'a', hostname: 'p.example.com', service: svc('p') }, ZONES) ?? '', /allowed zone/)
  assert.match(validateRoute({ name: 'a', hostname: 'Bad_Host', service: svc('p') }, ZONES) ?? '', /valid DNS/)
})

test('order: exact before wildcard, longer first, path before no path; catch-all last', () => {
  const plan = planTunnel({
    routes: [
      { name: 'wild', hostname: '*.example.org', service: svc('proxy', 'apps', 8080) },
      { name: 'portal', hostname: 'portal.example.org', service: svc('portal') },
      { name: 'api', hostname: 'portal.example.org', path: '^/api', service: svc('api') },
      { name: 'hl', hostname: 'cluster.example.net', service: svc('headlamp', 'headlamp', 4466) },
    ],
    zones: ZONES, target: TARGET, zoneIds: ZONE_IDS, dns: [],
  })
  assert.deepEqual(plan.ingress.map((r) => `${r.hostname ?? '*'}${r.path ?? ''}`), [
    'cluster.example.net',
    'portal.example.org^/api',
    'portal.example.org',
    '*.example.org',
    '*',
  ])
  assert.equal(plan.ingress.at(-1)!.service, 'http_status:404')
  // A newer exact hostname can never land behind the wildcard.
  assert.deepEqual(orderRules([{ hostname: '*.a.com', service: 's' }, { hostname: 'z.a.com', service: 's' }]).map((r) => r.hostname), ['z.a.com', '*.a.com'])
})

test('DNS: create when absent, reuse when it is ours, Conflict (untouched) when foreign', () => {
  const dns: DnsRecord[] = [
    { id: 'd1', zoneId: 'z-ops', name: 'portal.example.org', type: 'CNAME', content: TARGET, comment: MANAGED_COMMENT },
    { id: 'd2', zoneId: 'z-ops', name: 'legacy.example.org', type: 'CNAME', content: 'other-tunnel.cfargotunnel.com' },
    { id: 'd3', zoneId: 'z-ops', name: 'time.example.org', type: 'A', content: '1.2.3.4' },
  ]
  const plan = planTunnel({
    routes: [
      { name: 'portal', hostname: 'portal.example.org', service: svc('portal') },
      { name: 'ninja', hostname: 'legacy.example.org', service: svc('x') },
      { name: 'time', hostname: 'time.example.org', service: svc('x') },
      { name: 'new', hostname: 'new.example.org', service: svc('x') },
    ],
    zones: ZONES, target: TARGET, zoneIds: ZONE_IDS, dns,
  })
  assert.deepEqual(plan.createDns, [{ zoneId: 'z-ops', name: 'new.example.org' }])
  assert.equal(plan.statuses.portal!.state, 'Ready')
  assert.equal(plan.statuses.ninja!.state, 'Conflict')
  assert.equal(plan.statuses.time!.state, 'Conflict')
  assert.equal(plan.statuses.new!.state, 'Ready')
  assert.ok(!plan.ingress.some((r) => r.hostname === 'legacy.example.org'), 'a conflicting route is not routed')
  assert.deepEqual(plan.deleteDns, [])
})

test('DNS cleanup: only our own records (comment AND target) for hostnames with no route', () => {
  const dns: DnsRecord[] = [
    { id: 'gone', zoneId: 'z-ops', name: 'old.example.org', type: 'CNAME', content: TARGET, comment: MANAGED_COMMENT },
    { id: 'hand', zoneId: 'z-ops', name: 'hand.example.org', type: 'CNAME', content: TARGET, comment: null },
    { id: 'kept', zoneId: 'z-ops', name: 'portal.example.org', type: 'CNAME', content: TARGET, comment: MANAGED_COMMENT },
  ]
  const plan = planTunnel({
    routes: [{ name: 'portal', hostname: 'portal.example.org', service: svc('portal') }],
    zones: ZONES, target: TARGET, zoneIds: ZONE_IDS, dns,
  })
  assert.deepEqual(plan.deleteDns.map((d) => d.id), ['gone'])
})

test('invalid and duplicate routes are reported, not routed', () => {
  const plan = planTunnel({
    routes: [
      { name: 'a', hostname: 'dup.example.org', service: svc('a') },
      { name: 'b', hostname: 'dup.example.org', service: svc('b') },
      { name: 'c', hostname: 'x.example.com', service: svc('c') },
    ],
    zones: ZONES, target: TARGET, zoneIds: ZONE_IDS, dns: [],
  })
  assert.equal(plan.statuses.a!.state, 'Ready')
  assert.match(plan.statuses.b!.message, /same hostname and path as route "a"/)
  assert.equal(plan.statuses.c!.state, 'Invalid')
  assert.equal(plan.ingress.length, 2)
  assert.equal(plan.createDns.length, 1)
})

test('sameIngress is order-sensitive and ignores empty paths', () => {
  const a = [{ hostname: 'a', service: 's' }, { service: 'http_status:404' }]
  assert.ok(sameIngress(a, [{ hostname: 'a', path: '', service: 's' }, { service: 'http_status:404' }]))
  assert.ok(!sameIngress(a, [...a].reverse()))
})
