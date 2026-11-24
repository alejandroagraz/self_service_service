/**
 * GAP-033 §6 — `GET /me/profile` expone como `seniorityYears` el `serviceYears` que calcula people
 * (fuente única `completedYearsSince`); el BFF ya no lo recalcula desde `hireDate`. Si people no lo
 * informa, el campo es `null` (decisión provisional B, pendiente del orquestador).
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { API, buildHarness, type Harness } from "../support/http-harness";

let h: Harness;
const TENANT = randomUUID();

const tokenWith = (serviceYears: unknown, present: boolean): string => {
  const token = `token-${randomUUID()}`;
  const userId = randomUUID();
  h.upstream.principals.set(token, {
    userId,
    tenantId: TENANT,
    permissions: ["self_service:read"],
  });
  h.upstream.employees.set(token, {
    employeeId: randomUUID(),
    userId,
    fullName: "Ana Pérez",
    ...(present ? { serviceYears } : {}),
  });
  return token;
};

const seniorityOf = async (token: string): Promise<unknown> => {
  const res = await h.app.inject({
    method: "GET",
    url: `${API}/me/profile`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  return res.json().data.seniorityYears;
};

before(async () => {
  h = await buildHarness();
});

after(async () => {
  await h.close();
});

test("seniorityYears = serviceYears de people (no se recalcula con hireDate 2020-01-15)", async () => {
  // El doble devuelve hireDate 2020-01-15; con el reloj en 2026-11-23 el cálculo local daría 6.
  assert.equal(await seniorityOf(tokenWith(3, true)), 3);
  assert.equal(await seniorityOf(tokenWith(0, true)), 0);
});

test("seniorityYears = null si people no informa serviceYears o lo informa mal", async () => {
  assert.equal(await seniorityOf(tokenWith(undefined, false)), null);
  assert.equal(await seniorityOf(tokenWith(null, true)), null);
  assert.equal(await seniorityOf(tokenWith(-1, true)), null);
  assert.equal(await seniorityOf(tokenWith(2.5, true)), null);
  assert.equal(await seniorityOf(tokenWith("3", true)), null);
});
