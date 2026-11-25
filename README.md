# headlamp-plugins

Rising Tide's [Headlamp](https://headlamp.dev) plugins, and the Headlamp image built with them.

| Plugin | What it does |
|---|---|
| [`cloudflare-tunnel-manager`](plugins/cloudflare-tunnel-manager) | Sidebar → **Cloudflare Tunnel**: the cluster's tunnel (start, stop, scale the `cloudflared` connector) and its `TunnelRoute`s (list with state, add, delete). Needs [cloudflare-tunnel-manager](https://github.com/Network-Integration-Specialists-Inc/nis-mcp/tree/main/platform/cloudflare-tunnel-manager) in the cluster. |
| [`do-firewall`](plugins/do-firewall) | Sidebar → **DO Firewall** (in a cluster and on the home screen): the DigitalOcean Kubernetes control-plane firewall allowlist, which DO's control panel does not show. Labels per address, NAT gateway locked, public-IPv4 validation, review before save. Needs each person's own DigitalOcean token. |

## Images

Built by [`.github/workflows/build.yml`](.github/workflows/build.yml). Every run (pull requests
included) checks each plugin (audit, typecheck, lint, tests, build), runs Headlamp's backend
tests on the exact commit being built, builds both images, starts Headlamp and requires it to
serve every plugin, and Trivy-scans both images (MEDIUM or higher fails). Only pushes to `main`
(or a manual run on `main`) publish:

| Image | Contents | Tags |
|---|---|---|
| `ghcr.io/risingtidegroup/headlamp` | Headlamp from [`headlamp.env`](headlamp.env) with every plugin here baked into `/headlamp/plugins` | `<HEADLAMP_TAG>` (moves), `<HEADLAMP_TAG>-<headlamp sha7>-<this repo sha7>` (pinned) |
| `ghcr.io/risingtidegroup/headlamp-plugins` | Every plugin under `/plugins/<name>/`, for an initContainer in any other Headlamp | `main`, `sha-<sha>` |

A change to any plugin, or to `headlamp.env`, rebuilds both. Headlamp comes from
[`RisingTideGroup/headlamp`](https://github.com/RisingTideGroup/headlamp) branch `rtg/main`:
upstream Headlamp `main` (unreleased) plus our fixes, listed in [`headlamp.env`](headlamp.env).
To pick up new upstream changes, sync the fork's `main`, rebase `rtg/main` onto it, then re-run
this workflow (Actions → Build → Run workflow); a moved `rtg/main` alone does not trigger a build.

The first publish of each image creates a GHCR package; set its visibility to **public** once
(Organization → Packages → the package → Package settings).

## Add a plugin

1. `plugins/<name>/` with a `package.json` whose scripts include `build`, `tsc`, `lint` and
   `test` (`npx @kinvolk/headlamp-plugin create <name>` gives that shape). `build` writes
   `dist/main.js`. The shipped `package.json` is `dist/package.json` if the build writes one,
   else the plugin's own; either must declare `devDependencies["@kinvolk/headlamp-plugin"]`
   (the plugin-API level), or Headlamp skips the plugin and the workflow fails.
2. Push. The workflow discovers it, checks it, and bakes it into the image.

## Develop

```bash
cd plugins/cloudflare-tunnel-manager
npm ci
npm run tsc && npm run lint && npm test && npm run build   # dist/main.js
npm start                                                  # hot reload into a running Headlamp
```

Plugins run in the browser only, with the signed-in person's own Kubernetes token and RBAC.
They run no server-side code and store no credentials in the image or the cluster.
`do-firewall` also takes the person's own DigitalOcean token, keeps it in that browser tab
only (sessionStorage) and sends it only to `api.digitalocean.com`.
