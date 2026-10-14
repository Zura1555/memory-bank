import assert from "node:assert/strict";

assert.ok(process.env.OPERATOR_TOKEN, "Set OPERATOR_TOKEN or run with --env-file=.dev.vars");
const url = "http://127.0.0.1:8787/api/operator/status";
const unauthorized = await fetch(url);
assert.equal(unauthorized.status, 404);
await unauthorized.arrayBuffer();
await Promise.all(Array.from({ length: 3 }, async () => {
  const response: Response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.OPERATOR_TOKEN}` },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, "Database access must work across Worker requests");
  await response.arrayBuffer();
}));
console.log("Operator authentication and three concurrent database reads passed; no model jobs submitted.");
