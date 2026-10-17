import assert from "node:assert/strict";
import Ajv from "ajv";
import test from "node:test";
import type { ArtifactRole, AssessmentResult, Claim, RequestConstraints, Selection, SupportVerdict } from "../shared/protocol.ts";
import { assessmentDraftSchema, assessmentReviewSchema, briefDraftSchema, openRouterSchema, parseAssessmentDraft, reviewSchema, type AssessmentDraft, type AssessmentOutput, type BriefDraft } from "./schemas.ts";
import { buildCheckedAssessment, buildCheckedBrief, GateFailure, revalidateAssessment, revalidateBrief, validateAssessmentDraft, validateBriefDraft, validateArtifactReview, validateSupportReview } from "./gates.ts";
import { validateSelections } from "./selections.ts";
import { assessmentPassageIds, EvidenceUnavailable, type Artifact, type CorpusSnapshot, type ModelCaseContext, type PastCase, type SourceVersion } from "./corpus.ts";
import { dispositionChanges } from "../ui/lineage.ts";
import { assessmentDraftPrompt, briefDraftPrompt } from "./prompts.ts";
import { callOpenRouter } from "./openrouter.ts";
import type { Env } from "./env.ts";

const emptyRequirementReview: { request: string; constraints: RequestConstraints } = {
  request: "current request",
  constraints: { product_version: [], environment: [], scale: [], identity_access: [], recovery_operations: [] },
};

function artifactRoles(draft: AssessmentDraft, role: ArtifactRole = "starting_point"): Map<string, ArtifactRole> {
  return new Map(draft.cases.flatMap((item) => item.artifactWork.map((work) => [`${item.caseId}/${work.artifactId}`, role] as const)));
}

function fixture(): CorpusSnapshot {
  const cases: PastCase[] = [];
  const availableVersions = new Set<string>();
  const caseAvailability = new Map<string, "available" | "partial" | "unavailable">();
  const passages = new Map();
  const versions = new Map<string, { version: SourceVersion; artifact: Artifact; pastCase: PastCase }>();
  for (let index = 1; index <= 8; index++) {
    const caseId = `case-${index}`;
    const pastCase: PastCase = { caseId, title: `Fictional case ${index}`, fictional: true, artifacts: [], records: [] };
    const artifactIds = index === 1 ? ["request", "handover"] : ["request"];
    for (const artifactId of artifactIds) {
      const sourceVersions = index === 1 && artifactId === "request" ? ["request-v1", "request-v2"] : [`${artifactId}-v1-${caseId}`];
      const artifact: Artifact = { artifactId, title: artifactId, fictional: true, versions: [] };
      for (const versionId of sourceVersions) {
        const passageId = `p-${versionId}`;
        const version: SourceVersion = {
          versionId,
          sourcePath: `corpora/test-v1/originals/${caseId}/${artifactId}.txt`,
          mimeType: "text/plain",
          sha256: "a".repeat(64),
          statedDate: null,
          importedAt: "2026-10-14T00:00:00.000Z",
          extractionStatus: "complete",
          exclusionReasons: [],
          passages: [{ passageId, excerpt: `Evidence from ${versionId}`, sourceKind: "native", location: { type: "text", startLine: 1, endLine: 1 } }],
        };
        artifact.versions.push(version);
        availableVersions.add(versionId);
        passages.set(passageId, {
          caseId,
          artifactId,
          versionId,
          passageId,
          title: artifact.title,
          fictional: true,
          statedDate: null,
          excerpt: version.passages[0].excerpt,
          sourceKind: "native",
          location: version.passages[0].location,
        });
        versions.set(versionId, { version, artifact, pastCase });
      }
      pastCase.artifacts.push(artifact);
    }
    cases.push(pastCase);
    caseAvailability.set(caseId, "available");
  }
  return {
    manifest: { schemaVersion: 2, corpusVersion: "test-v1", cases },
    manifestSha256: "b".repeat(64),
    availableVersions,
    caseAvailability,
    passages,
    versions,
  };
}

function assessmentDraft(corpus: CorpusSnapshot): AssessmentDraft {
  const claims: Claim[] = corpus.manifest.cases.flatMap((pastCase, caseIndex) => pastCase.artifacts.flatMap((artifact, artifactIndex) => {
    const version = artifact.versions[0];
    const sourceRefs = [{ caseId: pastCase.caseId, artifactId: artifact.artifactId, versionId: version.versionId, passageId: version.passages[0].passageId }];
    const suffix = `${caseIndex}-${artifactIndex}`;
    return [
      { claimId: `fact-${suffix}`, text: "Recorded work", kind: "source_fact", sourceRefs, requestQuotes: [], dependsOnClaimIds: [] },
      { claimId: `decision-${suffix}`, text: "Adapt the recorded work after checking the client's capabilities.", kind: "recommendation", sourceRefs, requestQuotes: ["current request"], dependsOnClaimIds: [`fact-${suffix}`] },
    ];
  }));
  claims.push(...claims.filter((claim) => claim.kind === "recommendation").map((claim): Claim => ({
    ...claim, claimId: `classification-${claim.claimId}`, kind: "interpretation",
    text: "Artifact disposition: adapt.", dependsOnClaimIds: [claim.claimId],
  })));
  return {
    cases: corpus.manifest.cases.map((pastCase, caseIndex) => ({
      caseId: pastCase.caseId,
      outcome: "observed_success",
      outcomeClaimIds: [`fact-${caseIndex}-0`],
      claimIds: pastCase.artifacts.map((_, artifactIndex) => `fact-${caseIndex}-${artifactIndex}`),
      artifactWork: pastCase.artifacts.map((artifact, artifactIndex) => ({
        artifactId: artifact.artifactId,
        disposition: "adapt",
        dispositionClaimId: `decision-${caseIndex}-${artifactIndex}`,
        claimIds: [`fact-${caseIndex}-${artifactIndex}`, `decision-${caseIndex}-${artifactIndex}`, `classification-decision-${caseIndex}-${artifactIndex}`],
        blockerClaimIds: [],
        verificationClaimIds: [],
      })),
    })),
    leads: [],
    contrasts: [],
    clarifyingClaimIds: [],
    comparisons: [],
    requestConstraints: { ...emptyRequirementReview.constraints },
    claims,
  };
}

test("assessment rejects omitted artifacts even when all eight cases are present", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  draft.cases[0].artifactWork.pop();
  assert.throws(
    () => validateAssessmentDraft(draft, "current request", corpus),
    (error: unknown) => error instanceof GateFailure && error.code === "INCOMPLETE_ARTIFACT_WORK",
  );
});

test("selection cannot substitute a different version of an assessed artifact", () => {
  const corpus = fixture();
  const caseId = "case-1";
  const claim: Claim = {
    claimId: "checked-claim",
    text: "Adapt the checked work for this request.",
    kind: "recommendation",
    sourceRefs: [{ caseId, artifactId: "request", versionId: "request-v1", passageId: "p-request-v1" }],
    requestQuotes: ["current request"],
    dependsOnClaimIds: [],
  };
  const assessment: AssessmentResult = {
    conclusion: "precedent_found",
    clarifyingClaimIds: [],
    comparisons: [],
    requestConstraints: emptyRequirementReview.constraints,
    artifactReviews: [{ caseId, artifactId: "request", role: "starting_point" }],
    nextActions: [],
    cases: [{ caseId, availability: "available", outcome: "unknown", outcomeClaimIds: [], claimIds: [claim.claimId], artifactWork: [{ artifactId: "request", availability: "available", exclusionReasons: [], disposition: "adapt", dispositionClaimId: claim.claimId, claimIds: [claim.claimId], blockerClaimIds: [], verificationClaimIds: [] }] }],
    leads: [],
    contrasts: [],
    claims: [claim],
    withheldClaimCount: 0,
  };
  const selection: Selection = { caseId, artifactId: "request", versionId: "request-v2", passageIds: ["p-request-v2"] };
  assert.throws(
    () => validateSelections([selection], assessment, corpus),
    (error: unknown) => error instanceof Error && error.message === "INVALID_SELECTION_PASSAGE",
  );
});
test("brief disposition is withheld when its recommendation claim is unsupported", () => {
  const corpus = fixture();
  const caseId = "case-1";
  const sourceRefs = [{ caseId, artifactId: "request", versionId: "request-v1", passageId: "p-request-v1" }];
  const factual: Claim = {
    claimId: "factual",
    text: "The source records the work.",
    kind: "source_fact",
    sourceRefs,
    requestQuotes: ["current request"],
    dependsOnClaimIds: [],
  };
  const recommendation: Claim = {
    claimId: "disposition",
    text: "Reuse this work unchanged.",
    kind: "recommendation",
    sourceRefs,
    requestQuotes: ["current request"],
    dependsOnClaimIds: [],
  };
  const draft: BriefDraft = {
    reuse: [{ caseId, artifactId: "request", versionId: "request-v1", disposition: "reuse", dispositionClaimId: recommendation.claimId, claimIds: [factual.claimId, recommendation.claimId] }],
    adapt: [],
    verify: [],
    claims: [factual, recommendation],
  };
  const selections = [{ caseId, artifactId: "request", versionId: "request-v1" }];
  const invalidRefs = validateBriefDraft(draft, "current request", selections, corpus);
  const checked = buildCheckedBrief(draft, new Map<string, SupportVerdict>([
    [factual.claimId, "supported"],
    [recommendation.claimId, "unsupported"],
  ]), invalidRefs);
  assert.deepEqual(checked.reuse, []);
  assert.deepEqual(checked.claims.map((claim) => claim.claimId), [factual.claimId]);
});


