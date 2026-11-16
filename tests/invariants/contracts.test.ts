/**
 * INVARIANTE — Contrato FE↔BE del envelope de respuesta (rulebook §4.8). El frontend depende de
 * esta forma exacta: `success/statusCode/message/data/meta`, con `code` presente SOLO en error y
 * `data` null en error. Test puro sobre los builders de `shared/application/response.dto` (sin DB).
 *
 * `self_service` expone solo tres builders (`ok`, `created`, `failure`): no hay `accepted()` porque
 * ningún caso de uso responde 202 (las marcaciones de reloj se crean de forma síncrona). El
 * invariante que se verifica es el mismo que en payroll.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { created, failure, ok } from "../../src/shared/application/response.dto";

test("ok(): éxito con data, statusCode 200 y SIN code", () => {
  const r = ok({ a: 1 }, "listo");
  assert.equal(r.success, true);
  assert.equal(r.statusCode, 200);
  assert.equal(r.message, "listo");
  assert.deepEqual(r.data, { a: 1 });
  assert.equal("code" in r, false, "una respuesta de éxito NUNCA lleva code");
  assert.equal(r.errors, undefined);
});

test("ok(): incluye meta de paginación cuando se pasa", () => {
  const meta = { page: 1, pageSize: 10, total: 0, totalPages: 0 };
  const r = ok([], "listado", meta);
  assert.deepEqual(r.meta, meta);
});

test("ok(): sin meta, la clave meta no aparece en el envelope", () => {
  const r = ok({ a: 1 });
  assert.equal("meta" in r, false, "sin meta explícita, el envelope no debe inventar paginación");
});

test("created(): 201, éxito, sin code", () => {
  const c = created({ id: "x" });
  assert.equal(c.statusCode, 201);
  assert.equal(c.success, true);
  assert.equal("code" in c, false);
  assert.deepEqual(c.data, { id: "x" });
});

test("failure(): success=false, code del catálogo presente, data null, errors preservados", () => {
  const r = failure(409, "SSCOM0001", "conflicto", [{ field: "x", issue: "y" }]);
  assert.equal(r.success, false);
  assert.equal(r.statusCode, 409);
  assert.equal(r.code, "SSCOM0001");
  assert.equal(r.data, null, "una respuesta de error lleva data null");
  assert.deepEqual(r.errors, [{ field: "x", issue: "y" }]);
});

test("failure(): errors por defecto es una lista vacía, nunca undefined", () => {
  const r = failure(400, "SSCOM0002", "mal");
  assert.deepEqual(r.errors, []);
});

test("invariante transversal: `code` aparece exactamente en los errores", () => {
  assert.equal("code" in ok(null), false);
  assert.equal("code" in created(null), false);
  assert.equal(typeof failure(400, "SSCOM0002", "mal").code, "string");
});
