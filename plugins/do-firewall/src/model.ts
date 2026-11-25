/**
 * Pure allowlist logic for the DOKS control-plane firewall: parse and validate
 * addresses, merge DigitalOcean's list with the labels kept in-cluster, diff
 * a draft against what DO holds, and build the update body.
 *
 * DO's rules (API spec, control_plane_firewall.yml + doctl docs): public IPv4
 * addresses or CIDRs only, at most 500 entries, and every update REPLACES the
 * whole list. Nothing here talks to the network, so all of it is unit-tested.
 */

export const MAX_ENTRIES = 500;

export type Purpose = 'nat-gateway' | 'management-host' | 'workstation' | 'automation' | 'other';

export const PURPOSES: { value: Purpose; label: string }[] = [
  { value: 'nat-gateway', label: 'NAT gateway (cluster nodes)' },
  { value: 'management-host', label: 'Management host (Headlamp)' },
  { value: 'workstation', label: 'Workstation' },
  { value: 'automation', label: 'Automation / CI' },
  { value: 'other', label: 'Other' },
];

export interface AllowEntry {
  /** Normalized `a.b.c.d/n`. */
  cidr: string;
  label: string;
  purpose: Purpose;
  /** The cluster's NAT gateway egress: nodes go NotReady without it, so it cannot be removed. */
  locked: boolean;
}

export interface StoredLabel {
  label: string;
  purpose: Purpose;
}

export type LabelMap = Record<string, StoredLabel>;

/** Ranges that are never valid in DO's allowlist (not publicly routable). */
const NON_PUBLIC: { net: string; bits: number; why: string }[] = [
  { net: '0.0.0.0', bits: 8, why: '"this network"' },
  { net: '10.0.0.0', bits: 8, why: 'private (RFC 1918)' },
  { net: '100.64.0.0', bits: 10, why: 'carrier-grade NAT (RFC 6598)' },
  { net: '127.0.0.0', bits: 8, why: 'loopback' },
  { net: '169.254.0.0', bits: 16, why: 'link-local' },
  { net: '172.16.0.0', bits: 12, why: 'private (RFC 1918)' },
  { net: '192.168.0.0', bits: 16, why: 'private (RFC 1918)' },
  { net: '224.0.0.0', bits: 4, why: 'multicast' },
  { net: '240.0.0.0', bits: 4, why: 'reserved' },
];

function ipToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function intToIp(n: number): string {
  return [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');
}

function blockSize(bits: number): number {
  return 2 ** (32 - bits);
}

function overlaps(aStart: number, aBits: number, bStart: number, bBits: number): boolean {
  const aEnd = aStart + blockSize(aBits) - 1;
  const bEnd = bStart + blockSize(bBits) - 1;
  return aStart <= bEnd && bStart <= aEnd;
}

export type ParseResult = { ok: true; cidr: string } | { ok: false; error: string };

/**
 * Parse one address as typed: `1.2.3.4` becomes `1.2.3.4/32`. Rejects host
 * bits set under the mask (suggesting the network form), /0, and anything
 * overlapping a non-public range.
 */
export function parseCidr(input: string): ParseResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'Enter an IPv4 address or CIDR.' };
  const [ip, maskText, extra] = raw.split('/');
  if (extra !== undefined)
    return { ok: false, error: 'Use the form 203.0.113.7 or 203.0.113.0/24.' };
  const start = ipToInt(ip);
  if (start === null)
    return {
      ok: false,
      error: 'Not an IPv4 address (IPv6 is not supported by DO here).',
    };
  let bits = 32;
  if (maskText !== undefined) {
    if (!/^\d{1,2}$/.test(maskText) || Number(maskText) > 32) {
      return { ok: false, error: 'The prefix length must be 1–32.' };
    }
    bits = Number(maskText);
  }
  if (bits === 0) return { ok: false, error: '/0 would allow the whole internet.' };
  if (start % blockSize(bits) !== 0) {
    const net = start - (start % blockSize(bits));
    return {
      ok: false,
      error: `Host bits are set; did you mean ${intToIp(net)}/${bits}?`,
    };
  }
  for (const r of NON_PUBLIC) {
    if (overlaps(start, bits, ipToInt(r.net) as number, r.bits)) {
      return {
        ok: false,
        error: `Overlaps ${r.net}/${r.bits}, which is ${r.why}; DO accepts public addresses only.`,
      };
    }
  }
  return { ok: true, cidr: `${intToIp(start)}/${bits}` };
}

/** DO may return bare addresses; compare everything in `/n` form. */
export function normalizeStored(addr: string): string {
  const parsed = parseCidr(addr);
  return parsed.ok ? parsed.cidr : addr.trim();
}

/**
 * Build the editable rows from DO's list, the stored labels, and the NAT
 * gateway egress IPs. NAT rows are locked; a NAT IP missing from DO's list is
 * added (the nodes need it), so the first save repairs a broken list.
 */
