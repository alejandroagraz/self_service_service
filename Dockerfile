# Repo independiente: el build context es la raiz de ESTE repo. El compose de dev fija
# `context: ../<svc>_service`; las imagenes de staging/produccion las construye
# `fibex-infra/scripts/build-release.sh` y se despliegan desde el registro on-premise.
# `yarn install` resuelve solo las dependencias de este servicio con su propio yarn.lock;
# tsconfig.json trae las opciones de compilador inline.
#
# REQUIERE BuildKit (`RUN --mount`). Con docker-compose v1 usar `fibex-infra/scripts/compose.sh`,
# que exporta DOCKER_BUILDKIT=1 y COMPOSE_DOCKER_CLI_BUILD=1 (compose v1 NO las lee de `.env`).
# El builder clasico falla de forma explicita: "the --mount option requires BuildKit".
# Sin linea `# syntax=` a proposito: se usa el frontend de Dockerfile integrado en Docker 20.10, que
# ya entiende `RUN --mount`, y asi el build no descarga `docker/dockerfile` de Docker Hub. Por lo
# mismo no se usan heredocs ni `COPY --chmod` (exigirian un frontend mas nuevo).
# Con BuildKit solo se construyen las stages que necesita el `--target` pedido, en cualquier orden.

# Imagen base fijada por digest del indice multiplataforma (Node 22.23.5, Alpine 3.24).
# build-release.sh la redirige al mirror pull-through on-premise: mismo digest, byte a byte.
# Actualizar con `fibex-infra/scripts/update-image-digests.sh`.
ARG NODE_IMAGE=node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

FROM ${NODE_IMAGE} AS base
# Proxy npm on-premise (Verdaccio). Vacio = directo a npmjs (dev sin proxy).
ARG NPM_REGISTRY=
RUN corepack enable \
 && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}" \
    corepack prepare yarn@1.22.22 --activate
WORKDIR /app

# yarn 1.22 NO aplica `--registry`, `.yarnrc` ni YARN_REGISTRY a las URLs `resolved` del yarn.lock:
# descarga de los hosts escritos en el lockfile (verificado en red aislada). Por eso, si hay proxy,
# en el MISMO `RUN`: (1) se guarda el sha256 del lockfile commiteado, (2) se reescriben sus hosts
# npmjs/yarnpkg al proxy, (3) se exige que no quede ninguno sin reescribir, (4) se instala con
# `--frozen-lockfile` (yarn sigue verificando la integridad de cada tarball contra el lockfile) y
# (5) se restaura el original y se comprueba su sha256. La imagen conserva el yarn.lock del repo.
# La cache de paquetes de yarn (`--mount=type=cache`) persiste entre builds aunque la capa se
# invalide y NO entra en la imagen. `sharing=locked`: la cache de yarn 1 no admite escritores
# concurrentes (serializa los installs que la comparten).
FROM base AS deps
ARG NPM_REGISTRY=
COPY package.json yarn.lock ./
RUN --mount=type=cache,id=fibex-yarn-cache,target=/yarn-cache,sharing=locked \
    if [ -n "$NPM_REGISTRY" ]; then \
      sha256sum yarn.lock > /tmp/yarn.lock.sha256 && cp yarn.lock /tmp/yarn.lock.orig \
      && sed -i -E "s#https://registry\.(yarnpkg\.com|npmjs\.org)/#${NPM_REGISTRY%/}/#g" yarn.lock \
      && ! grep -qE 'resolved "https://registry\.(yarnpkg\.com|npmjs\.org)/' yarn.lock; \
    fi \
 && YARN_CACHE_FOLDER=/yarn-cache yarn install --frozen-lockfile --prefer-offline --non-interactive \
 && if [ -n "$NPM_REGISTRY" ]; then \
      mv /tmp/yarn.lock.orig yarn.lock && sha256sum -c /tmp/yarn.lock.sha256 >/dev/null; \
    fi

# Target de docker-compose.dev.yml: dependencias completas (incl. tsx para hot-reload). En
# dev el repo se monta por bind-mount sobre /app, asi que el codigo del host prevalece.
FROM deps AS dev
CMD ["yarn", "dev"]

FROM base AS prod-deps
ARG NPM_REGISTRY=
COPY package.json yarn.lock ./
RUN --mount=type=cache,id=fibex-yarn-cache,target=/yarn-cache,sharing=locked \
    if [ -n "$NPM_REGISTRY" ]; then \
      sha256sum yarn.lock > /tmp/yarn.lock.sha256 && cp yarn.lock /tmp/yarn.lock.orig \
      && sed -i -E "s#https://registry\.(yarnpkg\.com|npmjs\.org)/#${NPM_REGISTRY%/}/#g" yarn.lock \
      && ! grep -qE 'resolved "https://registry\.(yarnpkg\.com|npmjs\.org)/' yarn.lock; \
    fi \
 && YARN_CACHE_FOLDER=/yarn-cache yarn install --frozen-lockfile --prefer-offline --non-interactive --production=true \
 && if [ -n "$NPM_REGISTRY" ]; then \
      mv /tmp/yarn.lock.orig yarn.lock && sha256sum -c /tmp/yarn.lock.sha256 >/dev/null; \
    fi

# Target de la imagen `-seed` (solo QA/demo, nunca produccion): node_modules completo (el seeder
# usa @faker-js/faker, devDependency) + dist/.
FROM deps AS build
COPY . .
RUN yarn build

# Target de la imagen de runtime: UNA imagen por servicio para los contenedores migrate, api y
# worker (el ROLE lo decide src/main.ts en runtime; la migracion corre `yarn migration:run:dist`,
# que invoca el binario typeorm —dependencia de produccion— sobre el .js compilado en dist/).
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json /app/yarn.lock ./
COPY --from=build /app/dist ./dist
CMD ["node", "dist/main.js"]
