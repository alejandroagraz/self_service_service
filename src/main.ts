/**
 * Punto de entrada del `self_service_service` (BFF del portal del colaborador).
 *
 * `reflect-metadata` DEBE importarse antes que cualquier módulo con decoradores (tsyringe,
 * TypeORM): si se carga después, los metadatos de diseño ya se habrán emitido sin el shim y la
 * resolución de dependencias fallará en tiempo de ejecución con errores opacos.
 *
 * Orden de arranque (fail-fast salvo Redis, que es degradable):
 *   1. `env` ya se validó al importarse (envalid) — un secreto ausente mata el proceso aquí.
 *   2. Contenedor DI + conexión a PostgreSQL con el rol `app_self_service`.
 *   3. Conexión a Redis, sin fail-fast y con techo (≤ 2 s): es dependencia degradable (§4.10).
 *   4. Según `ROLE`: servidor HTTP (`api`), workers (`worker`) o ambos (`all`).
 *
 * Apagado limpio acotado por un reloj de guarda de proceso (`SHUTDOWN_WATCHDOG_MS`): es el único
 * backstop que cubre `server.close()` (espera peticiones en vuelo sin cota) y `dataSource.destroy()`.
 * Sale con código 1 al dispararse (no 0, que mentiría; no 143/137, que son ambiguos).
 */
import "reflect-metadata";

import type { FastifyInstance } from "fastify";

import { env, isApiRole, isWorkerRole } from "./shared/config/env";
import { buildContainer } from "./shared/container";
import { SELF_SERVICE_SCHEMA } from "./shared/infrastructure/database/schema";
import { logger } from "./shared/logger/logger";
import { connectRedisAtBoot } from "./shared/infrastructure/cache/redis-client";
import { buildHttpServer } from "./shared/infrastructure/http/server";
import { startWorkers, type WorkerHandles } from "./workers";

const log = logger;

/**
 * Reloj de guarda del apagado: techo absoluto del proceso. 8 s está por debajo del
 * `stop_grace_period` de Docker (10 s por defecto) y por encima de los 5 s del drenaje de los
 * workers. Si `infra/` baja el `stop_grace_period`, hay que bajar esta constante con él.
 */
const SHUTDOWN_WATCHDOG_MS = 8_000;

const bootstrap = async (): Promise<void> => {
  const handles = buildContainer();

  await handles.dataSource.initialize();
  log.info("Conexión a PostgreSQL establecida.", {
    schema: SELF_SERVICE_SCHEMA,
    user: env.POSTGRES_APP_USER,
    role: env.ROLE,
  });

  // Nunca lanza por un fallo de Redis y nunca espera más de su techo: ver su cabecera.
  await connectRedisAtBoot(handles.redis);

  let server: FastifyInstance | null = null;
  let workers: WorkerHandles | null = null;
  let shuttingDown = false;

  const shutdown = (reason: string, successExitCode: number): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info("Apagado iniciado; cerrando ordenadamente.", {
      reason,
      watchdogMs: SHUTDOWN_WATCHDOG_MS,
    });

    const pending = new Set<string>();
    if (server !== null) {
      pending.add("http-server");
    }
    if (workers !== null) {
      pending.add("workers");
    }
    pending.add("postgres");
    pending.add("redis");

    const watchdog = setTimeout(() => {
      log.error("El apagado no terminó dentro del plazo; se fuerza la salida del proceso.", {
        reason,
        watchdogMs: SHUTDOWN_WATCHDOG_MS,
        pending: [...pending],
      });
      process.exit(1);
    }, SHUTDOWN_WATCHDOG_MS);
    watchdog.unref();

    void (async (): Promise<void> => {
      try {
        if (server !== null) {
          await server.close();
          pending.delete("http-server");
        }
        if (workers !== null) {
          await workers.stop();
          pending.delete("workers");
        }
        if (handles.dataSource.isInitialized) {
          await handles.dataSource.destroy();
        }
        pending.delete("postgres");
        handles.redis.disconnect();
        pending.delete("redis");
        clearTimeout(watchdog);
        log.info("Apagado completado.", { reason, exitCode: successExitCode });
        process.exit(successExitCode);
      } catch (error) {
        clearTimeout(watchdog);
        log.error("Fallo durante el apagado; se fuerza la salida.", {
          reason,
          pending: [...pending],
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      }
    })();
  };

  if (isApiRole()) {
    server = await buildHttpServer(handles.redis);
    await server.listen({ host: env.HOST, port: env.PORT });
    log.info("Servidor HTTP escuchando.", { host: env.HOST, port: env.PORT });
  }

  if (isWorkerRole()) {
    // Un canal o conexión de RabbitMQ caídos, o un consumidor cancelado por el broker, dejan al
    // worker inútil —o peor, quemando `retry_count` del Outbox hasta FAILED (terminal). La
    // respuesta es apagado ordenado con salida NO NULA, para que `restart: unless-stopped` reponga
    // el contenedor con conexión y canales nuevos.
    workers = await startWorkers(handles.dataSource, (reason, detail) => {
      log.error("Fallo irrecuperable de mensajería; se cierra el proceso para reponerlo.", {
        reason,
        ...detail,
      });
      shutdown(reason, 1);
    });
  }

  process.on("SIGTERM", () => {
    shutdown("SIGTERM", 0);
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT", 0);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    log.error("Promesa rechazada sin manejar; se termina el proceso.", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
    process.exit(1);
  });
  process.on("uncaughtException", (error: Error) => {
    log.error("Excepción no capturada; se termina el proceso.", { error: error.message });
    process.exit(1);
  });
};

bootstrap().catch((error: unknown) => {
  log.error("Arranque fallido.", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
