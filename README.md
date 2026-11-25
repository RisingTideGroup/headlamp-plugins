# headlamp-plugins

Rising Tide's [Headlamp](https://headlamp.dev) plugins, and the Headlamp image built with them.

| Plugin | What it does |
|---|---|
| [`cloudflare-tunnel-manager`](plugins/cloudflare-tunnel-manager) | Sidebar → **Cloudflare Tunnel**: the cluster's tunnel (start, stop, scale the `cloudflared` connector) and its `TunnelRoute`s (list with state, add, delete). Needs [cloudflare-tunnel-manager](https://github.com/Network-Integration-Specialists-Inc/nis-mcp/tree/main/platform/cloudflare-tunnel-manager) in the cluster. |

## Deploy

[`deploy/`](deploy) installs Headlamp (this repo's image, every plugin included) and the
cluster's Cloudflare Tunnel (`cloudflared` + `cloudflare-tunnel-manager`) in one apply:

```bash
kubectl apply -f https://raw.githubusercontent.com/RisingTideGroup/headlamp-plugins/main/deploy/install.yaml
```

Then create the `cloudflare-api` Secret and a route for Headlamp. See [deploy/README.md](deploy/README.md).

## Images

Built by [`.github/workflows/build.yml`](.github/workflows/build.yml) on every push to `main`,
after every plugin's audit, typecheck, lint, tests and build pass:

| Image | Contents | Tags |
|---|---|---|
| `ghcr.io/risingtidegroup/headlamp` | Headlamp from [`headlamp.env`](headlamp.env) with every plugin here baked into `/headlamp/plugins` | `<HEADLAMP_TAG>` (moves), `<HEADLAMP_TAG>-<headlamp sha7>-<this repo sha7>` (pinned) |
| `ghcr.io/risingtidegroup/headlamp-plugins` | Every plugin under `/plugins/<name>/`, for an initContainer in any other Headlamp | `main`, `sha-<sha>` |

A change to any plugin, or to `headlamp.env`, rebuilds both. To build Headlamp from another
source (e.g. a Rising Tide fork), edit `headlamp.env`.

The first publish of each image creates a GHCR package; set its visibility to **public** once
(Organization → Packages → the package → Package settings).

## Add a plugin

1. `plugins/<name>/` with a `package.json` whose scripts include `build`, `tsc`, `lint` and
   `test` (`npx @kinvolk/headlamp-plugin create <name>` gives that shape).
2. Push. The workflow discovers it, checks it, and bakes it into the image.

## Develop

```bash
cd plugins/cloudflare-tunnel-manager
npm ci
npm run tsc && npm run lint && npm test && npm run build   # dist/main.js
npm start                                                  # hot reload into a running Headlamp
```

Plugins run in the browser only, with the signed-in person's own Kubernetes token and RBAC.
They hold no credentials and run no server-side code.
