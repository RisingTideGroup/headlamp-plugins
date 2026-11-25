// Cloudflare Tunnel page for Headlamp: the cluster's ONE tunnel (start / stop / scale the
// cloudflared connector) and its TunnelRoutes (list with state, create, delete).
// All calls go through Headlamp's own API proxy with the signed-in person's token; see api.ts.

import { ApiProxy, registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import {
  Loader,
  NameValueTable,
  SectionBox,
  SimpleTable,
  StatusLabel,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  checkRoute,
  CONNECTOR,
  createRoute,
  deleteRoute,
  DeploymentState,
  getDeployment,
  getSettings,
  listRoutes,
  MANAGER,
  NAMESPACE,
  Request,
  RouteInput,
  scaleConnector,
  TunnelRoute,
  TunnelSettings,
  tunnelState,
  zoneOf,
} from './api';

const request: Request = (path, init) => ApiProxy.request(path, init ?? {});
const REFRESH_MS = 5000;

interface PageData {
  settings: TunnelSettings | null;
  connector: DeploymentState | null;
  manager: DeploymentState | null;
  routes: TunnelRoute[] | null;
  errors: string[];
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function load(): Promise<PageData> {
  const errors: string[] = [];
  const settle = async <T,>(what: string, p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch (e) {
      errors.push(`${what}: ${message(e)}`);
      return null;
    }
  };
  const [settings, connector, manager, routes] = await Promise.all([
    settle('settings', getSettings(request)),
    settle('cloudflared', getDeployment(request, CONNECTOR)),
    settle('manager', getDeployment(request, MANAGER)),
    settle('routes', listRoutes(request)),
  ]);
  return { settings, connector, manager, routes, errors };
}

function stateLabel(state: string) {
  const status =
    state === 'Ready' || state === 'Running'
      ? 'success'
      : state === 'Pending' || state === 'Starting' || state === 'Degraded'
      ? 'warning'
      : state === 'Stopped'
      ? ''
      : 'error';
  return <StatusLabel status={status}>{state}</StatusLabel>;
}

function TunnelCard(props: { data: PageData; onChanged: () => void }) {
  const { settings, connector, manager } = props.data;
  const [replicas, setReplicas] = React.useState('2');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const desired = connector?.replicas ?? 0;
  React.useEffect(() => {
    if (desired > 0) setReplicas(String(desired));
  }, [desired]);

  async function scale(n: number) {
    setBusy(true);
    setError(null);
    try {
      await scaleConnector(request, n);
      props.onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const state = connector ? tunnelState(connector) : null;
  return (
    <SectionBox title="Cloudflare Tunnel">
      <NameValueTable
        rows={[
          { name: 'Tunnel', value: settings?.tunnelName || '—' },
          { name: 'Allowed zones', value: settings?.zones.join(', ') || '—' },
          {
            name: 'Connector (cloudflared)',
            value: connector ? (
              <Box display="flex" alignItems="center" gap={1}>
                {stateLabel(state!)}
                <Typography variant="body2">
                  {connector.ready}/{connector.replicas} ready
                </Typography>
              </Box>
            ) : (
              '—'
            ),
          },
          {
            name: 'Manager',
            value: manager ? (
              <Box display="flex" alignItems="center" gap={1}>
                {stateLabel(manager.ready > 0 ? 'Running' : 'Stopped')}
                <Typography variant="body2">
                  {manager.ready}/{manager.replicas} ready
                </Typography>
              </Box>
            ) : (
              '—'
            ),
          },
        ]}
      />
      <Box display="flex" alignItems="center" gap={1} mt={2}>
        <TextField
          size="small"
          label="Connector replicas"
          type="number"
          value={replicas}
          onChange={e => setReplicas(e.target.value)}
          inputProps={{ min: 1, max: 10 }}
          sx={{ width: 170 }}
        />
        <Button
          variant="contained"
          disabled={busy || !connector}
          onClick={() => scale(Number(replicas))}
        >
          {connector && connector.replicas > 0 ? 'Scale' : 'Start'}
        </Button>
        <Button
          variant="outlined"
          color="error"
          disabled={busy || !connector || connector.replicas === 0}
          onClick={() => {
            if (window.confirm('Stop the tunnel? Every hostname on it goes offline until it is started again.')) {
              scale(0);
            }
          }}
        >
          Stop
        </Button>
      </Box>
      {error && (
        <Typography color="error" variant="body2" mt={1}>
          {error}
        </Typography>
      )}
    </SectionBox>
  );
}

const EMPTY: RouteInput = { name: '', hostname: '', service: '', path: '' };

function AddRouteDialog(props: { open: boolean; zones: string[]; onClose: (changed: boolean) => void }) {
  const [input, setInput] = React.useState<RouteInput>(EMPTY);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (props.open) {
      setInput(EMPTY);
      setError(null);
    }
  }, [props.open]);

  const problem = input.name || input.hostname || input.service ? checkRoute(input, props.zones) : null;
  const zone = input.hostname ? zoneOf(input.hostname, props.zones) : null;
  const set = (k: keyof RouteInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setInput({ ...input, [k]: e.target.value });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await createRoute(request, input, props.zones);
      props.onClose(true);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={props.open} onClose={() => props.onClose(false)} maxWidth="sm" fullWidth>
      <DialogTitle>Add a route</DialogTitle>
      <DialogContent>
        <Box display="flex" flexDirection="column" gap={2} mt={1}>
          <TextField label="Name" value={input.name} onChange={set('name')} helperText="e.g. portal" />
          <TextField
            label="Hostname"
            value={input.hostname}
            onChange={set('hostname')}
            helperText={zone ? `zone ${zone}` : `in one of: ${props.zones.join(', ') || '(none configured)'}; *.zone for a wildcard`}
          />
          <TextField
            label="Service"
            value={input.service}
            onChange={set('service')}
            helperText="http://<service>.<namespace>.svc.cluster.local:<port>, or http_status:404"
          />
          <TextField label="Path (optional)" value={input.path} onChange={set('path')} helperText="regular expression, e.g. ^/api" />
          {(error || problem) && (
            <Typography color="error" variant="body2">
              {error || problem}
            </Typography>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => props.onClose(false)}>Cancel</Button>
        <Button variant="contained" disabled={busy || !!problem || !input.name} onClick={save}>
          Add
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function RoutesCard(props: { data: PageData; onChanged: () => void }) {
  const [adding, setAdding] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function remove(r: TunnelRoute) {
    if (!window.confirm(`Delete route ${r.name} (${r.hostname})? Its DNS record is removed if the manager created it.`)) return;
    setError(null);
    try {
      await deleteRoute(request, r.name);
      props.onChanged();
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <SectionBox
      title="Routes"
      headerProps={{
        actions: [
          <Button key="add" variant="contained" onClick={() => setAdding(true)} disabled={!props.data.settings}>
            Add route
          </Button>,
        ],
      }}
    >
      <SimpleTable
        data={props.data.routes}
        emptyMessage="No routes yet."
        errorMessage={props.data.routes === null ? 'Routes could not be read.' : null}
        columns={[
          { label: 'Name', getter: (r: TunnelRoute) => r.name, sort: true },
          { label: 'Hostname', getter: (r: TunnelRoute) => r.hostname, sort: true },
          { label: 'Path', getter: (r: TunnelRoute) => r.path ?? '' },
          { label: 'Service', getter: (r: TunnelRoute) => r.service },
          { label: 'State', getter: (r: TunnelRoute) => stateLabel(r.state) },
          { label: 'Message', getter: (r: TunnelRoute) => r.message },
          {
            label: '',
            getter: (r: TunnelRoute) => (
              <Button size="small" color="error" onClick={() => remove(r)}>
                Delete
              </Button>
            ),
          },
        ]}
      />
      {error && (
        <Typography color="error" variant="body2" mt={1}>
          {error}
        </Typography>
      )}
      <AddRouteDialog
        open={adding}
        zones={props.data.settings?.zones ?? []}
        onClose={changed => {
          setAdding(false);
          if (changed) props.onChanged();
        }}
      />
    </SectionBox>
  );
}

function TunnelPage() {
  const [data, setData] = React.useState<PageData | null>(null);
  const refresh = React.useCallback(() => {
    load().then(setData);
  }, []);

  React.useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (!data) return <Loader title="Loading the Cloudflare Tunnel" />;
  return (
    <>
      {data.errors.length > 0 && (
        <SectionBox>
          {data.errors.map(e => (
            <Typography key={e} color="error" variant="body2">
              {e}
            </Typography>
          ))}
          <Typography variant="body2">
            Is cloudflare-tunnel-manager installed in {NAMESPACE} (deploy/install.yaml), and may your account read it?
          </Typography>
        </SectionBox>
      )}
      <TunnelCard data={data} onChanged={refresh} />
      <RoutesCard data={data} onChanged={refresh} />
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
