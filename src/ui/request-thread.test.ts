import assert from "node:assert/strict";
import test from "node:test";
import { refinedRequest } from "./request-thread.ts";

test("follow-ups preserve complete context in order and reject oversized UTF-8 without truncation", () => {
  const original = "Individual investors only.\nAttached source: 投資家一覧";
  const first = refinedRequest(original, "Include entity investors instead.");
  const second = refinedRequest(first, "Require a separate administrator export.");
  assert.ok(second.startsWith(original));
  assert.ok(second.indexOf("Include entity investors instead.") < second.indexOf("Require a separate administrator export."));
  assert.equal(second.split("Attached source: 投資家一覧").length, 2);
  assert.throws(() => refinedRequest(original, "  "), /Enter a follow-up/);
  const boundary = "é".repeat(8192);
  assert.equal(refinedRequest(boundary), boundary);
  assert.throws(() => refinedRequest(boundary, "x"), /16 KiB/);
  assert.throws(() => refinedRequest(`${boundary}é`), /16 KiB/);
});
