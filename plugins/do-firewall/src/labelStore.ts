/**
 * Labels and purposes for allowlist entries. DO stores only the addresses, so
 * the names live in the cluster itself: ConfigMap `do-firewall-labels` in the
 * `cluster-management` namespace, read and written through Headlamp with the
 * signed-in person's own Kubernetes credentials (their RBAC applies).
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import type { LabelMap, Purpose } from './model';

export const NAMESPACE = 'cluster-management';
export const CONFIGMAP = 'do-firewall-labels';
const DATA_KEY = 'entries.json';
const PURPOSES: Purpose[] = [
  'nat-gateway',
  'management-host',
  'workstation',
  'automation',
  'other',
];

function isNotFound(err: unknown): boolean {
  return (err as { status?: number })?.status === 404;
}

/** Ignores malformed data rather than failing the page: labels are descriptive only. */
export function parseLabels(json: string | undefined): LabelMap {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as {
      entries?: Record<string, { label?: unknown; purpose?: unknown }>;
    };
    const out: LabelMap = {};
    for (const [cidr, v] of Object.entries(parsed.entries ?? {})) {
      const purpose = PURPOSES.includes(v?.purpose as Purpose) ? (v.purpose as Purpose) : 'other';
      out[cidr] = {
        label: typeof v?.label === 'string' ? v.label.slice(0, 120) : '',
        purpose,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export async function readLabels(): Promise<LabelMap> {
  try {
    const cm = (await ApiProxy.request(`/api/v1/namespaces/${NAMESPACE}/configmaps/${CONFIGMAP}`)) as
      | { data?: Record<string, string | undefined> }
      | null;
    return parseLabels(cm?.data?.[DATA_KEY]);
  } catch (err) {
    if (isNotFound(err)) return {};
    throw err;
  }
}

/** Creates the namespace on first save, then applies the ConfigMap. */
export async function writeLabels(labels: LabelMap): Promise<void> {
  try {
    await ApiProxy.request(`/api/v1/namespaces/${NAMESPACE}`);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await ApiProxy.apply({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: NAMESPACE,
        // Holds only a ConfigMap; still enforce the restricted Pod Security Standard like
        // every other namespace, so nothing privileged can be scheduled into it later.
        labels: {
          'app.kubernetes.io/managed-by': 'headlamp-do-firewall',
          'pod-security.kubernetes.io/enforce': 'restricted',
          'pod-security.kubernetes.io/enforce-version': 'latest',
        },
      },
    });
  }
  await ApiProxy.apply({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: CONFIGMAP,
      namespace: NAMESPACE,
      labels: { 'app.kubernetes.io/managed-by': 'headlamp-do-firewall' },
    },
    data: {
      [DATA_KEY]: JSON.stringify({ version: 1, entries: labels }, null, 2),
    },
  });
}
