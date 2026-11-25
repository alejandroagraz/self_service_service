/**
 * Lote 4.4B1 — Contrato de respuesta de la jornada de people (`WorkSessionDto`, contrato §3) visto
 * desde el BFF: validación ESTRICTA (todo campo presente, `null` explícito donde se admite). Un campo
 * ausente o ilegible es un contrato roto (`parseWorkSession` lanza → el cliente responde 503). La ida
 * y vuelta por red y el mapeo de códigos los cubren los tests de `tests/http`.
 */
import "../support/test-env";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  parseCurrentWorkSession,
  parseOverrunAnswer,
  parseWorkSession,
} from "../../src/shared/infrastructure/http/work-session-client";

const SESSION = randomUUID();

const valid = (): Record<string, unknown> => ({
  sessionId: SESSION,
  status: "ACTIVE",
  punctuality: "IN_PROGRESS",
  workDate: "2026-11-23",
  shiftAssignmentId: randomUUID(),
  scheduledStartAt: "2026-11-23T12:00:00.000Z",
  scheduledEndAt: "2026-11-23T20:00:00.000Z",
  clockInAt: "2026-11-23T11:55:00.000Z",
  clockOutAt: null,
  closeReason: null,
  onBreak: false,
  overrun: {
    sessionId: SESSION,
    cycle: 1,
    noticesSent: 1,
    nextNoticeAt: "2026-11-23T20:30:00.000Z",
    abandonAt: "2026-11-23T21:20:00.000Z",
    awaitingAnswer: true,
  },
  overtimeRequestId: null,
  unrecordedOvertimeMinutes: 0,
  postCloseCheckoutAt: null,
});

test("jornada válida: instantes como Date, overrun incluido", () => {
  const session = parseWorkSession(valid());
  assert.equal(session.sessionId, SESSION);
  assert.equal(session.status, "ACTIVE");
  assert.equal(session.clockInAt?.toISOString(), "2026-11-23T11:55:00.000Z");
  assert.equal(session.overrun?.abandonAt.toISOString(), "2026-11-23T21:20:00.000Z");
  assert.equal(session.overrun?.awaitingAnswer, true);
  assert.equal(session.onBreak, false);
  assert.equal(parseWorkSession({ ...valid(), onBreak: true }).onBreak, true, "pausa de people");
  assert.equal(parseCurrentWorkSession(null), null, "data: null = sin jornada vigente");
});

test("contrato roto: campo ausente, valor fuera de dominio, instante sin zona u overrun de otra jornada", () => {
  const broken: Record<string, unknown>[] = [];
  for (const field of Object.keys(valid())) {
    const missing = valid();
    delete missing[field];
    broken.push(missing);
  }
  broken.push(
    { ...valid(), status: "IN_PROGRESS" },
    { ...valid(), punctuality: "TARDE" },
    { ...valid(), closeReason: "OTRO" },
    { ...valid(), workDate: "2026-11-23T00:00" },
    { ...valid(), clockInAt: "2026-11-23T07:55:00" },
    { ...valid(), clockInAt: "ayer" },
    { ...valid(), unrecordedOvertimeMinutes: -1 },
    { ...valid(), onBreak: "false" },
    { ...valid(), overrun: { ...(valid().overrun as object), sessionId: randomUUID() } },
    { ...valid(), overrun: { ...(valid().overrun as object), cycle: 1.5 } },
  );
  for (const raw of broken) {
    assert.throws(
      () => parseWorkSession(raw),
      undefined,
      `debe rechazarse: ${JSON.stringify(raw)}`,
    );
  }
  assert.throws(() => parseCurrentWorkSession(undefined));
});

test("overrun-answer: la respuesta debe ser de la jornada pedida", () => {
  const ok = parseOverrunAnswer(
    {
      sessionId: SESSION,
      status: "ACTIVE",
      overtimeRequestId: null,
      answeredAt: "2026-11-23T20:31:00Z",
    },
    SESSION.toUpperCase(),
  );
  assert.equal(ok.answeredAt.toISOString(), "2026-11-23T20:31:00.000Z");
  assert.throws(() =>
    parseOverrunAnswer(
      {
        sessionId: randomUUID(),
        status: "ACTIVE",
        overtimeRequestId: null,
        answeredAt: "2026-11-23T20:31:00Z",
      },
      SESSION,
    ),
  );
});
