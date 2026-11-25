// Cloudflare Tunnel page for Headlamp, laid out like EasyPanel's: the tunnel (start / stop),
// its Config (API token → account → tunnel), and its rules (hostname → cluster Service:port).
// All calls go through Headlamp's API proxy with the signed-in person's own token; see api.ts.

import { ApiProxy, registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { Loader, SectionBox, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CfTunnel,
  checkRule,
  createRule,
  DEFAULT_REPLICAS,
  deleteRule,
  DeploymentState,
  getConnector,
  getStatus,
  hostnameOf,
  listAccounts,
  listRoutes,
  listServices,
  listTunnels,
  listZones,
  ManagerStatus,
  Named,
  NAMESPACE,
  parseServiceUrl,
  reconcileNow,
  Request,
  RuleInput,
  saveSettings,
  saveToken,
  scaleConnector,
  ServiceRef,
  serviceUrl,
  splitHostname,
  TunnelRoute,
  tunnelState,
  updateRule,
} from './api';

const request: Request = (path, init) => ApiProxy.request(path, init ?? {});
const REFRESH_MS = 5000;
const NEW_TUNNEL = '__new__';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function stateLabel(state: string, title?: string) {
  const status =
    state === 'Ready' || state === 'Running'
      ? 'success'
      : state === 'Pending' || state === 'Starting' || state === 'Degraded'
      ? 'warning'
      : state === 'Stopped'
      ? ''
      : 'error';
  return (
    <StatusLabel status={status} title={title}>
      {state}
    </StatusLabel>
  );
}

// --- Tunnel: start / stop -------------------------------------------------------------------

function TunnelCard(props: {
  status: ManagerStatus | null;
  connector: DeploymentState | null;
  onChanged: () => void;
}) {
  const { status, connector } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = !!connector && connector.replicas > 0;

  async function toggle() {
    if (running && !window.confirm('Stop the tunnel? Every hostname on it goes offline until it is started again.')) return;
    setBusy(true);
    setError(null);
    try {
      await scaleConnector(request, running ? 0 : DEFAULT_REPLICAS);
      props.onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const pass = status?.lastPass;
  return (
    <SectionBox title="Cloudflare Tunnel">
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
          {connector ? stateLabel(tunnelState(connector)) : stateLabel('Unknown')}
          <Typography variant="body2">
            {pass?.tunnel ? (
              <>
                Tunnel <strong>{pass.tunnel.name}</strong> <code>{pass.tunnel.id}</code>
              </>
            ) : (
              'No tunnel yet: complete the Config below.'
            )}
          </Typography>
          {connector && (
            <Typography variant="body2" color="text.secondary">
              connectors {connector.ready}/{connector.replicas} ready
            </Typography>
          )}
        </Stack>
        {status && !status.configured && (
          <Alert severity="info">Not configured yet: {status.missing.join(', ')}.</Alert>
        )}
        {status?.configured && pass && !pass.ok && <Alert severity="error">{pass.error}</Alert>}
        <Button variant="outlined" fullWidth onClick={toggle} disabled={busy || !connector}>
          {running ? 'Stop Tunnel' : 'Start Tunnel'}
        </Button>
        {error && <Alert severity="error">{error}</Alert>}
      </Stack>
    </SectionBox>
  );
}

// --- Config: token → account → tunnel ---------------------------------------------------------

function ConfigCard(props: { status: ManagerStatus; onSaved: () => void }) {
  const saved = props.status.settings;
  const [token, setToken] = useState('');
  const [accounts, setAccounts] = useState<Named[] | null>(null);
  const [accountId, setAccountId] = useState(saved.accountId);
  const [tunnels, setTunnels] = useState<CfTunnel[] | null>(null);
  const [tunnelChoice, setTunnelChoice] = useState(saved.tunnelId || (saved.tunnelName ? NEW_TUNNEL : ''));
  const [newName, setNewName] = useState(saved.tunnelName);
  const [adopt, setAdopt] = useState(saved.adopt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tokenSet = props.status.tokenSet;

  const loadAccounts = useCallback(async () => {
    setError(null);
    try {
      const list = await listAccounts(request);
      setAccounts(list);
      setAccountId(current => current || (list.length === 1 ? list[0].id : ''));
    } catch (e) {
      setAccounts([]);
      setError(`Accounts could not be listed (${message(e)}). You can still type the Account ID.`);
    }
  }, []);

  useEffect(() => {
    if (tokenSet) void loadAccounts();
  }, [tokenSet, loadAccounts]);

  useEffect(() => {
    if (!tokenSet || !/^[0-9a-f]{32}$/.test(accountId)) {
      setTunnels(null);
      return;
    }
    let live = true;
    listTunnels(request, accountId)
      .then(list => live && setTunnels(list))
      .catch(e => live && (setTunnels([]), setError(`Tunnels could not be listed: ${message(e)}`)));
    return () => {
      live = false;
    };
  }, [tokenSet, accountId]);

  async function connectToken() {
    setBusy(true);
    setError(null);
    try {
      await saveToken(request, token);
      setToken('');
      setNotice('Token saved.');
      props.onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const picked = tunnels?.find(t => t.id === tunnelChoice) ?? null;
  const foreign = picked && !picked.owned && picked.hostnames.length > 0 ? picked : null;
  const nameOk = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(newName.trim());
  const canSave =
    tokenSet &&
    /^[0-9a-f]{32}$/.test(accountId) &&
    (tunnelChoice === NEW_TUNNEL ? nameOk : !!picked) &&
    (!foreign || adopt) &&
    !busy;

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (token.trim()) await saveToken(request, token);
      await saveSettings(request, {
        accountId,
        tunnelId: tunnelChoice === NEW_TUNNEL ? '' : tunnelChoice,
        tunnelName: tunnelChoice === NEW_TUNNEL ? newName : '',
        adopt: !!foreign && adopt,
      });
      setToken('');
      const s = await reconcileNow(request);
      setNotice(
        s.lastPass?.ok ? `Saved. Tunnel ${s.lastPass.tunnel?.name ?? ''} is in step.` : `Saved. The manager reports: ${s.lastPass?.error ?? 'pending'}`
      );
      props.onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionBox title="Config">
      <Stack spacing={2}>
        <Stack direction="row" spacing={2} justifyContent="flex-end">
          <Link href="https://developers.cloudflare.com/fundamentals/api/get-started/create-token/" target="_blank" rel="noopener noreferrer">
            How to get an API token?
          </Link>
          <Link href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/" target="_blank" rel="noopener noreferrer">
            What is a tunnel?
          </Link>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <TextField
            label="API Token"
            type="password"
            autoComplete="off"
            fullWidth
            size="small"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder={tokenSet ? 'Saved (hidden). Enter a new token to replace it.' : ''}
            helperText="Permissions: Account → Cloudflare Tunnel: Edit; Zone → Zone: Read, DNS: Edit. Stored in Secret cloudflare-api; never shown again."
          />
          <Button variant="outlined" onClick={connectToken} disabled={busy || !token.trim()} sx={{ whiteSpace: 'nowrap', mt: 0.5 }}>
            {tokenSet ? 'Replace token' : 'Connect'}
          </Button>
        </Stack>

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          <TextField
            select
            label="Accounts"
            size="small"
            fullWidth
            disabled={!tokenSet || !accounts?.length}
            value={accounts?.some(a => a.id === accountId) ? accountId : ''}
            onChange={e => {
              setAccountId(e.target.value);
              setTunnelChoice('');
            }}
          >
            {(accounts ?? []).map(a => (
              <MenuItem key={a.id} value={a.id}>
                {a.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Account ID"
            size="small"
            fullWidth
            disabled={!tokenSet}
            value={accountId}
            onChange={e => setAccountId(e.target.value.trim().toLowerCase())}
          />
        </Stack>

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          <TextField
            select
            label="Tunnels"
            size="small"
            fullWidth
            disabled={!tunnels}
            value={tunnelChoice === NEW_TUNNEL || tunnels?.some(t => t.id === tunnelChoice) ? tunnelChoice : ''}
            onChange={e => {
              setTunnelChoice(e.target.value);
              setAdopt(false);
            }}
          >
            <MenuItem value={NEW_TUNNEL}>+ Create a new tunnel</MenuItem>
            {(tunnels ?? []).map(t => (
              <MenuItem key={t.id} value={t.id}>
                {t.name}
                {t.owned ? ' (this cluster)' : t.hostnames.length ? ` (${t.hostnames.length} routes elsewhere)` : ''}
                {t.status ? ` · ${t.status}` : ''}
              </MenuItem>
            ))}
          </TextField>
          {tunnelChoice === NEW_TUNNEL ? (
            <TextField
              label="New tunnel name"
              size="small"
              fullWidth
              value={newName}
              error={!!newName && !nameOk}
              helperText="Unique in the account, e.g. prod-nyc1"
              onChange={e => setNewName(e.target.value)}
            />
          ) : (
            <TextField label="Tunnel ID" size="small" fullWidth disabled value={picked?.id ?? ''} />
          )}
        </Stack>

        {foreign && (
          <Alert severity="warning">
            <strong>{foreign.name}</strong> already routes {foreign.hostnames.length} hostname(s) that this cluster did not
            create ({foreign.hostnames.slice(0, 6).join(', ')}
            {foreign.hostnames.length > 6 ? ', …' : ''}). Using it REPLACES all of them with this cluster's rules, and this
            cluster's cloudflared joins it. For anything already in use (EasyPanel, another cluster), create a new tunnel
            instead.
            <FormControlLabel
              control={<Checkbox checked={adopt} onChange={e => setAdopt(e.target.checked)} />}
              label={`Replace ${foreign.name}'s ${foreign.hostnames.length} existing route(s)`}
            />
          </Alert>
        )}

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
        <Box>
          <Button variant="contained" color="success" onClick={save} disabled={!canSave}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </Box>
      </Stack>
    </SectionBox>
  );
}

// --- Rules -----------------------------------------------------------------------------------

function RuleDialog(props: {
  open: boolean;
  editing: TunnelRoute | null;
  zones: string[];
  services: ServiceRef[] | null;
  taken: string[];
  onClose: (changed: boolean) => void;
}) {
  const { editing, zones, services } = props;
  const initial = useMemo(() => {
    const split = editing ? splitHostname(editing.hostname, zones) : { subdomain: '', zone: zones[0] ?? '' };
    const svc = editing ? parseServiceUrl(editing.service) : null;
    return {
      subdomain: split.subdomain,
      zone: split.zone,
      service: svc ? `${svc.namespace}/${svc.name}` : '',
      port: svc ? String(svc.port) : '',
      https: svc?.https ?? false,
      path: editing?.path ?? '',
    };
  }, [editing, zones]);
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (props.open) {
      setForm(initial);
      setError(null);
    }
  }, [props.open, initial]);

  const svc = services?.find(s => `${s.namespace}/${s.name}` === form.service) ?? null;
  const rule: RuleInput | null =
    form.zone && svc && form.port
      ? {
          hostname: hostnameOf(form.subdomain, form.zone),
          service: serviceUrl(svc.namespace, svc.name, Number(form.port), form.https),
          path: form.path,
        }
      : null;
  const problem = rule ? checkRule(rule, zones) : null;

  async function submit() {
    if (!rule) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) await updateRule(request, editing.name, rule, zones);
      else await createRule(request, rule, zones, props.taken);
      await reconcileNow(request).catch(() => undefined);
      props.onClose(true);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={props.open} onClose={() => props.onClose(false)} maxWidth="sm" fullWidth>
      <DialogTitle>{editing ? 'Edit Tunnel Rule' : 'Create Tunnel Rule'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Subdomain"
            size="small"
            value={form.subdomain}
            helperText="Empty for the domain itself; * for every subdomain."
            onChange={e => setForm({ ...form, subdomain: e.target.value })}
          />
          <TextField select label="Domain" size="small" value={form.zone} onChange={e => setForm({ ...form, zone: e.target.value })}>
            {zones.map(z => (
              <MenuItem key={z} value={z}>
                {z}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Service"
            size="small"
            value={svc ? form.service : ''}
            disabled={!services}
            helperText={services ? 'The cluster Service traffic goes to.' : 'Loading Services…'}
            onChange={e => {
              const next = services?.find(s => `${s.namespace}/${s.name}` === e.target.value);
              setForm({ ...form, service: e.target.value, port: next?.ports.length === 1 ? String(next.ports[0].port) : '' });
            }}
          >
            {(services ?? []).map(s => (
              <MenuItem key={`${s.namespace}/${s.name}`} value={`${s.namespace}/${s.name}`}>
                {s.namespace} / {s.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Internal Port"
            size="small"
            value={svc?.ports.some(p => String(p.port) === form.port) ? form.port : ''}
            disabled={!svc}
            onChange={e => setForm({ ...form, port: e.target.value })}
          >
            {(svc?.ports ?? []).map(p => (
              <MenuItem key={p.port} value={String(p.port)}>
                {p.port}
                {p.name ? ` (${p.name})` : ''}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Path (optional)"
            size="small"
            value={form.path}
            helperText="A regular expression, e.g. ^/api"
            onChange={e => setForm({ ...form, path: e.target.value })}
          />
          <FormControlLabel
            control={<Checkbox checked={form.https} onChange={e => setForm({ ...form, https: e.target.checked })} />}
            label="The Service speaks HTTPS"
          />
          {rule && (
            <Typography variant="body2" color="text.secondary">
              https://{rule.hostname}
              {form.path ? ` (${form.path})` : ''} → {rule.service}
            </Typography>
          )}
          {(error || problem) && <Alert severity="error">{error || problem}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => props.onClose(false)}>Cancel</Button>
        <Button variant="contained" color="success" disabled={!rule || !!problem || busy} onClick={submit}>
          {editing ? 'Save' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function RulesCard(props: { routes: TunnelRoute[] | null; status: ManagerStatus; onChanged: () => void }) {
  const [dialog, setDialog] = useState<{ open: boolean; editing: TunnelRoute | null }>({ open: false, editing: null });
  const [services, setServices] = useState<ServiceRef[] | null>(null);
  const [zones, setZones] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const passZones = props.status.lastPass?.zones;
  const accountId = props.status.settings.accountId;

  useEffect(() => {
    if (passZones?.length) {
      setZones(passZones);
      return;
    }
    if (!props.status.tokenSet || !/^[0-9a-f]{32}$/.test(accountId)) return;
    let live = true;
    listZones(request, accountId)
      .then(z => live && setZones(z.map(x => x.name)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [passZones, props.status.tokenSet, accountId]);

  function open(editing: TunnelRoute | null) {
    setDialog({ open: true, editing });
    if (!services) listServices(request).then(setServices, e => setError(`Services could not be listed: ${message(e)}`));
  }

  async function remove(r: TunnelRoute) {
    if (!window.confirm(`Remove https://${r.hostname}? Its DNS record is deleted if the manager created it.`)) return;
    setError(null);
    try {
      await deleteRule(request, r.name);
      await reconcileNow(request).catch(() => undefined);
      props.onChanged();
    } catch (e) {
      setError(message(e));
    }
  }

  const routes = props.routes ?? [];
  return (
    <SectionBox title="Cloudflare Tunnel Rules">
      <Stack spacing={1}>
        {props.routes === null && <Loader title="Loading rules" />}
        {routes.map(r => {
          const url = `https://${r.hostname.replace(/^\*\./, 'x.')}`;
          const svc = parseServiceUrl(r.service);
          return (
            <Stack key={r.name} direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'center' }}>
              <Tooltip title="Open">
                <span>
                  <IconButton
                    size="small"
                    aria-label={`Open ${r.hostname}`}
                    disabled={r.hostname.startsWith('*.')}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    ↗
                  </IconButton>
                </span>
              </Tooltip>
              <TextField
                size="small"
                fullWidth
                value={`https://${r.hostname}${r.path ? ` ${r.path}` : ''}`}
                InputProps={{
                  readOnly: true,
                  endAdornment: (
                    <Tooltip title="Copy">
                      <IconButton
                        size="small"
                        aria-label={`Copy ${r.hostname}`}
                        onClick={() => void navigator.clipboard?.writeText(`https://${r.hostname}`)}
                      >
                        ⧉
                      </IconButton>
                    </Tooltip>
                  ),
                }}
              />
              <Typography sx={{ px: 1 }}>→</Typography>
              <TextField
                size="small"
                sx={{ minWidth: 260 }}
                value={svc ? `${svc.namespace}/${svc.name}:${svc.port}` : r.service}
                InputProps={{ readOnly: true }}
              />
              {stateLabel(r.state, r.message)}
              <Button onClick={() => open(r)}>Edit</Button>
              <Button color="error" onClick={() => remove(r)}>
                Remove
              </Button>
            </Stack>
          );
        })}
        {props.routes !== null && routes.length === 0 && (
          <Typography color="text.secondary">No rules yet.</Typography>
        )}
        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        <Button variant="outlined" fullWidth onClick={() => open(null)} disabled={zones.length === 0}>
          Add Tunnel Rule
        </Button>
        {zones.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            Domains appear once the API token and account are saved.
          </Typography>
        )}
      </Stack>
      <RuleDialog
        open={dialog.open}
        editing={dialog.editing}
        zones={zones}
        services={services}
        taken={routes.map(r => r.name)}
        onClose={changed => {
          setDialog({ open: false, editing: null });
          if (changed) props.onChanged();
        }}
      />
    </SectionBox>
  );
}

// --- the page --------------------------------------------------------------------------------

function TunnelPage() {
  const [status, setStatus] = useState<ManagerStatus | null>(null);
  const [connector, setConnector] = useState<DeploymentState | null>(null);
  const [routes, setRoutes] = useState<TunnelRoute[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getStatus(request).then(
      s => (setStatus(s), setProblem(null)),
      e =>
        setProblem(
          `The manager did not answer (${message(e)}). Is cloudflare-tunnel-manager running in ${NAMESPACE} (deploy/install.yaml), and may your account use services/proxy there?`
        )
    );
    getConnector(request).then(setConnector, () => setConnector(null));
    listRoutes(request).then(setRoutes, () => setRoutes([]));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (!status && !problem) return <Loader title="Loading the Cloudflare Tunnel" />;
  return (
    <>
      {problem && (
        <SectionBox>
          <Alert severity="error">{problem}</Alert>
        </SectionBox>
      )}
      <TunnelCard status={status} connector={connector} onChanged={refresh} />
      {status && <ConfigCard key={`${status.settings.accountId}/${status.settings.tunnelId}/${status.settings.tunnelName}`} status={status} onSaved={refresh} />}
      {status && <RulesCard routes={routes} status={status} onChanged={refresh} />}
    </>
  );
}

registerSidebarEntry({
  parent: null,
  name: 'cloudflare-tunnel',
  label: 'Cloudflare Tunnel',
  url: '/cloudflare-tunnel',
  icon: 'mdi:cloud-lock-outline',
});

registerRoute({
  path: '/cloudflare-tunnel',
  sidebar: 'cloudflare-tunnel',
  name: 'cloudflare-tunnel',
  exact: true,
  component: () => <TunnelPage />,
});
