/**
 * Rutas de la bóveda documental propia y de la subida de evidencias del portal (Lote 4.5A, contrato
 * `lote-4.5a-contratos.md` §6), bajo el prefijo `/api/v1/self-service` (aplicado en `server.ts`):
 *   - `GET /me/documents` y `GET /me/documents/:documentId/content` (`self_service:read`);
 *   - `GET /me/documents/upload-policy` y `POST /me/evidence` (`self_service:punch`).
 *
 * `POST /me/evidence` recibe el fichero como cuerpo binario CRUDO (no multipart, no JSON): se registra en
 * su propio ámbito encapsulado, que retira los parsers heredados y monta uno de PASO DIRECTO (el cuerpo
 * llega al controller como stream sin leer). Así ninguna otra ruta del servicio acepta binario ni ve
 * alterado su `bodyLimit` (C1). El `bodyLimit` de 25 MB de la ruta documenta el techo; el control real es
 * el pre-chequeo de `Content-Length` del controller y el contador del cliente de documents (Fastify no
 * aplica `bodyLimit` a un parser de paso directo).
 *
 * Limitadores por usuario (C8), además del global por IP: 20 subidas/min y 60 descargas/min.
 *
 * Todas declaran `schema` (DEC-16 = A); el `schema` NO valida: class-validator sigue siendo el validador.
 */
import type { FastifyInstance } from "fastify";

import { container } from "../../../../../shared/container";
import {
  authenticate,
  requirePermission,
} from "../../../../../shared/infrastructure/http/middlewares/authentication.middleware";
import { userRateLimit } from "../../../../../shared/infrastructure/http/middlewares/rate-limit/user-rate-limit";
import {
  AUTHENTICATED_ROUTE_ERRORS,
  routeSchema,
} from "../../../../../shared/infrastructure/http/openapi/route-schema";
import {
  EvidenceUploadHeadersDto,
  MyDocumentContentParamsDto,
  MyDocumentDto,
  MyDocumentsQueryDto,
  MyUploadPolicyQueryDto,
  UploadedEvidenceDto,
  UploadPolicyDto,
} from "../../../application/dtos/self-portal-documents.dto";
import { EVIDENCE_TECHNICAL_MAX_BYTES } from "../../../application/ports/documents-client.port";
import { DocumentsPortalController } from "../controllers/documents-portal.controller";

const READ_PERMISSION = "self_service:read";
const PUNCH_PERMISSION = "self_service:punch";
const TAG = "Portal del colaborador";

/** C8: subidas de evidencia por usuario y minuto (contrato §6). */
export const EVIDENCE_UPLOADS_PER_MINUTE = 20;
/** Descargas de contenido por usuario y minuto (decisión del BFF: documents descifra en memoria). */
export const CONTENT_DOWNLOADS_PER_MINUTE = 60;
const ONE_MINUTE_MS = 60_000;

/** Media types que documents admite como evidencia (contrato §2: pdf, jpeg, png, webp). */
const EVIDENCE_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/** Respuesta binaria de una descarga (sin envelope). */
export const DOWNLOAD_RESPONSE = {
  description: "Contenido del documento.",
  raw: {
    content: {
      "application/octet-stream": { schema: { type: "string", format: "binary" } },
    },
  },
} as const;

export const contentDownloadLimiter = (app: FastifyInstance) =>
  userRateLimit(app, {
    name: "content-download",
    max: CONTENT_DOWNLOADS_PER_MINUTE,
    timeWindowMs: ONE_MINUTE_MS,
  });

