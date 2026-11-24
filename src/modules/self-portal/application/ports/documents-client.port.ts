/**
 * Puerto saliente de DESCARGA de confianza hacia `documents` (GAP-012; clave per-caller dedicada de
 * self_service, NO reenvía el token del usuario). Abre el contenido binario de un documento cuya
 * pertenencia YA verificó el BFF (el `documentId` sale de un recibo propio del empleado).
 *
 * El adaptador (`shared/infrastructure/http/documents-client.ts`) mapea los errores de documents a
 * `AppError` ya resueltos para el usuario, sin filtrar detalles aguas arriba:
 *   404 → SELF_PAYSLIP_NOT_FOUND, 409 → SELF_PAYSLIP_DOCUMENT_PENDING,
 *   401/403/5xx/red/timeout → SELF_UPSTREAM_UNAVAILABLE.
 */
import type { Readable } from "node:stream";

export interface DocumentContentStream {
  /** Cuerpo binario en stream: el BFF nunca carga el fichero entero en memoria. */
  readonly stream: Readable;
  /** `Content-Length` declarado por documents, o `null` si no lo declara. */
  readonly contentLength: number | null;
}

export interface IDocumentsClient {
  openContent(tenantId: string, documentId: string): Promise<DocumentContentStream>;
}
