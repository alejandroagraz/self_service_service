/**
 * Controller HTTP de la bóveda documental propia y de la subida de evidencias del portal (Lote 4.5A,
 * contrato §6). Delgado (rulebook §7.1): valida query/params/cabeceras, invoca el caso de uso y arma la
 * respuesta.
 *
 * El `tenantId` sale SIEMPRE del principal verificado y el `employeeId` del perfil de people (C10):
 * ningún parámetro, cabecera ni campo del cliente lo fija.
 */
import type { Readable } from "node:stream";

import type { FastifyReply, FastifyRequest } from "fastify";
import { inject, singleton } from "tsyringe";

import { created, ok } from "../../../../../shared/application/response.dto";
import { fail } from "../../../../../shared/errors/app-error";
import {
  bearerOf,
  principalOf,
} from "../../../../../shared/infrastructure/http/middlewares/authentication.middleware";
import { validateDto } from "../../../../../shared/infrastructure/http/validate-dto";
import {
  EvidenceUploadHeadersDto,
  MyDocumentContentParamsDto,
  MyDocumentsQueryDto,
  MyUploadPolicyQueryDto,
} from "../../../application/dtos/self-portal-documents.dto";
import {
  EVIDENCE_TECHNICAL_MAX_BYTES,
  EVIDENCE_TECHNICAL_MAX_MB,
} from "../../../application/ports/documents-client.port";
import { DownloadMyDocumentContentUseCase } from "../../../application/use-cases/download-my-document-content.use-case";
import { GetMyUploadPolicyUseCase } from "../../../application/use-cases/get-my-upload-policy.use-case";
import { ListMyDocumentsUseCase } from "../../../application/use-cases/list-my-documents.use-case";
import { UploadMyEvidenceUseCase } from "../../../application/use-cases/upload-my-evidence.use-case";
import { rejectQueryParams, sendDocumentContent } from "./document-content-reply";

/** Mismo patrón que documents valida tras decodificar (C9): 1–255, sin controles, `/` ni `\`. */
const FILENAME_PATTERN = /^[^\u0000-\u001f/\\]{1,255}$/;
/** Tope del valor CODIFICADO de `X-File-Name` (255 caracteres × hasta 4 bytes × 3 por `%XX`). */
const MAX_ENCODED_FILENAME_LENGTH = 3_060;
/** `type/subtype` (RFC 9110 token); los parámetros (`; charset=…`) se descartan. */
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

const toPageNumber = (value: string | undefined): number | undefined =>
  value === undefined ? undefined : Number(value);

const fileNameIssue = (issue: string) => [{ field: "x-file-name", issue }];

/** Decodifica `X-File-Name` (UTF-8 con `%`, C9) y aplica el mismo patrón que documents. */
const checkFileName = (encoded: string): void => {
  if (encoded.length === 0 || encoded.length > MAX_ENCODED_FILENAME_LENGTH) {
    throw fail(
      "VALIDATION_FAILED",
      fileNameIssue("X-File-Name es obligatoria y no puede exceder su longitud máxima."),
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch (error) {
    if (!(error instanceof URIError)) {
      throw error;
    }
    throw fail(
      "VALIDATION_FAILED",
      fileNameIssue("X-File-Name debe ir en UTF-8 codificado con %."),
    );
  }
  if (!FILENAME_PATTERN.test(decoded)) {
    throw fail(
      "VALIDATION_FAILED",
      fileNameIssue("El nombre debe tener 1–255 caracteres, sin caracteres de control, / ni \\."),
    );
  }
};

/** Media type declarado, sin parámetros y en minúsculas; ausente o ilegible → 415 `SSVDOC0010`. */
const mediaTypeOf = (raw: string | string[] | undefined): string => {
  const value = typeof raw === "string" ? raw.split(";", 1)[0].trim().toLowerCase() : "";
  if (!MEDIA_TYPE_PATTERN.test(value)) {
    throw fail("EVIDENCE_UNSUPPORTED_TYPE");
  }
  return value;
};

/** `Content-Length` declarado (dígitos), o `null` si la subida llega en chunked. */
const contentLengthOf = (raw: string | undefined): number | null => {
  if (raw === undefined || !/^[0-9]+$/.test(raw.trim())) {
    return null;
  }
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : null;
};

@singleton()
export class DocumentsPortalController {
  constructor(
    @inject(ListMyDocumentsUseCase) private readonly listMyDocuments: ListMyDocumentsUseCase,
    @inject(DownloadMyDocumentContentUseCase)
    private readonly downloadMyDocumentContent: DownloadMyDocumentContentUseCase,
    @inject(GetMyUploadPolicyUseCase) private readonly getMyUploadPolicy: GetMyUploadPolicyUseCase,
    @inject(UploadMyEvidenceUseCase) private readonly uploadMyEvidence: UploadMyEvidenceUseCase,
  ) {}

  async myDocuments(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const query = validateDto(MyDocumentsQueryDto, request.query ?? {});
    const result = await this.listMyDocuments.execute(principal.tenantId, bearerOf(request), {
      kind: query.kind,
      page: toPageNumber(query.page),
      pageSize: toPageNumber(query.pageSize),
    });
    return reply.status(200).send(ok(result.items, "Documentos propios.", result.meta));
  }

  async myDocumentContent(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const { documentId } = validateDto(MyDocumentContentParamsDto, request.params ?? {});
    rejectQueryParams(request);
    const content = await this.downloadMyDocumentContent.execute(
      principal.tenantId,
      bearerOf(request),
      documentId.toLowerCase(),
    );
    return sendDocumentContent(reply, content);
  }

  async uploadPolicy(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const query = validateDto(MyUploadPolicyQueryDto, request.query ?? {});
    const data = await this.getMyUploadPolicy.execute(
      principal.tenantId,
      query.purpose ?? "EVIDENCE",
    );
    return reply.status(200).send(ok(data, "Política de subida."));
  }

  /**
   * Cuerpo binario crudo en stream (parser de paso directo de la ruta). Antes de leer un solo byte:
   * cabeceras válidas y `Content-Length` dentro del techo técnico (25 MB → 413 sin leer el cuerpo).
   */
  async uploadEvidence(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const principal = principalOf(request);
    const contentType = mediaTypeOf(request.headers["content-type"]);
    const encoding = request.headers["content-encoding"];
    if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
      // El cuerpo debe ser el fichero tal cual: documents sniffea su firma.
      throw fail("UNSUPPORTED_MEDIA_TYPE");
    }
    const rawFileName = request.headers["x-file-name"];
    const headers = validateDto(
      EvidenceUploadHeadersDto,
      rawFileName === undefined ? {} : { "x-file-name": rawFileName },
    );
    checkFileName(headers["x-file-name"]);
    const contentLength = contentLengthOf(request.headers["content-length"]);
    if (contentLength !== null && contentLength > EVIDENCE_TECHNICAL_MAX_BYTES) {
      throw fail("EVIDENCE_TOO_LARGE", [
        { field: "max_size_mb", issue: String(EVIDENCE_TECHNICAL_MAX_MB) },
      ]);
    }
    const body = request.body as Readable | undefined;
    if (body === undefined || body === null) {
      throw fail("VALIDATION_FAILED", [
        { field: "body", issue: "Falta el contenido del fichero." },
      ]);
    }

    const data = await this.uploadMyEvidence.execute(principal.tenantId, bearerOf(request), {
      body,
      contentType,
      encodedFileName: headers["x-file-name"],
      contentLength,
    });
    return reply.status(201).send(created(data, "Evidencia subida."));
  }
}
