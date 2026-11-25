import { Utils } from '@kinvolk/headlamp-plugin/lib';
import { Loader, SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AllowlistTable } from './AllowlistTable';
import {
  DoCluster,
  getCluster,
  listClusters,
  NatEgress,
  natEgressForVpc,
  updateFirewall,
} from './doApi';
import { CONFIGMAP, NAMESPACE, readLabels, writeLabels } from './labelStore';
import {
  AllowEntry,
  buildUpdateBody,
  diffLists,
  labelsFor,
  matchDoCluster,
  mergeEntries,
  normalizeStored,
  sameAddresses,
  validateDraft,
} from './model';
import { ReviewDialog } from './ReviewDialog';
import { readToken, writeToken } from './tokenStore';
import { TokenPanel } from './TokenPanel';

const CHOICE_KEY = 'do-firewall.cluster';

function rememberChoice(headlampCluster: string | null, id?: string): string | null {
  try {
    const key = `${CHOICE_KEY}:${headlampCluster ?? ''}`;
    if (id) window.localStorage.setItem(key, id);
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

interface Loaded {
  cluster: DoCluster;
  /** Exactly what DO holds, normalized; the save compares against this. */
  doAddresses: string[];
  enabled: boolean;
  nat: NatEgress[];
  baseline: AllowEntry[];
  labelsError: string | null;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function FirewallPage() {
  const headlampCluster = Utils.getCluster();
  const [token, setToken] = useState(readToken);
  const [clusters, setClusters] = useState<DoCluster[] | null>(null);
  const [clusterId, setClusterId] = useState<string>('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [entries, setEntries] = useState<AllowEntry[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(0);
  const [saving, setSaving] = useState(false);

  const connect = (t: string) => {
    writeToken(t);
    setToken(t);
  };
  const forget = () => {
    writeToken('');
    setToken('');
    setClusters(null);
    setLoaded(null);
  };

  useEffect(() => {
    if (!token) return;
    setBusy(true);
    setError(null);
    listClusters(token)
      .then(list => {
        setClusters(list);
        const remembered = rememberChoice(headlampCluster);
        const pick =
          matchDoCluster(headlampCluster, list) ?? list.find(c => c.id === remembered) ?? null;
        setClusterId(pick?.id ?? '');
      })
      .catch(err => setError(message(err)))
      .finally(() => setBusy(false));
  }, [token, headlampCluster]);

  const load = useCallback(async () => {
    if (!token || !clusterId) return;
    setBusy(true);
    setError(null);
    try {
      const cluster = await getCluster(token, clusterId);
      const [nat, labelsResult] = await Promise.all([
        natEgressForVpc(token, cluster.vpc_uuid),
        readLabels().then(
          labels => ({ labels, labelsError: null as string | null }),
          err => ({ labels: {}, labelsError: message(err) })
        ),
      ]);
      const doAddresses = (cluster.control_plane_firewall?.allowed_addresses ?? []).map(
        normalizeStored
      );
      const baseline = mergeEntries(doAddresses, labelsResult.labels, nat);
      const fwEnabled = !!cluster.control_plane_firewall?.enabled;
      setLoaded({
        cluster,
        doAddresses,
        enabled: fwEnabled,
        nat,
        baseline,
        labelsError: labelsResult.labelsError,
      });
      setEntries(baseline);
      setEnabled(fwEnabled);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }, [token, clusterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const diff = useMemo(
    () =>
      diffLists(
        loaded?.doAddresses ?? [],
        entries.map(e => e.cidr)
      ),
    [loaded, entries]
  );
  const validation = useMemo(
    () =>
      validateDraft(
        entries,
        enabled,
        (loaded?.nat ?? []).map(n => n.ip)
      ),
    [entries, enabled, loaded]
  );
  const addressesChanged =
    !!loaded && (diff.added.length > 0 || diff.removed.length > 0 || enabled !== loaded.enabled);
  const dirty =
    !!loaded && (addressesChanged || JSON.stringify(entries) !== JSON.stringify(loaded.baseline));

  // Ctrl/Cmd+S opens the review.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && dirty) {
        e.preventDefault();
        setReviewOpen(n => n + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty]);

  const save = async () => {
    if (!loaded) return;
    setSaving(true);
    setError(null);
    try {
      if (addressesChanged) {
        // DO replaces the list wholesale: refuse to overwrite a change made elsewhere since this page loaded.
        const fresh = await getCluster(token, loaded.cluster.id);
        const freshAddrs = fresh.control_plane_firewall?.allowed_addresses ?? [];
        if (
          !sameAddresses(freshAddrs, loaded.doAddresses) ||
          !!fresh.control_plane_firewall?.enabled !== loaded.enabled
        ) {
          throw new Error(
            'The firewall was changed elsewhere after this page loaded. Reload, then re-apply your edits.'
          );
        }
        await updateFirewall(
          token,
          loaded.cluster.id,
          buildUpdateBody(loaded.cluster.name, enabled, entries)
        );
      }
      let labelNote = '';
      try {
        await writeLabels(labelsFor(entries));
      } catch (err) {
        labelNote = ` Labels were not saved to ${NAMESPACE}/${CONFIGMAP}: ${message(err)}`;
      }
      setReviewOpen(0);
      setNotice(
        (addressesChanged
          ? 'Saved to DigitalOcean. Firewall changes take effect within a few minutes.'
          : 'Labels saved.') + labelNote
      );
      await load();
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  };

  if (!token) {
    return (
      <SectionBox title="DigitalOcean control-plane firewall">
        <TokenPanel onToken={connect} />
      </SectionBox>
    );
  }

  const saved = new Set(loaded?.doAddresses ?? []);
  const removed = loaded
    ? loaded.baseline.filter(b => !entries.some(e => e.cidr === b.cidr)).map(b => b.cidr)
    : [];

  return (
    <SectionBox title="DigitalOcean control-plane firewall">
      <Stack spacing={2}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
          <TextField
            select
            size="small"
            label="DigitalOcean cluster"
            value={clusterId}
            sx={{ minWidth: 320 }}
            onChange={e => {
              setClusterId(e.target.value);
              rememberChoice(headlampCluster, e.target.value);
            }}
          >
            {(clusters ?? []).map(c => (
              <MenuItem key={c.id} value={c.id}>
                {c.name} ({c.region}, {c.version})
              </MenuItem>
            ))}
          </TextField>
          <Button onClick={() => void load()} disabled={busy || !clusterId}>
            Reload from DigitalOcean
          </Button>
          <Button color="inherit" onClick={forget}>
            Forget my token
          </Button>
        </Stack>

        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {notice && (
          <Alert severity="success" onClose={() => setNotice(null)}>
            {notice}
          </Alert>
        )}
        {clusters && !clusterId && (
          <Alert severity="info">
            No DigitalOcean cluster matched “{headlampCluster}”. Pick the cluster this dashboard is
            connected to.
          </Alert>
        )}
        {busy && !loaded && <Loader title="Reading the firewall from DigitalOcean" />}

        {loaded && (
          <>
            <Typography variant="body2" color="text.secondary">
              API endpoint <code>{loaded.cluster.endpoint}</code> · VPC{' '}
              <code>{loaded.cluster.vpc_uuid}</code> · NAT egress{' '}
              {loaded.nat.length
                ? loaded.nat.map(n => <code key={n.ip}>{n.ip} </code>)
                : 'none found'}
            </Typography>
            {loaded.labelsError && (
              <Alert severity="warning">
                Labels could not be read from {NAMESPACE}/{CONFIGMAP} ({loaded.labelsError}).
                Addresses are shown without them.
              </Alert>
            )}
            <FormControlLabel
              control={<Switch checked={enabled} onChange={e => setEnabled(e.target.checked)} />}
              label={
                enabled
                  ? 'Firewall enabled — only the addresses below reach the Kubernetes API'
                  : 'Firewall disabled — the Kubernetes API is reachable from anywhere'
              }
            />
            <AllowlistTable
              entries={entries}
              saved={saved}
              removed={removed}
              onChange={setEntries}
              onRestore={cidr => {
                const row = loaded.baseline.find(b => b.cidr === cidr);
                if (row) setEntries([...entries, row]);
              }}
            />
            <Stack direction="row" spacing={1}>
              <Button
                variant="contained"
                disabled={!dirty}
                onClick={() => setReviewOpen(n => n + 1)}
              >
                Review and save (Ctrl+S)
              </Button>
              <Button
                disabled={!dirty}
                onClick={() => {
                  setEntries(loaded.baseline);
                  setEnabled(loaded.enabled);
                }}
              >
                Discard changes
              </Button>
            </Stack>
            <ReviewDialog
              key={reviewOpen}
              open={reviewOpen > 0}
              clusterName={loaded.cluster.name}
              diff={diff}
              entries={entries}
              baseline={loaded.baseline}
              enabledBefore={loaded.enabled}
              enabledAfter={enabled}
              validation={validation}
              saving={saving}
              onCancel={() => setReviewOpen(0)}
              onConfirm={() => void save()}
            />
          </>
        )}
      </Stack>
    </SectionBox>
  );
}