test("support review must cover each claim exactly once", () => {
  const claim: Claim = {
    claimId: "claim-one",
    text: "A checked statement.",
    kind: "source_fact",
    sourceRefs: [{ caseId: "case-1", artifactId: "request", versionId: "request-v1", passageId: "p-request-v1" }],
    requestQuotes: [],
    dependsOnClaimIds: [],
  };
  assert.throws(
    () => validateSupportReview([claim], { claimReviews: [] }),
    (error: unknown) => error instanceof GateFailure && error.code === "INCOMPLETE_SUPPORT_REVIEW",
  );
});

test("case outcome labels need their own review even when the underlying facts pass", () => {
  const corpus = fixture();
  const wireIds = assessmentPassageIds(corpus);
  const output: AssessmentOutput = {
    requestConstraints: emptyRequirementReview.constraints,
    cases: corpus.manifest.cases.map((pastCase) => ({
      caseId: pastCase.caseId, outcome: "failed",
      artifactWork: pastCase.artifacts.map((artifact) => ({
        artifactId: artifact.artifactId, disposition: "adapt", usefulForLead: false,
        recommendation: {
          text: "Adapt the recorded work after checking the client's capabilities.",
          sourceRefs: [wireIds.get(artifact.versions[0].passages[0].passageId)!],
          requestQuotes: ["current request"], dependsOnClaimIds: [],
        },
        supportingClaims: [], blockerClaims: [], verificationClaims: [],
      })),
    })),
    claims: corpus.manifest.cases.map((pastCase, index) => ({
      claimId: `fact-${index}`, caseId: pastCase.caseId, kind: "source_fact", outcomeEvidence: true,
      text: index === 0 ? "Work stopped; the client-dependent provisioning outcome is unknown." : "The attempted provisioning failed with a recorded error.",
      sourceRefs: [wireIds.get(pastCase.artifacts[0].versions[0].passages[0].passageId)!],
      requestQuotes: [], dependsOnClaimIds: [],
    })),
    leads: [], contrasts: [], clarifyingClaimIds: [],
  };
  output.cases[4].outcome = "unknown";
  output.claims[5].outcomeEvidence = false;
  output.cases[6].outcome = "partial";
  output.cases[7].outcome = "observed_success";
  const draft = parseAssessmentDraft(output, corpus);
  const invalid = validateAssessmentDraft(draft, "current request", corpus);
  const review = { claimReviews: draft.claims.map((claim) => ({
    claimId: claim.claimId,
    verdict: (claim.claimId === "outcome-0" ? "unsupported" : claim.claimId === "outcome-2" ? "uncertain" : "supported") as SupportVerdict,
  })) };
  const verdicts = validateSupportReview(draft.claims, review);
  // A missing verdict also fails closed; production rejects incomplete reviews.
  verdicts.delete("outcome-3");
  const checked = buildCheckedAssessment(draft, verdicts, invalid, corpus, artifactRoles(draft), emptyRequirementReview);
  assert.deepEqual(checked.cases.map((item) => item.outcome), ["unknown", "failed", "unknown", "unknown", "unknown", "unknown", "partial", "observed_success"]);
  assert.deepEqual(checked.cases[0].outcomeClaimIds, []);
  assert.ok(checked.claims.some((claim) => claim.claimId === "fact-0"));
  assert.ok(!checked.claims.some((claim) => claim.claimId === "outcome-0"));
  const classification = checked.claims.find((claim) => claim.claimId === "outcome-1")!;
  assert.equal(classification.kind, "interpretation");
  assert.deepEqual(classification.dependsOnClaimIds, ["fact-1"]);
  assert.throws(
    () => validateSupportReview(draft.claims, { claimReviews: review.claimReviews.filter((item) => item.claimId !== "outcome-1") }),
    (error: unknown) => error instanceof GateFailure && error.code === "INCOMPLETE_SUPPORT_REVIEW",
  );
  assert.equal(revalidateAssessment(checked, "current request", corpus).cases[1].outcome, "failed");
  const legacy = structuredClone(checked);
  legacy.claims = legacy.claims.filter((claim) => claim.claimId !== "outcome-1");
  legacy.cases[1].outcomeClaimIds = ["fact-1"];
  assert.equal(revalidateAssessment(legacy, "current request", corpus).cases[1].outcome, "unknown");
  for (const rejection of ["unsupported", "uncertain"] as const) {
    verdicts.set("fact-1", rejection);
    assert.equal(buildCheckedAssessment(draft, verdicts, invalid, corpus, artifactRoles(draft), emptyRequirementReview).cases[1].outcome, "unknown");
  }
  verdicts.set("fact-1", "supported");
  assert.equal(buildCheckedAssessment(draft, verdicts, new Set(["fact-1"]), corpus, artifactRoles(draft), emptyRequirementReview).cases[1].outcome, "unknown");
  corpus.passages.delete(corpus.manifest.cases[1].artifacts[0].versions[0].passages[0].passageId);
  assert.equal(revalidateAssessment(checked, "current request", corpus).cases[1].outcome, "unknown");
});

