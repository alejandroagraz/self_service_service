/**
 * Tabla `celebration_greetings` — felicitaciones sociales ("felicitar") que un colaborador deja en la
 * celebración (cumpleaños / aniversario) de otro, POR TENANT (rulebook §1). `self_service` es dueño de
 * esta data social (como `clock_punches`), aunque las celebraciones en sí las sirve people en caliente.
 *
 * Lleva `tenant_id uuid NOT NULL` + política RLS (ver la migración `1792368100000`). La unicidad
 * `(tenant_id, celebrant_employee_id, celebration_date, author_user_id)` hace idempotente el "felicitar"
 * (un autor felicita una celebración concreta a lo sumo una vez) y permite el borrado por autor
 * ("quitar felicitación").
 *
 * `celebration_date` es la FECHA de la celebración (`AAAA-MM-DD`), nunca la de nacimiento. `created_at`
 * es la marca de inserción (default de la BD).
 */
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

import { SELF_SERVICE_SCHEMA } from "../schema";

@Entity({ schema: SELF_SERVICE_SCHEMA, name: "celebration_greetings" })
@Index("ix_celebration_greetings_lookup", ["tenantId", "celebrantEmployeeId", "celebrationDate"])
@Index(
  "uq_celebration_greetings",
  ["tenantId", "celebrantEmployeeId", "celebrationDate", "authorUserId"],
  { unique: true },
)
export class CelebrationGreetingModel {
  @PrimaryColumn({ type: "uuid", name: "id" })
  id!: string;

  @Column({ type: "uuid", name: "tenant_id" })
  tenantId!: string;

  @Column({ type: "uuid", name: "celebrant_employee_id" })
  celebrantEmployeeId!: string;

  @Column({ type: "date", name: "celebration_date" })
  celebrationDate!: string;

  @Column({ type: "varchar", length: 20, name: "celebration_type" })
  celebrationType!: string;

  @Column({ type: "uuid", name: "author_user_id" })
  authorUserId!: string;

  @Column({ type: "varchar", length: 160, name: "author_name" })
  authorName!: string;

  @Column({ type: "varchar", length: 280, name: "message", nullable: true })
  message!: string | null;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
