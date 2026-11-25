# syntax=docker/dockerfile:1
# cloudflare-tunnel-manager — no runtime dependencies; Node 24 runs the TypeScript directly.
#   docker build -t cloudflare-tunnel-manager backends/cloudflare-tunnel-manager
FROM node:24-alpine
# Pending Alpine security fixes; and no package managers at runtime (nothing is installed:
# the manager has no dependencies), which also keeps their own dependency trees out of the scan.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/main.ts"]