test("artifact recommendations and role claims remain independently reviewable", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  const wireIds = assessmentPassageIds(corpus);
  const byId = new Map(draft.claims.map((claim) => [claim.claimId, claim]));
  const output: AssessmentOutput = {
    requestConstraints: draft.requestConstraints, leads: [], contrasts: [], clarifyingClaimIds: [],
    claims: draft.claims.filter((claim) => claim.kind === "source_fact").map((claim) => ({ ...claim, sourceRefs: claim.sourceRefs.map((ref) => wireIds.get(ref.passageId)!), caseId: claim.sourceRefs[0].caseId, outcomeEvidence: false as const })),
    cases: draft.cases.map(({ claimIds: _, outcomeClaimIds: __, ...item }) => ({
      ...item,
      artifactWork: item.artifactWork.map((work) => {
        const { claimId: _, kind: __, ...recommendation } = byId.get(work.dispositionClaimId)!;
        return {
          artifactId: work.artifactId, disposition: "adapt", usefulForLead: false, recommendation: { ...recommendation, sourceRefs: recommendation.sourceRefs.map((ref) => wireIds.get(ref.passageId)!) },
          supportingClaims: work.claimIds.filter((id) => id !== work.dispositionClaimId && !id.startsWith("classification-")).map((id) => {
            const { claimId: _, ...claim } = byId.get(id)!;
            return { ...claim, sourceRefs: claim.sourceRefs.map((ref) => wireIds.get(ref.passageId)!) };
          }),
          blockerClaims: [], verificationClaims: [],
        };
      }),
    })),
  };
  // A current-client constraint is not a historical fact merely because it cites a past request.
  const requestClaim = { ...output.claims[0], kind: "source_fact" as const, outcomeEvidence: false as const, text: "The current request states: current request.", requestQuotes: ["current request"] };
  const mistakenRequirement = structuredClone(output);
  mistakenRequirement.claims[0] = requestClaim;
  assert.equal(assessmentDraftSchema.safeParse(mistakenRequirement).success, false);
  const generation = assessmentDraftPrompt("current request", corpus).responseSchema!;
  const providerSchema = openRouterSchema("assessment", generation).json_schema.schema;
  assert.doesNotMatch(JSON.stringify(providerSchema), /"allOf":/, "OpenAI Structured Outputs rejects allOf composition.");
  const provider = new Ajv({ strict: false }).compile(providerSchema);
  const wire = {
    ...mistakenRequirement,
    cases: Object.fromEntries(mistakenRequirement.cases.map(({ caseId, artifactWork, outcome }) => [caseId, {
      outcome, tier: "context",
      artifactWork: Object.fromEntries(artifactWork.map(({ artifactId, ...work }) => [artifactId, work])),
    }])),
  };
  const { leads: _leads, contrasts: _contrasts, ...providerWire } = wire;
  assert.equal(provider(providerWire), false);
  mistakenRequirement.claims[0] = { ...requestClaim, kind: "interpretation" };
  assert.equal(assessmentDraftSchema.safeParse(mistakenRequirement).success, true);
  providerWire.claims[0] = { ...requestClaim, kind: "interpretation" };
  assert.equal(provider(providerWire), true);
  mistakenRequirement.cases[0].artifactWork[0].recommendation.dependsOnClaimIds = [requestClaim.claimId];
  const requirementDraft = parseAssessmentDraft(mistakenRequirement, corpus);
  const requirementInvalid = validateAssessmentDraft(requirementDraft, "current request", corpus);
  const requirementVerdicts = new Map<string, SupportVerdict>(requirementDraft.claims.map((claim) => [claim.claimId, "supported"]));
  const buildRequirement = () => buildCheckedAssessment(requirementDraft, requirementVerdicts, requirementInvalid, corpus, artifactRoles(requirementDraft), emptyRequirementReview);
  const selection = [{ caseId: "case-1", artifactId: "request", versionId: "request-v1", passageIds: ["p-request-v1"] }];
  assert.equal(buildRequirement().cases[0].artifactWork[0].disposition, "adapt");
  assert.deepEqual(validateSelections(selection, buildRequirement(), corpus), selection);
  for (const verdict of ["uncertain", "unsupported"] as const) {
    requirementVerdicts.set(requestClaim.claimId, verdict);
    assert.equal(buildRequirement().cases[0].artifactWork[0].disposition, null);
    assert.throws(() => validateSelections(selection, buildRequirement(), corpus));
  }
  const { claimId: _, ...blocker } = {
    ...draft.claims[0], kind: "recommendation" as const, text: "Verify the new target before adaptation.",
    sourceRefs: draft.claims[0].sourceRefs.map((ref) => wireIds.get(ref.passageId)!),
    dependsOnClaimIds: ["fact-0-1"],
  };
  output.cases[0].artifactWork[0].blockerClaims.push(blocker);
  output.claims[0] = { ...output.claims[0], kind: "source_fact", outcomeEvidence: true };
  output.leads = [{ caseId: "case-1", state: "conditional", reasonClaimIds: ["fact-0-1"], comparisons: [] }];
  output.cases[0].artifactWork[1].usefulForLead = true;
  output.leads[0].comparisons = [{
    dimension: "product_version", requirementQuote: null, relation: "unknown",
    evidence: { text: "The record describes earlier work without establishing the new target version.", sourceRefs: draft.claims[0].sourceRefs.map((ref) => wireIds.get(ref.passageId)!), requestQuotes: [] },
    assessment: { text: "Unknown: no target version is stated.", sourceRefs: draft.claims[0].sourceRefs.map((ref) => wireIds.get(ref.passageId)!), requestQuotes: [] },
    implication: { text: "Verify the target version before unchanged reuse.", sourceRefs: draft.claims[0].sourceRefs.map((ref) => wireIds.get(ref.passageId)!), requestQuotes: ["current request"] },
  }];
  const invalidMatch = structuredClone(output);
  Object.assign(invalidMatch.leads[0].comparisons[0], { relation: "match" });
  const validate = new Ajv({ strict: false }).compile(openRouterSchema("assessment", assessmentDraftSchema).json_schema.schema);
  assert.equal(validate(invalidMatch), false);
  assert.throws(() => parseAssessmentDraft(invalidMatch, corpus));
  const parsed = parseAssessmentDraft(output, corpus);
  const unknownPassage = structuredClone(output);
  unknownPassage.claims[0].sourceRefs = ["not-a-published-passage"];
  assert.throws(() => parseAssessmentDraft(unknownPassage, corpus));
  const invalid = validateAssessmentDraft(parsed, "current request", corpus);
  assert.equal(parsed.comparisons[0].caseId, "case-1");
  const foreignComparison = structuredClone(output);
  foreignComparison.contrasts = [{
    caseId: "case-2", state: "partial", usefulArtifactIds: [], reasonClaimIds: ["fact-1-0"],
    comparisons: foreignComparison.leads[0].comparisons,
  }];
  foreignComparison.leads[0].comparisons = [];
  assert.throws(() => validateAssessmentDraft(parseAssessmentDraft(foreignComparison, corpus), "current request", corpus),
    (error: unknown) => error instanceof GateFailure && error.code === "INVALID_COMPARISON_CLAIMS");
  assert.equal(assessmentDraftSchema.safeParse({ ...output, comparisons: output.leads[0].comparisons }).success, false);
  const rejected = parsed.cases[0].artifactWork[0].dispositionClaimId;
  const kept = parsed.cases[0].artifactWork[1].dispositionClaimId;
  const verdicts = new Map<string, SupportVerdict>(parsed.claims.map((claim) => [claim.claimId, claim.claimId === rejected ? "unsupported" : "supported"]));
  const checked = buildCheckedAssessment(parsed, verdicts, invalid, corpus, artifactRoles(parsed), emptyRequirementReview);
  assert.equal(checked.cases[0].artifactWork[0].disposition, null);
  assert.equal(checked.cases[0].artifactWork[1].disposition, "adapt");
  assert.ok(checked.claims.some((claim) => claim.claimId === kept));
  assert.ok(checked.claims.some((claim) => claim.claimId === parsed.cases[0].artifactWork[0].blockerClaimIds[0]));
  assert.deepEqual(parsed.claims.find((claim) => claim.claimId === parsed.cases[0].artifactWork[0].blockerClaimIds[0])?.dependsOnClaimIds, ["fact-0-1"]);
  assert.equal(checked.comparisons[0].relation, "unknown");
  assert.equal(checked.cases[0].outcome, "observed_success");
  verdicts.set("fact-0-0", "unsupported");
  verdicts.set(parsed.comparisons[0].evidenceClaimId, "unsupported");
  const withheldComparison = buildCheckedAssessment(parsed, verdicts, invalid, corpus, artifactRoles(parsed), emptyRequirementReview);
  assert.deepEqual(withheldComparison.comparisons, []);
  assert.equal(withheldComparison.cases[0].outcome, "unknown");
  assert.ok(!withheldComparison.claims.some((claim) => claim.claimId === parsed.comparisons[0].implicationClaimId));
  const inventedRequirement = structuredClone(output);
  Object.assign(inventedRequirement.leads[0].comparisons[0], { requirementQuote: "an unstated target version", relation: "match" });
  const inventedDraft = parseAssessmentDraft(inventedRequirement, corpus);
  const invalidQuoteRefs = validateAssessmentDraft(inventedDraft, "current request", corpus);
  const inventedChecked = buildCheckedAssessment(inventedDraft, new Map(inventedDraft.claims.map((claim) => [claim.claimId, "supported"])), invalidQuoteRefs, corpus, artifactRoles(inventedDraft), emptyRequirementReview);
  assert.deepEqual(inventedChecked.comparisons, []);
  assert.ok(!inventedChecked.claims.some((claim) => claim.claimId === inventedDraft.comparisons[0].implicationClaimId));
  const wrongOwner = structuredClone(output);
  wrongOwner.cases[0].artifactWork[1].blockerClaims.push(blocker);
  assert.throws(
    () => validateAssessmentDraft(parseAssessmentDraft(wrongOwner, corpus), "current request", corpus),
    (error: unknown) => error instanceof GateFailure && error.code === "CLAIM_ARTIFACT_SCOPE",
  );
});

test("generation contract excludes verify work from explicit useful lead choices", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  const wireIds = assessmentPassageIds(corpus);
  const output: AssessmentOutput = {
    requestConstraints: draft.requestConstraints, contrasts: [], clarifyingClaimIds: [],
    claims: draft.claims.filter((claim) => claim.kind === "source_fact").map((claim) => ({ ...claim, sourceRefs: claim.sourceRefs.map((ref) => wireIds.get(ref.passageId)!), caseId: claim.sourceRefs[0].caseId, outcomeEvidence: false as const })),
    leads: [{ caseId: "case-1", state: "conditional", reasonClaimIds: ["fact-0-1"], comparisons: [] }],
    cases: draft.cases.map(({ claimIds: _, outcomeClaimIds: __, ...item }) => ({
      ...item,
      artifactWork: item.artifactWork.map((work) => {
        const { claimId: _, kind: __, ...recommendation } = draft.claims.find((claim) => claim.claimId === work.dispositionClaimId)!;
        return {
          artifactId: work.artifactId, disposition: "adapt", usefulForLead: false,
          recommendation: { ...recommendation, sourceRefs: recommendation.sourceRefs.map((ref) => wireIds.get(ref.passageId)!) }, supportingClaims: [], blockerClaims: [], verificationClaims: [],
        };
      }),
    })),
  };
  const validate = new Ajv({ strict: false }).compile(openRouterSchema("assessment", assessmentDraftSchema).json_schema.schema);
  for (const disposition of ["reuse", "adapt"] as const) {
    const work = output.cases[0].artifactWork[1];
    work.disposition = disposition;
    work.usefulForLead = true;
    assert.equal(validate(output), true, JSON.stringify(validate.errors));
    const parsed = parseAssessmentDraft(output, corpus);
    assert.deepEqual(parsed.leads[0].usefulArtifactIds, ["handover"]);
    validateAssessmentDraft(parsed, "current request", corpus);
  }
  const work = output.cases[0].artifactWork[1];
  output.cases[0].artifactWork[1] = {
    ...work, disposition: "verify", usefulForLead: false,
    verificationClaims: [{ ...work.recommendation, kind: "recommendation" }],
  };
  assert.equal(validate(output), true, JSON.stringify(validate.errors));
  const parsed = parseAssessmentDraft(output, corpus);
  assert.deepEqual(parsed.leads[0].usefulArtifactIds, []);
  assert.equal(parsed.cases[0].artifactWork[1].disposition, "verify");
  const inconsistent = structuredClone(output);
  Object.assign(inconsistent.cases[0].artifactWork[1], { usefulForLead: true });
  assert.equal(validate(inconsistent), false);
  assert.throws(() => parseAssessmentDraft(inconsistent, corpus));
  parsed.leads[0].usefulArtifactIds = ["handover"];
  assert.throws(
    () => validateAssessmentDraft(parsed, "current request", corpus),
    (error: unknown) => error instanceof GateFailure && error.code === "LEAD_ARTIFACT_NOT_USABLE",
  );
});

