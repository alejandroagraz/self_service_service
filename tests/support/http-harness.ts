/**
 * Arnés de los tests HTTP/contrato: el MISMO ensamblado de Fastify que producción (`buildHttpApp`:
 * rutas, preHandlers, manejador de errores, OpenAPI) con dobles en los bordes:
 *
 *   - Un servidor HTTP local (`node:http`) hace de identity (`/sessions/verify`), de people
 *     (`/employees/me`) y de time (`/time/internal/active-shift`). Los clientes REALES
 *     (`IdentityClient`, `PeopleClient`, `TimeClient`) le hablan por red, así que también se prueban
 *     su parseo y su mapeo de errores, sin depender de people real (que otro agente está ampliando).
 *   - La Unidad de Trabajo es en memoria y respeta el aislamiento por tenant (el RLS real lo cubre
 *     `tests/invariants/rls.test.ts` contra PostgreSQL) y la atomicidad (nada se guarda si el job
 *     lanza).
 *   - El reloj es manual (`clock.set`).
 *
 * Importa `./test-env` antes que cualquier módulo de `src`.
 */
import "./test-env";
import "reflect-metadata";

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { FastifyInstance } from "fastify";
import { container } from "tsyringe";

import { ClockPunch } from "../../src/modules/self-portal/domain/entities/clock-punch.entity";
import type { IClockPunchRepository } from "../../src/modules/self-portal/domain/repositories/clock-punch-repository.interface";
import type { ClockAction } from "../../src/modules/self-portal/domain/services/clock-status";
import { TOKENS } from "../../src/shared/container/tokens";
import type { OutboxEventDraft } from "../../src/shared/domain/repositories/outbox-repository.interface";
import type {
  IRepositoryRegistry,
  IUnitOfWork,
  TenantScopedJob,
} from "../../src/shared/domain/repositories/unit-of-work.interface";
import type { IClock } from "../../src/shared/domain/services/clock.interface";
import { AbsencesClient } from "../../src/shared/infrastructure/http/absences-client";
import { IdentityClient } from "../../src/shared/infrastructure/http/identity-client";
import { PayrollClient } from "../../src/shared/infrastructure/http/payroll-client";
import { PeopleClient } from "../../src/shared/infrastructure/http/people-client";
import { PeopleInternalClient } from "../../src/shared/infrastructure/http/people-internal-client";
import { buildHttpApp } from "../../src/shared/infrastructure/http/server";
import { TimeClient } from "../../src/shared/infrastructure/http/time-client";
import { UuidV4IdGenerator } from "../../src/shared/infrastructure/services/uuid-v4-id-generator";
import { rootLogger } from "../../src/shared/infrastructure/services/winston-logger";

export const API = "/api/v1/self-service";
const UPSTREAM_TIMEOUT_MS = 2_000;

// ───────────────────────────── Reloj manual ─────────────────────────────

export class ManualClock implements IClock {
  private current = new Date("2026-11-23T12:00:00.000Z");

  set(instant: Date): void {
    this.current = instant;
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  addSeconds(base: Date, seconds: number): Date {
    return new Date(base.getTime() + seconds * 1000);
  }

  isBefore(a: Date, b: Date): boolean {
    return a.getTime() < b.getTime();
  }
}

// ───────────────────────────── Unidad de Trabajo en memoria ─────────────────────────────

interface StoredPunch {
  readonly tenantId: string;
  readonly punch: ClockPunch;
}

class InMemoryClockPunchRepository implements IClockPunchRepository {
  constructor(
    private readonly committed: readonly StoredPunch[],
    private readonly staged: StoredPunch[],
    private readonly tenantId: string,
  ) {}

  /** Solo las filas del tenant de la transacción (equivalente a la política RLS). */
  private visible(employeeId: string): ClockPunch[] {
    return [...this.committed, ...this.staged]
      .filter((row) => row.tenantId === this.tenantId && row.punch.employeeId === employeeId)
      .map((row) => row.punch);
  }

  async findLastByEmployee(employeeId: string): Promise<ClockPunch | null> {
    const sorted = this.visible(employeeId).sort(
      (a, b) => b.punchedAt.getTime() - a.punchedAt.getTime() || a.id.localeCompare(b.id),
    );
    return sorted[0] ?? null;
  }

  async findLastCheckInAt(employeeId: string): Promise<Date | null> {
    const checkIns = this.visible(employeeId)
      .filter((punch) => punch.action === "CHECK_IN")
      .sort((a, b) => b.punchedAt.getTime() - a.punchedAt.getTime());
    return checkIns[0]?.punchedAt ?? null;
  }

