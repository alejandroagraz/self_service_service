/**
 * Arnés de los tests HTTP/contrato: el MISMO ensamblado de Fastify que producción (`buildHttpApp`:
 * rutas, preHandlers, manejador de errores, OpenAPI) con dobles en los bordes:
 *
 *   - Un servidor HTTP local (`node:http`) hace de identity (`/sessions/verify`), de people
 *     (`/employees/me`), de time (`/time/internal/active-shift` y la jornada consolidada
 *     `/time/internal/work-sessions/*`, Lote 4.4B1, y las horas extra excepcionales
 *     `/time/internal/overtime-*` y `/time/internal/team/overtime-exceptions*`, Lote 4.4B2), de payroll
 *     (`/payroll/internal/payslips`), de absences (`/absences/internal/leave-balance`,
 *     `employee-month-absences` y `employee-requests`) y de documents
 *     (`/documents/internal/:id/content` y, desde el Lote 4.5A, `evidence`, `evidence/verify`,
 *     `upload-policy` y `employees/:id/documents`; más `evidence-access` de people). Los clientes REALES (`IdentityClient`, `PeopleClient`,
 *     `TimeClient`, `WorkSessionClient`, `OvertimeClient`, `PayrollClient`, `AbsencesClient`, `DocumentsClient`) le
 *     hablan por red, así que también se prueban su parseo y su mapeo de errores, sin depender de los
 *     servicios reales (que otros agentes están ampliando).
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
import { DocumentsClient } from "../../src/shared/infrastructure/http/documents-client";
import { IdentityClient } from "../../src/shared/infrastructure/http/identity-client";
import { OvertimeClient } from "../../src/shared/infrastructure/http/overtime-client";
import { PayrollClient } from "../../src/shared/infrastructure/http/payroll-client";
import { PeopleClient } from "../../src/shared/infrastructure/http/people-client";
import { PeopleInternalClient } from "../../src/shared/infrastructure/http/people-internal-client";
import { buildHttpApp } from "../../src/shared/infrastructure/http/server";
import { TimeClient } from "../../src/shared/infrastructure/http/time-client";
import { WorkSessionClient } from "../../src/shared/infrastructure/http/work-session-client";
import { UuidV4IdGenerator } from "../../src/shared/infrastructure/services/uuid-v4-id-generator";
import { rootLogger } from "../../src/shared/infrastructure/services/winston-logger";

export const API = "/api/v1/self-service";
/** Clave de relleno de los clientes de confianza (no es un secreto de ningún entorno). */
export const TEST_SERVICE_KEY = "test-key-not-a-secret";
/**
 * Clave de relleno de ESCRITURA hacia time (Lote 4.4B1, C12), distinta de la de lectura: los tests
 * comprueban que solo viaja en los POST de `work-sessions`.
 */