test("true historical facts cannot promote an incompatible artifact into a useful precedent", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  draft.leads = [{ caseId: "case-1", state: "partial", usefulArtifactIds: ["request"], reasonClaimIds: ["fact-0-0"] }];
  const review = {
    requestConstraints: emptyRequirementReview.constraints,
    claimReviews: draft.claims.map((claim) => ({ claimId: claim.claimId, verdict: "supported" as const })),
    artifactReviews: [...artifactRoles(draft, "not_relevant")].map(([key, role]) => ({ caseId: key.split("/")[0], artifactId: key.split("/")[1], role })),
  };
  const checked = buildCheckedAssessment(draft, validateSupportReview(draft.claims, review), new Set(), corpus, validateArtifactReview(draft, review), emptyRequirementReview);
  assert.equal(checked.conclusion, "cannot_be_established", "Negative roles alone do not supply an accepted explanation.");
  assert.deepEqual(checked.leads, []);
  assert.equal(checked.cases[0].artifactWork[0].disposition, null);
  assert.ok(checked.claims.some((claim) => claim.claimId === "fact-0-0"));
  const uncertain = { ...review, artifactReviews: review.artifactReviews.map((item, index) => ({ ...item, role: index === 0 ? "unresolved" as const : item.role })) };
  assert.equal(buildCheckedAssessment(draft, validateSupportReview(draft.claims, uncertain), new Set(), corpus, validateArtifactReview(draft, uncertain), emptyRequirementReview).conclusion, "cannot_be_established");
});

test("persisted assessments and briefs lose claims transitively when original evidence becomes unavailable", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  draft.claims.find((claim) => claim.claimId === "decision-0-1")!.dependsOnClaimIds.push("fact-0-0");
  draft.leads = [{ caseId: "case-1", state: "conditional", usefulArtifactIds: ["handover"], reasonClaimIds: ["fact-0-1"] }];
  const verdicts = new Map<string, SupportVerdict>(draft.claims.map((claim) => [claim.claimId, "supported"]));
  const persisted = buildCheckedAssessment(draft, verdicts, new Set(), corpus, artifactRoles(draft), emptyRequirementReview);
  const base = { ...draft.claims[0], sourceRefs: [...draft.claims[0].sourceRefs, ...draft.claims[2].sourceRefs] };
  const dependent = { ...draft.claims[3], dependsOnClaimIds: [base.claimId] };
  const brief = {
    reuse: [], verify: [],
    adapt: [{ caseId: "case-1", artifactId: "handover", versionId: dependent.sourceRefs[0].versionId, disposition: "adapt" as const, dispositionClaimId: dependent.claimId, claimIds: [base.claimId, dependent.claimId] }],
    claims: [base, dependent], withheldClaimCount: 0,
  };
  validateBriefDraft(brief, "current request", [{ caseId: "case-1", artifactId: "handover", versionId: dependent.sourceRefs[0].versionId }], corpus);
  assert.equal(revalidateBrief(brief, "current request", corpus).adapt[0].disposition, "adapt");
  corpus.availableVersions.delete("request-v1");
  corpus.passages.delete("p-request-v1");
  corpus.caseAvailability.set("case-1", "partial");
  const current = revalidateAssessment(persisted, "current request", corpus);
  assert.equal(current.conclusion, "cannot_be_established");
  assert.deepEqual(current.leads, []);
  assert.equal(current.cases[0].outcome, "unknown");
  assert.equal(current.cases[0].artifactWork[1].disposition, null);
  assert.ok(!current.claims.some((claim) => ["fact-0-0", "decision-0-1"].includes(claim.claimId)));
  assert.ok(current.claims.some((claim) => claim.claimId === "fact-1-0"));
  const currentBrief = revalidateBrief(brief, "current request", corpus);
  assert.deepEqual(currentBrief.adapt, []);
  assert.deepEqual(currentBrief.claims, []);
  assert.equal(currentBrief.withheldClaimCount, 2);
  corpus.availableVersions.add("request-v1");
  corpus.passages.set("p-request-v1", {
    ...base.sourceRefs[0], title: "request", fictional: true, statedDate: null,
    excerpt: "Restored verified evidence", sourceKind: "native", location: { type: "text", startLine: 1, endLine: 1 },
  });
  corpus.caseAvailability.set("case-1", "available");
  assert.equal(revalidateAssessment(persisted, "current request", corpus).conclusion, "precedent_found");
});

test("comparisons preserve unknown and mismatch and withhold rejected dependencies and actions", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  draft.leads = [{ caseId: "case-1", state: "conditional", usefulArtifactIds: ["handover"], reasonClaimIds: ["fact-0-1"] }];
  draft.requestConstraints.environment = ["current request"];
  const sourceRefs = draft.claims[0].sourceRefs;
  draft.claims.push(
    { claimId: "requirement", kind: "interpretation", text: "current request", sourceRefs, requestQuotes: ["current request"], dependsOnClaimIds: [] },
    { claimId: "environment-relation", kind: "interpretation", text: "Mismatch: the recorded work is sandbox-only, not production.", sourceRefs, requestQuotes: ["current request"], dependsOnClaimIds: ["fact-0-0", "requirement"] },
    { claimId: "environment-implication", kind: "recommendation", text: "Do not reuse unchanged for production; verify operational controls.", sourceRefs, requestQuotes: ["current request"], dependsOnClaimIds: ["environment-relation"] },
    { claimId: "scale-relation", kind: "interpretation", text: "Unknown: the current request does not state scale.", sourceRefs, requestQuotes: [], dependsOnClaimIds: ["fact-0-0"] },
    { claimId: "scale-implication", kind: "recommendation", text: "Confirm the target row count before reusing the bounded batch.", sourceRefs, requestQuotes: ["current request"], dependsOnClaimIds: ["scale-relation"] },
    { claimId: "verify-environment", kind: "recommendation", text: "Verify production recovery controls because the historical run was sandbox-only.", sourceRefs, requestQuotes: ["current request"], dependsOnClaimIds: ["environment-relation"] },
  );
  draft.comparisons = [
    { caseId: "case-1", dimension: "environment", requirementClaimId: "requirement", evidenceClaimId: "fact-0-0", relation: "mismatch", assessmentClaimId: "environment-relation", implicationClaimId: "environment-implication" },
    { caseId: "case-1", dimension: "scale", requirementClaimId: null, evidenceClaimId: "fact-0-0", relation: "unknown", assessmentClaimId: "scale-relation", implicationClaimId: "scale-implication" },
  ];
  const work = draft.cases[0].artifactWork[0];
  work.claimIds.push("verify-environment");
  work.verificationClaimIds.push("verify-environment");
  const invalid = validateAssessmentDraft(draft, "current request", corpus);
  const verdicts = new Map<string, SupportVerdict>(draft.claims.map((claim) => [claim.claimId, "supported"]));
  const requirementReview = { ...emptyRequirementReview, constraints: { ...emptyRequirementReview.constraints, environment: ["current request"] } };
  const build = () => buildCheckedAssessment(draft, verdicts, invalid, corpus, artifactRoles(draft), requirementReview);
  const checked = build();
  assert.deepEqual(checked.comparisons.map((row) => row.relation), ["mismatch", "unknown"]);
  assert.deepEqual(checked.nextActions, [{ caseId: "case-1", artifactId: "request", claimId: "verify-environment" }]);
  const unestablished = buildCheckedAssessment(draft, verdicts, invalid, corpus, new Map([...artifactRoles(draft), ["case-1/handover", "unresolved"]]), requirementReview);
  assert.deepEqual(unestablished.leads, []);
  assert.deepEqual(unestablished.comparisons.map((row) => row.relation), ["mismatch", "unknown"]);
  draft.comparisons[1].relation = "match";
  assert.throws(() => validateAssessmentDraft(draft, "current request", corpus), (error: unknown) => error instanceof GateFailure && error.code === "INVALID_COMPARISON_CLAIMS");
  draft.comparisons[1].relation = "unknown";
  verdicts.set("requirement", "unsupported");
  const withheld = build();
  assert.deepEqual(withheld.comparisons.map((row) => row.dimension), ["scale"]);
  assert.deepEqual(withheld.nextActions, []);
  assert.ok(!withheld.claims.some((claim) => claim.claimId === "environment-implication"));
  draft.claims.find((claim) => claim.claimId === "environment-relation")!.dependsOnClaimIds.push("missing");
  assert.throws(() => validateAssessmentDraft(draft, "current request", corpus), (error: unknown) => error instanceof GateFailure && error.code === "INVALID_DEPENDENCY_GRAPH");
  draft.claims.find((claim) => claim.claimId === "environment-relation")!.dependsOnClaimIds.pop();
  corpus.passages.delete("p-request-v1");
  const rechecked = revalidateAssessment(checked, "current request", corpus);
  assert.deepEqual(rechecked.comparisons, []);
  assert.deepEqual(rechecked.nextActions, []);
});

