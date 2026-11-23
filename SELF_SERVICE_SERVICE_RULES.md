# SELF_SERVICE_SERVICE_RULES — `self_service_service`

BFF (Backend-for-Frontend) del **portal del colaborador**. Servicio hexagonal Fastify 5 + TypeORM.
Schema PostgreSQL `self_service`, exchange RabbitMQ `self_service.events`, puerto `3012`, prefijo HTTP
`/api/v1/self-service`. Permisos del catálogo de identity: `self_service:read` (lecturas),
`self_service:punch` (fichaje).

## Rol: agregador, no CRUD

`self_service` **no es dueño de datos de negocio** salvo una tabla propia: `clock_punches` (el
registro de fichaje del empleado). Todo lo demás que muestra el portal lo **compone** llamando a
servicios hermanos por HTTP interno. Es LLAMANTE, nunca callee de rutas internas: no expone ninguna
ruta `/internal/*` ni registra preHandler de "servicio de confianza" entrante.

## Endpoints (todos de cara al usuario, vía Traefik)

| Método | Ruta | Permiso | Compone |
|---|---|---|---|
| GET | `/api/v1/self-service/me/profile` | `self_service:read` | people + absences + time + clock_punches |
| GET | `/api/v1/self-service/me/clock-status` | `self_service:read` | people + time (`active-shift`) + clock_punches |
| GET | `/api/v1/self-service/me/payslips` | `self_service:read` | people + payroll |
| POST | `/api/v1/self-service/me/clock-punch` | `self_service:punch` | people + time (`active-shift`) + clock_punches (propio) + Outbox |

Ruta de red interna (sin autenticación, como `/metrics`; **Traefik debe excluirla** porque cuelga del
prefijo público): `GET /api/v1/self-service/docs/openapi.json`, el OpenAPI publicado (DEC-16 = A).

El principal verificado trae `userId`, no `employeeId`. **El `employeeId` se resuelve SIEMPRE vía
people** (único dueño del vínculo `userId↔empleado`) antes de consultar a los demás.

## Dos mecanismos de auth saliente

1. **people — pass-through del token del usuario.** `self_service` reenvía el `Authorization: Bearer`
   del usuario a `GET /api/v1/people/employees/me`; people resuelve su propia ficha y lo autoriza con
   `self_service:read`. Es el ÚNICO cliente que reenvía el token.
2. **payroll / absences / time — confianza per-pair (D2).** NO reenvían el token. `self_service` se
   identifica con `X-Service-Name: self-service` + `X-Internal-Api-Key: <clave per-pair dedicada>` +
   `X-Tenant-Id: <tenantId del principal>`. Cada hermano valida esa clave contra SU allowlist y acota
   por RLS con el `tenantId` recibido. El compromiso de una clave per-pair no habilita a las otras.

Las cuatro claves (interna de identity + 3 per-pair salientes) se leen de Docker secrets al construir
el servidor HTTP (`http-secrets.ts`), 43 chars base64url, fail-fast. Nunca se escriben en logs.

## Resiliencia de la composición

- Fuente **PRIMARIA** de `/me/profile`: people. Si falla, el perfil falla (no hay empleado que
  mostrar); el error se mapea al usuario (401/403/404 → `SELF_PROFILE_NOT_LINKED`, 5xx/red →
  `SELF_UPSTREAM_UNAVAILABLE`).
- Fuentes **SECUNDARIAS** del perfil: absences (días de vacaciones) y time (turno activo). Su caída
  NO rompe el perfil: degradan a `vacationDaysAvailable = 0`, `activeShiftName = "Sin turno asignado"`
  y estado de jornada sobre el día natural VET.
- time (`active-shift`) es **PRIMARIO** de `GET /me/clock-status` y de `POST /me/clock-punch`: sin el
  turno no hay ventana que validar, así que su caída responde 503 `SSVSLF0002` (fail-closed).
- Toda llamada saliente usa el núcleo `internal-http.ts`: timeout por `AbortController`, backoff
  exponencial con jitter y reintento SOLO ante fallo transitorio (429/5xx/red). Un 4xx de contrato no
  se reintenta.

## Fichaje (`clock_punches`) y máquina de estados

