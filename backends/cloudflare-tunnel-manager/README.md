# cloudflare-tunnel-manager

Keeps the cluster's **one** Cloudflare Tunnel in step with its `TunnelRoute` objects, so
nobody needs the Cloudflare dashboard to expose a service.

Each pass (every 30 s, or right after a Save in Headlamp):

1. read its settings (ConfigMap `cloudflare-tunnel-settings`) and the API token (Secret
   `cloudflare-api`) — live, so changes need no restart; until both exist it reports what is
   missing and waits;
2. use the tunnel `TUNNEL_ID`, or find/create the one named `TUNNEL_NAME` (remotely managed);
3. **takeover guard:** a tunnel this cluster has never written that already routes hostnames
   (EasyPanel's, another cluster's) is left untouched unless `TUNNEL_ADOPT=replace`; checked
   before its token is written, so no `cloudflared` of ours joins it;
4. write its token into Secret `cloudflared-token` (annotated with the tunnel id: that is how
   it knows the tunnel is its own);
5. read every `TunnelRoute` and build the tunnel's routes — exact hostnames before wildcards,
   longer first, a path before the same host without one, a 404 catch-all last;
6. make DNS match: create a proxied CNAME to the tunnel where none exists, delete its own
   records whose route is gone;
7. write each route's status: `Ready`, `Invalid` (bad hostname, zone or service) or
   `Conflict` (the hostname's DNS already points elsewhere — left untouched).

It also serves a small API for the Headlamp plugin (status, and the accounts, tunnels and zones
the token can see, because api.cloudflare.com does not answer browsers); see `src/server.ts`.
The plugin reaches it only through the Kubernetes API server's service proxy.

Safety:
- **Services are cluster-internal only** (`http(s)://<svc>.<ns>.svc.cluster.local:<port>` or
  `http_status:404`), checked by the CRD and again here.
- **DNS ownership:** records it creates carry `managed-by: cloudflare-tunnel-manager`; it deletes
  only records with that comment that point at its tunnel. A hand-built record is never
  modified or removed.
- **Credentials:** the Cloudflare API token lives in Secret `cloudflare-api` and is used only
  by this process; its RBAC is limited to reading routes, writing their status, and one Secret.

Start or stop the tunnel by scaling `cloudflared` (0 = stopped).

```bash
npm test        # planning, reconcile and client tests — no network
npm run typecheck
```

Settings (written by the Headlamp plugin, or by kubectl; `src/settings.ts`):

| Where | Key | Meaning |
|---|---|---|
| Secret `cloudflare-api` | `CLOUDFLARE_API_TOKEN` | Account → Cloudflare Tunnel: Edit; Zone → Zone: Read, DNS: Edit |
| ConfigMap `cloudflare-tunnel-settings` | `CLOUDFLARE_ACCOUNT_ID` | The account the tunnel lives in |
| same | `TUNNEL_ID` or `TUNNEL_NAME` | An existing tunnel, or the name to find/create |
| same | `TUNNEL_ZONES` | Optional allowlist; empty = every zone the token can see |
| same | `TUNNEL_ADOPT` | `replace` = may take over a tunnel that already has routes |
| Deployment env | `TOKEN_SECRET_NAME`, `RECONCILE_SECONDS`, `PORT` | Defaults `cloudflared-token`, `30`, `8080` |

- **Manifests:** [`deploy/cloudflare-tunnel-manager.yaml`](../../deploy/cloudflare-tunnel-manager.yaml),
  part of the one-apply bundle with `cloudflared` and Headlamp.
- **Image:** `ghcr.io/risingtidegroup/cloudflare-tunnel-manager`, built and published by this
  repo's workflow.
- **UI:** the Headlamp plugin [`plugins/cloudflare-tunnel`](../../plugins/cloudflare-tunnel)
  (start, stop and scale the tunnel; add and delete routes). The plugin's form and this manager
  share [`src/rules.ts`](src/rules.ts).