test("next actions are bounded checked request-specific checks, not slot filling", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  for (const [index, item] of draft.cases.entries()) {
    const work = item.artifactWork[0];
    const claim: Claim = { ...draft.claims.find((claim) => claim.claimId === work.dispositionClaimId)!, claimId: `check-${index}`, text: "Verify target compatibility because the recorded work is bounded." };
    draft.claims.push(claim);
    work.claimIds.push(claim.claimId);
    work.verificationClaimIds.push(claim.claimId);
  }
  const build = (verdict: SupportVerdict) => buildCheckedAssessment(draft, new Map(draft.claims.map((claim) => [claim.claimId, claim.claimId.startsWith("check-") ? verdict : "supported"])), new Set(), corpus, artifactRoles(draft), emptyRequirementReview);
  validateAssessmentDraft(draft, "current request", corpus);
  assert.deepEqual(build("supported").nextActions.map((action) => action.claimId), ["check-0", "check-1", "check-2"]);
  assert.deepEqual(build("uncertain").nextActions, []);
});

test("clarification changes compare two checked dispositions, never withheld recommendations", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  draft.leads = [{ caseId: "case-1", state: "useful", usefulArtifactIds: ["request"], reasonClaimIds: ["fact-0-0"] }];
  const build = () => buildCheckedAssessment(draft, new Map(draft.claims.map((claim) => [claim.claimId, "supported"])), new Set(), corpus, artifactRoles(draft), emptyRequirementReview);
  const before = structuredClone(build());
  draft.cases[0].artifactWork[0].disposition = "reuse";
  draft.claims.find((claim) => claim.claimId === "decision-0-0")!.text = "Reuse after the clarified target is established compatible.";
  draft.claims.find((claim) => claim.claimId === "classification-decision-0-0")!.text = "Artifact disposition: reuse.";
  const after = build();
  const changes = dispositionChanges(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].before, "adapt");
  assert.equal(changes[0].after, "reuse");
  after.claims = after.claims.filter((claim) => claim.claimId !== "decision-0-0");
  assert.deepEqual(dispositionChanges(before, after).map((change) => ({ after: change.after, currentClaim: change.currentClaim })), [{ after: null, currentClaim: null }]);
});

test("assessment passage labels never rebind after source availability changes", () => {
  const corpus = fixture();
  const before = assessmentPassageIds(corpus);
  corpus.availableVersions.delete("request-v1");
  corpus.passages.delete("p-request-v1");
  assert.deepEqual(assessmentPassageIds(corpus), before);
});

test("the independent review cannot override artifact decisions with an aggregate label", () => {
  const schema = reviewSchema({ claimIds: ["checked-claim"], artifacts: [] }, "current request");
  const response = { requestConstraints: emptyRequirementReview.constraints, claimVerdicts: { "checked-claim": "supported" }, artifactReviews: [], conclusion: "precedent_found" };
  const validate = new Ajv({ strict: false }).compile(openRouterSchema("assessment_review", schema).json_schema.schema);
  assert.equal(validate(response), false);
  assert.equal(schema.safeParse(response).success, false);
  const { conclusion: _, ...validReview } = response;
  assert.equal(validate(validReview), true);
  assert.deepEqual(schema.parse(validReview), { requestConstraints: emptyRequirementReview.constraints, artifactReviews: [], claimReviews: [{ claimId: "checked-claim", verdict: "supported" }] });
  assert.equal(validate({ ...validReview, claimVerdicts: {} }), false, "The reviewer cannot omit a claim verdict.");
  assert.equal(validate({ ...validReview, claimVerdicts: { ...validReview.claimVerdicts, "foreign-claim": "supported" } }), false, "Background or foreign IDs cannot enter the review inventory.");
});

test("attached dispositions are independently checked for lead and non-lead work", () => {
  const corpus = fixture();
  const wireIds = assessmentPassageIds(corpus);
  const output: AssessmentOutput = {
    requestConstraints: emptyRequirementReview.constraints,
    cases: corpus.manifest.cases.map((pastCase) => ({
      caseId: pastCase.caseId, outcome: "unknown",
      artifactWork: pastCase.artifacts.map((artifact) => ({
        artifactId: artifact.artifactId, disposition: "adapt", usefulForLead: pastCase.caseId === "case-1",
        recommendation: {
          text: artifact.artifactId === "handover"
            ? "Adapt the handover checklist, checking target compatibility before use."
            : "Do not use this as starting material for the current request.",
          sourceRefs: [wireIds.get(artifact.versions[0].passages[0].passageId)!],
          requestQuotes: ["current request"], dependsOnClaimIds: [],
        },
        supportingClaims: [], blockerClaims: [],
        verificationClaims: [{
          text: "Check target compatibility because it determines whether the recorded work is usable.",
          kind: "recommendation",
          sourceRefs: [wireIds.get(artifact.versions[0].passages[0].passageId)!],
          requestQuotes: ["current request"], dependsOnClaimIds: [],
        }],
      })),
    })),
    claims: [{
      claimId: "lead-reason", caseId: "case-1", outcomeEvidence: false, kind: "source_fact",
      text: "The case records handover work.", requestQuotes: [], dependsOnClaimIds: [],
      sourceRefs: [wireIds.get("p-handover-v1-case-1")!],
    }],
    leads: [{ caseId: "case-1", state: "conditional", reasonClaimIds: ["lead-reason"], comparisons: [] }],
    contrasts: [], clarifyingClaimIds: [],
  };
  const draft = parseAssessmentDraft(output, corpus);
  const invalid = validateAssessmentDraft(draft, "current request", corpus);
  const verdicts = new Map<string, SupportVerdict>(draft.claims.map((claim) => [claim.claimId, "supported"]));
  const roles = artifactRoles(draft);
  const build = () => buildCheckedAssessment(draft, verdicts, invalid, corpus, roles, emptyRequirementReview);
  const selected = (caseId: string, artifactId: string) => {
    const source = corpus.manifest.cases.find((item) => item.caseId === caseId)!.artifacts.find((item) => item.artifactId === artifactId)!.versions[0];
    return [{ caseId, artifactId, versionId: source.versionId, passageIds: [source.passages[0].passageId] }];
  };
  for (const rejection of ["unsupported", "uncertain", undefined] as const) {
    for (const item of draft.cases) for (const work of item.artifactWork) {
      if (work.artifactId === "handover") continue;
      const classificationId = `classification-${work.dispositionClaimId}`;
      if (rejection === undefined) verdicts.delete(classificationId);
      else verdicts.set(classificationId, rejection);
    }
    const checked = build();
    assert.equal(checked.cases[0].artifactWork[0].disposition, null);
    assert.equal(checked.cases[1].artifactWork[0].disposition, null);
    assert.equal(checked.cases[0].artifactWork[1].disposition, "adapt");
    assert.deepEqual(checked.leads[0].usefulArtifactIds, ["handover"]);
    assert.deepEqual(checked.nextActions.map((action) => action.artifactId), ["handover"]);
    assert.throws(() => validateSelections(selected("case-1", "request"), checked, corpus));
    assert.throws(() => validateSelections(selected("case-2", "request"), checked, corpus));
    assert.deepEqual(validateSelections(selected("case-1", "handover"), checked, corpus), selected("case-1", "handover"));
    assert.equal(revalidateAssessment(checked, "current request", corpus).cases[0].artifactWork[1].disposition, "adapt");
  }
  const checked = build();
  const legacy = structuredClone(checked);
  legacy.claims = legacy.claims.filter((claim) => !claim.claimId.startsWith("classification-"));
  assert.equal(revalidateAssessment(legacy, "current request", corpus).cases[0].artifactWork[1].disposition, null);
  const changedLabel = structuredClone(checked);
  changedLabel.cases[0].artifactWork[1].disposition = "reuse";
  assert.equal(revalidateAssessment(changedLabel, "current request", corpus).cases[0].artifactWork[1].disposition, null);
  const handover = draft.cases[0].artifactWork[1];
  verdicts.set(handover.verificationClaimIds[0], "unsupported");
  assert.deepEqual(build().leads, []);
  assert.deepEqual(build().nextActions, []);
});

