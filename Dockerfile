# syntax=docker/dockerfile:1
#
# Repo independiente (tras separar el monorepo Yarn workspaces): el build context es la raiz
# de ESTE repo. El compose fija `context: ../<svc>_service` + `dockerfile: Dockerfile`.
# `yarn install` resuelve solo las dependencias de este servicio con su propio yarn.lock;
# tsconfig.json trae las opciones de compilador inline (ya no extiende un tsconfig.base.json).
#
# Orden de stages deliberado: `dev` va justo despues de `deps` (su unica dependencia). Con el
# builder clasico de Docker (sin BuildKit, el que usa docker-compose v1.29.2), `--target X`
# ejecuta TODAS las stages anteriores a X en el archivo; si `build` (que necesita src/ para
# `tsc`) apareciera antes de `dev`, construir la imagen de dev fallaria.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare yarn@1.22.22 --activate
WORKDIR /app

FROM base AS deps
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

# Target de docker-compose.dev.yml: dependencias completas (incl. tsx para hot-reload). En
# dev el repo se monta por bind-mount sobre /app, asi que el codigo del host prevalece.
FROM deps AS dev
CMD ["yarn", "dev"]

FROM base AS prod-deps
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=true

FROM deps AS build
COPY . .
RUN yarn build

# Target de docker-compose.staging.yml: build-only, sin bind-mounts. Misma imagen para
# ROLE=api y ROLE=worker y para el contenedor efimero de migracion (el ROLE lo decide
# src/main.ts en runtime; la migracion corre `yarn migration:run:dist`, que invoca el binario
# typeorm —dependencia de produccion— sobre el .js compilado en dist/).
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json /app/yarn.lock ./
COPY --from=build /app/dist ./dist
CMD ["node", "dist/main.js"]
