import assert from "node:assert/strict";
import test from "node:test";
import type { ArtifactAssessment, Claim, SourceRef } from "../shared/protocol.ts";
import { checkedArtifactRefs } from "./checked-sources.ts";

test("selectable source cards exclude withheld, unrelated, blocker-only and unavailable evidence", () => {
  const ref: SourceRef = { caseId: "cedar", artifactId: "mapping", versionId: "v1", passageId: "p1" };
  const claim: Claim = { claimId: "accepted", kind: "source_fact", text: "Recorded map", dependsOnClaimIds: [], requestQuotes: [], sourceRefs: [ref, ref, { ...ref, artifactId: "request" }, { ...ref, caseId: "other" }] };
  const blocker: Claim = { ...claim, claimId: "blocker", sourceRefs: [{ ...ref, passageId: "blocker-only" }] };
  const claims = new Map([[claim.claimId, claim], [blocker.claimId, blocker]]);
  const item: ArtifactAssessment = { artifactId: "mapping", availability: "available", disposition: null, dispositionClaimId: null, claimIds: ["accepted", "withheld"], blockerClaimIds: ["blocker"], verificationClaimIds: [], exclusionReasons: [] };
  assert.deepEqual(checkedArtifactRefs("cedar", "available", item, claims), [ref]);
  assert.deepEqual(checkedArtifactRefs("cedar", "partial", item, claims), [ref]);
  assert.deepEqual(checkedArtifactRefs("cedar", "failed", item, claims), []);
  assert.deepEqual(checkedArtifactRefs("cedar", "unavailable", item, claims), []);
  assert.deepEqual(checkedArtifactRefs("cedar", "available", { ...item, availability: "unavailable" }, claims), []);
  assert.deepEqual(checkedArtifactRefs("cedar", "available", { ...item, claimIds: ["withheld"] }, claims), []);
  const retained = { ...ref, versionId: "v2" };
  claims.set("accepted", { ...claim, sourceRefs: [ref, retained] });
  assert.deepEqual(checkedArtifactRefs("cedar", "available", item, claims), [ref, retained]);
});