test("independent request constraints block false absence even when every claim is supported", () => {
  const corpus = fixture();
  const wireIds = assessmentPassageIds(corpus);
  for (const scenario of [
    { dimension: "environment", constraint: "isolated staging only", requirementQuote: null, rejected: true },
    { dimension: "scale", constraint: "at most 300 records", requirementQuote: null, rejected: true },
    { dimension: "identity_access", constraint: "preserve external keys", requirementQuote: null, rejected: true },
    { dimension: "product_version", constraint: "target version is unconfirmed", requirementQuote: "target version is unconfirmed", rejected: false },
    { dimension: "environment", constraint: "", requirementQuote: null, rejected: false },
  ] as const) {
    const request = `current request: ${scenario.constraint}`;
    const sourceRefs = [wireIds.get("p-request-v1")!];
    const output: AssessmentOutput = {
      requestConstraints: { ...emptyRequirementReview.constraints, [scenario.dimension]: scenario.constraint && scenario.dimension !== "identity_access" ? [scenario.constraint] : [] },
      cases: corpus.manifest.cases.map((item) => ({
        caseId: item.caseId, outcome: "unknown",
        artifactWork: item.artifacts.map((artifact) => ({
          artifactId: artifact.artifactId, disposition: "adapt", usefulForLead: false,
          recommendation: { text: "Adapt after checking target compatibility.", sourceRefs: [wireIds.get(artifact.versions[0].passages[0].passageId)!], requestQuotes: ["current request"], dependsOnClaimIds: [] },
          supportingClaims: [], blockerClaims: [], verificationClaims: [],
        })),
      })),
      claims: [
        { claimId: "recorded", caseId: "case-1", kind: "source_fact", outcomeEvidence: false, text: "Recorded past work.", sourceRefs, requestQuotes: [], dependsOnClaimIds: [] },
        { claimId: "downstream", caseId: "case-1", kind: "recommendation", outcomeEvidence: false, text: "Confirm scope before reuse.", sourceRefs, requestQuotes: [], dependsOnClaimIds: ["comparison-0-assessment"] },
      ],
      leads: [], clarifyingClaimIds: ["downstream"],
      contrasts: [{ caseId: "case-1", state: "conditional", usefulArtifactIds: [], reasonClaimIds: ["recorded"], comparisons: [{
        dimension: scenario.dimension, requirementQuote: scenario.requirementQuote, relation: "unknown",
        evidence: { text: "Past work has bounded applicability.", sourceRefs, requestQuotes: [] },
        assessment: { text: scenario.requirementQuote === null ? "The requirement is not stated." : "The requested target remains unconfirmed.", sourceRefs, requestQuotes: [] },
        implication: { text: "Verify compatibility before reuse.", sourceRefs, requestQuotes: [] },
      }] }],
    };
    const draft = parseAssessmentDraft(output, corpus);
    const constraints = { ...emptyRequirementReview.constraints, [scenario.dimension]: scenario.constraint && (scenario.dimension === "identity_access" || !scenario.rejected) ? [scenario.constraint] : [] };
    const review = assessmentReviewSchema.parse({
      requestConstraints: constraints, artifactReviews: [...artifactRoles(draft)].map(([key, role]) => ({ caseId: key.split("/")[0], artifactId: key.split("/")[1], role })),
      claimReviews: draft.claims.map((claim) => ({ claimId: claim.claimId, verdict: "supported" })),
    });
    const verdicts = validateSupportReview(draft.claims, review);
    const invalid = validateAssessmentDraft(draft, request, corpus);
    const checked = buildCheckedAssessment(draft, verdicts, invalid, corpus, validateArtifactReview(draft, review), { request, constraints: review.requestConstraints });
    assert.equal(checked.comparisons.some((row) => row.dimension === scenario.dimension), !scenario.rejected);
    assert.equal(checked.claims.some((claim) => claim.claimId === "downstream"), !scenario.rejected);
    assert.equal(checked.claims.some((claim) => claim.claimId === "comparison-0-implication"), !scenario.rejected);
    assert.ok(checked.claims.some((claim) => claim.claimId === "comparison-0-evidence"));
    assert.equal(checked.cases.length, 8);
    assert.deepEqual(revalidateAssessment(checked, request, corpus).comparisons, checked.comparisons);
    if (scenario.requirementQuote !== null) {
      assert.deepEqual(checked.claims.find((claim) => claim.claimId === checked.comparisons[0].requirementClaimId)?.requestQuotes, [scenario.requirementQuote]);
      assert.equal(checked.comparisons[0].relation, "unknown");
    }
    if (scenario.dimension === "environment" && scenario.rejected) {
      const invented = { ...constraints, environment: ["not present in the current request"] };
      assert.throws(() => buildCheckedAssessment(draft, verdicts, invalid, corpus, artifactRoles(draft), { request, constraints: invented }),
        (error: unknown) => error instanceof GateFailure && error.code === "INVALID_REQUEST_CONSTRAINT_REVIEW");
      const { requestConstraints: _, ...oldReview } = review;
      assert.equal(assessmentReviewSchema.safeParse(oldReview).success, false);
      const legacy = { ...checked };
      delete (legacy as Partial<AssessmentResult>).requestConstraints;
      assert.throws(() => revalidateAssessment(legacy, request, corpus), EvidenceUnavailable);
      assert.equal(buildCheckedAssessment(draft, verdicts, invalid, corpus, artifactRoles(draft), { request, constraints }).conclusion, "cannot_be_established");
    }
  }
});

test("implementation roles preserve conditional starting work but block context-only Adapt", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  draft.leads = [{ caseId: "case-1", state: "conditional", usefulArtifactIds: ["request", "handover"], reasonClaimIds: ["fact-0-1"] }];
  const roles = artifactRoles(draft);
  roles.set("case-1/request", "context_only");
  const work = draft.cases[0].artifactWork[1];
  const check: Claim = { ...draft.claims.find((claim) => claim.claimId === work.dispositionClaimId)!, claimId: "check-new-version", text: "Verify the new API version and account limits before adapting the recorded submit-and-poll procedure." };
  draft.claims.push(check);
  work.claimIds.push(check.claimId);
  work.verificationClaimIds.push(check.claimId);
  const verdicts = new Map<string, SupportVerdict>(draft.claims.map((claim) => [claim.claimId, "supported"]));
  const checked = buildCheckedAssessment(draft, verdicts, validateAssessmentDraft(draft, "current request", corpus), corpus, roles, emptyRequirementReview);
  assert.equal(checked.cases[0].artifactWork[0].disposition, null);
  assert.equal(checked.cases[0].artifactWork[1].disposition, "adapt");
  assert.deepEqual(checked.leads[0].usefulArtifactIds, ["handover"]);
  assert.deepEqual(checked.nextActions, [{ caseId: "case-1", artifactId: "handover", claimId: check.claimId }]);
  const selection = [{ caseId: "case-1", artifactId: "handover", versionId: "handover-v1-case-1", passageIds: ["p-handover-v1-case-1"] }];
  assert.deepEqual(validateSelections(selection, checked, corpus), selection);
  assert.equal(revalidateAssessment(checked, "current request", corpus).cases[0].artifactWork[1].disposition, "adapt");
  roles.set("case-1/handover", "unresolved");
  assert.deepEqual(buildCheckedAssessment(draft, verdicts, new Set(), corpus, roles, emptyRequirementReview).leads, []);
  roles.set("case-1/handover", "starting_point");
  work.disposition = "reuse";
  draft.claims.find((claim) => claim.claimId === `classification-${work.dispositionClaimId}`)!.text = "Artifact disposition: reuse.";
  assert.equal(buildCheckedAssessment(draft, verdicts, new Set(), corpus, roles, emptyRequirementReview).cases[0].artifactWork[1].disposition, null);
});

