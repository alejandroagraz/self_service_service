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

# Manifiesto SOLO de dependencias (mini-lote de builds, C): de package.json se conservan los campos
# que deciden QUÉ se instala (dependencies, devDependencies, optionalDependencies, resolutions,
# engines) y se descartan scripts, descripciones y comentarios. La cache de BuildKit de un COPY se
# indexa por el contenido del fichero, así que editar un script ya no invalida el `yarn install`:
# solo lo invalida un cambio real de dependencias o del yarn.lock.
FROM base AS manifest
COPY package.json ./
RUN mkdir -p /manifest \
 && node -e "const p=require('./package.json');const k=['name','version','private','dependencies','devDependencies','optionalDependencies','resolutions','engines'];const o={};for(const f of k){if(p[f]!==undefined)o[f]=p[f];}require('fs').writeFileSync('/manifest/package.json',JSON.stringify(o,null,2)+'\n');"

# yarn 1.22 NO aplica `--registry`, `.yarnrc` ni YARN_REGISTRY a las URLs `resolved` del yarn.lock:
# descarga de los hosts escritos en el lockfile (verificado en red aislada). Por eso, si hay proxy,
# en el MISMO `RUN`: (1) se guarda el sha256 del lockfile commiteado, (2) se reescriben sus hosts
# npmjs/yarnpkg al proxy, (3) se exige que no quede ninguno sin reescribir, (4) se instala con
# `--frozen-lockfile` (yarn sigue verificando la integridad de cada tarball contra el lockfile) y
# (5) se restaura el original y se comprueba su sha256. La imagen conserva el yarn.lock del repo.
# La cache de paquetes de yarn (`--mount=type=cache`) persiste entre builds aunque la capa se
# invalide y NO entra en la imagen. `sharing=locked`: la cache de yarn 1 no admite escritores
# concurrentes (serializa los installs que la comparten).
# Es la ÚNICA instalación de la imagen (mini-lote de builds, D): `prod-deps` poda sobre este
# node_modules en vez de instalar otra vez desde cero.
FROM base AS deps
ARG NPM_REGISTRY=
COPY --from=manifest /manifest/package.json ./package.json
COPY yarn.lock ./
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

# Target de docker-compose.dev.yml: dependencias completas (incl. tsx para hot-reload). En dev se
# montan `src/` (y los ficheros de configuración) por bind-mount, así que el código del host
# prevalece; package.json completo para que `yarn dev` encuentre sus scripts.
FROM deps AS dev
COPY package.json ./
CMD ["yarn", "dev"]

# Poda de devDependencies (D): parte del node_modules ya instalado en `deps` (sin segunda instalación
# ni red) y borra lo que no alcanzan las dependencias de producción, con la misma resolución de Node.
# Ver scripts/prune-prod-deps.cjs (por qué no `yarn install --production`: lento y conserva peers
# opcionales como ts-node/typescript). El runtime migra sobre el JS compilado de dist/.
FROM deps AS prod-deps
COPY scripts/prune-prod-deps.cjs /tmp/prune-prod-deps.cjs
RUN node /tmp/prune-prod-deps.cjs

# Target de la imagen `-seed` (solo QA/demo, nunca produccion): node_modules completo (el seeder
# usa @faker-js/faker, devDependency) + dist/.
FROM deps AS build
COPY . .
RUN yarn build

# Target de la imagen de runtime: UNA imagen por servicio para los contenedores migrate, api y
# worker (el ROLE lo decide src/main.ts en runtime; la migracion corre `yarn migration:run:dist`,
# que invoca el binario typeorm —dependencia de produccion— sobre el .js compilado en dist/).
# package.json completo (scripts) desde `build`; node_modules podado desde `prod-deps`.
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/yarn.lock ./
COPY --from=build /app/dist ./dist
CMD ["node", "dist/main.js"]