export const registerDocumentsPortalRoutes = (app: FastifyInstance): void => {
  const controller = container.resolve(DocumentsPortalController);
  const downloadLimiter = contentDownloadLimiter(app);

  app.get(
    "/me/documents",
    {
      preHandler: [authenticate, requirePermission(READ_PERMISSION)],
      schema: routeSchema({
        operationId: "listMyDocuments",
        summary: "Documentos propios del empleado autenticado (bóveda), paginados.",
        description:
          "Solo documentos CONFIRMED del propio empleado de los tipos CONTRACT, SUPPORT, OTHER, PAYSLIP, SETTLEMENT y UTILIDADES_SLIP (nunca evidencias de horas extra). El empleado se resuelve en el servidor: un employeeId u otro parámetro no declarado → 422 SSVCOM0001. documents o people caídos → 503.",
        tags: [TAG],
        permission: READ_PERMISSION,
        querystring: MyDocumentsQueryDto,
        response: {
          description: "Página de documentos propios.",
          list: [MyDocumentDto],
          paginated: true,
        },
        errors: [
          ...AUTHENTICATED_ROUTE_ERRORS,
          "VALIDATION_FAILED",
          "SELF_PROFILE_NOT_LINKED",
          "SELF_UPSTREAM_UNAVAILABLE",
        ],
      }),
    },
    (request, reply) => controller.myDocuments(request, reply),
  );

  app.get(
    "/me/documents/upload-policy",
    {
      preHandler: [authenticate, requirePermission(PUNCH_PERMISSION)],
      schema: routeSchema({
        operationId: "getMyUploadPolicy",
        summary: "Política de subida de evidencias del tenant (tamaño y tipos admitidos).",
        description:
          "?purpose=EVIDENCE (único admitido; por defecto). maxSizeMb es el límite del tenant y technicalMaxSizeMb el techo fijo (25); allowedTypes, la intersección de pdf/jpeg/png/webp con los tipos del tenant. Cualquier otro parámetro → 422 SSVCOM0001. documents caído → 503.",
        tags: [TAG],
        permission: PUNCH_PERMISSION,
        querystring: MyUploadPolicyQueryDto,
        response: { description: "Política de subida.", data: UploadPolicyDto },
        errors: [...AUTHENTICATED_ROUTE_ERRORS, "VALIDATION_FAILED", "SELF_UPSTREAM_UNAVAILABLE"],
      }),
    },
    (request, reply) => controller.uploadPolicy(request, reply),
  );

  app.get(
    "/me/documents/:documentId/content",
    {
      preHandler: [authenticate, requirePermission(READ_PERMISSION), downloadLimiter],
      schema: routeSchema({
        operationId: "downloadMyDocumentContent",
        summary: "Descarga un documento propio del empleado autenticado.",
        description:
          "Binario en stream, sin envelope, con las cabeceras de descarga de documents (Content-Type según el tipo detectado, Content-Disposition attachment, Cache-Control no-store, nosniff). Un documento ajeno, inexistente, sin confirmar o de un tipo no visible responde 404 SSVDOC0001 sin distinguirlos. Sin parámetros de query (→ 422 SSVCOM0001). Límite: 60 descargas/min por usuario.",
        tags: [TAG],
        permission: READ_PERMISSION,
        params: MyDocumentContentParamsDto,
        response: DOWNLOAD_RESPONSE,
        errors: [
          ...AUTHENTICATED_ROUTE_ERRORS,
          "VALIDATION_FAILED",
          "SELF_PROFILE_NOT_LINKED",
          "SELF_DOCUMENT_NOT_FOUND",
          "SELF_UPSTREAM_UNAVAILABLE",
        ],
      }),
    },
    (request, reply) => controller.myDocumentContent(request, reply),
  );

  // Ámbito propio: solo esta ruta acepta un cuerpo binario crudo (C1).
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_request, payload, done) => {
      // Paso directo: el cuerpo NO se lee aquí; el controller lo reenvía en stream a documents.
      done(null, payload);
    });

    scope.post(
      "/me/evidence",
      {
        bodyLimit: EVIDENCE_TECHNICAL_MAX_BYTES,
        preHandler: [
          authenticate,
          requirePermission(PUNCH_PERMISSION),
          userRateLimit(scope, {
            name: "evidence-upload",
            max: EVIDENCE_UPLOADS_PER_MINUTE,
            timeWindowMs: ONE_MINUTE_MS,
          }),
        ],
        schema: routeSchema({
          operationId: "uploadMyOvertimeEvidence",
          summary: "Sube una evidencia de horas extra del empleado autenticado.",
          description:
            "Cuerpo = el fichero en binario crudo (no multipart), con Content-Type del fichero y X-File-Name (nombre original en UTF-8 codificado con %). Se reenvía en stream a documents, que verifica la firma real, el tamaño del tenant y la confirma en la misma llamada; un solo intento (sin reintentos). 413 SSVDOC0009 si supera el límite del tenant o 25 MB (errors[{field:max_size_mb}]); 415 SSVDOC0010 si el contenido no es pdf/jpeg/png/webp admitido o no coincide con el declarado (errors de documents); 422 SSVCOM0001 si X-File-Name falta o es inválida; 429 si se supera la cuota (20/min por usuario, o 30 evidencias por empleado en 24 h); documents caído → 503.",
          tags: [TAG],
          permission: PUNCH_PERMISSION,
          headers: EvidenceUploadHeadersDto,
          rawBody: { contentTypes: [...EVIDENCE_CONTENT_TYPES] as [string, ...string[]] },
          response: { description: "Evidencia subida.", status: 201, data: UploadedEvidenceDto },
          errors: [
            ...AUTHENTICATED_ROUTE_ERRORS,
            "MALFORMED_REQUEST",
            "UNSUPPORTED_MEDIA_TYPE",
            "VALIDATION_FAILED",
            "EVIDENCE_TOO_LARGE",
            "EVIDENCE_UNSUPPORTED_TYPE",
            "SELF_PROFILE_NOT_LINKED",
            "SELF_UPSTREAM_UNAVAILABLE",
          ],
        }),
      },
      (request, reply) => controller.uploadEvidence(request, reply),
    );
  });
};
