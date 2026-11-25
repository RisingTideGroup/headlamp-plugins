// The route rules cloudflare-tunnel-manager enforces (its src/plan.ts: HOST_RE, SERVICE_RE,
// zoneFor, validateRoute). Copied here so the form refuses exactly what the manager would mark
// Invalid; the TunnelRoute CRD's patterns are the server-side backstop either way.
// Keep in step with the manager when its rules change.

export interface RouteSpec {
  name: string;
  hostname: string;
  service: string;
  path?: string;
}

const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SERVICE_RE =
  /^https?:\/\/[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\.svc\.cluster\.local:\d{1,5}$/;

/** The zone a hostname belongs to, from the allowed list (longest match), or null. */
export function zoneFor(hostname: string, zones: string[]): string | null {
  const bare = hostname.startsWith('*.') ? hostname.slice(2) : hostname;
  let best: string | null = null;
  for (const z of zones) {
    if ((bare === z || bare.endsWith(`.${z}`)) && (!best || z.length > best.length)) best = z;
  }
  return best;
}

export function validateRoute(r: RouteSpec, zones: string[]): string | null {
  if (!HOST_RE.test(r.hostname)) return `hostname "${r.hostname}" is not a valid DNS name`;
  if (!zoneFor(r.hostname, zones)) {
    return `hostname "${r.hostname}" is not in an allowed zone (${zones.join(', ')})`;
  }
  if (r.service !== 'http_status:404' && !SERVICE_RE.test(r.service)) {
    return `service "${r.service}" must be http(s)://<service>.<namespace>.svc.cluster.local:<port>`;
  }
  if (r.path !== undefined && r.path !== '' && (r.path.length > 200 || /[\s]/.test(r.path))) {
    return 'path must be a regular expression without whitespace, at most 200 characters';
  }
  return null;
}
