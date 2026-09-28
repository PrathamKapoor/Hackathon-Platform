# syntax=docker/dockerfile:1
#
# Two stages, and the split is not about image size — it is about what ends up
# in the runtime layer. The build stage needs the full workspace (every
# devDependency, the test files, the TypeScript compiler). The runtime stage
# needs the compiled web bundle, the API source, and production dependencies
# for exactly two workspaces. Shipping the test suite into production would
# hand anyone who can pull the image a working copy of the acceptance harness.

# ------------------------------------------------------------------ build

FROM node:24-bookworm-slim AS build
WORKDIR /app

# Manifests first: dependency installation is cached until a manifest changes,
# which is the difference between a two-second and a two-minute rebuild.
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# `npm ci` when a lockfile is present, `npm install` otherwise, so the image
# builds from a fresh clone that has never had dependencies installed.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.base.json tsconfig.check.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

RUN npm run build

# Prune to what the server actually loads. The API runs TypeScript directly
# through Node's type stripping, so there is no compile step to keep here — but
# the dev dependencies still have to go.
RUN npm prune --omit=dev

# ---------------------------------------------------------------- runtime

FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# `tini` is PID 1 and Node is its child. tini forwards SIGTERM to the process
# group and reaps zombies, so `docker compose down` reaches the graceful drain
# in `server.ts` (which needs more than the 10s Docker would allow by default —
# see `stop_grace_period` in docker-compose.yml) instead of being SIGKILLed.
RUN apt-get update \
  && apt-get install --no-install-recommends --yes tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATABASE_FILE=/data/verdict.db \
    STORAGE_DIR=/data/uploads \
    WEB_DIST_DIR=/app/apps/web/dist

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/core ./packages/core
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist

# The database and uploaded files live on a volume, never in the image layer.
# Everything the platform knows has to survive `docker compose down -v` being
# typed with a stray flag.
RUN mkdir -p /data/uploads && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 8080

# Readiness, not liveness.
#
# This deliberately probes /api/ready and not /api/health. /api/health answers
# 200 with `status: "degraded"` when the database is unreadable — that is
# correct for a *liveness* probe, whose job is to say "the process is not
# wedged". But Docker then reports the container healthy, `restart: unless-
# stopped` never fires, and traffic keeps being routed to a server where every
# query fails. A readiness probe is the one an orchestrator should gate on, and
# it returns 503 until migrations have run and the database answers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/src/server.ts"]