- `clock_punches` es POR-TENANT (`tenant_id` + RLS) y **APPEND-ONLY**: privilegios `SELECT, INSERT`
  (sin UPDATE/DELETE a nivel de PostgreSQL — el "append-only" es un invariante del esquema, no una
  convención). El estado de jornada NO se persiste: se **deriva** de las marcaciones del **día
  operativo** vigente (`domain/services/operational-day.ts`, GAP-003), la MISMA función para
  `clock-status`, `profile` y `clock-punch`:
  - ventana del turno asignado `[inicio − checkInWindowBeforeMinutes, min(fin + abandonAfterMinutes,
    apertura del turno siguiente))`, que cruza medianoche; sin turno ese día, día natural VET;
  - vigente: la ventana que contiene `now`; si no y HOY hay turno (alguna asignación con `workDate`
    = día civil VET), la siguiente asignación que aún no abrió (hoy o mañana) o, si no hay ninguna,
    la última de hoy ya vencida; el día natural rige SOLO si hoy no hay ningún turno asignado;
  - fuera de ventana un día con turno el estado es `NOT_STARTED` (no cuenta ninguna marcación): una
    salida tardía tras `abandonAt` da `409 SSVCLK0002` y la regulariza RRHH (GAP-043, Lote 4.4);
  - un día con turno, `CHECK_IN` fuera de ventana → `409 SSVCLK0003` con `errors[{field:"opensAt"}]`
    (próxima apertura) o `errors: []` si no hay turno siguiente en el horizonte; una entrada sin
    cerrar de una ventana vencida no cuenta y no bloquea la siguiente;
  - los parámetros (ventana previa, abandono, tolerancias) llegan de people por `active-shift`; con
    el contrato antiguo (`{ shiftName }`) se usan los valores por defecto de 01B y un `warn`.
- Acciones: `CHECK_IN | BREAK | CHECK_OUT`. Estados: `NOT_STARTED | CLOCKED_IN | ON_BREAK |
  CLOCKED_OUT`. Transiciones válidas (`clock-status.ts`):
  - `NOT_STARTED`/`CLOCKED_OUT` → solo `CHECK_IN`.
  - `CLOCKED_IN` → `BREAK` o `CHECK_OUT`.
  - `ON_BREAK` → `CHECK_IN` (reanudar) o `CHECK_OUT`.
  Una transición imposible se rechaza con `409 CLOCK_PUNCH_INVALID_TRANSITION` ANTES de escribir.

## OpenAPI (DEC-16 = A, modo transitorio)

- Las rutas nuevas o modificadas declaran `schema` con `routeSchema()`
  (`shared/infrastructure/http/openapi/route-schema.ts`), generado de los DTO class-validator con
  `class-validator-jsonschema`, con `operationId`, `tags`, `security` y `x-permission` (clave real de
  `requirePermission`, `public` o `internal`; las internas con `x-internal: true`).
- Los esquemas son SOLO documentación: validador y serializador de Fastify desactivados;
  class-validator sigue dando el 422.
- `tests/contract/openapi-drift.test.ts` + `openapi-allowlist.json` (solo crece; el Lote 6.1 pasa a
  modo `strict`).
- Cada fichaje se inserta y encola el evento `attendance.punched` en el **MISMO COMMIT**
  (Transactional Outbox). `time` lo conciliará como consumo de Fase posterior; hoy `self_service` es
  el dueño del registro de fichaje.

## Invariantes heredados (plantilla)

- **RLS por tenant** en `clock_punches`; el `tenant_id` sale SIEMPRE del principal, nunca de un header
  del cliente. `withTenant` fija `app.tenant_id` local a la transacción (`set_config(..., true)`).
- **Default-deny de privilegios**: `APP_TABLE_PRIVILEGES` declara tabla por tabla y la migración
  verifica el resultado efectivo contra el catálogo (aborta si no coincide). El schema lo crea infra
  (`01_schemas.sql`), no la migración.
- **Outbox publish-only**: `OutboxPublisherWorker` (ROLE=worker) publica a `self_service.events`; un
  advisory lock por base de datos garantiza una sola réplica publicando. `self_service` NO consume
  ningún evento (sin consumidor, sin `processed_events`).
- Secrets como Docker secrets (rutas en env), nunca como variables de entorno con el valor.
