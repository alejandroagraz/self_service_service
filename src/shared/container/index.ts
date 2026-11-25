/**
 * Composition root (tsyringe). Es el ÚNICO lugar del servicio donde se decide qué implementación
 * concreta satisface cada puerto del dominio (rulebook 4.3).
 *
 * `application/` y `domain/` nunca ven estos nombres de clase: solo los símbolos de `TOKENS` y las
 * interfaces.
 */
import type Redis from "ioredis";
import { container } from "tsyringe";
import type { DataSource } from "typeorm";

import { env } from "../config/env";
import type { HttpSecrets } from "../config/http-secrets";
import { appDataSource } from "../infrastructure/database/data-source";
import { TypeOrmUnitOfWork } from "../infrastructure/database/typeorm-unit-of-work";
import { createRedisClient } from "../infrastructure/cache/redis-client";
import { AbsencesClient } from "../infrastructure/http/absences-client";
import { DocumentsClient } from "../infrastructure/http/documents-client";
import { IdentityClient } from "../infrastructure/http/identity-client";
import { OvertimeClient } from "../infrastructure/http/overtime-client";
import { PayrollClient } from "../infrastructure/http/payroll-client";
import { PeopleClient } from "../infrastructure/http/people-client";
import { PeopleInternalClient } from "../infrastructure/http/people-internal-client";
import { TimeClient } from "../infrastructure/http/time-client";
import { WorkSessionClient } from "../infrastructure/http/work-session-client";
import { DayjsClock } from "../infrastructure/services/dayjs-clock";
import { UuidV4IdGenerator } from "../infrastructure/services/uuid-v4-id-generator";
import { rootLogger } from "../infrastructure/services/winston-logger";
import { TOKENS } from "./tokens";

export interface ContainerHandles {
  readonly dataSource: DataSource;
  readonly redis: Redis;
}

export const buildContainer = (): ContainerHandles => {
  const redis = createRedisClient();

  container.registerInstance(TOKENS.DataSource, appDataSource);
  container.registerInstance(TOKENS.RedisClient, redis);
  container.registerInstance(TOKENS.Logger, rootLogger());

  container.registerSingleton(TOKENS.IdGenerator, UuidV4IdGenerator);
  container.registerSingleton(TOKENS.Clock, DayjsClock);
  container.registerSingleton(TOKENS.UnitOfWork, TypeOrmUnitOfWork);

  return { dataSource: appDataSource, redis };
};

/**
 * Registra el cliente de identity para validar tokens (§10.4). Lo llama `buildHttpServer` tras leer
 * la clave interna (`http-secrets.ts`); el rol worker no lo llama y no monta ese secreto.
 */
export const registerIdentityClient = (
  baseUrl: string,
  internalApiKey: string,
  timeoutMs: number,
): void => {
  container.registerInstance(
    TOKENS.IdentityClient,
    new IdentityClient(baseUrl, internalApiKey, timeoutMs),
  );
};

/**
 * Registra los clientes SALIENTES hacia los hermanos. Lo llama `buildHttpServer` tras leer las claves
 * per-pair (`http-secrets.ts`); el rol worker no lo llama (no sirve HTTP ni compone vistas).
 *
 * `people` (pass-through) reenvía el token del usuario (sin clave); `payroll`/`absences`/`time`/
 * `documents` son de confianza per-pair, cada uno con SU clave dedicada. `WorkSessionClient` (jornada
 * de time, Lote 4.4B1) lleva DOS: la de lectura de time en el GET y la de escritura en los POST (C12);
 * `OvertimeClient` (horas extra excepcionales, Lote 4.4B2) reutiliza esa misma pareja con la misma
 * regla (lecturas con la de lectura, las dos escrituras con la de escritura). Todos comparten el timeout de
 * upstream (en `documents`, hasta recibir las cabeceras: el cuerpo fluye en stream).
 *
 * `PeopleInternalClient` es el canal trusted-service hacia people (`/api/v1/people/internal/*`:
 * celebraciones y estado del equipo). El proceso fusionado `people` sirve los tres dominios
 * (people/time/absences) y valida TODAS sus rutas internas contra la ÚNICA clave de lectura per-caller
 * de `self-service`; esa misma clave ya llega al proceso fusionado por `active-shift` (canal `time`),
 * así que se REUTILIZA `secrets.timeReadKey` para estas rutas del prefijo people. No se crea secreto
 * nuevo. (Deuda: `env.ts`/infra podrían converger las tres claves de lectura en una sola clave
 * `people` para reflejar la fusión; fuera de alcance aquí.)
 */
export const registerOutboundClients = (secrets: HttpSecrets): void => {
  container.registerInstance(
    TOKENS.PeopleClient,
    new PeopleClient(env.PEOPLE_INTERNAL_URL, env.UPSTREAM_TIMEOUT_MS),
  );
  container.registerInstance(
    TOKENS.PeopleInternalClient,
    new PeopleInternalClient(env.PEOPLE_INTERNAL_URL, secrets.timeReadKey, env.UPSTREAM_TIMEOUT_MS),
  );
  container.registerInstance(
    TOKENS.PayrollClient,
    new PayrollClient(env.PAYROLL_INTERNAL_URL, secrets.payrollReadKey, env.UPSTREAM_TIMEOUT_MS),
  );
  container.registerInstance(
    TOKENS.AbsencesClient,
    new AbsencesClient(env.ABSENCES_INTERNAL_URL, secrets.absencesReadKey, env.UPSTREAM_TIMEOUT_MS),
  );
  container.registerInstance(
    TOKENS.TimeClient,
    new TimeClient(env.TIME_INTERNAL_URL, secrets.timeReadKey, env.UPSTREAM_TIMEOUT_MS),
  );
  container.registerInstance(
    TOKENS.WorkSessionClient,
    new WorkSessionClient(
      env.TIME_INTERNAL_URL,
      secrets.timeReadKey,
      secrets.timeWriteKey,
      env.UPSTREAM_TIMEOUT_MS,
    ),
  );
  container.registerInstance(
    TOKENS.OvertimeClient,
    new OvertimeClient(
      env.TIME_INTERNAL_URL,
      secrets.timeReadKey,
      secrets.timeWriteKey,
      env.UPSTREAM_TIMEOUT_MS,
    ),
  );
  container.registerInstance(
    TOKENS.DocumentsClient,
    new DocumentsClient(
      env.DOCUMENTS_INTERNAL_URL,
      secrets.documentsReadKey,
      env.UPSTREAM_TIMEOUT_MS,
    ),
  );
};

export { container, TOKENS };
