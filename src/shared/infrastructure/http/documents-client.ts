/**
 * Cliente saliente de confianza hacia `documents`. Implementa `IDocumentsClient` (GAP-012 y Lote 4.5A,
 * contrato `docs/audit/design/lote-4.5a-contratos.md` §4 y §6).
 *
 *   GET  {DOCUMENTS_INTERNAL_URL}/api/v1/documents/internal/:documentId/content              (lectura)
 *   GET  {DOCUMENTS_INTERNAL_URL}/api/v1/documents/internal/employees/:employeeId/documents   (lectura)
 *   GET  {DOCUMENTS_INTERNAL_URL}/api/v1/documents/internal/upload-policy?purpose=            (lectura)
 *   POST {DOCUMENTS_INTERNAL_URL}/api/v1/documents/internal/evidence                          (ESCRITURA)
 *   POST {DOCUMENTS_INTERNAL_URL}/api/v1/documents/internal/evidence/verify                   (ESCRITURA)
 *
 * Cabeceras: `x-service-name: self-service`, `x-internal-api-key` (clave de lectura o de escritura,
 * C7), `x-tenant-id` (tenant del principal) y, donde la ruta lo exige, `x-employee-id` (empleado
 * resuelto en servidor, nunca del cliente). NO reenvía el token del usuario.
 *
 * - Las lecturas reintentan ante fallo transitorio (429/5xx/red) ANTES de recibir el cuerpo.
 * - La subida de evidencia es UN SOLO intento y sin `withTransientRetry` (C7): el stream del usuario no
 *   se puede repetir. Su plazo (`uploadTimeoutMs`) cubre el envío completo del cuerpo. Un contador corta
 *   el reenvío al superar el techo técnico de 25 MB (el límite del tenant lo aplica documents).
 * - El contenido se devuelve como stream (`Readable.fromWeb`), sin bufferizar.
 *
 * La clave NUNCA se escribe en logs ni errores.
 */
import { Readable, Transform, type TransformCallback } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

import {
  DOCUMENT_FILE_TYPES,
  EMPLOYEE_DOCUMENT_KINDS,
  EVIDENCE_TECHNICAL_MAX_BYTES,
  EVIDENCE_TECHNICAL_MAX_MB,
  FORWARDED_DOWNLOAD_HEADERS,
  type AllowedFileType,
  type ContentErrorKeys,
  type ContentOptions,
  type DocumentContentStream,
  type DocumentFileType,
  type DocumentsCaller,
  type DocumentsPageMeta,
  type EmployeeDocument,
  type EmployeeDocumentKind,
  type EmployeeDocumentsPage,
  type EmployeeDocumentsQuery,
  type EvidenceUpload,
  type EvidenceVerification,
  type IDocumentsClient,
  type UploadedEvidence,
  type UploadPolicy,
  type UploadPurpose,
} from "../../../modules/self-portal/application/ports/documents-client.port";
import { fail, type AppError } from "../../errors/app-error";
import type { ErrorKey } from "../../errors/error-catalog";
import { childLogger } from "../../logger/logger";
import { rootLogger } from "../services/winston-logger";
import {
  fetchOnce,
  isRetryableStatus,
  safeJson,
  UpstreamError,
  withTransientRetry,
} from "./internal-http";
import { rateLimitExceededError } from "./middlewares/rate-limit/ip-rate-limit";
import {
  arrayOf,
  broken,
  ContractViolation,
  instantOf,
  nonNegativeIntegerOf,
  nullableStringOf,
  objectOf,
  oneOf,
  sanitizeDetails,
  stringOf,
  uuidOf,
  type Json,
} from "./time-internal-http";

const log = childLogger("documents-client");
/** Slug con que documents identifica a este llamador en su mapa per-caller de claves. */
const SERVICE_SLUG = "self-service";
const INTERNAL_PREFIX = "/api/v1/documents/internal";

