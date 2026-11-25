/**
 * Puerto saliente hacia la JORNADA CONSOLIDADA de people (contexto time, GAP-043, Lote 4.4B1). Rutas
 * internas `/api/v1/time/internal/work-sessions/*` (no expuestas por Traefik), confianza per-caller:
 * NO reenvía el token del usuario.
 *
 * Dos claves distintas (guardian C12): la de ESCRITURA (`TIME_INTERNAL_WRITE_KEY_FILE`) solo en los
 * POST (`punch`, `answerOverrun`); la de LECTURA (`TIME_INTERNAL_READ_KEY_FILE`, la de `active-shift`)
 * en el GET (`getCurrentWorkSession`). Toda llamada lleva además `X-Tenant-Id` (tenant del principal)
 * y `X-Acting-User-Id` (userId del principal verificado, C13): people comprueba que el empleado es
 * del usuario y que no está `TERMINATED`.
 *
 * El adaptador traduce los códigos de people a los del BFF (contrato 4.4B1 §7) y cualquier otro fallo
 * (red, timeout, 5xx, 4xx no previsto o contrato de respuesta roto) a `SELF_UPSTREAM_UNAVAILABLE`
 * (503, fail-closed). Ver `work-session-client.ts`.
 */
import type { ClockAction, OverrunAnswer, SessionStatus } from "../../domain/services/clock-status";

/** Quién llama: siempre del principal verificado, nunca de una cabecera del cliente. */
export interface WorkSessionCaller {
  readonly tenantId: string;
  readonly actingUserId: string;
}

/** Aviso de fin de turno abierto sobre la jornada (`overrun` de `WorkSessionDto`). */
export interface OverrunNoticeDto {
  readonly sessionId: string;
  readonly cycle: number;
  readonly noticesSent: number;
  /** Próximo aviso; `null` si ya no quedan avisos antes del cierre. */
  readonly nextNoticeAt: Date | null;
  readonly abandonAt: Date;
  readonly awaitingAnswer: boolean;
}

/** `WorkSessionDto` del contrato 4.4B1 §3, con los instantes ya como `Date`. */
export interface WorkSessionDto {
  readonly sessionId: string;
  readonly status: SessionStatus;
  /** Puntualidad (`ON_TIME|LATE_ARRIVAL|EARLY_DEPARTURE|ABSENT|IN_PROGRESS`) o `null`. */
  readonly punctuality: string | null;
  readonly workDate: string;
  readonly shiftAssignmentId: string | null;
  readonly scheduledStartAt: Date | null;
  readonly scheduledEndAt: Date | null;
  readonly clockInAt: Date | null;
  readonly clockOutAt: Date | null;
  readonly closeReason: string | null;
  /** La jornada `ACTIVE` está en pausa (`on_break_since IS NOT NULL` en people). */
  readonly onBreak: boolean;
  readonly overrun: OverrunNoticeDto | null;
  readonly overtimeRequestId: string | null;
  readonly unrecordedOvertimeMinutes: number;
  readonly postCloseCheckoutAt: Date | null;
}

export interface PunchRequest {
  /** Idempotencia en people (y `id` de la fila de `clock_punches`). */
  readonly clockPunchId: string;
  readonly employeeId: string;
  readonly action: ClockAction;
  /** Reloj del BFF; people lo acota a ±5 min del suyo (`TIMCLK0011`). */
  readonly punchedAt: Date;
}

export interface OverrunAnswerResultDto {
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly overtimeRequestId: string | null;
  readonly answeredAt: Date;
}

export interface IWorkSessionClient {
  /**
   * `POST /time/internal/work-sessions/punches` (clave de escritura). Idempotente por
   * `clockPunchId`. Errores: 409 `SSVCLK0002` (`TIMCLK0005`/`TIMCLK0010`, con `errors`), 409
   * `SSVCLK0003` (`TIMCLK0006`), 422 `SSVCLK0001` (`TIMCLK0011`), 403 `SSVCOM0003` (`TIMCLK0012`),
   * 503 `SSVSLF0002` (resto).
   */
  punch(caller: WorkSessionCaller, request: PunchRequest): Promise<WorkSessionDto>;

  /**
   * `GET /time/internal/work-sessions/current?employeeId` (clave de lectura). `null` si no hay
   * jornada vigente. 403 `SSVCOM0003` (`TIMCLK0012`); 503 `SSVSLF0002` (resto).
   */
  getCurrentWorkSession(
    caller: WorkSessionCaller,
    employeeId: string,
  ): Promise<WorkSessionDto | null>;

  /**
   * `POST /time/internal/work-sessions/:id/overrun-answer` (clave de escritura). Errores: 404
   * `SSVSHF0001` (`TIMCLK0007`), 409 `SSVSHF0002` (`TIMCLK0008`), 403 `SSVCOM0003` (`TIMCLK0012`),
   * 503 `SSVSLF0002` (resto).
   */
  answerOverrun(
    caller: WorkSessionCaller,
    sessionId: string,
    request: { readonly employeeId: string; readonly answer: OverrunAnswer },
  ): Promise<OverrunAnswerResultDto>;
}
