import { describe, expect, it } from 'vitest';
import {
  AllowEntry,
  buildUpdateBody,
  diffLists,
  labelsFor,
  matchDoCluster,
  MAX_ENTRIES,
  mergeEntries,
  parseCidr,
  sameAddresses,
  validateDraft,
} from './model';

const row = (cidr: string, extra: Partial<AllowEntry> = {}): AllowEntry => ({
  cidr,
  label: '',
  purpose: 'other',
  locked: false,
  ...extra,
});

describe('parseCidr', () => {
  it('turns a bare address into /32', () => {
    expect(parseCidr(' 100.1.2.3 ')).toEqual({
      ok: true,
      cidr: '100.1.2.3/32',
    });
  });

  it('keeps a valid network CIDR', () => {
    expect(parseCidr('203.0.113.0/24')).toEqual({
      ok: true,
      cidr: '203.0.113.0/24',
    });
  });

  it('suggests the network form when host bits are set', () => {
    const r = parseCidr('203.0.113.7/24');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('203.0.113.0/24');
  });

  it.each([
    ['10.1.2.3', 'RFC 1918'],
    ['172.20.0.1', 'RFC 1918'],
    ['192.168.1.1', 'RFC 1918'],
    ['100.64.0.1', 'RFC 6598'],
    ['127.0.0.1', 'loopback'],
    ['169.254.1.1', 'link-local'],
    ['224.0.0.1', 'multicast'],
    ['8.0.0.0/5', 'RFC 1918'],
  ])('rejects non-public %s', (input, why) => {
    const r = parseCidr(input);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(why);
  });

  it('does not treat 100.0-100.63 or 100.128+ as carrier-grade NAT (100.64/10 starts at 100.64)', () => {
    expect(parseCidr('100.1.2.3').ok).toBe(true);
    expect(parseCidr('100.63.255.255').ok).toBe(true);
    expect(parseCidr('100.128.0.1').ok).toBe(true);
  });

  it.each([
    '',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '1.2.3.4/33',
    '1.2.3.4/0',
    '0.0.0.0/0',
    '::1',
    '1.2.3.4/24/1',
    'a.b.c.d',
  ])('rejects malformed %j', input => {
    expect(parseCidr(input).ok).toBe(false);
  });
});

describe('mergeEntries', () => {
  it('labels DO addresses from the store and locks the NAT row', () => {
    const rows = mergeEntries(
      ['100.1.2.3', '168.144.13.186/32', '146.190.0.10/32'],
      { '100.1.2.3/32': { label: 'Office', purpose: 'workstation' } },
      [{ ip: '146.190.0.10', name: 'sfo3-nat' }]
    );
    expect(rows).toEqual([
      {
        cidr: '100.1.2.3/32',
        label: 'Office',
        purpose: 'workstation',
        locked: false,
      },
      { cidr: '168.144.13.186/32', label: '', purpose: 'other', locked: false },
      {
        cidr: '146.190.0.10/32',
        label: 'NAT gateway sfo3-nat',
        purpose: 'nat-gateway',
        locked: true,
      },
    ]);
  });

  it("adds a NAT IP that DO's list is missing", () => {
    const rows = mergeEntries(['1.2.3.4/32'], {}, [{ ip: '146.190.0.10', name: 'nat' }]);
    expect(rows.map(r => r.cidr)).toEqual(['1.2.3.4/32', '146.190.0.10/32']);
    expect(rows[1].locked).toBe(true);
  });

  it('drops duplicates', () => {
    expect(mergeEntries(['1.2.3.4', '1.2.3.4/32'], {}, [])).toHaveLength(1);
  });
});

describe('diffLists', () => {
  it('compares in normalized form', () => {
    expect(diffLists(['1.2.3.4', '5.6.7.8/32'], ['1.2.3.4/32', '9.9.9.9/32'])).toEqual({
      added: ['9.9.9.9/32'],
      removed: ['5.6.7.8/32'],
      unchanged: ['1.2.3.4/32'],
    });
  });

  it('sameAddresses ignores order', () => {
    expect(sameAddresses(['1.2.3.4/32', '5.6.7.8/32'], ['5.6.7.8', '1.2.3.4'])).toBe(true);
    expect(sameAddresses(['1.2.3.4/32'], ['1.2.3.4/32', '5.6.7.8/32'])).toBe(false);
  });
});

describe('validateDraft', () => {
  const nat = ['146.190.0.10'];
  const good = [
    row('146.190.0.10/32', { purpose: 'nat-gateway', locked: true }),
    row('168.144.13.186/32', { purpose: 'management-host' }),
  ];

  it('passes a complete list', () => {
    expect(validateDraft(good, true, nat)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('blocks an enabled firewall without the NAT IP', () => {
    const v = validateDraft([good[1]], true, nat);
    expect(v.errors.join(' ')).toContain('146.190.0.10/32 (NAT gateway) is missing');
  });

  it('blocks an enabled empty list', () => {
    expect(validateDraft([], true, []).errors.join(' ')).toContain('empty list');
  });

  it('blocks duplicates and invalid rows', () => {
    const v = validateDraft([...good, row('168.144.13.186/32'), row('10.0.0.1/32')], true, nat);
    expect(v.errors.join(' ')).toContain('Duplicate entries: 168.144.13.186/32');
    expect(v.errors.join(' ')).toContain('10.0.0.1/32');
  });

  it(`blocks more than ${MAX_ENTRIES} entries`, () => {
    const many = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) =>
      row(`11.0.${Math.floor(i / 256)}.${i % 256}/32`)
    );
    expect(validateDraft(many, false, []).errors.join(' ')).toContain(`at most ${MAX_ENTRIES}`);
  });

  it('warns when no management host is marked', () => {
    expect(validateDraft([good[0]], true, nat).warnings.join(' ')).toContain('Management host');
  });

  it('warns when saving disabled', () => {
    expect(validateDraft(good, false, nat).warnings.join(' ')).toContain('whole internet');
  });
});

describe('buildUpdateBody / labelsFor', () => {
  it('sends the name and the complete list', () => {
    expect(
      buildUpdateBody('example-sfo3-cluster', true, [row('1.2.3.4/32'), row('5.6.7.0/24')])
    ).toEqual({
      name: 'example-sfo3-cluster',
      control_plane_firewall: {
        enabled: true,
        allowed_addresses: ['1.2.3.4/32', '5.6.7.0/24'],
      },
    });
  });

  it('stores labels only for rows that carry one', () => {
    expect(
      labelsFor([
        row('1.2.3.4/32', { label: ' Office ', purpose: 'workstation' }),
        row('5.6.7.8/32'),
      ])
    ).toEqual({ '1.2.3.4/32': { label: 'Office', purpose: 'workstation' } });
  });
});

describe('matchDoCluster', () => {
  const clusters = [
    { name: 'example-sfo3-cluster', region: 'sfo3' },
    { name: 'other', region: 'nyc1' },
  ];

  it('matches the do-<region>-<name> kubeconfig context', () => {
    expect(matchDoCluster('do-sfo3-example-sfo3-cluster', clusters)).toBe(clusters[0]);
  });

  it('matches a bare name and returns null otherwise', () => {
    expect(matchDoCluster('other', clusters)).toBe(clusters[1]);
    expect(matchDoCluster('nope', clusters)).toBeNull();
    expect(matchDoCluster(null, clusters)).toBeNull();
  });
});