test("full negative artifact coverage establishes no precedent without inventing uncertain case outcomes", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  for (const item of draft.cases) for (const work of item.artifactWork) {
    work.disposition = null;
    const explanation = draft.claims.find((claim) => claim.claimId === work.dispositionClaimId)!;
    explanation.kind = "interpretation";
    explanation.text = "This historical record does not establish implementation material for the current request.";
    item.claimIds.push(work.dispositionClaimId);
    draft.claims.find((claim) => claim.claimId === `classification-${work.dispositionClaimId}`)!.text = "Artifact disposition: excluded.";
  }
  const roles = artifactRoles(draft, "context_only");
  const review = assessmentReviewSchema.parse({
    requestConstraints: emptyRequirementReview.constraints,
    artifactReviews: [...roles].map(([key, role]) => ({ caseId: key.split("/")[0], artifactId: key.split("/")[1], role })),
    claimReviews: draft.claims.map((claim) => ({ claimId: claim.claimId, verdict: claim.claimId === "fact-0-0" ? "uncertain" : "supported" })),
  });
  const checked = buildCheckedAssessment(draft, validateSupportReview(draft.claims, review), new Set(), corpus, validateArtifactReview(draft, review), emptyRequirementReview);
  assert.equal(checked.conclusion, "no_useful_precedent");
  assert.ok(checked.cases.every((item) => item.outcome === "unknown" && item.artifactWork.every((work) => work.disposition === null)));
  assert.equal(revalidateAssessment(checked, "current request", corpus).conclusion, "no_useful_precedent");
  const historicalUncertain: AssessmentResult = { ...checked, conclusion: "cannot_be_established" };
  assert.equal(revalidateAssessment(historicalUncertain, "current request", corpus).conclusion, "cannot_be_established");
  assert.throws(() => validateSelections([{ caseId: "case-1", artifactId: "request", versionId: "request-v1", passageIds: ["p-request-v1"] }], checked, corpus));
  assert.throws(() => validateArtifactReview(draft, { ...review, artifactReviews: review.artifactReviews.slice(1) }),
    (error: unknown) => error instanceof GateFailure && error.code === "INCOMPLETE_ARTIFACT_REVIEW");
  const unresolved = { ...review, artifactReviews: review.artifactReviews.map((item, index) => ({ ...item, role: index === 0 ? "unresolved" as const : item.role })) };
  assert.equal(buildCheckedAssessment(draft, validateSupportReview(draft.claims, unresolved), new Set(), corpus, validateArtifactReview(draft, unresolved), emptyRequirementReview).conclusion, "cannot_be_established");
  const omittedStartingPoint = { ...review, artifactReviews: review.artifactReviews.map((item, index) => ({ ...item, role: index === 0 ? "starting_point" as const : item.role })) };
  assert.equal(buildCheckedAssessment(draft, validateSupportReview(draft.claims, omittedStartingPoint), new Set(), corpus, validateArtifactReview(draft, omittedStartingPoint), emptyRequirementReview).conclusion, "cannot_be_established");
  assert.throws(() => validateArtifactReview(draft, { ...review, artifactReviews: [...review.artifactReviews.slice(1), review.artifactReviews[1]] }),
    (error: unknown) => error instanceof GateFailure && error.code === "INCOMPLETE_ARTIFACT_REVIEW");
  const legacy = { ...checked };
  delete (legacy as Partial<AssessmentResult>).artifactReviews;
  assert.throws(() => revalidateAssessment(legacy, "current request", corpus), EvidenceUnavailable);
  const missing = structuredClone(checked);
  missing.artifactReviews.pop();
  assert.throws(() => revalidateAssessment(missing, "current request", corpus), EvidenceUnavailable);
  const incomplete = structuredClone(draft);
  incomplete.cases.pop();
  const partialRoles = artifactRoles(incomplete, "context_only");
  assert.equal(buildCheckedAssessment(incomplete, validateSupportReview(draft.claims, review), new Set(), corpus, partialRoles, emptyRequirementReview).conclusion, "cannot_be_established");
  corpus.caseAvailability.set("case-2", "partial");
  assert.equal(revalidateAssessment(checked, "current request", corpus).conclusion, "cannot_be_established");
});

test("explicit artifact exclusion is reviewed and explained without fabricating reusable work", () => {
  const corpus = fixture();
  const wireIds = assessmentPassageIds(corpus);
  const output: AssessmentOutput = {
    requestConstraints: emptyRequirementReview.constraints, leads: [], contrasts: [], clarifyingClaimIds: [], claims: [],
    cases: corpus.manifest.cases.map((item) => ({
      caseId: item.caseId, outcome: "unknown",
      artifactWork: item.artifacts.map((artifact) => ({
        artifactId: artifact.artifactId, disposition: null, usefulForLead: false,
        recommendation: { text: "This record supplies background requirements, not an implementation procedure.", sourceRefs: [wireIds.get(artifact.versions[0].passages[0].passageId)!], requestQuotes: [], dependsOnClaimIds: [] },
        supportingClaims: [], blockerClaims: [], verificationClaims: [],
      })),
    })),
  };
  const draft = parseAssessmentDraft(output, corpus);
  const checked = buildCheckedAssessment(draft, new Map(draft.claims.map((claim) => [claim.claimId, "supported"])), validateAssessmentDraft(draft, "current request", corpus), corpus, artifactRoles(draft, "context_only"), emptyRequirementReview);
  assert.equal(checked.conclusion, "no_useful_precedent");
  assert.ok(checked.cases.every((item) => item.artifactWork.every((work) => work.disposition === null && work.dispositionClaimId === null && work.claimIds.length === 0)));
  assert.ok(checked.cases.every((item) => item.claimIds.some((id) => checked.claims.find((claim) => claim.claimId === id)?.text.includes("not an implementation procedure"))));
  assert.equal(revalidateAssessment(checked, "current request", corpus).conclusion, "no_useful_precedent");
  const rejectedExplanations = new Map(draft.claims.map((claim) => [claim.claimId, "unsupported" as const]));
  const unexplained = buildCheckedAssessment(draft, rejectedExplanations, new Set(), corpus, artifactRoles(draft, "context_only"), emptyRequirementReview);
  assert.equal(unexplained.conclusion, "cannot_be_established", "Negative roles cannot establish no precedent after every supported exclusion explanation is lost.");
  const invalid = structuredClone(output);
  invalid.cases[0].artifactWork[0].usefulForLead = true;
  assert.equal(assessmentDraftSchema.safeParse(invalid).success, false);
  const danglingExclusion = structuredClone(output);
  danglingExclusion.cases[0].artifactWork[0].recommendation.dependsOnClaimIds = ["missing-outcome"];
  assert.equal(assessmentDraftSchema.safeParse(danglingExclusion).success, false);
});