export const TEST_TIME_WRITE_KEY = "test-write-key-not-a-secret";
/** Clave de relleno de ESCRITURA hacia documents (Lote 4.5A, C7), distinta de la de lectura. */
export const TEST_DOCUMENTS_UPLOAD_KEY = "test-documents-upload-key-not-a-secret";
const UPSTREAM_TIMEOUT_MS = 2_000;
const UPLOAD_TIMEOUT_MS = 10_000;

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

  async findById(id: string): Promise<ClockPunch | null> {
    return (
      [...this.committed, ...this.staged].find(
        (row) => row.tenantId === this.tenantId && row.punch.id === id,
      )?.punch ?? null
    );
  }

  /** `ON CONFLICT (id) DO NOTHING`: la PK es global (no por tenant), como en PostgreSQL. */
  async insertIfAbsent(punch: ClockPunch): Promise<boolean> {
    if ([...this.committed, ...this.staged].some((row) => row.punch.id === punch.id)) {
      return false;
    }
    this.staged.push({ tenantId: this.tenantId, punch });
    return true;
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
  employees: Map<string, TestEmployee>;
  /** Fuerza el status de `/employees/me` (p. ej. 503 = people caído). */
  peopleStatus: number | null;
  /** Respuesta de `/time/internal/active-shift`. */
  activeShift: UpstreamResponse;
  /** Peticiones recibidas en `active-shift` (para verificar cabeceras y query). */
  activeShiftCalls: { employeeId: string | null; tenantId: string | undefined }[];
  /** Respuesta de `POST /time/internal/work-sessions/punches` (función: según el cuerpo). */
  punches: UpstreamResponse | ((body: Record<string, unknown>) => UpstreamResponse);
  /** Respuesta de `GET /time/internal/work-sessions/current`. */
  currentSession: UpstreamResponse;
  /** Respuesta de `POST /time/internal/work-sessions/:id/overrun-answer`. */
  overrunAnswer:
    UpstreamResponse | ((sessionId: string, body: Record<string, unknown>) => UpstreamResponse);
  /** Peticiones recibidas en `work-sessions/*` (cabeceras de confianza, query y cuerpo). */
  workSessionCalls: WorkSessionCall[];
  /**
   * Respuestas de las rutas internas de horas extra excepcionales (Lote 4.4B2). `validation` puede ser
   * una función del id de la ruta (p. ej. para simular una solicitud ajena o inexistente).
   */
  overtime: {
    submit: UpstreamResponse;
    ownRequests: UpstreamResponse;
    balance: UpstreamResponse;
    teamList: UpstreamResponse;
    validation:
      UpstreamResponse | ((requestId: string, body: Record<string, unknown>) => UpstreamResponse);
  };
  /** Peticiones recibidas en las rutas de horas extra (cabeceras de confianza, query y cuerpo). */
  overtimeCalls: WorkSessionCall[];
  /** TODAS las peticiones recibidas por el doble (método, ruta y clave interna presentada). */
  allCalls: { method: string; path: string; apiKey: string | undefined }[];
  /** employeeId → filas de `/payroll/internal/payslips` (ausente → lista vacía). */
  payslips: Map<string, readonly Record<string, unknown>[]>;
  /** Fuerza el status de `/payroll/internal/payslips` (p. ej. 503 = payroll caído). */
  payrollStatus: number | null;
  /** Peticiones recibidas en payroll `internal/payslips`. */
  payrollCalls: { employeeId: string | null; tenantId: string | undefined }[];
  /**
   * documentId → respuesta de documents `/internal/:id/content` (ausente → 404). Con `owner`, un
   * `x-employee-id` distinto responde 404 (C7); `headers` se añaden a la respuesta 200.
   */
  documents: Map<
    string,
    {
      status: number;
      pdf?: Buffer;
      owner?: string;
      /** Kind del documento: con `?kind=` distinto, 404 (filtro M-3 de documents). */
      kind?: string;
      headers?: Record<string, string>;
    }
  >;
  /** Peticiones recibidas en documents `/internal/:id/content` (cabeceras de confianza). */
  documentsCalls: DocumentsCall[];
  /** Respuesta de absences `/internal/employee-month-absences`. */
  monthAbsences: UpstreamResponse;
  /** Respuesta de absences `/internal/employee-requests` (contrato 4.4A §1.4). */
  absenceRequests: UpstreamResponse;
  /** Peticiones recibidas en absences `employee-month-absences` y `employee-requests`. */
  absencesCalls: AbsencesCall[];
  /** Respuestas de las rutas internas de documents del Lote 4.5A. */
  documentsApi: {
    evidence: UpstreamResponse;
    verify: UpstreamResponse | ((body: Record<string, unknown>) => UpstreamResponse);
    uploadPolicy: UpstreamResponse;
    employeeDocuments: UpstreamResponse;
  };
  /** Peticiones recibidas en esas rutas (cabeceras de confianza y cuerpo CRUDO). */
  documentsApiCalls: DocumentsApiCall[];
  /** Respuesta de people `GET /time/internal/overtime-requests/:id/evidence-access`. */
  evidenceAccess:
    UpstreamResponse | ((requestId: string, query: Record<string, string>) => UpstreamResponse);
}

export interface DocumentsApiCall {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly tenantId: string | undefined;
  readonly serviceName: string | undefined;
  readonly apiKey: string | undefined;
  readonly employeeId: string | undefined;
  readonly fileName: string | undefined;
  readonly contentType: string | undefined;
  readonly contentLength: string | undefined;
  readonly authorization: string | undefined;
  readonly body: Buffer;
}

