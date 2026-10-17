import assert from "node:assert/strict";
import test from "node:test";
import type { PassageView } from "../shared/protocol.ts";
import { isPassage } from "./passage.ts";

test("passage previews reject substituted identities, unverified sources, and malformed content", () => {
  const passage: PassageView = {
    caseId: "cedar", artifactId: "mapping", versionId: "v1", passageId: "p1",
    title: "Field mapping", fictional: true, statedDate: null,
    excerpt: "Preserve the source key.", sourceKind: "native",
    location: { type: "text", startLine: 3, endLine: 5 },
  };
  assert.equal(isPassage(passage, passage), true);
  for (const field of ["caseId", "artifactId", "versionId", "passageId"] as const) {
    assert.equal(isPassage({ ...passage, [field]: "another-source" }, passage), false, field);
  }
  for (const invalid of [
    { ...passage, fictional: false }, { ...passage, excerpt: "" },
    { ...passage, sourceKind: "generated" }, { ...passage, location: null },
    { ...passage, location: { region: { guessed: true } } },
  ]) assert.equal(isPassage(invalid, passage), false);
});
