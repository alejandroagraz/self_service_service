/**
 * Datos de prueba de las horas extra excepcionales (Lote 4.4B2): respuestas JSON de people con la
 * forma del contrato §2.4 (todos los campos presentes).
 */
import { randomUUID } from "node:crypto";

type Json = Record<string, unknown>;

export const periodJson = (overrides: Json = {}): Json => ({
  limitMinutes: 120,
  usedMinutes: 60,
  remainingMinutes: 60,
  from: "2026-11-23",
  to: "2026-11-23",
  ...overrides,
});

export const balanceJson = (overrides: Json = {}): Json => ({
  daily: periodJson(),
  weekly: periodJson({
    limitMinutes: 600,
    usedMinutes: 120,
    remainingMinutes: 480,
    from: "2026-11-23",
    to: "2026-11-29",
  }),
  monthly: null,
  annual: periodJson({
    limitMinutes: 6000,
    usedMinutes: 900,
    remainingMinutes: 5100,
    from: "2026-01-01",
    to: "2026-12-31",
  }),
  effectiveRemainingMinutes: 60,
  exceptionRequestsEnabled: true,
  exceptionEvidenceRequired: true,
  ...overrides,
});

/** «Item propio» de people (forma del contrato §2.4). */
export const ownItemJson = (overrides: Json = {}): Json => ({
  id: randomUUID(),
  requestType: "EXCEPTION_OVERRIDE",
  status: "PENDING_HR_APPROVAL",
  workDate: "2026-11-22",
  startAt: "2026-11-22T22:00:00.000Z",
  endAt: "2026-11-23T00:00:00.000Z",
  requestedMinutes: 120,
  approvedMinutes: null,
  approvedBreakdown: null,
  categoryBreakdown: [{ category: "NOCTURNA_80", minutes: 120 }],
  exceededLimits: ["DAILY"],
  provisional: false,
  supervisorValidation: { result: "CONFIRMED", validatedAt: "2026-11-23T12:00:00.000Z" },
  decisionReason: null,
  createdAt: "2026-11-23T01:00:00.000Z",
  evidenceDocumentIds: [],
  ...overrides,
});

export const teamValidationJson = (overrides: Json = {}): Json => ({
  result: "DISPUTED",
  comment: "Salió a las 19:30, no a las 20:00.",
  suggestedMinutes: 90,
  validatedBy: randomUUID(),
  validatedAt: "2026-11-23T13:00:00.000Z",
  ...overrides,
});

/** «Item de equipo» de people. */
export const teamItemJson = (overrides: Json = {}): Json => ({
  id: randomUUID(),
  employeeId: randomUUID(),
  employeeName: "Luis Gómez",
  workDate: "2026-11-22",
  startAt: "2026-11-22T22:00:00.000Z",
  endAt: "2026-11-23T00:00:00.000Z",
  requestedMinutes: 120,
  justification: "Caída del enlace troncal; cierre del incidente fuera de turno.",
  exceededLimits: ["DAILY", "WEEKLY"],
  status: "PENDING_SUPERVISOR_VALIDATION",
  supervisorValidation: null,
  createdAt: "2026-11-23T01:00:00.000Z",
  evidenceDocumentIds: [],
  ...overrides,
});