  async findPunchesInRange(
    employeeId: string,
    startInclusive: Date,
    endExclusive: Date,
  ): Promise<readonly ClockPunch[]> {
    return this.visible(employeeId)
      .filter(
        (punch) =>
          punch.punchedAt.getTime() >= startInclusive.getTime() &&
          punch.punchedAt.getTime() < endExclusive.getTime(),
      )
      .sort((a, b) => a.punchedAt.getTime() - b.punchedAt.getTime() || a.id.localeCompare(b.id));
  }

  async save(punch: ClockPunch): Promise<void> {
    this.staged.push({ tenantId: this.tenantId, punch });
  }
}

const notUsedHere = (): never => {
  throw new Error("Repositorio no usado por estos tests.");
};

export class InMemoryUnitOfWork implements IUnitOfWork {
  readonly punches: StoredPunch[] = [];
  readonly outbox: OutboxEventDraft[] = [];

  async withTenant<T>(tenantId: string, job: TenantScopedJob<T>): Promise<T> {
    const stagedPunches: StoredPunch[] = [];
    const stagedOutbox: OutboxEventDraft[] = [];
    const repos: IRepositoryRegistry = {
      clockPunches: new InMemoryClockPunchRepository(this.punches, stagedPunches, tenantId),
      celebrationGreetings: {
        insertIfNew: notUsedHere,
        deleteByAuthor: notUsedHere,
        listByCelebrantIds: notUsedHere,
      } as unknown as IRepositoryRegistry["celebrationGreetings"],
      outbox: {
        enqueue: async (draft) => {
          stagedOutbox.push(draft);
        },
      },
    };
    const result = await job(repos);
    // COMMIT: solo si el job no lanzó (un 409 no deja rastro).
    this.punches.push(...stagedPunches);
    this.outbox.push(...stagedOutbox);
    return result;
  }

  /** Siembra una marcación ya confirmada (como si se hubiera hecho en otra petición). */
  seedPunch(tenantId: string, employeeId: string, action: ClockAction, punchedAt: Date): void {
    this.punches.push({
      tenantId,
      punch: ClockPunch.create({
        id: randomUUID(),
        tenantId,
        employeeId,
        userId: randomUUID(),
        action,
        note: null,
        punchedAt,
        now: punchedAt,
      }),
    });
  }

