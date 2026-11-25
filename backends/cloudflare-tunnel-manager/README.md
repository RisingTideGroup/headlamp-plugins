# cloudflare-tunnel-manager

Keeps the cluster's **one** Cloudflare Tunnel in step with its `TunnelRoute` objects, so
nobody needs the Cloudflare dashboard to expose a service.

Each pass (every 30 s):

1. find the tunnel named `TUNNEL_NAME`, or create it (remotely managed);
2. write its token into Secret `cloudflared-token`, which the `cloudflared` Deployment runs with;
3. read every `TunnelRoute` in its namespace and build the tunnel's routes — exact hostnames
   before wildcards, longer first, a path before the same host without one, a 404 catch-all
   last;
4. make DNS match: create a proxied CNAME to the tunnel where none exists, delete its own
   records whose route is gone;
5. write each route's status: `Ready`, `Invalid` (bad hostname, zone or service) or
   `Conflict` (the hostname's DNS already points elsewhere — left untouched).

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

Settings (ConfigMap `cloudflare-tunnel-manager`; the token from Secret `cloudflare-api`):

| Env | Required | Meaning |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | yes | Account → Cloudflare Tunnel: Edit; Zone → Zone: Read, DNS: Edit (only the zones below) |
| `CLOUDFLARE_ACCOUNT_ID` | yes | The account the tunnel lives in |
| `TUNNEL_NAME` | yes | The cluster's tunnel. Unique per Cloudflare account: a tunnel that already has this name is **adopted** |
| `TUNNEL_ZONES` | yes | Comma-separated zones a route's hostname may use |
| `TOKEN_SECRET_NAME` | no | Default `cloudflared-token` |
| `RECONCILE_SECONDS` | no | Default `30` (minimum 10) |

The manager exits with `<NAME> is required` until the required ones are set.

- **Manifests:** [`deploy/cloudflare-tunnel-manager.yaml`](../../deploy/cloudflare-tunnel-manager.yaml),
  part of the one-apply bundle with `cloudflared` and Headlamp.
- **Image:** `ghcr.io/risingtidegroup/cloudflare-tunnel-manager`, built and published by this
  repo's workflow.
- **UI:** the Headlamp plugin [`plugins/cloudflare-tunnel`](../../plugins/cloudflare-tunnel)
  (start, stop and scale the tunnel; add and delete routes). The plugin's form and this manager
  share [`src/rules.ts`](src/rules.ts).
