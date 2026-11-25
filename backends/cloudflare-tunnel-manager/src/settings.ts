// The manager's settings, written by the Headlamp plugin (or kubectl) into ConfigMap
// `cloudflare-tunnel-settings` and read live on every pass, so a change applies within one
// interval and needs no restart. The bundle (deploy/) never ships this ConfigMap or the
// token Secret, so re-applying the bundle never resets what was saved from the UI.
//
//   CLOUDFLARE_ACCOUNT_ID  the account the tunnel lives in (32 hex characters)
//   TUNNEL_ID              use this existing tunnel …
//   TUNNEL_NAME            … or find/create the tunnel with this name (one of the two is required)
//   TUNNEL_ZONES           optional comma-separated allowlist; empty = every zone the token can see
//   TUNNEL_ADOPT           "replace": allowed to take over a tunnel that already has routes
//                          (its existing routes are REPLACED by this cluster's)
//
// The API token is not here: it is Secret `cloudflare-api`, key CLOUDFLARE_API_TOKEN.

export const SETTINGS_CONFIGMAP = 'cloudflare-tunnel-settings'
export const API_SECRET = 'cloudflare-api'
export const API_SECRET_KEY = 'CLOUDFLARE_API_TOKEN'

export interface Settings {
  accountId: string
  tunnelId: string
  tunnelName: string
  zones: string[]
  adopt: boolean
}

export type ParsedSettings = { ok: true; settings: Settings } | { ok: false; missing: string[]; settings: Settings }

const ACCOUNT_RE = /^[0-9a-f]{32}$/
const TUNNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TUNNEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

/** Parse the ConfigMap data (null = no ConfigMap). Never throws; reports what is missing or bad. */
export function parseSettings(data: Record<string, string | undefined> | null): ParsedSettings {
  const d = data ?? {}
  const settings: Settings = {
    accountId: (d.CLOUDFLARE_ACCOUNT_ID ?? '').trim().toLowerCase(),
    tunnelId: (d.TUNNEL_ID ?? '').trim().toLowerCase(),
    tunnelName: (d.TUNNEL_NAME ?? '').trim(),
    zones: (d.TUNNEL_ZONES ?? '').split(',').map((z) => z.trim().toLowerCase()).filter(Boolean),
    adopt: (d.TUNNEL_ADOPT ?? '').trim() === 'replace',
  }
  const missing: string[] = []
  if (!settings.accountId) missing.push('CLOUDFLARE_ACCOUNT_ID')
  else if (!ACCOUNT_RE.test(settings.accountId)) missing.push('CLOUDFLARE_ACCOUNT_ID (not a Cloudflare account id)')
  if (!settings.tunnelId && !settings.tunnelName) missing.push('TUNNEL_ID or TUNNEL_NAME')
  if (settings.tunnelId && !TUNNEL_ID_RE.test(settings.tunnelId)) missing.push('TUNNEL_ID (not a tunnel id)')
  if (!settings.tunnelId && settings.tunnelName && !TUNNEL_NAME_RE.test(settings.tunnelName)) {
    missing.push('TUNNEL_NAME (letters, digits, . _ -; at most 63)')
  }
  return missing.length ? { ok: false, missing, settings } : { ok: true, settings }
}

export function isAccountId(s: string): boolean {
  return ACCOUNT_RE.test(s)
}
