# cloudflare-tunnel (Headlamp plugin)

A Headlamp page for [cloudflare-tunnel-manager](../../backends/cloudflare-tunnel-manager), which
keeps a cluster's ONE Cloudflare Tunnel in step with its `TunnelRoute` objects. Install both,
with `cloudflared`, from [`deploy/`](../../deploy) in one apply; the page needs the manager.

**Where:** sidebar → **Cloudflare Tunnel** (`/c/<cluster>/cloudflare-tunnel`). Refreshes every 5 seconds.

Laid out like EasyPanel's Cloudflare Tunnel screen. Every action is an ordinary Kubernetes API
call with the signed-in person's own credentials (bind `cloudflare-tunnel-operator`, or be
`cluster-admin`). The browser never holds a saved Cloudflare token: it is written, never read.

| Section | What it does | Kubernetes API equivalent |
|---|---|---|
| **Cloudflare Tunnel** | State (Running / Starting / Degraded / Stopped), the tunnel's name and id, the manager's last error. **Start Tunnel** / **Stop Tunnel** scales `cloudflared` to 2 / 0 (Stop asks first). | `PATCH …/deployments/cloudflared/scale` |
| **Config → API Token** | **Connect** / **Replace token** writes the token. | `PATCH` (or `POST`) Secret `cloudflare-api`, `stringData.CLOUDFLARE_API_TOKEN` |
| **Config → Accounts / Account ID** | The accounts the token can act in (or type the id). | manager `GET /api/accounts` via `…/services/http:cloudflare-tunnel-manager:http/proxy` |
| **Config → Tunnels / Tunnel ID** | The account's tunnels, marked *this cluster* or *N routes elsewhere*, or **+ Create a new tunnel**. Picking a tunnel with someone else's routes shows them and requires **Replace its existing routes**. | manager `GET /api/tunnels?account=` |
| **Config → Save** | Saves the settings and runs a pass at once. | `PATCH` (or `POST`) ConfigMap `cloudflare-tunnel-settings`; manager `POST /api/reconcile` |
| **Cloudflare Tunnel Rules** | Each rule: `https://host` (open, copy) → `namespace/service:port`, its state (hover for the manager's message), **Edit**, **Remove** (asks first). | `GET/PATCH/DELETE …/tunnelroutes` |
| **Add Tunnel Rule** | Subdomain (empty = the domain itself, `*` = wildcard), Domain (the allowed zones), Service and Internal Port (picked from the cluster's Services), optional path, HTTPS to the Service. Refuses what the manager would mark Invalid. | `POST …/tunnelroutes` |

## Files

- `src/api.ts` — every API call (Kubernetes and the manager's), over an injected request
  function (tested in `api.test.ts`).
  Route validation is imported from the manager's `src/rules.ts`, so the form and the manager
  can never disagree.
- `src/index.tsx` — the page, sidebar entry and route.
- `src/headlamp-plugin.d.ts` — the parts of Headlamp's plugin API used here.
- `build.mjs` / `pluginlib-globals.mjs` — esbuild build mapping React, MUI and the plugin API to
  Headlamp's runtime `pluginLib` global (same toolchain as `do-firewall`: 78 packages, no
  `@kinvolk/headlamp-plugin` CLI).

```bash
npm ci && npm run tsc && npm run lint && npm test && npm run build   # dist/main.js + dist/package.json
```
