/**
 * Respuesta binaria de una descarga reenviada desde documents (Lote 4.5A §6): stream SIN envelope con
 * las cabeceras de descarga de documents (`Content-Type` desde `detected_type`, `Content-Disposition`,
 * `Cache-Control`, `nosniff`, CSP `sandbox` si es `inline`, C3). Si documents no envía alguna, se aplica
 * el defecto seguro: `application/octet-stream`, `attachment`, `private, no-store` y `nosniff`.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

import { fail } from "../../../../../shared/errors/app-error";
import type { DocumentContentStream } from "../../../application/ports/documents-client.port";

const SAFE_DEFAULTS: Readonly<Record<string, string>> = {
  "content-type": "application/octet-stream",
  "content-disposition": "attachment",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

export const sendDocumentContent = (
  reply: FastifyReply,
  content: DocumentContentStream,
): FastifyReply => {
  reply.status(200);
  for (const [name, value] of Object.entries({ ...SAFE_DEFAULTS, ...content.headers })) {
    reply.header(name, value);
  }
  if (content.contentLength !== null) {
    reply.header("content-length", String(content.contentLength));
  }
  return reply.send(content.stream);
};

/**
 * Las descargas no admiten parámetros de query: el empleado y el documento los fija el servidor y la
 * ruta. Cualquiera (p. ej. `employeeId`) → 422 `SSVCOM0001` sin llamar a ningún hermano.
 */
export const rejectQueryParams = (request: FastifyRequest): void => {
  const extraneous = Object.keys((request.query ?? {}) as object);
  if (extraneous.length > 0) {
    throw fail(
      "VALIDATION_FAILED",
      extraneous.map((field) => ({
        field,
        issue: "Parámetro no admitido: el empleado y el documento los determina el servidor.",
      })),
    );
  }
};
