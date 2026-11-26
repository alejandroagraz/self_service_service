/**
 * `DocumentsClient.uploadEvidence` (Lote 4.5A, guardian C7/C8) contra un servidor local:
 *   - el stream se reenvía en UN solo intento: ni un 503 ni un fallo de red se reintentan;
 *   - una subida SIN `Content-Length` que supera el techo técnico (25 MB) se corta en el BFF con 413
 *     `SSVDOC0009` sin reenviar más del techo;
 *   - `verifyEvidence` sí reintenta ante fallo transitorio (no tiene efectos).
 */
import "../support/test-env";

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import { EVIDENCE_TECHNICAL_MAX_BYTES } from "../../src/modules/self-portal/application/ports/documents-client.port";
import { isAppError } from "../../src/shared/errors/app-error";
import { DocumentsClient } from "../../src/shared/infrastructure/http/documents-client";

let server: Server;
let baseUrl = "";
let mode: "unavailable" | "destroy" | "drain" | "early413" | "early413close" = "unavailable";
let calls = 0;
let receivedBytes = 0;

before(async () => {
  server = createServer((req, res) => {
    calls += 1;
    if (mode === "destroy") {
      req.socket.destroy();
      return;
    }
    if (mode === "early413" || mode === "early413close") {
      // Pre-chequeo de Content-Length de documents (§2.1): responde SIN leer el cuerpo.
      res.writeHead(413, {
        "content-type": "application/json",
        ...(mode === "early413close" ? { connection: "close" } : {}),
      });
      res.end(
        JSON.stringify({
          success: false,
          statusCode: 413,
          code: "DOCCOM0009",
          message: "demasiado grande",
          data: null,
          errors: [{ field: "max_size_mb", issue: "10" }],
        }),
      );
      if (mode === "early413close") {
        res.on("finish", () => {
          req.socket.destroy();
        });
      }
      return;
    }
    req.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
    });
    req.on("end", () => {
      res.writeHead(mode === "drain" ? 201 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, code: "DOCCOM0004", data: null }));
    });
    req.on("error", () => {
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  calls = 0;
  receivedBytes = 0;
});

const client = () => new DocumentsClient(baseUrl, "read-key", "upload-key", 2_000, 10_000);
const caller = { tenantId: randomUUID(), employeeId: randomUUID() };

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(isAppError(error), String(error));
    return error.code;
  }
  assert.fail("se esperaba un AppError");
};

/** Stream de `total` bytes en trozos de 1 MiB (sin bufferizar el total). */
const bytesStream = (total: number): Readable => {
  const chunk = Buffer.alloc(1024 * 1024, 0x41);
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= total) {
        this.push(null);
        return;
      }
      const size = Math.min(chunk.length, total - sent);
      sent += size;
      this.push(chunk.subarray(0, size));
    },
  });
};

test("503 de documents: un solo intento, sin reintento del stream → SSVSLF0002", async () => {
  mode = "unavailable";
  const code = await codeOf(
    client().uploadEvidence(caller, {
      body: Readable.from([Buffer.from("%PDF-1.7 evidencia")]),
      contentType: "application/pdf",
      encodedFileName: "evidencia.pdf",
      contentLength: null,
    }),
  );
  assert.equal(code, "SSVSLF0002");
  assert.equal(calls, 1);
});

test("fallo de red durante la subida: un solo intento → SSVSLF0002", async () => {
  mode = "destroy";
  const code = await codeOf(
    client().uploadEvidence(caller, {
      body: Readable.from([Buffer.from("%PDF-1.7 evidencia")]),
      contentType: "application/pdf",
      encodedFileName: "evidencia.pdf",
      contentLength: null,
    }),
  );
  assert.equal(code, "SSVSLF0002");
  assert.equal(calls, 1);
});

test("sin Content-Length y por encima de 25 MB: el BFF corta el reenvío con 413 SSVDOC0009", async () => {
  mode = "drain";
  const code = await codeOf(
    client().uploadEvidence(caller, {
      body: bytesStream(EVIDENCE_TECHNICAL_MAX_BYTES + 1024 * 1024),
      contentType: "application/pdf",
      encodedFileName: "grande.pdf",
      contentLength: null,
    }),
  );
  assert.equal(code, "SSVDOC0009");
  assert.ok(receivedBytes <= EVIDENCE_TECHNICAL_MAX_BYTES, `recibidos ${String(receivedBytes)}`);
});

test("verify (sin efectos) sí reintenta ante 503 antes de rendirse", async () => {
  mode = "unavailable";
  const code = await codeOf(client().verifyEvidence(caller, [randomUUID()]));
  assert.equal(code, "SSVSLF0002");
  assert.equal(calls, 3);
});

for (const variant of ["early413", "early413close"] as const) {
  test(`M-7 (${variant}): 413 del pre-chequeo de documents con el cuerpo aún en vuelo → 413 SSVDOC0009 con sus errors`, async () => {
    mode = variant;
    const total = 20 * 1024 * 1024;
    let caught: unknown;
    try {
      await client().uploadEvidence(caller, {
        body: bytesStream(total),
        contentType: "application/pdf",
        encodedFileName: "grande.pdf",
        contentLength: total,
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(isAppError(caught), String(caught));
    assert.equal(caught.code, "SSVDOC0009");
    assert.deepEqual(caught.details, [{ field: "max_size_mb", issue: "10" }]);
    assert.equal(calls, 1);
  });
}