export interface WorkSessionCall {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown> | null;
  readonly tenantId: string | undefined;
  readonly serviceName: string | undefined;
  readonly apiKey: string | undefined;
  readonly actingUserId: string | undefined;
  readonly authorization: string | undefined;
}

export interface AbsencesCall {
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly tenantId: string | undefined;
  readonly serviceName: string | undefined;
  readonly apiKey: string | undefined;
  readonly authorization: string | undefined;
}

export interface TestEmployee {
  readonly employeeId: string;
  readonly userId: string;
  readonly fullName: string;
  /** `serviceYears` que devolvería people (GAP-033 §6); ausente → el campo no viaja. */
  readonly serviceYears?: unknown;
}

export interface DocumentsCall {
  readonly documentId: string;
  /** `?kind=` pedido (M-3), o `undefined` si no viaja. */
  readonly kind: string | undefined;
  readonly tenantId: string | undefined;
  readonly employeeId: string | undefined;
  readonly serviceName: string | undefined;
  readonly apiKey: string | undefined;
  readonly authorization: string | undefined;
}

const headerOf = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
};

const DOCUMENT_CONTENT_PATH = /^\/api\/v1\/documents\/internal\/([^/]+)\/content$/;
const WORK_SESSIONS_PREFIX = "/api/v1/time/internal/work-sessions";
const OVERTIME_PATHS = [
  "/api/v1/time/internal/overtime-exceptions",
  "/api/v1/time/internal/overtime-requests",
  "/api/v1/time/internal/overtime-balance",
  "/api/v1/time/internal/team/overtime-exceptions",
];
const TEAM_VALIDATION_PATH =
  /^\/api\/v1\/time\/internal\/team\/overtime-exceptions\/([^/]+)\/validation$/;
const OVERRUN_ANSWER_PATH = /^\/api\/v1\/time\/internal\/work-sessions\/([^/]+)\/overrun-answer$/;
const EVIDENCE_ACCESS_PATH =
  /^\/api\/v1\/time\/internal\/overtime-requests\/([^/]+)\/evidence-access$/;
const DOCUMENTS_INTERNAL = "/api/v1/documents/internal";
const EMPLOYEE_DOCUMENTS_PATH = /^\/api\/v1\/documents\/internal\/employees\/([^/]+)\/documents$/;

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const bearer = (req: IncomingMessage): string | null => {
  const header = req.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
};

const trustedCallOf = (
  req: IncomingMessage,
  url: URL,
  body: Record<string, unknown> | null,
): WorkSessionCall => ({
  method: req.method ?? "GET",
  path: url.pathname,
  query: Object.fromEntries(url.searchParams.entries()),
  body,
  tenantId: headerOf(req, "x-tenant-id"),
  serviceName: headerOf(req, "x-service-name"),
  apiKey: headerOf(req, "x-internal-api-key"),
  actingUserId: headerOf(req, "x-acting-user-id"),
  authorization: headerOf(req, "authorization"),
});

const parseBody = (rawBody: string): Record<string, unknown> | null => {
  try {
    return rawBody.length === 0 ? null : (JSON.parse(rawBody) as Record<string, unknown>);
  } catch {
    return null;
  }
};

const isOvertimePath = (pathname: string): boolean =>
  OVERTIME_PATHS.includes(pathname) ||
  TEAM_VALIDATION_PATH.test(pathname) ||
  EVIDENCE_ACCESS_PATH.test(pathname);

