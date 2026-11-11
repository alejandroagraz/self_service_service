/**
 * Tabla `outbox_events` — Transactional Outbox + Lease-State (docs/ARCHITECTURE.md §2).
 *
 * EXCEPCIÓN DOCUMENTADA: esta tabla NO lleva política RLS pese a tener `tenant_id`. El
 * `tenant_id` está aquí para preservar el orden causal/FIFO por tenant en el poller, no
 * para aislar lectura: el worker publica eventos de todos los tenants en un solo proceso,
 * fuera de cualquier contexto de tenant. Ver CLAUDE.md sección 5.
 *
 * NOTA ESPECÍFICA DE TIME: este servicio publica eventos POR-TENANT (`shift.closed`). La columna
 * `tenant_id` es el tenant real resuelto del principal autenticado (nunca del cliente).
 */
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

import { SELF_SERVICE_SCHEMA } from "../schema";

export const OutboxStatus = {
  PENDING: "PENDING",
  PUBLISHED: "PUBLISHED",
  FAILED: "FAILED",
} as const;
export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];

@Entity({ schema: SELF_SERVICE_SCHEMA, name: "outbox_events" })
@Index("ix_outbox_events_dispatch", ["status", "tenantId", "sequenceNumber"])
export class OutboxEventModel {
  @PrimaryColumn({ type: "uuid", name: "id" })
  id!: string;

  /**
   * Orden de despacho del poller. Lo asigna la secuencia de PostgreSQL (`bigserial`), por eso
   * se marca `insert: false, update: false`: la aplicación nunca lo escribe.
   *
   * El tipo es `string`, no `number`, a propósito: el driver `pg` devuelve `bigint` (OID 20)
   * como string para no perder precisión por encima de 2^53.
   */
  @Column({ type: "bigint", name: "sequence_number", insert: false, update: false })
  sequenceNumber!: string;

  @Column({ type: "uuid", name: "tenant_id" })
  tenantId!: string;

  @Column({ type: "varchar", length: 64, name: "aggregate_type" })
  aggregateType!: string;

  @Column({ type: "uuid", name: "aggregate_id" })
  aggregateId!: string;

  /** Routing key del mensaje en RabbitMQ, ej. `employee.created`. */
  @Column({ type: "varchar", length: 96, name: "event_type" })
  eventType!: string;

  @Column({ type: "jsonb", name: "payload" })
  payload!: Record<string, unknown>;

  @Column({ type: "varchar", length: 16, name: "status", default: OutboxStatus.PENDING })
  status!: string;

  @Column({ type: "integer", name: "retry_count", default: 0 })
  retryCount!: number;

  @Column({ type: "text", name: "last_error", nullable: true })
  lastError!: string | null;

  /** Lease del poller: `SELECT ... FOR UPDATE SKIP LOCKED` + `locked_until`. */
  @Column({ type: "timestamptz", name: "locked_until", nullable: true })
  lockedUntil!: Date | null;

  @Column({ type: "timestamptz", name: "published_at", nullable: true })
  publishedAt!: Date | null;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
