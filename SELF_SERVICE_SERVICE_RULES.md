# SELF_SERVICE_SERVICE_RULES — `self_service_service`

BFF (Backend-for-Frontend) del **portal del colaborador**. Servicio hexagonal Fastify 5 + TypeORM.
Schema PostgreSQL `self_service`, exchange RabbitMQ `self_service.events`, puerto `3012`, prefijo HTTP
`/api/v1/self-service`. Permisos del catálogo de identity: `self_service:read` (lecturas),
`self_service:punch` (fichaje y alta de horas extra excepcionales), `team:read` (vistas del
supervisor).

## Rol: agregador, no CRUD

`self_service` **no es dueño de datos de negocio** salvo una tabla propia: `clock_punches` (el
registro de fichaje del empleado). Todo lo demás que muestra el portal lo **compone** llamando a
servicios hermanos por HTTP interno. Es LLAMANTE, nunca callee de rutas internas: no expone ninguna
ruta `/internal/*` ni registra preHandler de "servicio de confianza" entrante.

## Endpoints (todos de cara al usuario, vía Traefik)

| Método | Ruta | Permiso | Compone |
|---|---|---|---|
| GET | `/api/v1/self-service/me/profile` | `self_service:read` | people + absences + time (`active-shift`, `work-sessions/current`) + clock_punches |
| GET | `/api/v1/self-service/me/clock-status` | `self_service:read` | people + time (`work-sessions/current` + `active-shift`) + clock_punches |
| GET | `/api/v1/self-service/me/payslips` | `self_service:read` | people + payroll |
| POST | `/api/v1/self-service/me/clock-punch` | `self_service:punch` | people + time (`work-sessions/punches`) + clock_punches (propio) + Outbox |
| POST | `/api/v1/self-service/me/shift-overruns/:sessionId/answer` | `self_service:punch` | people + time (`work-sessions/:id/overrun-answer`) |
| POST | `/api/v1/self-service/me/overtime-exceptions` | `self_service:punch` | people + time (`overtime-exceptions`, escritura) |
| GET | `/api/v1/self-service/me/overtime-requests` | `self_service:read` | people + time (`overtime-requests`) |
| GET | `/api/v1/self-service/me/overtime-balance` | `self_service:read` | people + time (`overtime-balance`) |
| GET | `/api/v1/self-service/team/overtime-exceptions` | `team:read` | time (`team/overtime-exceptions`) |
| POST | `/api/v1/self-service/team/overtime-exceptions/:id/validation` | `team:read` | time (`team/overtime-exceptions/:id/validation`, escritura) |

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
3. **time, jornada consolidada (`/api/v1/time/internal/work-sessions/*`, Lote 4.4B1, guardian C12/C13).**
   Como (2) más `X-Acting-User-Id: <userId del principal verificado>`. Catálogo de escritura separado:
   los POST (`punches`, `overrun-answer`) usan la clave de ESCRITURA (`TIME_INTERNAL_WRITE_KEY_FILE`,
   secreto `people_internal_write_key_self_service`); el GET (`current`), la de lectura de time. Las
   dos claves deben ser distintas (fail-fast).

Las seis claves (interna de identity + 4 per-pair de lectura + la de escritura hacia time) se leen de Docker secrets al construir
el servidor HTTP (`http-secrets.ts`), 43 chars base64url, fail-fast. Nunca se escriben en logs.

## Resiliencia de la composición

- Fuente **PRIMARIA** de `/me/profile`: people. Si falla, el perfil falla (no hay empleado que
  mostrar); el error se mapea al usuario (401/403/404 → `SELF_PROFILE_NOT_LINKED`, 5xx/red →
  `SELF_UPSTREAM_UNAVAILABLE`).
- Fuentes **SECUNDARIAS** del perfil: absences (días de vacaciones) y time (turno activo). Su caída
  NO rompe el perfil: degradan a `vacationDaysAvailable = 0`, `activeShiftName = "Sin turno asignado"`
  y estado de jornada sobre el día natural VET.
- time es **PRIMARIO** de `GET /me/clock-status` (`work-sessions/current` y `active-shift`), de
  `POST /me/clock-punch` (`work-sessions/punches`) y de la respuesta al aviso: su caída, un 4xx no
  previsto o un contrato de respuesta roto responden 503 `SSVSLF0002` (fail-closed, nada se escribe).
  En `/me/profile` la jornada es SECUNDARIA: sin ella `currentClockStatus` degrada a `NOT_STARTED`.
- Toda llamada saliente usa el núcleo `internal-http.ts`: timeout por `AbortController`, backoff
  exponencial con jitter y reintento SOLO ante fallo transitorio (429/5xx/red). Un 4xx de contrato no
  se reintenta.

## Fichaje (`clock_punches`) y máquina de estados

- `clock_punches` es POR-TENANT (`tenant_id` + RLS) y **APPEND-ONLY**: privilegios `SELECT, INSERT`
  (sin UPDATE/DELETE a nivel de PostgreSQL — el "append-only" es un invariante del esquema, no una
  convención). Es el log de lo que pulsa el empleado; la **autoridad de la jornada es people**
  (jornada consolidada, GAP-043, Lote 4.4B1). El BFF ya no valida ventana ni transiciones
  (`assertPunchAllowed` retirado, guardian C25).
