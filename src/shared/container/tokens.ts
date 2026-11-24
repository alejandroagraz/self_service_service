/**
 * Tokens de inyección de tsyringe.
 *
 * Las interfaces de TypeScript se borran en tiempo de ejecución, así que todo puerto se registra
 * contra un símbolo explícito. Centralizarlos aquí evita strings mágicos dispersos (Zero
 * Hardcoding, rulebook 4.4).
 */
export const TOKENS = {
  // Infraestructura base
  DataSource: Symbol.for("DataSource"),
  UnitOfWork: Symbol.for("IUnitOfWork"),
  IdGenerator: Symbol.for("IIdGenerator"),
  Clock: Symbol.for("IClock"),
  Logger: Symbol.for("Logger"),

  // Caché (rate limiting distribuido, ROLE=api)
  RedisClient: Symbol.for("RedisClient"),

  // Cliente HTTP de identity para validar tokens (§10.4). Solo se registra en el rol HTTP
  // (`registerIdentityClient`): el worker no valida tokens y no tiene la clave interna.
  IdentityClient: Symbol.for("IdentityClient"),

  // Clientes SALIENTES hacia los servicios hermanos (puertos del módulo self-portal). Solo el rol
  // HTTP los registra (`registerOutboundClients`), tras leer las claves per-pair; el worker no.
  PeopleClient: Symbol.for("IPeopleClient"),
  // Canal trusted-service hacia people (`/api/v1/people/internal/*`): distinto del pass-through
  // `PeopleClient`. Sirve celebraciones y estado del equipo con clave de lectura per-caller.
  PeopleInternalClient: Symbol.for("IPeopleInternalClient"),
  PayrollClient: Symbol.for("IPayrollClient"),
  AbsencesClient: Symbol.for("IAbsencesClient"),
  TimeClient: Symbol.for("ITimeClient"),
  // Descarga de confianza del PDF de un recibo propio (GAP-012), clave per-caller ante documents.
  DocumentsClient: Symbol.for("IDocumentsClient"),
} as const;