const KIND_VALUES: ReadonlySet<string> = new Set(EMPLOYEE_DOCUMENT_KINDS);
const FILE_TYPE_VALUES: ReadonlySet<string> = new Set(DOCUMENT_FILE_TYPES);
/** `Retry-After` por defecto (s) si documents responde 429 sin cabecera legible. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

/** Libera el socket de una respuesta que no se va a consumir. */
const discardBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch (error) {
    // La respuesta ya se descarta: solo queda constancia en debug.
    log.debug("No se pudo cancelar el cuerpo de una respuesta descartada.", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
};

const parseContentLength = (raw: string | null): number | null => {
  if (raw === null || !/^[0-9]+$/.test(raw.trim())) {
    return null;
  }
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : null;
};

const parseRetryAfterSeconds = (raw: string | null): number => {
  const seconds = parseContentLength(raw);
  return seconds !== null && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
};

// ───────────────────────────── Validación estricta del contrato ─────────────────────────────

const parsePageMeta = (envelope: Json): DocumentsPageMeta => {
  const meta = objectOf(envelope.meta, "meta");
  const page = nonNegativeIntegerOf(meta.page, "meta.page");
  const pageSize = nonNegativeIntegerOf(meta.pageSize, "meta.pageSize");
  return {
    page: page >= 1 ? page : broken("meta.page"),
    pageSize: pageSize >= 1 ? pageSize : broken("meta.pageSize"),
    total: nonNegativeIntegerOf(meta.total, "meta.total"),
    totalPages: nonNegativeIntegerOf(meta.totalPages, "meta.totalPages"),
  };
};

/** Ítem de la bóveda: SOLO los campos del DTO mínimo (§4); cualquier extra se descarta. */
export const parseEmployeeDocument = (raw: unknown, field: string): EmployeeDocument => {
  const d = objectOf(raw, field);
  const contentType = stringOf(d.contentType, `${field}.contentType`);
  return {
    id: uuidOf(d.id, `${field}.id`),
    kind: oneOf(d.kind, KIND_VALUES, `${field}.kind`) as EmployeeDocumentKind,
    originalFilename: nullableStringOf(d.originalFilename ?? null, `${field}.originalFilename`),
    contentType: contentType.length > 0 ? contentType : broken(`${field}.contentType`),
    sizeBytes: nonNegativeIntegerOf(d.sizeBytes, `${field}.sizeBytes`),
    createdAt: instantOf(d.createdAt, `${field}.createdAt`),
    sourceService: nullableStringOf(d.sourceService ?? null, `${field}.sourceService`),
  };
};

const fileTypeOf = (value: unknown, field: string): DocumentFileType =>
  oneOf(value, FILE_TYPE_VALUES, field) as DocumentFileType;

export const parseUploadPolicy = (raw: unknown): UploadPolicy => {
  const p = objectOf(raw, "data");
  const maxSizeMb = nonNegativeIntegerOf(p.maxSizeMb, "maxSizeMb");
  const technicalMaxSizeMb = nonNegativeIntegerOf(p.technicalMaxSizeMb, "technicalMaxSizeMb");
  const allowedTypes = arrayOf(p.allowedTypes, "allowedTypes").map(
    (rawType, index): AllowedFileType => {
      const where = `allowedTypes[${String(index)}]`;
      const t = objectOf(rawType, where);
      const mime = stringOf(t.mime, `${where}.mime`);
      return {
        type: fileTypeOf(t.type, `${where}.type`),
        mime: mime.length > 0 ? mime : broken(`${where}.mime`),
        extensions: arrayOf(t.extensions, `${where}.extensions`).map((ext, i) =>
          stringOf(ext, `${where}.extensions[${String(i)}]`),
        ),
      };
    },
  );
  return {
    maxSizeMb: maxSizeMb >= 1 ? maxSizeMb : broken("maxSizeMb"),
    technicalMaxSizeMb: technicalMaxSizeMb >= 1 ? technicalMaxSizeMb : broken("technicalMaxSizeMb"),
    allowedTypes: allowedTypes.length > 0 ? allowedTypes : broken("allowedTypes"),
  };
};

export const parseUploadedEvidence = (raw: unknown): UploadedEvidence => {
  const d = objectOf(raw, "data");
  return {
    documentId: uuidOf(d.documentId, "documentId"),
    sizeBytes: nonNegativeIntegerOf(d.sizeBytes, "sizeBytes"),
    detectedType: fileTypeOf(d.detectedType, "detectedType"),
  };
};

/** `valid ∪ invalid` debe ser EXACTAMENTE el conjunto pedido, sin solapes: si no, contrato roto. */
export const parseVerification = (
  raw: unknown,
  requested: readonly string[],
): EvidenceVerification => {
  const d = objectOf(raw, "data");
  const valid = arrayOf(d.valid, "valid").map((id, i) => uuidOf(id, `valid[${String(i)}]`));
  const invalid = arrayOf(d.invalid, "invalid").map((id, i) => uuidOf(id, `invalid[${String(i)}]`));
  const wanted = new Set(requested.map((id) => id.toLowerCase()));
  const seen = new Set<string>();
  for (const id of [...valid, ...invalid]) {
    if (!wanted.has(id) || seen.has(id)) {
      broken("valid/invalid");
    }
    seen.add(id);
  }
  return seen.size === wanted.size ? { valid, invalid } : broken("valid/invalid");
};

// ───────────────────────────── Contador del techo técnico ─────────────────────────────

/** Deja pasar el stream y lo corta con error al superar `maxBytes` (marca `exceeded`). */
class ByteCeiling extends Transform {
  exceeded = false;
  private seen = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.seen += chunk.length;
    if (this.seen > this.maxBytes) {
      this.exceeded = true;
      callback(new Error("la evidencia supera el techo técnico de subida."));
      return;
    }
    callback(null, chunk);
  }
}

