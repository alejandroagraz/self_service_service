# Fibex RRHH — Portal del Colaborador (`self_service_service`)

BFF/agregador hexagonal Fastify 5 + TypeORM (schema PostgreSQL `self_service`, exchange RabbitMQ
`self_service.events`, puerto `3012`, prefijo HTTP `/api/v1/self-service`). Reglas completas en
[SELF_SERVICE_SERVICE_RULES.md](SELF_SERVICE_SERVICE_RULES.md).

## Rol
Compone la vista de autoservicio del empleado llamando por HTTP interno a sus hermanos. Solo es dueño
de una tabla propia: `clock_punches` (fichaje, POR-TENANT con RLS, append-only). Resuelve el
`employeeId` del usuario autenticado vía people (dueño del vínculo `userId↔empleado`).

## Endpoints (permiso `self_service:read` lectura / `self_service:punch` fichaje)
| Método | Ruta | Permiso | Fuentes |
|---|---|---|---|
| GET | `/api/v1/self-service/me/profile` | `self_service:read` | people + absences + time (`active-shift`, `work-sessions/current`) + clock_punches |
| GET | `/api/v1/self-service/me/clock-status` | `self_service:read` | people + time (`work-sessions/current`, `active-shift`) + clock_punches |
| GET | `/api/v1/self-service/me/payslips` | `self_service:read` | people + payroll |
| POST | `/api/v1/self-service/me/clock-punch` | `self_service:punch` | people + time (`work-sessions/punches`) + clock_punches + Outbox |
| POST | `/api/v1/self-service/me/shift-overruns/:sessionId/answer` | `self_service:punch` | people + time (`work-sessions/:id/overrun-answer`) |

OpenAPI publicado (red interna, excluido de Traefik): `GET /api/v1/self-service/docs/openapi.json`.

## Auth saliente
- **people**: pass-through del token del usuario (`GET /employees/me`).
- **payroll / absences / time**: confianza per-pair (`X-Service-Name` + clave dedicada + `X-Tenant-Id`),
  sin reenviar el token. Claves como Docker secrets, fail-fast al arrancar.
- **time, jornada (`work-sessions`, Lote 4.4B1)**: además `X-Acting-User-Id` (userId del principal). Los
  POST usan la clave de ESCRITURA (`TIME_INTERNAL_WRITE_KEY_FILE`, distinta de la de lectura); el GET,
  la de lectura (`TIME_INTERNAL_READ_KEY_FILE`).

## Fichaje
Acciones `CHECK_IN | BREAK | CHECK_OUT`. Desde el Lote 4.4B1 (GAP-043) la marcación es SÍNCRONA contra la
jornada consolidada de people, única autoridad: `Idempotency-Key` opcional (uuid v4; inválida → 422), y si
people acepta se guarda `clock_punches` con `id = clockPunchId` (`ON CONFLICT (id) DO NOTHING`) y se emite
`attendance.punched` con el instante oficial de people, en el mismo commit (sin reencolar en un
reintento). Códigos de people: `TIMCLK0005`/`0010` → `409 SSVCLK0002`, `TIMCLK0006` → `409 SSVCLK0003`,
`TIMCLK0011` → `422 SSVCLK0001`, `TIMCLK0012` → `403 SSVCOM0003`; caída → `503 SSVSLF0002`. El estado
(`NOT_STARTED`/`CLOCKED_IN`/`ON_BREAK`/`CLOCKED_OUT`) se traduce de la jornada vigente (`ON_BREAK` = `onBreak` de people;
un `CHECK_IN` en pausa es una reanudación que gestiona people). Respuesta al aviso de fin de turno: `404 SSVSHF0001` / `409 SSVSHF0002`.

## Roles de proceso
`ROLE=api` (HTTP), `ROLE=worker` (poller del Outbox, publish-only) o `ROLE=all`.

## Desarrollo
```bash
yarn install
yarn build      # tsc
yarn lint       # eslint
yarn test:nodb  # unit + http + contract (sin BD)
yarn test       # todo, incluido RLS: ../fibex-infra/scripts/test-db.sh self_service
yarn migration:run
```
