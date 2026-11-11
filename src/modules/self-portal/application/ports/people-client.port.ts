/**
 * Puerto saliente hacia `people` (pass-through del token del usuario). `self_service` reenvía el
 * Bearer del usuario para que people resuelva SU propia ficha (`GET /employees/me`). Es el único
 * cliente saliente que reenvía el token; los demás (payroll/absences/time) son de confianza per-pair.
 *
 * El adaptador (`shared/infrastructure/http/people-client.ts`) mapea los errores de people a
 * `AppError` ya resueltos para el usuario:
 *   401 → UNAUTHORIZED, 403 → FORBIDDEN, 404 → SELF_PROFILE_NOT_LINKED, 5xx/red → SELF_UPSTREAM_UNAVAILABLE.
 */
export interface MyProfileDto {
  readonly employeeId: string;
  readonly userId: string;
  readonly fullName: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly nationalId: string;
  readonly email: string;
  readonly phone: string | null;
  readonly positionTitle: string;
  readonly departmentName: string;
  readonly supervisorName: string | null;
  readonly site: string;
  readonly hireDate: string;
}

export interface IPeopleClient {
  getMyProfile(userBearerToken: string): Promise<MyProfileDto>;
}
