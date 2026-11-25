/**
 * Tabla `clock_punches` — marcaciones de reloj del empleado desde el portal de autoservicio, POR
 * TENANT (rulebook §1). APPEND-ONLY: una marcación es un hecho inmutable; no hay UPDATE ni DELETE.
 *
 * Lleva `tenant_id uuid NOT NULL` + política RLS (ver la migración `1792368000000`). El estado de
 * jornada del empleado NO se materializa aquí: desde el Lote 4.4B1 lo decide la jornada consolidada de
 * people y el portal lo traduce (`deriveClockState`); `id` es el `clockPunchId` idempotente.
 *
 * `punched_at` es el momento de la marcación; `created_at` es la marca de inserción (default de la
 * BD). `punched_at` es el instante OFICIAL que devuelve people (Lote 4.4B1), así que puede diferir
 * unos segundos de `created_at`; se separan también por si en el futuro se admiten
 * ajustes retroactivos.
 */
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

import { SELF_SERVICE_SCHEMA } from "../schema";

@Entity({ schema: SELF_SERVICE_SCHEMA, name: "clock_punches" })
@Index("ix_clock_punches_tenant_id", ["tenantId"])
@Index("ix_clock_punches_tenant_employee_punched", ["tenantId", "employeeId", "punchedAt"])
export class ClockPunchModel {
  @PrimaryColumn({ type: "uuid", name: "id" })
  id!: string;

  @Column({ type: "uuid", name: "tenant_id" })
  tenantId!: string;

  @Column({ type: "uuid", name: "employee_id" })
  employeeId!: string;

  @Column({ type: "uuid", name: "user_id" })
  userId!: string;

  @Column({ type: "varchar", length: 16, name: "action" })
  action!: string;

  @Column({ type: "varchar", length: 500, name: "note", nullable: true })
  note!: string | null;

  @Column({ type: "timestamptz", name: "punched_at" })
  punchedAt!: Date;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