// ───────────────────────────── Llamadas JSON ─────────────────────────────

interface JsonCall<T> {
  readonly step: string;
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly apiKey: string;
  readonly tenantId: string;
  readonly employeeId?: string;
  readonly body?: unknown;
  readonly parse: (data: unknown, envelope: Json) => T;
}

export class DocumentsClient implements IDocumentsClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly readKey: string,
    private readonly uploadKey: string,
    private readonly timeoutMs: number,
    private readonly uploadTimeoutMs: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private headers(apiKey: string, tenantId: string, employeeId?: string): Record<string, string> {
    return {
      "x-service-name": SERVICE_SLUG,
      "x-internal-api-key": apiKey,
      "x-tenant-id": tenantId,
      ...(employeeId === undefined ? {} : { "x-employee-id": employeeId }),
    };
  }

  /** Llamada JSON idempotente (lecturas y `verify`): 200 + `data` → valor; cualquier otra cosa → 503. */
  private async callJson<T>(spec: JsonCall<T>): Promise<T> {
    const attempt = async (): Promise<T> => {
      const headers = this.headers(spec.apiKey, spec.tenantId, spec.employeeId);
      if (spec.body !== undefined) {
        headers["content-type"] = "application/json";
      }
      const response = await fetchOnce({
        url: spec.url,
        method: spec.method,
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        timeoutMs: this.timeoutMs,
      });
      const body = (await safeJson(response)) as Json | null;
      if (response.status !== 200) {
        throw new UpstreamError(
          `${spec.step}: documents respondió ${String(response.status)}.`,
          isRetryableStatus(response.status),
          response.status,
        );
      }
      if (body === null || typeof body !== "object" || !("data" in body)) {
        throw new UpstreamError(`${spec.step}: 200 sin data.`, false, 200);
      }
      try {
        return spec.parse(body.data, body);
      } catch (error) {
        if (error instanceof ContractViolation) {
          throw new UpstreamError(`${spec.step}: contrato roto en ${error.message}.`, false, 200);
        }
        throw error;
      }
    };
    try {
      return await withTransientRetry(rootLogger(), spec.step, attempt);
    } catch (error) {
      log.error("documents no pudo atender la llamada interna.", {
        step: spec.step,
        status: error instanceof UpstreamError ? error.status : undefined,
        reason: error instanceof UpstreamError ? error.message : undefined,
      });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }
  }

  async openContent(
    caller: DocumentsCaller,
    documentId: string,
    errors: ContentErrorKeys,
    options: ContentOptions = {},
  ): Promise<DocumentContentStream> {
    const kindFilter =
      options.kind === undefined ? "" : `?kind=${encodeURIComponent(options.kind)}`;
    const url = `${this.baseUrl}${INTERNAL_PREFIX}/${encodeURIComponent(documentId)}/content${kindFilter}`;
    let response: Response;
    try {
      response = await withTransientRetry(rootLogger(), "documents:openContent", async () => {
        const candidate = await fetchOnce({
          url,
          method: "GET",
          // C7: documents comprueba que el documento es de ESTE empleado (404 si no).
          headers: this.headers(this.readKey, caller.tenantId, caller.employeeId),
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
          throw fail(errors.notFound);
        }
        if (error.status === 409) {
          throw fail(errors.pending);
        }
      }
      log.error("documents no pudo entregar el contenido del documento.", {
        status: error instanceof UpstreamError ? error.status : undefined,
      });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }

    if (response.body === null) {
      log.error("documents respondió 200 sin cuerpo.", { status: 200 });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_DOWNLOAD_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null && value.length > 0) {
        headers[name] = value;
      }
    }
    return {
      stream: Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
      contentLength: parseContentLength(response.headers.get("content-length")),
      headers,
    };
  }

  async listEmployeeDocuments(
    caller: DocumentsCaller,
    query: EmployeeDocumentsQuery,
  ): Promise<EmployeeDocumentsPage> {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries({
      kind: query.kind,
      page: query.page,
      pageSize: query.pageSize,
    })) {
      if (value !== undefined) {
        search.set(name, String(value));
      }
    }
    const rendered = search.toString();
    return this.callJson({
      step: "documents:listEmployeeDocuments",
      method: "GET",
      url: `${this.baseUrl}${INTERNAL_PREFIX}/employees/${encodeURIComponent(caller.employeeId)}/documents${rendered.length === 0 ? "" : `?${rendered}`}`,
      apiKey: this.readKey,
      tenantId: caller.tenantId,
      parse: (data, envelope) => ({
        items: arrayOf(data, "data").map((item, index) =>
          parseEmployeeDocument(item, `data[${String(index)}]`),
        ),
        meta: parsePageMeta(envelope),
      }),
    });
  }

  async getUploadPolicy(tenantId: string, purpose: UploadPurpose): Promise<UploadPolicy> {
    return this.callJson({
      step: "documents:getUploadPolicy",
      method: "GET",
      url: `${this.baseUrl}${INTERNAL_PREFIX}/upload-policy?purpose=${encodeURIComponent(purpose)}`,
      apiKey: this.readKey,
      tenantId,
      parse: parseUploadPolicy,
    });
  }

  async verifyEvidence(
    caller: DocumentsCaller,
    documentIds: readonly string[],
  ): Promise<EvidenceVerification> {
    return this.callJson({
      step: "documents:verifyEvidence",
      method: "POST",
      url: `${this.baseUrl}${INTERNAL_PREFIX}/evidence/verify`,
      apiKey: this.uploadKey,
      tenantId: caller.tenantId,
      body: { employeeId: caller.employeeId, documentIds: [...documentIds] },
      parse: (data) => parseVerification(data, documentIds),
    });
  }

  async uploadEvidence(caller: DocumentsCaller, upload: EvidenceUpload): Promise<UploadedEvidence> {
    const ceiling = new ByteCeiling(EVIDENCE_TECHNICAL_MAX_BYTES);
    // Un error del stream del usuario (abortó la subida) también corta el reenvío.
    upload.body.on("error", (error) => {
      ceiling.destroy(error);
    });
    upload.body.pipe(ceiling);

    const headers: Record<string, string> = {
      ...this.headers(this.uploadKey, caller.tenantId, caller.employeeId),
      "content-type": upload.contentType,
      "x-file-name": upload.encodedFileName,
    };
    if (upload.contentLength !== null) {
      // documents hace su pre-chequeo de tamaño sin leer el cuerpo (contrato §2.1).
      headers["content-length"] = String(upload.contentLength);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.uploadTimeoutMs);
    let response: Response;
    try {
      // UN solo intento, sin `withTransientRetry` (C7): el stream no se puede repetir.
      response = await fetch(`${this.baseUrl}${INTERNAL_PREFIX}/evidence`, {
        method: "POST",
        headers,
        body: Readable.toWeb(ceiling) as unknown as ReadableStream<Uint8Array>,
        duplex: "half",
        signal: controller.signal,
      } as RequestInit);
    } catch (error) {
      clearTimeout(timer);
      upload.body.unpipe(ceiling);
      ceiling.destroy();
      if (ceiling.exceeded) {
        throw fail("EVIDENCE_TOO_LARGE", [
          { field: "max_size_mb", issue: String(EVIDENCE_TECHNICAL_MAX_MB) },
        ]);
      }
      log.error("documents no pudo recibir la evidencia.", {
        reason: error instanceof Error ? error.message : String(error),
      });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }
    clearTimeout(timer);

    const body = (await safeJson(response)) as Json | null;
    if (response.status !== 201) {
      // M-7: documents puede rechazar (p. ej. 413 por su pre-chequeo de Content-Length) con el cuerpo
      // aún en vuelo; undici entrega la respuesta igualmente. Se deja de reenviar y se libera el
      // stream: el rechazo se traduce por su status, nunca como caída.
      upload.body.unpipe(ceiling);
      ceiling.destroy();
    }
    if (response.status === 201) {
      if (body !== null && typeof body === "object" && "data" in body) {
        try {
          return parseUploadedEvidence(body.data);
        } catch (error) {
          if (!(error instanceof ContractViolation)) {
            throw error;
          }
          log.error("documents respondió 201 con el contrato roto.", { field: error.message });
          throw fail("SELF_UPSTREAM_UNAVAILABLE");
        }
      }
      log.error("documents respondió 201 sin data.", { status: 201 });
      throw fail("SELF_UPSTREAM_UNAVAILABLE");
    }
    throw this.uploadError(response, body);
  }

  /** Traducción de un rechazo de `/internal/evidence` (contrato §6). */
  private uploadError(response: Response, body: Json | null): AppError {
    const mapped: Readonly<Record<number, ErrorKey>> = {
      413: "EVIDENCE_TOO_LARGE",
      415: "EVIDENCE_UNSUPPORTED_TYPE",
      422: "VALIDATION_FAILED",
    };
    const key = mapped[response.status];
    if (key !== undefined) {
      return fail(key, sanitizeDetails(body?.errors));
    }
    if (response.status === 429) {
      // Cuota de evidencias por empleado (C8, `DOCCOM0007`).
      return rateLimitExceededError(
        parseRetryAfterSeconds(response.headers.get("retry-after")) * 1000,
      );
    }
    log.error("documents rechazó la evidencia con un status no previsto.", {
      status: response.status,
      code: typeof body?.code === "string" ? body.code : undefined,
    });
    return fail("SELF_UPSTREAM_UNAVAILABLE");
  }
}
