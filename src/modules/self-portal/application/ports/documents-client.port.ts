/**
 * Puerto saliente de confianza hacia `documents` (clave per-caller dedicada de self_service; NO reenvía
 * el token del usuario). Rutas internas `/api/v1/documents/internal/*` (nunca por Traefik).
 *
 * Dos claves (guardian C7):
 *   - LECTURA (`documentsReadKey`): contenido (`/internal/:id/content`, siempre con `x-employee-id`),
 *     bóveda del empleado (`/internal/employees/:id/documents`) y política de subida
 *     (`/internal/upload-policy`).
 *   - ESCRITURA (`documentsUploadKey`): subida de evidencias (`/internal/evidence`) y su verificación
 *     (`/internal/evidence/verify`).
 *
 * El `employeeId` lo resuelve SIEMPRE el caso de uso (perfil de people o dueño confirmado por people en
 * las evidencias); nunca llega del cliente (C10).
 *
 * El adaptador (`shared/infrastructure/http/documents-client.ts`) mapea los errores de documents a
 * `AppError` ya resueltos para el usuario, sin filtrar detalles aguas arriba; caída, timeout, 401/403
 * (clave mal provista: error de despliegue), status no previsto o contrato roto →
 * `SELF_UPSTREAM_UNAVAILABLE` (503, fail-closed).
 */
import type { Readable } from "node:stream";

import type { ErrorKey } from "../../../../shared/errors/error-catalog";

/** Quién llama: tenant del principal verificado y empleado resuelto en servidor. */
export interface DocumentsCaller {
  readonly tenantId: string;
  readonly employeeId: string;
}

/** Cabeceras de descarga de documents que el BFF reenvía tal cual (en minúsculas). */
export const FORWARDED_DOWNLOAD_HEADERS = [
  "content-type",
  "content-disposition",
  "cache-control",
  "x-content-type-options",
  "content-security-policy",
] as const;

export interface DocumentContentStream {
  /** Cuerpo binario en stream: el BFF nunca carga el fichero entero en memoria. */
  readonly stream: Readable;
  /** `Content-Length` declarado por documents, o `null` si no lo declara. */
  readonly contentLength: number | null;
  /** Cabeceras de descarga de documents presentes (subconjunto de `FORWARDED_DOWNLOAD_HEADERS`). */
  readonly headers: Readonly<Record<string, string>>;
}

/** Qué error del catálogo corresponde a un 404 / 409 de documents en cada uso de `openContent`. */
export interface ContentErrorKeys {
  readonly notFound: ErrorKey;
  readonly pending: ErrorKey;
}

/**
 * Filtro de kind de `openContent` (revisión de guardian M-3): las descargas de EVIDENCIA piden
 * `?kind=OVERTIME_EVIDENCE` y documents responde 404 si el documento es de otro kind. Así una evidencia
 * nunca puede servir un recibo aunque `evidence_document_ids` contuviera otro id.
 */
export interface ContentOptions {
  readonly kind?: "OVERTIME_EVIDENCE";
}

/** Kinds que el empleado ve en su bóveda (contrato 4.5A §4; nunca `OVERTIME_EVIDENCE`). */
export const EMPLOYEE_DOCUMENT_KINDS = [
  "CONTRACT",
  "SUPPORT",
  "OTHER",
  "PAYSLIP",
  "SETTLEMENT",
  "UTILIDADES_SLIP",
] as const;
export type EmployeeDocumentKind = (typeof EMPLOYEE_DOCUMENT_KINDS)[number];

/** Tipos de la lista blanca de documents (contrato 4.5A §2). */
export const DOCUMENT_FILE_TYPES = ["pdf", "docx", "xlsx", "jpeg", "png", "webp"] as const;
export type DocumentFileType = (typeof DOCUMENT_FILE_TYPES)[number];

/** DTO mínimo de la bóveda del empleado (contrato 4.5A §4). */
export interface EmployeeDocument {
  readonly id: string;
  readonly kind: EmployeeDocumentKind;
  readonly originalFilename: string | null;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: Date;
  readonly sourceService: string | null;
}