export function mergeEntries(
  doAddresses: string[],
  labels: LabelMap,
  natIps: { ip: string; name: string }[]
): AllowEntry[] {
  const natByCidr = new Map(natIps.map(n => [normalizeStored(n.ip), n.name]));
  const seen = new Set<string>();
  const rows: AllowEntry[] = [];
  const push = (cidr: string) => {
    if (seen.has(cidr)) return;
    seen.add(cidr);
    const nat = natByCidr.get(cidr);
    if (nat !== undefined) {
      rows.push({
        cidr,
        label: labels[cidr]?.label || `NAT gateway ${nat}`,
        purpose: 'nat-gateway',
        locked: true,
      });
      return;
    }
    const stored = labels[cidr];
    rows.push({
      cidr,
      label: stored?.label ?? '',
      purpose: stored?.purpose ?? 'other',
      locked: false,
    });
  };
  doAddresses.map(normalizeStored).forEach(push);
  natByCidr.forEach((_name, cidr) => push(cidr));
  return rows;
}

export interface ListDiff {
  added: string[];
  removed: string[];
  unchanged: string[];
}

export function diffLists(before: string[], after: string[]): ListDiff {
  const b = new Set(before.map(normalizeStored));
  const a = new Set(after.map(normalizeStored));
  return {
    added: [...a].filter(x => !b.has(x)),
    removed: [...b].filter(x => !a.has(x)),
    unchanged: [...a].filter(x => b.has(x)),
  };
}

export interface Validation {
  /** Block the save. */
  errors: string[];
  /** Need an explicit acknowledgement before saving. */
  warnings: string[];
}

export function validateDraft(
  entries: AllowEntry[],
  enabled: boolean,
  natIps: string[]
): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cidrs = entries.map(e => e.cidr);
  const dupes = cidrs.filter((c, i) => cidrs.indexOf(c) !== i);
  if (dupes.length) errors.push(`Duplicate entries: ${[...new Set(dupes)].join(', ')}.`);
  for (const e of entries) {
    const parsed = parseCidr(e.cidr);
    if (!parsed.ok) errors.push(`${e.cidr}: ${parsed.error}`);
  }
  if (entries.length > MAX_ENTRIES)
    errors.push(`DO allows at most ${MAX_ENTRIES} entries; this list has ${entries.length}.`);
  if (enabled) {
    if (entries.length === 0)
      errors.push('An enabled firewall with an empty list blocks everyone, including the nodes.');
    for (const ip of natIps) {
      if (!cidrs.includes(normalizeStored(ip))) {
        errors.push(
          `${normalizeStored(ip)} (NAT gateway) is missing; the nodes would go NotReady.`
        );
      }
    }
    if (natIps.length === 0) {
      warnings.push(
        "No NAT gateway was found for this cluster's VPC. If its nodes are isolated, they reach the API through one; make sure its IP is listed."
      );
    }
    if (!entries.some(e => e.purpose === 'management-host')) {
      warnings.push(
        'No entry is marked "Management host (Headlamp)". If this dashboard\'s egress IP is not listed, it loses access when you save.'
      );
    }
  } else {
    warnings.push(
      'Saving with the firewall disabled opens the Kubernetes API to the whole internet (token auth still applies).'
    );
  }
  return { errors, warnings };
}

export interface ClusterUpdateBody {
  name: string;
  control_plane_firewall: { enabled: boolean; allowed_addresses: string[] };
}

/** `name` is required by DO's cluster update schema; everything omitted is left unchanged. */
export function buildUpdateBody(
  clusterName: string,
  enabled: boolean,
  entries: AllowEntry[]
): ClusterUpdateBody {
  return {
    name: clusterName,
    control_plane_firewall: {
      enabled,
      allowed_addresses: entries.map(e => e.cidr),
    },
  };
}

/** Labels to persist: only rows still on the list, and only rows that carry something. */
export function labelsFor(entries: AllowEntry[]): LabelMap {
  const out: LabelMap = {};
  for (const e of entries) {
    if (e.label.trim() || e.purpose !== 'other')
      out[e.cidr] = { label: e.label.trim(), purpose: e.purpose };
  }
  return out;
}

/** Same set of addresses, order ignored (DO does not promise to keep order). */
export function sameAddresses(a: string[], b: string[]): boolean {
  const d = diffLists(a, b);
  return d.added.length === 0 && d.removed.length === 0;
}

/**
 * Pick the DO cluster behind the Headlamp cluster: DO's kubeconfig names the
 * context `do-<region>-<name>`; a bare cluster name also matches.
 */
export function matchDoCluster<T extends { name: string; region: string }>(
  headlampCluster: string | null,
  clusters: T[]
): T | null {
  if (!headlampCluster) return null;
  return (
    clusters.find(
      c => `do-${c.region}-${c.name}` === headlampCluster || c.name === headlampCluster
    ) ?? null
  );
}