test("provider generation binds request inventories and each case claim to their actual sources", async () => {
  const corpus = fixture();
  const request = "Named operators need recovery evidence. New target authorization remains unconfirmed.";
  const ids = assessmentPassageIds(corpus);
  const output: AssessmentOutput = {
    requestConstraints: { ...emptyRequirementReview.constraints },
    leads: [], contrasts: [], clarifyingClaimIds: [],
    cases: corpus.manifest.cases.map((item) => ({
      caseId: item.caseId, outcome: "unknown",
      artifactWork: item.artifacts.map((artifact) => ({
        artifactId: artifact.artifactId, disposition: null, usefulForLead: false,
        recommendation: { text: "Background context only.", sourceRefs: [ids.get(artifact.versions[0].passages[0].passageId)!], requestQuotes: [], dependsOnClaimIds: [] },
        supportingClaims: [], blockerClaims: [], verificationClaims: [],
      })),
    })),
    claims: [{ claimId: "source-fact", caseId: "case-1", outcomeEvidence: false, kind: "source_fact", text: "Recorded evidence.", sourceRefs: [ids.get("p-request-v1")!], requestQuotes: [], dependsOnClaimIds: [] }],
  };
  const { leads: _, contrasts: __, ...content } = output;
  const wireOutput = {
    ...content,
    cases: Object.fromEntries(content.cases.map(({ caseId, outcome, artifactWork }) => [caseId, {
      outcome, tier: "context",
      artifactWork: Object.fromEntries(artifactWork.map(({ artifactId, ...work }) => [artifactId, work])),
    }])),
  };
  const originalFetch = globalThis.fetch;
  let providerSchema: object | undefined;
  let normalized: AssessmentOutput | undefined;
  globalThis.fetch = async (_input, init) => {
    providerSchema = JSON.parse(init!.body as string).response_format.json_schema.schema;
    return Response.json({ id: "gen-source-bound-schema", model: "openai/gpt-6-luna", provider: "OpenAI", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(wireOutput) } }] });
  };
  try {
    normalized = assessmentDraftSchema.parse((await callOpenRouter({ OPENROUTER_API_KEY: "local-test-only" } as Env, "assessment_draft", assessmentDraftPrompt(request, corpus))).output);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(normalized);
  const normalizedDraft = parseAssessmentDraft(normalized, corpus);
  assert.equal(validateAssessmentDraft(normalizedDraft, request, corpus).size, 0, "Derived inventory identities must preserve every claim's actual evidence ownership.");
  const validate = new Ajv({ strict: false }).compile(providerSchema!);
  const valid = structuredClone(wireOutput);
  valid.requestConstraints.recovery_operations = ["Named operators need recovery evidence."];
  valid.requestConstraints.identity_access = ["New target authorization remains unconfirmed."];
  assert.equal(validate(valid), true);
  const historicalRequest = structuredClone(valid);
  historicalRequest.requestConstraints.recovery_operations = ["Historical recovery was exercised in test only."];
  assert.equal(validate(historicalRequest), false, "A historical client request cannot become a current-request quotation.");
  const wrongCase = structuredClone(valid);
  wrongCase.claims[0].caseId = "case-2";
  assert.equal(validate(wrongCase), false, "A claim cannot pair another case's identity with this source.");
  wrongCase.claims[0].sourceRefs = [ids.get("p-request-v1-case-2")!];
  assert.equal(validate(wrongCase), true);
  const siblingArtifact = structuredClone(valid);
  siblingArtifact.cases["case-1"].artifactWork.handover.recommendation.sourceRefs = [ids.get("p-request-v1")!];
  assert.equal(validate(siblingArtifact), false, "A keyed artifact cannot borrow its sibling's passages.");
  const reason = { kind: "interpretation", text: "The historical scope does not establish the new environment.", sourceRefs: [ids.get("p-request-v1")!], requestQuotes: [], dependsOnClaimIds: [] };
  const cell = { text: "Historical scope remains bounded.", sourceRefs: [ids.get("p-request-v1")!], requestQuotes: [] };
  const ownContrast = structuredClone(valid);
  Object.assign(ownContrast.cases["case-1"], { tier: "contrast", state: "partial", reasons: [reason], comparisons: [{ dimension: "environment", requirementQuote: null, relation: "unknown", evidence: cell, assessment: cell, implication: cell }] });
  assert.equal(validate(ownContrast), true);
  const normalizedContrast = assessmentDraftPrompt(request, corpus).responseSchema!.parse(ownContrast) as AssessmentOutput;
  assert.equal(normalizedContrast.claims.find((claim) => claim.claimId === normalizedContrast.contrasts[0].reasonClaimIds[0])?.caseId, "case-1");
  const foreignReason = structuredClone(ownContrast);
  Object.assign(foreignReason.cases["case-1"], { reasons: [{ ...reason, sourceRefs: [ids.get("p-request-v1-case-2")!] }] });
  assert.equal(validate(foreignReason), false, "A lead/contrast reason cannot borrow another case's evidence.");
  const foreignComparison = structuredClone(ownContrast);
  Object.assign(foreignComparison.cases["case-1"], { comparisons: [{ dimension: "environment", requirementQuote: null, relation: "unknown", evidence: { ...cell, sourceRefs: [ids.get("p-request-v1-case-2")!] }, assessment: cell, implication: cell }] });
  assert.equal(validate(foreignComparison), false, "An inline comparison cannot borrow another case's evidence.");
  const omittedCase = structuredClone(valid);
  delete omittedCase.cases["case-8"];
  assert.equal(validate(omittedCase), false, "Every supplied case key is required.");
  const extraCase = structuredClone(valid);
  extraCase.cases["extra-case"] = structuredClone(extraCase.cases["case-8"]);
  assert.equal(validate(extraCase), false, "Case keys outside the supplied inventory are rejected.");
  const omittedArtifact = structuredClone(valid);
  delete omittedArtifact.cases["case-1"].artifactWork.handover;
  assert.equal(validate(omittedArtifact), false, "Every available artifact key is required.");
  const renamedArtifact = structuredClone(valid);
  renamedArtifact.cases["case-1"].artifactWork["renamed-handover"] = structuredClone(renamedArtifact.cases["case-1"].artifactWork.handover);
  delete renamedArtifact.cases["case-1"].artifactWork.handover;
  assert.equal(validate(renamedArtifact), false, "Renamed artifact keys cannot satisfy the supplied inventory.");
  const redundantIdentity = structuredClone(valid);
  Object.assign(redundantIdentity.cases["case-1"], { caseId: "case-1" });
  Object.assign(redundantIdentity.cases["case-1"].artifactWork.request, { artifactId: "request" });
  assert.equal(validate(redundantIdentity), false, "Case and artifact identities are carried only by their keys.");
  const noAvailableArtifact = fixture();
  noAvailableArtifact.availableVersions.delete("request-v1-case-2");
  const noArtifactPrompt = assessmentDraftPrompt(request, noAvailableArtifact);
  const noArtifactSchema = new Ajv({ strict: false }).compile(openRouterSchema("assessment", noArtifactPrompt.responseSchema!).json_schema.schema);
  const emptyArtifactWork = structuredClone(valid);
  emptyArtifactWork.cases["case-2"].artifactWork = {};
  assert.equal(noArtifactSchema(emptyArtifactWork), true, "Cases remain required when no artifacts have available versions.");
  const unavailableArtifact = structuredClone(emptyArtifactWork);
  unavailableArtifact.cases["case-2"].artifactWork.request = structuredClone(wireOutput.cases["case-2"].artifactWork.request);
  assert.equal(noArtifactSchema(unavailableArtifact), false, "Unavailable artifacts are not accepted into the inventory.");
});

test("brief generation cannot add an unselected background artifact", async () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  const checked = buildCheckedAssessment(draft, new Map(draft.claims.map((item) => [item.claimId, "supported"])), new Set(), corpus, artifactRoles(draft), emptyRequirementReview);
  const selected = [{ caseId: "case-1", artifactId: "handover", versionId: "handover-v1-case-1", passageIds: ["p-handover-v1-case-1"] }];
  const ids = assessmentPassageIds(corpus);
  const prompt = briefDraftPrompt("current request", selected, corpus, checked);
  // StagePrompt erases this in-process modelCorpus return type; no external data is asserted here.
  const data = prompt.untrustedData as { historicalContext: { completeSelectedCaseContext: ModelCaseContext[] } };
  const suppliedPassage = data.historicalContext.completeSelectedCaseContext.find((item) => item.caseId === selected[0].caseId)!.artifacts.find((item) => item.artifactId === selected[0].artifactId)!.versions.find((item) => item.versionId === selected[0].versionId)!.passages[0];
  const output: BriefDraft = {
    reuse: [], verify: [],
    adapt: [{ caseId: selected[0].caseId, artifactId: selected[0].artifactId, versionId: selected[0].versionId, disposition: "adapt", dispositionClaimId: "choose", claimIds: ["choose"] }],
    claims: [{ claimId: "choose", kind: "recommendation", text: "Adapt the selected procedure after checking compatibility.", sourceRefs: [{ caseId: selected[0].caseId, artifactId: selected[0].artifactId, versionId: selected[0].versionId, passageId: selected[0].passageIds[0] }], requestQuotes: ["current request"], dependsOnClaimIds: [] }],
  };
  const selectedKey: string = "case-1/handover/handover-v1-case-1";
  const wireOutput = {
    items: { [selectedKey]: { disposition: "adapt", dispositionClaimId: "choose", claimIds: ["choose"] } },
    claims: output.claims.map((claim) => ({ ...claim, sourceRefs: [suppliedPassage.passageId] })),
  };
  let normalized: BriefDraft | undefined;
  let providerSchema: object | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    providerSchema = JSON.parse(init!.body as string).response_format.json_schema.schema;
    return Response.json({ id: "gen-selected-only", model: "openai/gpt-6-luna", provider: "OpenAI", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(wireOutput) } }] });
  };
  try {
    normalized = briefDraftSchema.parse((await callOpenRouter({ OPENROUTER_API_KEY: "local-test-only" } as Env, "brief_draft", prompt)).output);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(normalized);
  assert.equal(validateBriefDraft(normalized, "current request", selected, corpus).size, 0, "Derived selected identities must preserve actual claim ownership.");
  assert.deepEqual(normalized.claims, output.claims, "A supplied context label must resolve to its unchanged canonical identity.");
  const validate = new Ajv({ strict: false }).compile(providerSchema!);
  assert.equal(validate(wireOutput), true);
  const unselected = structuredClone(wireOutput);
  unselected.items["case-1/request/request-v1"] = structuredClone(unselected.items[selectedKey]);
  assert.equal(validate(unselected), false, "Full case background cannot add an unselected brief item.");
  const omitted = structuredClone(wireOutput);
  delete omitted.items[selectedKey];
  assert.equal(validate(omitted), false, "Every selected identity requires exactly one disposition.");
  assert.equal(validate({ ...wireOutput, adapt: output.adapt, verify: output.adapt }), false, "Independent section arrays cannot classify the same selected work twice.");
  const foreignClaim = structuredClone(wireOutput);
  foreignClaim.claims[0].sourceRefs[0] = ids.get("p-request-v1")!;
  assert.equal(validate(foreignClaim), false, "Brief claims must preserve selected-source ownership.");
});