/** Rutas internas de documents del Lote 4.5A (todas salvo `/:id/content`). */
const handleDocumentsApi = (
  state: UpstreamState,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rawBody: Buffer,
): boolean => {
  const route = `${req.method ?? "GET"} ${url.pathname}`;
  let response: UpstreamResponse | undefined;
  if (route === `POST ${DOCUMENTS_INTERNAL}/evidence`) {
    response = state.documentsApi.evidence;
  } else if (route === `POST ${DOCUMENTS_INTERNAL}/evidence/verify`) {
    const { verify } = state.documentsApi;
    response =
      typeof verify === "function" ? verify(parseBody(rawBody.toString("utf8")) ?? {}) : verify;
  } else if (route === `GET ${DOCUMENTS_INTERNAL}/upload-policy`) {
    response = state.documentsApi.uploadPolicy;
  } else if (req.method === "GET" && EMPLOYEE_DOCUMENTS_PATH.test(url.pathname)) {
    response = state.documentsApi.employeeDocuments;
  }
  if (response === undefined) {
    return false;
  }
  state.documentsApiCalls.push({
    method: req.method ?? "GET",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    tenantId: headerOf(req, "x-tenant-id"),
    serviceName: headerOf(req, "x-service-name"),
    apiKey: headerOf(req, "x-internal-api-key"),
    employeeId: headerOf(req, "x-employee-id"),
    fileName: headerOf(req, "x-file-name"),
    contentType: headerOf(req, "content-type"),
    contentLength: headerOf(req, "content-length"),
    authorization: headerOf(req, "authorization"),
    body: rawBody,
  });
  send(res, response.status, response.body);
  return true;
};

const handleOvertime = (
  state: UpstreamState,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Record<string, unknown> | null,
): void => {
  state.overtimeCalls.push(trustedCallOf(req, url, body));
  const { overtime } = state;
  const route = `${req.method ?? "GET"} ${url.pathname}`;
  const validationMatch = TEAM_VALIDATION_PATH.exec(url.pathname);
  const evidenceMatch = EVIDENCE_ACCESS_PATH.exec(url.pathname);
  let response: UpstreamResponse | undefined;
  if (route === `POST ${OVERTIME_PATHS[0]}`) {
    response = overtime.submit;
  } else if (route === `GET ${OVERTIME_PATHS[1]}`) {
    response = overtime.ownRequests;
  } else if (route === `GET ${OVERTIME_PATHS[2]}`) {
    response = overtime.balance;
  } else if (route === `GET ${OVERTIME_PATHS[3]}`) {
    response = overtime.teamList;
  } else if (req.method === "POST" && validationMatch !== null) {
    const requestId = decodeURIComponent(validationMatch[1]);
    response =
      typeof overtime.validation === "function"
        ? overtime.validation(requestId, body ?? {})
        : overtime.validation;
  } else if (req.method === "GET" && evidenceMatch !== null) {
    const requestId = decodeURIComponent(evidenceMatch[1]);
    response =
      typeof state.evidenceAccess === "function"
        ? state.evidenceAccess(requestId, Object.fromEntries(url.searchParams.entries()))
        : state.evidenceAccess;
  }
  if (response === undefined) {
    send(res, 404, { success: false, code: "NOTFOUND", data: null });
    return;
  }
  send(res, response.status, response.body);
};

const handleWorkSessions = (
  state: UpstreamState,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Record<string, unknown> | null,
): void => {
  state.workSessionCalls.push({
    method: req.method ?? "GET",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    body,
    tenantId: headerOf(req, "x-tenant-id"),
    serviceName: headerOf(req, "x-service-name"),
    apiKey: headerOf(req, "x-internal-api-key"),
    actingUserId: headerOf(req, "x-acting-user-id"),
    authorization: headerOf(req, "authorization"),
  });
  if (req.method === "POST" && url.pathname === `${WORK_SESSIONS_PREFIX}/punches`) {
    const response =
      typeof state.punches === "function" ? state.punches(body ?? {}) : state.punches;
    send(res, response.status, response.body);
    return;
  }
  if (req.method === "GET" && url.pathname === `${WORK_SESSIONS_PREFIX}/current`) {
    send(res, state.currentSession.status, state.currentSession.body);
    return;
  }
  const answerMatch = OVERRUN_ANSWER_PATH.exec(url.pathname);
  if (req.method === "POST" && answerMatch !== null) {
    const sessionId = decodeURIComponent(answerMatch[1]);
    const response =
      typeof state.overrunAnswer === "function"
        ? state.overrunAnswer(sessionId, body ?? {})
        : state.overrunAnswer;
    send(res, response.status, response.body);
    return;
  }
  send(res, 404, { success: false, code: "NOTFOUND", data: null });
};

