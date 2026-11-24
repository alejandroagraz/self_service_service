/**
 * Cliente saliente de DESCARGA de confianza hacia `documents` (GAP-012). Implementa `IDocumentsClient`.
 *
 * `GET {DOCUMENTS_INTERNAL_URL}/api/v1/documents/internal/:documentId/content`
 *   x-service-name: self-service
 *   x-internal-api-key: <clave per-caller self_service→documents>
 *   x-tenant-id: <tenantId del principal verificado>
 *
 * NO reenvía el token del usuario: self_service ya autenticó al usuario y verificó que el recibo (y
 * por tanto su `documentId`) es suyo. documents confía en ese `documentId`/`tenantId` (su RLS sigue
 * aislando por tenant).
 *
 * El 200 se devuelve como stream (`Readable.fromWeb`), sin bufferizar. El timeout de `fetchOnce`
 * cubre hasta recibir las cabeceras; el cuerpo fluye después sin ese plazo.
 *
 * Mapeo de error (sin filtrar el detalle aguas arriba):
 *   404 → SELF_PAYSLIP_NOT_FOUND, 409 → SELF_PAYSLIP_DOCUMENT_PENDING,
 *   401/403 (clave mal provista: error de despliegue, no del usuario), 5xx, red, timeout →
 *   SELF_UPSTREAM_UNAVAILABLE. La clave NUNCA se escribe en logs ni errores.
 */
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

import type {
  DocumentContentStream,
  IDocumentsClient,
} from "../../../modules/self-portal/application/ports/documents-client.port";
import { fail } from "../../errors/app-error";
import { childLogger } from "../../logger/logger";
import { rootLogger } from "../services/winston-logger";
import { fetchOnce, isRetryableStatus, UpstreamError, withTransientRetry } from "./internal-http";

const log = childLogger("documents-client");
/** Slug con que documents identifica a este llamador en su mapa per-caller de claves. */
const SERVICE_SLUG = "self-service";
const INTERNAL_PREFIX = "/api/v1/documents/internal";

/** Libera el socket de una respuesta que no se va a consumir. */
const discardBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Nada que hacer: la respuesta ya se descarta.
  }
};

const parseContentLength = (raw: string | null): number | null => {
  if (raw === null || !/^[0-9]+$/.test(raw.trim())) {
    return null;
  }
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : null;
};

export class DocumentsClient implements IDocumentsClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly internalApiKey: string,
    private readonly timeoutMs: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async openContent(tenantId: string, documentId: string): Promise<DocumentContentStream> {
    const url = `${this.baseUrl}${INTERNAL_PREFIX}/${encodeURIComponent(documentId)}/content`;
    let response: Response;
    try {
      response = await withTransientRetry(rootLogger(), "documents:openContent", async () => {
        const candidate = await fetchOnce({
          url,
          method: "GET",
          headers: {
            "x-service-name": SERVICE_SLUG,
            "x-internal-api-key": this.internalApiKey,
            "x-tenant-id": tenantId,
          },
          timeoutMs: this.timeoutMs,
        });
        if (candidate.status === 200) {
          return candidate;
        }
        await discardBody(candidate);
        throw new UpstreamError(
          `documents respondió ${String(candidate.status)} en /internal/:id/content.`,
          isRetryableStatus(candidate.status),
          candidate.status,
        );
      });
    } catch (error) {
      if (error instanceof UpstreamError) {
        if (error.status === 404) {
          throw fail("SELF_PAYSLIP_NOT_FOUND");
        }
        if (error.status === 409) {
          throw fail("SELF_PAYSLIP_DOCUMENT_PENDING");
        }
      }
      log.error("documents no pudo entregar el contenido del recibo.", {
        status: error instanceof UpstreamError ? error.status : undefined,
      });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }

    if (response.body === null) {
      log.error("documents respondió 200 sin cuerpo.", { status: 200 });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }
    return {
      stream: Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
      contentLength: parseContentLength(response.headers.get("content-length")),
    };
  }
}