- `POST /me/clock-punch`: `Idempotency-Key` opcional (uuid v4; vacía, repetida o inválida → 422
  `SSVCOM0001`). `clockPunchId` = esa clave o uno generado. Perfil (people) → `work-sessions/punches`
  (idempotente por `clockPunchId`) → si 200, en UNA transacción: `clock_punches` con `id =
  clockPunchId` (`ON CONFLICT (id) DO NOTHING`) y, solo si la fila es nueva, `attendance.punched` en
  el Outbox. Una clave reutilizada para otra marcación (otro empleado o acción) → 422. El instante
  guardado/emitido es el OFICIAL de people (`clockInAt`; en la salida `postCloseCheckoutAt` o
  `clockOutAt`); `BREAK` y la reanudación (`CHECK_IN` en pausa) usan el `punchedAt` enviado (people lo acota a
  ±5 min). Mapeo: `TIMCLK0005`/`0010` → 409 `SSVCLK0002` (propaga `errors`), `TIMCLK0006` → 409
  `SSVCLK0003` (propaga `opensAt`), `TIMCLK0011` → 422 `SSVCLK0001`, `TIMCLK0012` → 403 `SSVCOM0003`,
  resto → 503. Respuesta `{ id, status, timestamp, message, sessionId }`.
- Estado (`clock-status.ts`, `deriveClockState`), MISMA función para `clock-status` y `profile`: sin
  jornada o `ABSENT` → `NOT_STARTED`; `COMPLETED`/`INCOMPLETE` → `CLOCKED_OUT`; `ACTIVE` →
  `CLOCKED_IN`, u `ON_BREAK` si people informa `onBreak: true` (contrato §3, «Pausa y reanudación»). Un
  `CHECK_IN` en pausa se pasa a people sin reglas propias: es una reanudación (200). people no devuelve
  el instante de la pausa ni de la reanudación: se guarda el `punchedAt` enviado.
- Turno y ventana de `clock-status` (`operational-day.ts`): el turno programado de la jornada vigente
  si coincide con una asignación de `active-shift`; si no, la ventana `[inicio −
  checkInWindowBeforeMinutes, min(fin + abandonAfterMinutes, apertura del turno siguiente))` que
  contiene `now`, la siguiente asignación de hoy/mañana o la última de hoy; sin turno hoy, día natural
  VET. Los parámetros llegan de people por `active-shift` (contrato antiguo → defaults de 01B + `warn`).
- Respuesta al aviso de fin de turno (`POST /me/shift-overruns/:sessionId/answer`, `{ answer:
  CONTINUE|END }`): `employeeId` resuelto en servidor; `TIMCLK0007` → 404 `SSVSHF0001`,
  `TIMCLK0008` → 409 `SSVSHF0002`. El BFF no escribe nada (people emite el evento).

## Horas extra excepcionales (GAP-044, Lote 4.4B2)

- Cliente `OvertimeClient` (`overtime-client.ts`) sobre el núcleo común `time-internal-http.ts`
  (compartido con `WorkSessionClient`): mismas cabeceras y misma pareja de claves (escritura en los dos
  POST, lectura en los tres GET), `X-Acting-User-Id` = userId del principal en todas.
- Rutas `/me`: `employeeId` resuelto SIEMPRE vía people (`/employees/me`); un `employeeId`,
  `supervisorId` o cualquier campo/parámetro no declarado → 422 `SSVCOM0001` sin llamar a people.
  `GET /me/overtime-balance` no admite parámetros. Del supervisor, el empleado solo ve `result` y
  `validatedAt` (D7: el BFF proyecta aunque people envíe más).
- Rutas `/team`: ningún filtro de supervisor ni de empleado viaja; people deriva el supervisor del
  actor (D11) y responde igual a una solicitud ajena o inexistente (403 `SSVOVT0010`). No se resuelve
  el perfil. `team:read` autoriza también el POST de validación porque people verifica la relación.
- Mapeo: `TIMOVT0001` → 422 `SSVOVT0001` (propaga `errors`), `TIMOVT0006` → 409 `SSVOVT0006`,
  `TIMOVT0008` → 422 `SSVOVT0008`, `TIMOVT0009` → 409 `SSVOVT0009`, `TIMOVT0010` → 403 `SSVOVT0010`,
  `TIMOVT0011` → 422 `SSVOVT0011`, `TIMCLK0012` → 403 `SSVCOM0003`; caída, código no previsto para la
  ruta o contrato roto → 503 `SSVSLF0002`. Las dos escrituras NO se reintentan (no son idempotentes).
- El alta responde 201; los listados, `meta` paginada `{ page, pageSize, total, totalPages }`.
- Sin evidencias (4.5) ni avisos (4.4B3).

## OpenAPI (DEC-16 = A, modo transitorio)

- Las rutas nuevas o modificadas declaran `schema` con `routeSchema()`
  (`shared/infrastructure/http/openapi/route-schema.ts`), generado de los DTO class-validator con
  `class-validator-jsonschema`, con `operationId`, `tags`, `security` y `x-permission` (clave real de
  `requirePermission`, `public` o `internal`; las internas con `x-internal: true`).
- Los esquemas son SOLO documentación: validador y serializador de Fastify desactivados;
  class-validator sigue dando el 422.
- `tests/contract/openapi-drift.test.ts` + `openapi-allowlist.json` (solo crece; el Lote 6.1 pasa a
  modo `strict`).
- Cada fichaje NUEVO se inserta y encola el evento `attendance.punched` en el **MISMO COMMIT**
  (Transactional Outbox); un reintento con el mismo `clockPunchId` no reencola. Desde el 4.4B1 la
  jornada la registra people de forma síncrona; `clock_punches` queda como log propio del portal.

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