  reset(): void {
    this.punches.length = 0;
    this.outbox.length = 0;
  }
}

// ───────────────────────────── Doble de identity + people + time ─────────────────────────────

export interface TestPrincipal {
  readonly userId: string;
  readonly tenantId: string;
  readonly permissions: readonly string[];
}

export interface UpstreamResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface UpstreamState {
  /** token → principal que devuelve `/sessions/verify` (ausente → 401). */
  principals: Map<string, TestPrincipal>;
  /** token → ficha de `/employees/me` (ausente → 404 EMPLOYEE_NOT_LINKED). */
  employees: Map<string, { employeeId: string; userId: string; fullName: string }>;
  /** Fuerza el status de `/employees/me` (p. ej. 503 = people caído). */
  peopleStatus: number | null;
  /** Respuesta de `/time/internal/active-shift`. */
  activeShift: UpstreamResponse;
  /** Peticiones recibidas en `active-shift` (para verificar cabeceras y query). */
  activeShiftCalls: { employeeId: string | null; tenantId: string | undefined }[];
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const bearer = (req: IncomingMessage): string | null => {
  const header = req.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
};

const handle = (state: UpstreamState, req: IncomingMessage, res: ServerResponse): void => {
  const url = new URL(req.url ?? "/", "http://upstream.test");
  if (url.pathname === "/api/v1/identity/sessions/verify") {
    const principal = state.principals.get(bearer(req) ?? "");
    if (principal === undefined) {
      send(res, 401, { success: false, code: "IDNSES0001", data: null });
      return;
    }
    send(res, 200, {
      success: true,
      data: { ...principal, sessionId: randomUUID(), roleId: randomUUID() },
    });
    return;
  }
  if (url.pathname === "/api/v1/people/employees/me") {
    if (state.peopleStatus !== null) {
      send(res, state.peopleStatus, { success: false, code: "PPLCOM0004", data: null });
      return;
    }
    const employee = state.employees.get(bearer(req) ?? "");
    if (employee === undefined) {
      send(res, 404, { success: false, code: "PPLEMP0009", data: null });
      return;
    }
    send(res, 200, {
      success: true,
      data: {
        ...employee,
        firstName: "Ana",
        lastName: "Pérez",
        nationalId: "V-00000000",
        email: "ana.perez@example.test",
        phone: null,
        positionTitle: "Operadora NOC",
        departmentName: "NOC",
        supervisorName: null,
        site: "Sede de prueba",
        hireDate: "2020-01-15",
      },
    });
    return;
  }
  if (url.pathname === "/api/v1/absences/internal/leave-balance") {
    send(res, 200, {
      success: true,
      data: { employeeId: url.searchParams.get("employeeId"), availableDays: 12 },
    });
    return;
  }
  if (url.pathname === "/api/v1/time/internal/active-shift") {
    const tenantHeader = req.headers["x-tenant-id"];
    state.activeShiftCalls.push({
      employeeId: url.searchParams.get("employeeId"),
      tenantId: typeof tenantHeader === "string" ? tenantHeader : undefined,
    });
    send(res, state.activeShift.status, state.activeShift.body);
    return;
  }
  send(res, 404, { success: false, code: "NOTFOUND", data: null });
};

export interface Harness {
  readonly app: FastifyInstance;
  readonly upstream: UpstreamState;
  readonly uow: InMemoryUnitOfWork;
  readonly clock: ManualClock;
  close(): Promise<void>;
}

/** Una por fichero de test: el controller es `@singleton()` y captura los dobles al construirse. */
export const buildHarness = async (): Promise<Harness> => {
  const upstream: UpstreamState = {
    principals: new Map(),
    employees: new Map(),
    peopleStatus: null,
    activeShift: { status: 200, body: { success: true, data: { shiftName: null } } },
    activeShiftCalls: [],
  };
  const server: Server = createServer((req, res) => {
    handle(upstream, req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  const uow = new InMemoryUnitOfWork();
  const clock = new ManualClock();
  // Claves de relleno: el doble no las comprueba y no son secretos de ningún entorno.
  const key = "test-key-not-a-secret";
  container.registerInstance(TOKENS.Logger, rootLogger());
  container.registerInstance(TOKENS.Clock, clock);
  container.registerInstance(TOKENS.UnitOfWork, uow);
  container.registerInstance(TOKENS.IdGenerator, new UuidV4IdGenerator());
  container.registerInstance(
    TOKENS.IdentityClient,
    new IdentityClient(baseUrl, key, UPSTREAM_TIMEOUT_MS),
  );
  container.registerInstance(TOKENS.PeopleClient, new PeopleClient(baseUrl, UPSTREAM_TIMEOUT_MS));
  container.registerInstance(
    TOKENS.PeopleInternalClient,
    new PeopleInternalClient(baseUrl, key, UPSTREAM_TIMEOUT_MS),
  );
  container.registerInstance(
    TOKENS.PayrollClient,
    new PayrollClient(baseUrl, key, UPSTREAM_TIMEOUT_MS),
  );
  container.registerInstance(
    TOKENS.AbsencesClient,
    new AbsencesClient(baseUrl, key, UPSTREAM_TIMEOUT_MS),
  );
  container.registerInstance(TOKENS.TimeClient, new TimeClient(baseUrl, key, UPSTREAM_TIMEOUT_MS));

  const app = await buildHttpApp();
  await app.ready();

  return {
    app,
    upstream,
    uow,
    clock,
    close: async () => {
      await app.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
};

// ───────────────────────────── Datos de prueba ─────────────────────────────

/** Instante UTC de una hora local de Venezuela (`AAAA-MM-DDTHH:MM[:SS]`, UTC-4). */
export const vet = (local: string): Date =>
  new Date(`${local}${local.length === 16 ? ":00" : ""}-04:00`);

/** Asignación del contrato nuevo de `active-shift` (JSON), con `endAt` al día siguiente si cruza. */
export const assignmentJson = (
  workDate: string,
  startTime: string,
  endTime: string,
  shiftName: string,
  options: { breakMinutes?: number; isNightShift?: boolean } = {},
): Record<string, unknown> => {
  const startAt = vet(`${workDate}T${startTime}`);
  let endAt = vet(`${workDate}T${endTime}`);
  if (endAt.getTime() <= startAt.getTime()) {
    endAt = new Date(endAt.getTime() + 24 * 60 * 60 * 1000);
  }
  return {
    workDate,
    shiftName,
    startTime,
    endTime,
    breakMinutes: options.breakMinutes ?? 60,
    isNightShift: options.isNightShift ?? false,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
  };
};

export const SETTINGS_JSON = {
  checkInWindowBeforeMinutes: 60,
  abandonAfterMinutes: 80,
  lateArrivalGraceMinutes: 15,
  earlyDepartureGraceMinutes: 0,
};

export const activeShiftOk = (
  shiftName: string | null,
  assignments: readonly Record<string, unknown>[],
  settings: Record<string, unknown> = SETTINGS_JSON,
): UpstreamResponse => ({
  status: 200,
  body: { success: true, statusCode: 200, data: { shiftName, assignments, settings } },
});
