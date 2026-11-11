/**
 * Diccionario centralizado de errores (Zero Hardcoding, rulebook 4.4 / 4.9).
 * Formato del código: SSV[MODULO][SECUENCIAL] — ej. `SSVCLK0001`.
 *
 * Los mensajes van en castellano porque terminan expuestos al usuario final del frontend_rrhh;
 * los identificadores técnicos (claves, códigos) van en inglés según NAMING_CONVENTIONS.md.
 */
export interface ErrorDefinition {
  readonly code: string;
  readonly message: string;
  readonly statusCode: number;
  /**
   * `true` = el `errorHandler` NO registra el rechazo. Solo para errores cuyo emisor ya los
   * registra con un log acotado por tiempo, o para los 429.
   */
  readonly quiet?: true;
}

const define = <T extends Record<string, ErrorDefinition>>(catalog: T): T => catalog;

export const ERRORS = define({
  // ===== COM — transversales =====
  VALIDATION_FAILED: {
    code: "SSVCOM0001",
    message: "Los datos enviados no superan la validación.",
    statusCode: 422,
  },
  UNAUTHORIZED: {
    code: "SSVCOM0002",
    message: "Credenciales ausentes o inválidas.",
    statusCode: 401,
  },
  FORBIDDEN: {
    code: "SSVCOM0003",
    message: "No tiene permisos para ejecutar esta operación.",
    statusCode: 403,
  },
  INTERNAL: {
    code: "SSVCOM0004",
    message: "Error interno del servicio de autoservicio.",
    statusCode: 500,
  },
  // Los cinco siguientes no los lanza el dominio: los asigna el `errorHandler` (o el
  // `notFoundHandler`) a respuestas que produce Fastify o un limitador, para que TODA respuesta de
  // error lleve `code` (rulebook 4.8).
  ROUTE_NOT_FOUND: {
    code: "SSVCOM0006",
    message: "Ruta no encontrada.",
    statusCode: 404,
  },
  RATE_LIMIT_EXCEEDED: {
    code: "SSVCOM0007",
    message: "Demasiadas solicitudes.",
    statusCode: 429,
    quiet: true,
  },
  MALFORMED_REQUEST: {
    code: "SSVCOM0008",
    message: "La petición está mal formada (cuerpo ilegible o cabeceras inconsistentes).",
    statusCode: 400,
  },
  PAYLOAD_TOO_LARGE: {
    code: "SSVCOM0009",
    message: "El cuerpo de la petición excede el tamaño permitido.",
    statusCode: 413,
  },
  UNSUPPORTED_MEDIA_TYPE: {
    code: "SSVCOM0010",
    message: "Tipo de contenido no admitido.",
    statusCode: 415,
  },
  REQUEST_REJECTED: {
    code: "SSVCOM0011",
    message: "La petición fue rechazada.",
    statusCode: 400,
  },
  // identity no está disponible, rechazó la credencial de ESTE servicio, o agotó su cupo. El
  // usuario no ha hecho nada mal: 503, nunca 401/403 (ver §10.4).
  IDENTITY_UNAVAILABLE: {
    code: "SSVCOM0013",
    message: "El servicio de identidad no está disponible; reintente en unos segundos.",
    statusCode: 503,
    quiet: true,
  },

  // ===== SLF — autoservicio del empleado (perfil, nómina, marcaciones) =====
  // El usuario autenticado no está vinculado a ningún empleado en people (404 EMPLOYEE_NOT_LINKED
  // aguas arriba): no se puede componer su vista de autoservicio.
  SELF_PROFILE_NOT_LINKED: {
    code: "SSVSLF0001",
    message: "Su usuario no está vinculado a una ficha de empleado; contacte con RRHH.",
    statusCode: 404,
  },
  // Un servicio hermano REQUERIDO (people) no pudo responder. El usuario no ha hecho nada mal: 503.
  // Las lecturas SECUNDARIAS (absences/time) degradan en su lugar y nunca llegan aquí.
  SELF_UPSTREAM_UNAVAILABLE: {
    code: "SSVSLF0002",
    message: "Un servicio necesario no está disponible; reintente en unos segundos.",
    statusCode: 503,
    quiet: true,
  },

  // ===== CLK — clock punches (marcaciones de reloj del empleado, por tenant) =====
  CLOCK_PUNCH_INVALID: {
    code: "SSVCLK0001",
    message: "La marcación de reloj no es válida.",
    statusCode: 422,
  },
  // La máquina de estados de marcación rechaza la transición (p. ej. CHECK_OUT sin jornada abierta).
  CLOCK_PUNCH_INVALID_TRANSITION: {
    code: "SSVCLK0002",
    message: "La acción de marcación no es válida para su estado de jornada actual.",
    statusCode: 409,
  },
});

export type ErrorKey = keyof typeof ERRORS;
