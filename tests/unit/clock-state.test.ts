/**
 * Lote 4.4B1 (GAP-043) — `deriveClockState`: traducción de la jornada vigente de people al estado de
 * cuatro valores del portal. La pausa (`ON_BREAK`) sale de `onBreak` de people (contrato §3, «Pausa
 * y reanudación»); las marcaciones propias solo aportan `since`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveClockState,
  type PunchFact,
  type SessionFacts,
} from "../../src/modules/self-portal/domain/services/clock-status";

const at = (hhmm: string): Date => new Date(`2026-11-23T${hhmm}:00-04:00`);

const session = (overrides: Partial<SessionFacts> = {}): SessionFacts => ({
  status: "ACTIVE",
  onBreak: false,
  clockInAt: at("08:00"),
  clockOutAt: null,
  postCloseCheckoutAt: null,
  ...overrides,
});

const punch = (action: PunchFact["action"], hhmm: string): PunchFact => ({
  action,
  punchedAt: at(hhmm),
});

test("sin jornada o jornada ABSENT → NOT_STARTED (aunque haya marcaciones propias)", () => {
  assert.deepEqual(deriveClockState(null, null), { status: "NOT_STARTED", since: null });
  assert.deepEqual(deriveClockState(null, punch("CHECK_IN", "07:00")), {
    status: "NOT_STARTED",
    since: null,
  });
  assert.equal(
    deriveClockState(session({ status: "ABSENT", clockInAt: null }), null).status,
    "NOT_STARTED",
  );
});

test("ACTIVE → CLOCKED_IN desde la entrada de people", () => {
  assert.deepEqual(deriveClockState(session(), null), {
    status: "CLOCKED_IN",
    since: at("08:00"),
  });
  // Una marcación propia de una jornada anterior no cuenta.
  assert.equal(deriveClockState(session(), punch("BREAK", "07:59")).status, "CLOCKED_IN");
});

test("ACTIVE con onBreak de people → ON_BREAK (since = el BREAK propio de esta jornada, si se conoce)", () => {
  assert.deepEqual(deriveClockState(session({ onBreak: true }), punch("BREAK", "12:00")), {
    status: "ON_BREAK",
    since: at("12:00"),
  });
  assert.deepEqual(deriveClockState(session({ onBreak: true }), null), {
    status: "ON_BREAK",
    since: null,
  });
});

test("la pausa la decide people: un BREAK propio con onBreak false (ya reanudada) → CLOCKED_IN", () => {
  assert.deepEqual(deriveClockState(session(), punch("BREAK", "12:00")), {
    status: "CLOCKED_IN",
    since: at("08:00"),
  });
  // Reanudación: el CHECK_IN propio posterior a la entrada fija `since`.
  assert.deepEqual(deriveClockState(session(), punch("CHECK_IN", "13:00")), {
    status: "CLOCKED_IN",
    since: at("13:00"),
  });
});

test("COMPLETED / INCOMPLETE → CLOCKED_OUT; tras un cierre automático, desde la salida registrada", () => {
  assert.deepEqual(
    deriveClockState(session({ status: "COMPLETED", clockOutAt: at("16:00") }), null),
    { status: "CLOCKED_OUT", since: at("16:00") },
  );
  assert.deepEqual(
    deriveClockState(
      session({ status: "INCOMPLETE", clockOutAt: at("17:20"), postCloseCheckoutAt: at("18:00") }),
      punch("BREAK", "12:00"),
    ),
    { status: "CLOCKED_OUT", since: at("18:00") },
  );
});
