/**
 * DTO de la bóveda documental propia y de las evidencias de horas extra del portal (Lote 4.5A, contrato
 * `lote-4.5a-contratos.md` §6).
 *
 * Las clases de PETICIÓN se validan con `validateDto` (`whitelist` + `forbidNonWhitelisted`): un
 * `employeeId` o cualquier parámetro no declarado → 422 `SSVCOM0001` y ningún hermano se llama. El
 * empleado sale SIEMPRE del principal verificado (C10).
 *
 * Las de RESPUESTA existen solo para generar el OpenAPI (DEC-16 = A); nunca se instancian.
 */
import { IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches } from "class-validator";

import { Doc } from "../../../../shared/application/dto-docs";
import {
  DOCUMENT_FILE_TYPES,
  EMPLOYEE_DOCUMENT_KINDS,
  UPLOAD_PURPOSES,
  type DocumentFileType,
  type EmployeeDocumentKind,
  type UploadPurpose,
} from "../ports/documents-client.port";

/** `page` ≥ 1 y `pageSize` 1–100 (convención de paginación C2). */
const PAGE_PATTERN = /^[1-9]\d{0,8}$/;
const PAGE_SIZE_PATTERN = /^([1-9]|[1-9]\d|100)$/;

const KIND_VALUES = EMPLOYEE_DOCUMENT_KINDS as unknown as string[];
const FILE_TYPE_VALUES = DOCUMENT_FILE_TYPES as unknown as string[];
const PURPOSE_VALUES = UPLOAD_PURPOSES as unknown as string[];

// ───────────────────────────── Peticiones ─────────────────────────────

/** Query de `GET /me/documents`. Cualquier otro parámetro (p. ej. `employeeId`) → 422. */
export class MyDocumentsQueryDto {
  @IsOptional()
  @IsIn(KIND_VALUES, { message: `kind debe ser una de: ${KIND_VALUES.join(", ")}.` })
  @Doc({ description: `Filtro por tipo: ${KIND_VALUES.join(" | ")}. Sin él, todos.` })
  kind?: EmployeeDocumentKind;

  @IsOptional()
  @Matches(PAGE_PATTERN, { message: "page debe ser un entero ≥ 1." })
  @Doc({ description: "Página (entero ≥ 1, defecto 1)." })
  page?: string;

  @IsOptional()
  @Matches(PAGE_SIZE_PATTERN, { message: "pageSize debe ser un entero entre 1 y 100." })
  @Doc({ description: "Tamaño de página (1–100, defecto 20)." })
  pageSize?: string;
}

/** Parámetros de `GET /me/documents/:documentId/content` (422 si no es un UUID). */
export class MyDocumentContentParamsDto {
  @IsUUID()
  documentId!: string;
}

/** Query de `GET /me/documents/upload-policy`. El portal solo sube evidencias. */
export class MyUploadPolicyQueryDto {
  @IsOptional()
  @IsIn(PURPOSE_VALUES, { message: `purpose debe ser una de: ${PURPOSE_VALUES.join(", ")}.` })
  @Doc({ description: "EVIDENCE (único admitido en el portal; defecto EVIDENCE)." })
  purpose?: UploadPurpose;
}

/** Cabeceras propias de `POST /me/evidence` (en minúsculas, como las entrega Fastify). */
export class EvidenceUploadHeadersDto {
  @IsString()
  @Doc({
    description:
      "Nombre original del fichero en UTF-8 codificado con % (encodeURIComponent). Decodificado: 1–255 caracteres, sin controles, / ni \\.",
  })
  "x-file-name"!: string;
}

/** Parámetros de las descargas de evidencia (`/me/overtime-requests/:id/evidence/:documentId` y `/team/…`). */
export class OvertimeEvidenceParamsDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  documentId!: string;
}

// ───────────────────────────── Respuestas ─────────────────────────────

/** Un documento propio (`GET /me/documents`, DTO mínimo del contrato §4). */
export class MyDocumentDto {
  @IsUUID()
  readonly id!: string;

  @IsIn(KIND_VALUES)
  readonly kind!: EmployeeDocumentKind;

  @IsString()
  @Doc({ nullable: true })
  readonly originalFilename!: string | null;

  @IsString()
  readonly contentType!: string;

  @IsInt()
  readonly sizeBytes!: number;

  @IsString()
  @Doc({ format: "date-time" })
  readonly createdAt!: string;

  @IsString()
  @Doc({ nullable: true, description: '"manual" si lo subió RRHH; si no, el servicio emisor.' })
  readonly sourceService!: string | null;
}

/** Un tipo de fichero admitido por la política. */
export class AllowedFileTypeDto {
  @IsIn(FILE_TYPE_VALUES)
  readonly type!: DocumentFileType;

  @IsString()
  readonly mime!: string;

  @IsArray()
  @IsString({ each: true })
  readonly extensions!: string[];
}

/** `GET /me/documents/upload-policy` (política del tenant; con EVIDENCE, la intersección del §2). */
export class UploadPolicyDto {
  @IsInt()
  @Doc({ description: "Límite de subida del tenant en MB." })
  readonly maxSizeMb!: number;

  @IsInt()
  @Doc({ description: "Techo técnico fijo (25 MB)." })
  readonly technicalMaxSizeMb!: number;

  @Doc({ nested: () => AllowedFileTypeDto, each: true })
  readonly allowedTypes!: AllowedFileTypeDto[];
}

/** Respuesta 201 de `POST /me/evidence`. */
export class UploadedEvidenceDto {
  @IsUUID()
  readonly documentId!: string;

  @IsInt()
  readonly sizeBytes!: number;

  @IsIn(FILE_TYPE_VALUES)
  @Doc({ description: "Tipo detectado por la firma del contenido (pdf, jpeg, png o webp)." })
  readonly detectedType!: DocumentFileType;
}
