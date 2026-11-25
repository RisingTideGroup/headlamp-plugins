import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSettings } from '../src/settings.ts'

const ACCT = 'fb5d0e8640b72b5cf3da11b57995ec42'

test('no ConfigMap: everything is missing, nothing throws', () => {
  const r = parseSettings(null)
  assert.equal(r.ok, false)
  assert.deepEqual(!r.ok && r.missing, ['CLOUDFLARE_ACCOUNT_ID', 'TUNNEL_ID or TUNNEL_NAME'])
})

test('account + tunnel name, zones normalized, adopt only on "replace"', () => {
  const r = parseSettings({ CLOUDFLARE_ACCOUNT_ID: ACCT.toUpperCase(), TUNNEL_NAME: 'prod-nyc1', TUNNEL_ZONES: ' Example.org, ,example.net', TUNNEL_ADOPT: 'yes' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.settings, { accountId: ACCT, tunnelId: '', tunnelName: 'prod-nyc1', zones: ['example.org', 'example.net'], adopt: false })
  assert.equal(parseSettings({ CLOUDFLARE_ACCOUNT_ID: ACCT, TUNNEL_NAME: 'x', TUNNEL_ADOPT: 'replace' }).settings.adopt, true)
})

test('a tunnel id is accepted; malformed ids and names are reported', () => {
  assert.equal(parseSettings({ CLOUDFLARE_ACCOUNT_ID: ACCT, TUNNEL_ID: 'd1dbfdc1-52a5-454f-8f75-e5a415db2289' }).ok, true)
  const bad = parseSettings({ CLOUDFLARE_ACCOUNT_ID: 'nis', TUNNEL_ID: 'nope' })
  assert.deepEqual(!bad.ok && bad.missing, ['CLOUDFLARE_ACCOUNT_ID (not a Cloudflare account id)', 'TUNNEL_ID (not a tunnel id)'])
  const name = parseSettings({ CLOUDFLARE_ACCOUNT_ID: ACCT, TUNNEL_NAME: 'has space' })
  assert.equal(name.ok, false)
})
