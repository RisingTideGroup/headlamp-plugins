# cloudflare-tunnel-manager (Headlamp plugin)

A Headlamp page for [cloudflare-tunnel-manager](https://github.com/Network-Integration-Specialists-Inc/nis-mcp/tree/main/platform/cloudflare-tunnel-manager),
which keeps a cluster's ONE Cloudflare Tunnel in step with its `TunnelRoute` objects.

**Where:** sidebar → **Cloudflare Tunnel** (`/c/<cluster>/cloudflare-tunnel`). The page refreshes every 5 seconds.

## What it shows and does

Every action is an ordinary Kubernetes API call made with the signed-in person's own token, so
what someone can see or change here is exactly what their RBAC allows. The plugin holds no
credential; the Cloudflare API token stays in the manager's Secret.

| Feature | What it does | Kubernetes API equivalent |
|---|---|---|
| Tunnel name, allowed zones | Read from the manager's ConfigMap (`TUNNEL_NAME`, `TUNNEL_ZONES`). | `GET /api/v1/namespaces/nis-ingress/configmaps/cloudflare-tunnel-manager` |
| Connector state | Stopped (0 replicas) / Starting (none ready) / Degraded (some ready) / Running (all ready). | `GET /apis/apps/v1/namespaces/nis-ingress/deployments/cloudflared` |
| Manager state | Ready replicas of the manager. | `GET /apis/apps/v1/namespaces/nis-ingress/deployments/cloudflare-tunnel-manager` |
| **Start / Scale** | Sets the connector's replicas (1–10, default 2). | `PATCH …/deployments/cloudflared/scale` `{"spec":{"replicas":n}}` |
| **Stop** | Scales the connector to 0 after a confirmation. Every hostname on the tunnel goes offline. | same, `replicas: 0` |
| Routes | Name, hostname, path, service, state (Ready / Invalid / Conflict / Pending) and the manager's message. | `GET /apis/tunnel.nis.opsorganizer.com/v1alpha1/namespaces/nis-ingress/tunnelroutes` |
| **Add route** | Name, hostname (in an allowed zone; `*.zone` for a wildcard), service (`http(s)://<svc>.<ns>.svc.cluster.local:<port>` or `http_status:404`), optional path regex. Refuses what the manager would mark Invalid. | `POST …/tunnelroutes` |
| **Delete** | Deletes the route after a confirmation; the manager removes the DNS record if it created it. | `DELETE …/tunnelroutes/<name>` |

Replica changes made here are reverted by a later `kubectl apply` of the manifests (which set
2), so change the manifest too if the new count should stay.

## RBAC the signed-in person needs

`get` on the ConfigMap and both Deployments in `nis-ingress`; `patch` on `deployments/scale`
to start/stop; `list`, `create`, `delete` on `tunnelroutes`.

## Files

- `src/api.ts` — every API call, over an injected request function (tested in `api.test.ts`).
- `src/rules.ts` — the manager's route rules, mirrored; keep in step with the manager's `src/plan.ts`.
- `src/index.tsx` — the page, sidebar entry and route.

## Dependency overrides

`package.json` overrides some of `@kinvolk/headlamp-plugin`'s build/test toolchain
(vitest and `@vitest/mocker` 4.1.12, webpack-dev-middleware, glob, minimatch, rimraf, i18next)
to versions without moderate-or-higher advisories. None of them ship in `main.js`. Drop each
override once a `@kinvolk/headlamp-plugin` release carries a fixed version itself.