const handle = (
  state: UpstreamState,
  req: IncomingMessage,
  res: ServerResponse,
  rawBytes: Buffer,
): void => {
  const rawBody = rawBytes.toString("utf8");
  const url = new URL(req.url ?? "/", "http://upstream.test");
  state.allCalls.push({
    method: req.method ?? "GET",
    path: url.pathname,
    apiKey: headerOf(req, "x-internal-api-key"),
  });
  if (handleDocumentsApi(state, req, res, url, rawBytes)) {
    return;
  }
  if (isOvertimePath(url.pathname)) {
    handleOvertime(state, req, res, url, parseBody(rawBody));
    return;
  }
  if (url.pathname.startsWith(`${WORK_SESSIONS_PREFIX}/`)) {
    let body: Record<string, unknown> | null = null;
    try {
      body = rawBody.length === 0 ? null : (JSON.parse(rawBody) as Record<string, unknown>);
    } catch {
      body = null;
    }
    handleWorkSessions(state, req, res, url, body);
    return;
  }
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
  if (
    url.pathname === "/api/v1/absences/internal/employee-month-absences" ||
    url.pathname === "/api/v1/absences/internal/employee-requests"
  ) {
    state.absencesCalls.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      tenantId: headerOf(req, "x-tenant-id"),
      serviceName: headerOf(req, "x-service-name"),
      apiKey: headerOf(req, "x-internal-api-key"),
      authorization: headerOf(req, "authorization"),
    });
    const response = url.pathname.endsWith("/employee-requests")
      ? state.absenceRequests
      : state.monthAbsences;
    send(res, response.status, response.body);
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
  if (url.pathname === "/api/v1/payroll/internal/payslips") {
    const employeeId = url.searchParams.get("employeeId");
    state.payrollCalls.push({ employeeId, tenantId: headerOf(req, "x-tenant-id") });
    if (state.payrollStatus !== null) {
      send(res, state.payrollStatus, { success: false, code: "PAYCOM0004", data: null });
      return;
    }
    send(res, 200, {
      success: true,
      statusCode: 200,
      data: state.payslips.get(employeeId ?? "") ?? [],
    });
    return;
  }
  const documentMatch = DOCUMENT_CONTENT_PATH.exec(url.pathname);
  if (documentMatch !== null) {
    const documentId = decodeURIComponent(documentMatch[1]);
    const kindFilter = url.searchParams.get("kind") ?? undefined;
    state.documentsCalls.push({
      documentId,
      kind: kindFilter,
      tenantId: headerOf(req, "x-tenant-id"),
      employeeId: headerOf(req, "x-employee-id"),
      serviceName: headerOf(req, "x-service-name"),
      apiKey: headerOf(req, "x-internal-api-key"),
      authorization: headerOf(req, "authorization"),
    });
    const document = state.documents.get(documentId);
    if (
      document === undefined ||
      (document.owner !== undefined && document.owner !== headerOf(req, "x-employee-id")) ||
      (kindFilter !== undefined && document.kind !== kindFilter)
    ) {
      send(res, 404, { success: false, code: "DOCDOC0001", data: null });
      return;
    }
    if (document.status !== 200 || document.pdf === undefined) {
      send(res, document.status, { success: false, code: "DOCDOC0009", data: null });
      return;
    }
    res.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": String(document.pdf.length),
      ...document.headers,
    });
    res.end(document.pdf);
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

const UNAVAILABLE: UpstreamResponse = {
  status: 503,
  body: { success: false, code: "PPLCOM0004", data: null },
};

