/**
 * Puerto saliente de LECTURA de confianza hacia `people` por el CANAL trusted-service (per-caller key,
 * NO reenvía el token del usuario). Distinto del `IPeopleClient` pass-through (ese reenvía el Bearer
 * del usuario para `/employees/me`): estas rutas internas (`/api/v1/people/internal/*`) NO llevan
 * token de usuario y se autentican con `X-Service-Name` + `X-Internal-Api-Key` + `X-Tenant-Id`.
 *
 * Hoy el proceso fusionado `people` sirve los tres dominios (people/time/absences) y valida TODAS sus
 * rutas internas contra la ÚNICA clave de lectura per-caller de `self-service`; por eso se reutiliza la
 * misma clave que ya usan los demás clientes de confianza (ver `container/index.ts`).
 *
 * - `getCelebrations`: próximos cumpleaños y aniversarios del tenant (vista de equipo). PRIMARIO de
 *   `GET /me/celebrations`.
 * - `getTeamStatus`: estado del equipo del manager hoy (quién no fichó / quién está ausente). PRIMARIO
 *   de `GET /me/team-status`.
 *
 * Cualquier fallo (contrato, 4xx, 5xx, red, timeout, cuerpo ilegible) se traduce a
 * `SELF_UPSTREAM_UNAVAILABLE`: no es culpa del usuario. La clave NUNCA se escribe en logs ni errores.
 */
export type CelebrationType = "BIRTHDAY" | "WORK_ANNIVERSARY";

export interface CelebrationDto {
  readonly employeeId: string;
  readonly fullName: string;
  /** Nombre del departamento resuelto, o `""` si no se pudo resolver. */
  readonly departmentName: string;
  readonly type: CelebrationType;
  /** Mes de la celebración (1..12). */
  readonly month: number;
  /** Día de la celebración (1..31). */
  readonly day: number;
  /** Próxima ocurrencia `AAAA-MM-DD` (el año es el de la CELEBRACIÓN, nunca el de nacimiento). */
  readonly date: string;
  /** Años de empresa (aniversario); `null` para cumpleaños (no se expone la edad). */
  readonly years: number | null;
}

export interface TeamMemberDto {
  readonly employeeId: string;
  readonly fullName: string;
}

export interface AbsentTeamMemberDto {
  readonly employeeId: string;
  readonly fullName: string;
  /** Categoría de la ausencia (p. ej. `VACATION_LOTTT`). */
  readonly category: string;
  readonly startDate: string;
  readonly endDate: string;
  /** Día de regreso previsto (`AAAA-MM-DD`). */
  readonly returnDate: string;
}

export interface TeamStatusDto {
  readonly managerEmployeeId: string;
  /** Fecha civil evaluada (`AAAA-MM-DD`). */
  readonly date: string;
  readonly teamSize: number;
  readonly notCheckedIn: readonly TeamMemberDto[];
  readonly absentToday: readonly AbsentTeamMemberDto[];
}

export interface IPeopleInternalClient {
  /** `windowDays` opcional: si se omite, `people` aplica su default (30 días). */
  getCelebrations(tenantId: string, windowDays?: number): Promise<readonly CelebrationDto[]>;
  /** `date` en formato `AAAA-MM-DD` (obligatorio para el contrato interno de `people`). */
  getTeamStatus(tenantId: string, managerEmployeeId: string, date: string): Promise<TeamStatusDto>;
}
