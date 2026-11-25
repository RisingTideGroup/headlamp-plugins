# do-firewall (Headlamp plugin)

Manage a DigitalOcean Kubernetes (DOKS) cluster's **control-plane firewall allowlist** from
Headlamp. DigitalOcean's control panel has no screen for it; otherwise it is API / `doctl` only.

**Where:**
- Inside a cluster: sidebar → **DO Firewall** (`/c/<cluster>/do-firewall`).
- Break-glass, no cluster needed: **Home → DO Firewall** (`/do-firewall`). Use it when the
  Headlamp host's IP has fallen off the allowlist and Headlamp can no longer reach the
  cluster: pick the DO cluster, add the IP, save. Labels live in the cluster, so they show a
  warning there and are not saved; the addresses are.

## Signing in

Paste your **own** DigitalOcean personal access token. It is kept in this browser tab only
(sessionStorage, cleared when the tab closes) and sent only to `api.digitalocean.com`, straight
from the browser (not through Headlamp's backend). **Forget my token** clears it immediately.

Create one at cloud.digitalocean.com → API → Tokens, with custom scopes:

| Scope | Used for |
|---|---|
| `kubernetes:read` | list clusters, read the firewall |
| `kubernetes:update` | save the allowlist |
| `nat_gateway:read` | find the NAT gateway the nodes egress through |

## What the page shows

- **DigitalOcean cluster**: chosen automatically when the Headlamp cluster name is DO's
  kubeconfig context (`do-<region>-<name>`) or the bare cluster name; otherwise pick it
  (remembered per Headlamp cluster in this browser).
- **API endpoint, VPC, NAT egress**: read from DO on open and on **Reload from DigitalOcean**.
- **Firewall enabled** switch: the cluster's current state.
- **Allowlist table**: every address DO holds, with its **Label** and **Purpose** (stored
  in-cluster; DO keeps only addresses). **Saved** = in DO now, **New** = only in your draft,
  **Locked** = the NAT gateway: the nodes reach the API through it, so it cannot be removed.
  A NAT IP missing from DO is added automatically so the next save repairs the list.
- **Add address or CIDR**: `203.0.113.7` becomes `203.0.113.7/32`. Enter adds.

| Purpose | Use for |
|---|---|
| NAT gateway (cluster nodes) | Set automatically; locked. |
| Management host (Headlamp) | The egress IP of the host running Headlamp. Without it this page loses access to the cluster when you save. |
| Workstation | A person's office/home IP (kubectl, doctl). |
| Automation / CI | Runners that call the Kubernetes API. |
| Other | Anything else. |

## Saving

**Review and save** (or **Ctrl+S**) opens the review: what is added, removed, kept, and whether
the firewall is enabled. DigitalOcean replaces the whole list on every save, so the final call
always sends the complete list.

The save is **blocked** when: an entry is not a public IPv4 address/CIDR (private, CGNAT
`100.64/10`, loopback, link-local, multicast, reserved, `/0`, or host bits set); the list has
duplicates or more than 500 entries; the firewall is enabled and the list is empty or misses the
NAT gateway IP.

It **asks for acknowledgement** when: no entry is marked *Management host*; no NAT gateway was
found; or the firewall would be saved disabled.

Before writing, the page re-reads the cluster from DO and stops if the list or the enabled state
changed since it loaded (someone else saved). Labels are written after the DO save, with your own
Kubernetes credentials; label-only edits skip the DO call. DO applies firewall changes within a
few minutes.

## Labels: Kubernetes access needed

Labels are kept in ConfigMap `do-firewall-labels` (key `entries.json`) in namespace
`cluster-management`, read and written with the signed-in person's own token. Reading needs `get`
on that ConfigMap; saving labels needs create/update on it, plus `get` on the namespace (and
`create` once, if it does not exist yet: the first save creates it). Without that access the
allowlist still works; labels show an error.

## Equivalent API / CLI

| Page action | DigitalOcean API | doctl |
|---|---|---|
| Read firewall | `GET /v2/kubernetes/clusters/{id}` → `control_plane_firewall` | `doctl kubernetes cluster get <id> -o json` |
| Read NAT egress | `GET /v2/vpc_nat_gateways` → `egresses.public_gateways[].ipv4` | `doctl compute vpc-nat-gateway list` |
| Save | `PUT /v2/kubernetes/clusters/{id}` with `{"name":…,"control_plane_firewall":{"enabled":…,"allowed_addresses":[…]}}` | `doctl kubernetes cluster update <id> --enable-control-plane-firewall --control-plane-firewall-allowed-addresses "a/32,b/32"` |
| Labels | — | `kubectl get configmap do-firewall-labels -n cluster-management -o yaml` |

## Develop

```bash
cd plugins/do-firewall
npm ci --ignore-scripts
npm run tsc      # strict TypeScript
npm run lint     # oxlint
npm test         # vitest (model.ts, the pluginLib mapping)
npm run build    # dist/main.js + dist/package.json, what the image ships
```

Built with **esbuild**, not the `@kinvolk/headlamp-plugin` CLI: that CLI pulls ~1,300 packages
(Storybook, eslint 8, recharts, …) into every build to produce one 21 kB file. This toolchain is
8 direct dev dependencies, none of which needs install scripts. `build.mjs` reproduces what
Headlamp needs from the CLI's output:

- React, MUI and Headlamp's plugin API are not bundled. Headlamp provides them at runtime as the
  `pluginLib` global, and `pluginlib-globals.mjs` maps the imports to it exactly as the CLI's
  `config/vite.config.mjs` does.
- `dist/package.json` declares `devDependencies["@kinvolk/headlamp-plugin"]` as the plugin-API
  level (`0.14.0`, Headlamp v0.46.0). Headlamp refuses a plugin without it (`filterSources` in its
  `frontend/src/plugin/index.ts`); nothing installs it.
- `src/headlamp-plugin.d.ts` types the plugin-API calls used. React 18 and MUI 5 types are pinned
  to what Headlamp v0.46.0 ships at runtime (two majors behind their latest for that reason). On a
  Headlamp upgrade (`headlamp.env`), re-check both and `PLUGIN_API_VERSION` in `build.mjs`.

**Lint is oxlint, not ESLint:** typescript-eslint (8.74) supports TypeScript `<6.1`, and this
plugin is on TypeScript 7. oxlint needs no `typescript` package. Config: `.oxlintrc.json`
(correctness rules, React hooks rules as errors). `react/set-state-in-effect` is off: the two
effects it flags load data from DigitalOcean when the token or cluster changes, which is what an
effect is for.
