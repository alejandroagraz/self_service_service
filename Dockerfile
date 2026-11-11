# syntax=docker/dockerfile:1
#
# Monorepo Yarn Classic (v1) workspaces: el build context es la raiz del repo (ver
# infra/docker-compose.dev.yml e infra/docker-compose.staging.yml, que fijan
# `context: ..` + `dockerfile: workspace/time_service/Dockerfile`) para que `yarn
# install` resuelva el grafo de workspaces real, igual que en el host. Nunca construir
# con el contexto apuntando solo a esta carpeta.
#
# Orden de stages deliberado: `dev` va inmediatamente despues de `deps` (su unica
# dependencia). Con el builder clasico de Docker (sin BuildKit, el que usa
# docker-compose v1.29.2 por defecto), `--target X` igual ejecuta TODAS las stages que
# aparecen antes de X en el archivo, no solo sus dependencias reales — si `build`
# (que requiere `src/` real para `tsc`) apareciera antes de `dev`, construir la imagen
# de dev fallaria mientras el servicio no tenga codigo fuente todavia.

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare yarn@1.22.22 --activate
WORKDIR /repo

FROM base AS deps
COPY package.json yarn.lock tsconfig.base.json ./
COPY workspace/identity_service/package.json workspace/identity_service/package.json
COPY workspace/people_service/package.json workspace/people_service/package.json
COPY workspace/payroll_service/package.json workspace/payroll_service/package.json
COPY workspace/time_service/package.json workspace/time_service/package.json
COPY workspace/documents_service/package.json workspace/documents_service/package.json
COPY workspace/notifications_service/package.json workspace/notifications_service/package.json
COPY workspace/audit_service/package.json workspace/audit_service/package.json
RUN yarn install --frozen-lockfile

# Target usado por docker-compose.dev.yml: dependencias completas (incl. tsx para
# hot-reload) instaladas en la imagen; en runtime el repo completo se monta por
# bind-mount (ver volumes en dev), asi que node_modules del host (ya instalado via
# `yarn install` en la raiz) termina prevaleciendo — este stage solo garantiza que la
# imagen arranca sola incluso antes del primer `docker compose up`.
FROM deps AS dev
WORKDIR /repo/workspace/time_service
CMD ["yarn", "dev"]

FROM base AS prod-deps
COPY package.json yarn.lock tsconfig.base.json ./
COPY workspace/identity_service/package.json workspace/identity_service/package.json
COPY workspace/people_service/package.json workspace/people_service/package.json
COPY workspace/payroll_service/package.json workspace/payroll_service/package.json
COPY workspace/time_service/package.json workspace/time_service/package.json
COPY workspace/documents_service/package.json workspace/documents_service/package.json
COPY workspace/notifications_service/package.json workspace/notifications_service/package.json
COPY workspace/audit_service/package.json workspace/audit_service/package.json
RUN yarn install --frozen-lockfile --production=true

FROM deps AS build
COPY workspace/time_service workspace/time_service
RUN yarn workspace @fibex-rrhh/time build

# Target usado por docker-compose.staging.yml: build-only, sin bind-mounts. Misma
# imagen para ROLE=api y ROLE=worker (Worker Node Pattern) — la diferencia la decide
# src/main.ts leyendo la env var ROLE en runtime, no el Dockerfile.
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/package.json /repo/yarn.lock ./
COPY workspace/time_service/package.json workspace/time_service/package.json
COPY --from=build /repo/workspace/time_service/dist workspace/time_service/dist
WORKDIR /repo/workspace/time_service
CMD ["node", "dist/main.js"]
