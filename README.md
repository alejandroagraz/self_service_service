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
| GET | `/api/v1/self-service/me/profile` | `self_service:read` | people + absences + time + clock_punches |
| GET | `/api/v1/self-service/me/payslips` | `self_service:read` | people + payroll |
| POST | `/api/v1/self-service/me/clock-punch` | `self_service:punch` | people + clock_punches + Outbox |

## Auth saliente
- **people**: pass-through del token del usuario (`GET /employees/me`).
- **payroll / absences / time**: confianza per-pair (`X-Service-Name` + clave dedicada + `X-Tenant-Id`),
  sin reenviar el token. Claves como Docker secrets, fail-fast al arrancar.

## Fichaje
Acciones `CHECK_IN | BREAK | CHECK_OUT`; el estado (`NOT_STARTED`/`CLOCKED_IN`/`ON_BREAK`/`CLOCKED_OUT`)
se deriva de la última marcación. Cada fichaje emite `attendance.punched` por Transactional Outbox en
el mismo commit. Transición inválida → `409`.

## Roles de proceso
`ROLE=api` (HTTP), `ROLE=worker` (poller del Outbox, publish-only) o `ROLE=all`.

## Desarrollo
```bash
yarn install
yarn build      # tsc
yarn lint       # eslint
yarn migration:run
```