/** Una por fichero de test: el controller es `@singleton()` y captura los dobles al construirse. */
export const buildHarness = async (): Promise<Harness> => {
  const upstream: UpstreamState = {
    principals: new Map(),
    employees: new Map(),
    peopleStatus: null,
    activeShift: { status: 200, body: { success: true, data: { shiftName: null } } },
    activeShiftCalls: [],
    punches: { status: 503, body: { success: false, code: "PPLCOM0004", data: null } },
    currentSession: { status: 200, body: { success: true, statusCode: 200, data: null } },
    overrunAnswer: { status: 503, body: { success: false, code: "PPLCOM0004", data: null } },
    workSessionCalls: [],
    overtime: {
      submit: UNAVAILABLE,
      ownRequests: UNAVAILABLE,
      balance: UNAVAILABLE,
      teamList: UNAVAILABLE,
      validation: UNAVAILABLE,
    },
    overtimeCalls: [],
    allCalls: [],
    payslips: new Map(),
    payrollStatus: null,
    payrollCalls: [],
    documents: new Map(),
    documentsCalls: [],
    monthAbsences: { status: 200, body: { success: true, data: [] } },
    absenceRequests: { status: 200, body: { success: true, data: [] } },
    absencesCalls: [],
    documentsApi: {
      evidence: UNAVAILABLE,
      verify: UNAVAILABLE,
      uploadPolicy: UNAVAILABLE,
      employeeDocuments: UNAVAILABLE,
    },
    documentsApiCalls: [],
    evidenceAccess: UNAVAILABLE,
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      handle(upstream, req, res, Buffer.concat(chunks));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  const uow = new InMemoryUnitOfWork();
  const clock = new ManualClock();
  // Claves de relleno: el doble no las comprueba y no son secretos de ningún entorno.
  const key = TEST_SERVICE_KEY;
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
  container.registerInstance(
    TOKENS.WorkSessionClient,
    new WorkSessionClient(baseUrl, key, TEST_TIME_WRITE_KEY, UPSTREAM_TIMEOUT_MS),
  );
  container.registerInstance(
    TOKENS.OvertimeClient,
    new OvertimeClient(baseUrl, key, TEST_TIME_WRITE_KEY, UPSTREAM_TIMEOUT_MS),
  );
  container.registerInstance(
    TOKENS.DocumentsClient,
    new DocumentsClient(
      baseUrl,
      key,
      TEST_DOCUMENTS_UPLOAD_KEY,
      UPSTREAM_TIMEOUT_MS,
      UPLOAD_TIMEOUT_MS,
    ),
  );

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

/**
 * `WorkSessionDto` del contrato 4.4B1 §3 (JSON, todos los campos presentes). Por defecto, una jornada
 * `ACTIVE` sin turno ni aviso, con entrada a las 08:00 VET del 2026-11-23.
 */
export const workSessionJson = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  sessionId: randomUUID(),
  status: "ACTIVE",
  punctuality: "IN_PROGRESS",
  workDate: "2026-11-23",
  shiftAssignmentId: null,
  scheduledStartAt: null,
  scheduledEndAt: null,
  clockInAt: vet("2026-11-23T08:00").toISOString(),
  clockOutAt: null,
  closeReason: null,
  onBreak: false,
  overrun: null,
  overtimeRequestId: null,
  unrecordedOvertimeMinutes: 0,
  postCloseCheckoutAt: null,
  ...overrides,
});

/** Envelope 201 de people (altas). */
export const createdData = (data: unknown): UpstreamResponse => ({
  status: 201,
  body: { success: true, statusCode: 201, message: "creado", data },
});

/** Envelope paginado de people (`meta` C2). */
export const pagedData = (
  data: readonly unknown[],
  meta: { page?: number; pageSize?: number; total?: number; totalPages?: number } = {},
): UpstreamResponse => {
  const pageSize = meta.pageSize ?? 20;
  const total = meta.total ?? data.length;
  return {
    status: 200,
    body: {
      success: true,
      statusCode: 200,
      message: "ok",
      data,
      meta: {
        page: meta.page ?? 1,
        pageSize,
        total,
        totalPages: meta.totalPages ?? Math.max(1, Math.ceil(total / pageSize)),
      },
    },
  };
};

export const okData = (data: unknown): UpstreamResponse => ({
  status: 200,
  body: { success: true, statusCode: 200, message: "ok", data },
});

/** Envelope de error de people (C1) con su `code` y `errors`. */
export const peopleError = (
  status: number,
  code: string,
  errors: readonly { field: string; issue: string }[] = [],
): UpstreamResponse => ({
  status,
  body: {
    success: false,
    statusCode: status,
    code,
    message: "error de people",
    data: null,
    errors,
  },
});