export interface EmployeeDocumentsQuery {
  readonly kind?: EmployeeDocumentKind;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface DocumentsPageMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface EmployeeDocumentsPage {
  readonly items: readonly EmployeeDocument[];
  readonly meta: DocumentsPageMeta;
}

/** `purpose` de la política de subida. El portal del empleado solo sube evidencias. */
export const UPLOAD_PURPOSES = ["EVIDENCE"] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

export interface AllowedFileType {
  readonly type: DocumentFileType;
  readonly mime: string;
  readonly extensions: readonly string[];
}

export interface UploadPolicy {
  readonly maxSizeMb: number;
  readonly technicalMaxSizeMb: number;
  readonly allowedTypes: readonly AllowedFileType[];
}

/** Techo técnico de subida (contrato 4.5A §2: 25 MB). El límite del tenant lo aplica documents. */
export const EVIDENCE_TECHNICAL_MAX_MB = 25;
export const EVIDENCE_TECHNICAL_MAX_BYTES = EVIDENCE_TECHNICAL_MAX_MB * 1024 * 1024;

export interface EvidenceUpload {
  /** Cuerpo crudo de la petición del usuario, en stream (nunca se bufferiza). */
  readonly body: Readable;
  /** Media type declarado por el usuario (sin parámetros, en minúsculas). */
  readonly contentType: string;
  /** `X-File-Name` tal como llegó: UTF-8 codificado con `%` (C9). */
  readonly encodedFileName: string;
  /** `Content-Length` declarado por el usuario, o `null` si llegó en chunked. */
  readonly contentLength: number | null;
}

export interface UploadedEvidence {
  readonly documentId: string;
  readonly sizeBytes: number;
  readonly detectedType: DocumentFileType;
}

export interface EvidenceVerification {
  readonly valid: readonly string[];
  readonly invalid: readonly string[];
}

export interface IDocumentsClient {
  /**
   * `GET /internal/:id/content` con `x-employee-id` (C7). 404 → `errors.notFound`, 409 →
   * `errors.pending`; el resto → 503. Lectura: reintenta ante fallo transitorio (aún sin cuerpo).
   * Con `options.kind`, documents exige ese kind (`?kind=`) y responde 404 si no coincide.
   */
  openContent(
    caller: DocumentsCaller,
    documentId: string,
    errors: ContentErrorKeys,
    options?: ContentOptions,
  ): Promise<DocumentContentStream>;

  /** `GET /internal/employees/:employeeId/documents?kind&page&pageSize` (lectura). */
  listEmployeeDocuments(
    caller: DocumentsCaller,
    query: EmployeeDocumentsQuery,
  ): Promise<EmployeeDocumentsPage>;

  /** `GET /internal/upload-policy?purpose=` (lectura). El empleado no viaja: la política es del tenant. */
  getUploadPolicy(tenantId: string, purpose: UploadPurpose): Promise<UploadPolicy>;

  /**
   * `POST /internal/evidence` (ESCRITURA), cuerpo en stream. UN SOLO intento: el stream no se puede
   * repetir y la escritura no es idempotente (C7). 413 → `EVIDENCE_TOO_LARGE`, 415 →
   * `EVIDENCE_UNSUPPORTED_TYPE` (con los `errors` de documents), 429 → `RATE_LIMIT_EXCEEDED`, 422 →
   * `VALIDATION_FAILED`; el resto → 503. Más de `EVIDENCE_TECHNICAL_MAX_BYTES` → 413 sin terminar de
   * reenviar.
   */
  uploadEvidence(caller: DocumentsCaller, upload: EvidenceUpload): Promise<UploadedEvidence>;

  /**
   * `POST /internal/evidence/verify` (ESCRITURA, sin efectos): clasifica cada id en `valid` (evidencia
   * `CONFIRMED` del empleado y del tenant) o `invalid`. Una respuesta que no clasifica exactamente los
   * ids pedidos es contrato roto (503).
   */
  verifyEvidence(
    caller: DocumentsCaller,
    documentIds: readonly string[],
  ): Promise<EvidenceVerification>;
}
