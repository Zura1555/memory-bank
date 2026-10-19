import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AssessmentResult, BriefItem, BriefResult, Claim, Selection, SourceRef } from "../shared/protocol.ts";
import { OPERATION_CHECKS } from "../shared/operations.ts";
import { assessmentPassageIds, EvidenceUnavailable, loadCorpus, type CorpusManifest, type CorpusSnapshot } from "./corpus.ts";
import { HttpFailure } from "./errors.ts";
import type { JobRecord } from "./jobs.ts";
import type { Env } from "./env.ts";
import { buildStarterPack, starterPackMarkdown } from "./packs.ts";
import { app } from "./http.ts";
import { buildCheckedBrief, revalidateBrief, validateBriefDraft, validateSupportReview, withAssessmentConstraintFloor } from "./gates.ts";
import { briefDraftSchemaFor, briefSupportReviewSchema, reviewSchema } from "./schemas.ts";
import { briefReviewPrompt } from "./prompts.ts";
import { requestSpans } from "./request-constraints.ts";
import { applySourceHistoryQualifications } from "./source-history.ts";

async function fixture() {
  const manifest: CorpusManifest = JSON.parse(await readFile(new URL("../../corpus/manifest.json", import.meta.url), "utf8"));
  const corpus: CorpusSnapshot = { manifest, manifestSha256: "b".repeat(64), availableVersions: new Set(), caseAvailability: new Map(), versions: new Map(), passages: new Map() };
  for (const pastCase of manifest.cases) {
    corpus.caseAvailability.set(pastCase.caseId, "available");
    for (const artifact of pastCase.artifacts) for (const version of artifact.versions) {
      corpus.versions.set(version.versionId, { version, artifact, pastCase });
      corpus.availableVersions.add(version.versionId);
      for (const passage of version.passages) corpus.passages.set(passage.passageId, { ...passage, title: artifact.title, fictional: true, statedDate: version.statedDate, caseId: pastCase.caseId, artifactId: artifact.artifactId, versionId: version.versionId });
    }
  }
  const pastCase = manifest.cases.find((item) => item.caseId === "grove-scoped-access")!;
  const selections: Selection[] = pastCase.artifacts.map((artifact) => ({ caseId: pastCase.caseId, artifactId: artifact.artifactId, versionId: artifact.versions[0].versionId, passageIds: [artifact.versions[0].passages[0].passageId] }));
  const claims: Claim[] = selections.flatMap((selection, index) => {
    const sourceRefs = [{ caseId: selection.caseId, artifactId: selection.artifactId, versionId: selection.versionId, passageId: selection.passageIds[0] }];
    return [
      { claimId: `fact-${index}`, text: corpus.passages.get(selection.passageIds[0])!.excerpt, kind: "source_fact", sourceRefs, requestQuotes: [], dependsOnClaimIds: [] },
      { claimId: `check-${index}`, text: "Check client scope before use; unresolved scope blocks unchanged reuse.", kind: "recommendation", sourceRefs, requestQuotes: ["client scope"], dependsOnClaimIds: [`fact-${index}`] },
    ];
  });
  const items: BriefItem[] = selections.map((selection, index) => ({ ...selection, disposition: index === 0 ? "reuse" : index === 1 ? "adapt" : "verify", dispositionClaimId: `check-${index}`, claimIds: [`fact-${index}`, `check-${index}`] }));
  const brief: BriefResult = { reuse: items.filter((item) => item.disposition === "reuse"), adapt: items.filter((item) => item.disposition === "adapt"), verify: items.filter((item) => item.disposition === "verify"), claims, constraintReviews: selections.map(({ caseId, artifactId, versionId }) => ({ caseId, artifactId, versionId, requestQuotes: ["client scope"] })), withheldClaimCount: 2 };
  const assessmentClaims: Claim[] = [];
  const assessment: AssessmentResult = {
    conclusion: "cannot_be_established", clarifyingClaimIds: [], comparisons: [], nextActions: [], leads: [], contrasts: [],
    missingEvidenceRequests: [], missingEvidenceReview: { verdict: "supported", reason: null, claimIds: [] },
    claims: [...structuredClone(claims), ...assessmentClaims], withheldClaimCount: 0,
    requestConstraints: { product_version: [], environment: [], scale: [], identity_access: [], recovery_operations: [] },
    artifactReviews: items.map((item, index) => {
      const sourceRefs = structuredClone(claims.find((claim) => claim.claimId === `fact-${index}`)!.sourceRefs);
      const operationClaimId = `assessment-operation-${index}`;
      const checkClaimId = `assessment-check-${index}`;
      const operationClaim: Claim = {
        claimId: operationClaimId, text: "The recorded procedure is an access-provisioning operation.", kind: "interpretation",
        sourceRefs, requestQuotes: [], dependsOnClaimIds: [`fact-${index}`],
      };
      const checkClaims: Claim[] = item.disposition === "reuse" ? [] : Object.entries(OPERATION_CHECKS.access_provisioning).map(([kind, text], checkIndex) => ({
        claimId: checkIndex === 0 ? checkClaimId : `${checkClaimId}-${kind.replaceAll("_", "-")}`, text, kind: "recommendation",
        sourceRefs, requestQuotes: [], dependsOnClaimIds: [item.dispositionClaimId, `fact-${index}`],
      }));
      assessmentClaims.push(operationClaim, ...checkClaims);
      const adaptationClaimId = `assessment-adaptation-${index}`;
      const adaptations = item.disposition === "adapt" ? [{
        text: "Adapt the recorded access scope to the client.", sourceRefs, requestQuotes: [],
      }] : [];
      if (item.disposition === "adapt") assessmentClaims.push({
        claimId: adaptationClaimId, text: `Proposed adaptation: ${adaptations[0].text}`, kind: "recommendation",
        sourceRefs, requestQuotes: [], dependsOnClaimIds: [item.dispositionClaimId, `fact-${index}`],
      });
      const checks = checkClaims.map((claim, checkIndex) => ({
        kind: Object.keys(OPERATION_CHECKS.access_provisioning)[checkIndex] as keyof typeof OPERATION_CHECKS.access_provisioning,
        text: claim.text, sourceRefs, requestQuotes: [],
      }));
      return {
        caseId: item.caseId, artifactId: item.artifactId, role: "starting_point", verdict: "supported", reasons: [],
        decision: {
          disposition: item.disposition, operation: "access_provisioning", historicalEvidence: sourceRefs, requestQuotes: [],
          adaptations, checks, obligations: [],
        },
        claimFindings: [
          { claimId: `fact-${index}`, verdict: "supported", reason: null },
          { claimId: operationClaimId, verdict: "supported", reason: null },
          ...(item.disposition === "adapt" ? [{ claimId: adaptationClaimId, verdict: "supported" as const, reason: null }] : []),
          ...checkClaims.map((claim) => ({ claimId: claim.claimId, verdict: "supported" as const, reason: null })),
        ],
      };
    }),
    cases: [{ caseId: pastCase.caseId, availability: "available", outcome: "unknown", outcomeClaimIds: [], claimIds: [...claims, ...assessmentClaims].map((claim) => claim.claimId), artifactWork: items.map((item, index) => ({
      artifactId: item.artifactId, availability: "available", exclusionReasons: [], disposition: item.disposition, dispositionClaimId: item.dispositionClaimId,
      claimIds: [...item.claimIds, `assessment-operation-${index}`, ...(item.disposition === "adapt" ? [`assessment-adaptation-${index}`] : []),
        ...assessmentClaims.filter((claim) => claim.claimId === `assessment-check-${index}` || claim.claimId.startsWith(`assessment-check-${index}-`)).map((claim) => claim.claimId)],
      blockerClaimIds: [], verificationClaimIds: assessmentClaims.filter((claim) => claim.claimId === `assessment-check-${index}` || claim.claimId.startsWith(`assessment-check-${index}-`)).map((claim) => claim.claimId),
    })) }],
  };
  assessment.claims = [...structuredClone(claims), ...assessmentClaims];
  const job: JobRecord = {
    id: "00000000-0000-4000-8000-000000000005", request_text: "client scope", corpus_version: manifest.corpusVersion, corpus_sha256: corpus.manifestSha256,
    stage: "ready", assessment_state: "ready", brief_state: "ready", assessment_result: assessment, brief_result: brief, brief_selections: selections, error_code: null,
    created_at: new Date("2026-10-15T00:00:00Z"), expires_at: new Date("2099-10-22T00:00:00Z"), assessment_queued_at: new Date("2026-10-15T00:00:00Z"), assessment_processing_started_at: null, assessment_finished_at: null, brief_queued_at: null, brief_processing_started_at: null, brief_finished_at: null,
  };
  return { corpus, job };
}

async function elmAssessmentContextFixture() {
  const { corpus, job } = await fixture();
  const sourceCase = corpus.manifest.cases.find((item) => item.caseId === "grove-scoped-access")!;
  const elmCase = corpus.manifest.cases.find((item) => item.caseId === "elm-bulk-integration")!;
  const countHistory = elmCase.records.find((record) => record.recordId === "elm-batch-count-discrepancy");
  const limitationHistory = elmCase.records.find((record) => record.recordId === "elm-sandbox-limitations");
  assert.ok(countHistory?.kind === "source_fact");
  assert.ok(limitationHistory?.kind === "source_fact");

  const remapRef = (ref: SourceRef): SourceRef => {
    const artifactIndex = sourceCase.artifacts.findIndex((artifact) => artifact.artifactId === ref.artifactId);
    const artifact = elmCase.artifacts[artifactIndex]!;
    if (artifact.artifactId === "delivery-log") return { ...countHistory.evidence[0] };
    if (artifact.artifactId === "batch-adapter-notes") {
      return { ...limitationHistory.evidence.find((evidence) => evidence.artifactId === artifact.artifactId)! };
    }
    return {
      caseId: elmCase.caseId, artifactId: artifact.artifactId, versionId: artifact.versions[0].versionId,
      passageId: artifact.versions[0].passages[0].passageId,
    };
  };
  const remapClaim = (claim: Claim): Claim => {
    const sourceRefs = claim.sourceRefs.map(remapRef);
    return {
      ...claim, sourceRefs,
      text: claim.kind === "source_fact" ? sourceRefs.map((ref) => corpus.passages.get(ref.passageId)!.excerpt).join("\n") : claim.text,
    };
  };

  const assessment = job.assessment_result!;
  assessment.claims = assessment.claims.map(remapClaim);
  assessment.cases = assessment.cases.map((item) => ({
    ...item, caseId: elmCase.caseId,
    artifactWork: item.artifactWork.map((work, index) => ({ ...work, artifactId: elmCase.artifacts[index].artifactId })),
  }));
  assessment.artifactReviews = assessment.artifactReviews.map((review, index) => ({
    ...review, caseId: elmCase.caseId, artifactId: elmCase.artifacts[index].artifactId,
    decision: {
      ...review.decision,
      historicalEvidence: review.decision.historicalEvidence.map(remapRef),
      adaptations: review.decision.adaptations.map((item) => ({ ...item, sourceRefs: item.sourceRefs.map(remapRef) })),
      checks: review.decision.checks.map((item) => ({ ...item, sourceRefs: item.sourceRefs.map(remapRef) })),
    },
  }));
  const originalAssessmentIds = new Set(assessment.claims.map((claim) => claim.claimId));
  const assessedClaims = applySourceHistoryQualifications(corpus, assessment.claims);
  const assessmentQualifications = assessedClaims.filter((claim) => !originalAssessmentIds.has(claim.claimId));
  assessment.claims = assessedClaims;
  for (const item of assessment.cases) {
    item.claimIds.push(...assessmentQualifications.filter((claim) => claim.sourceRefs.some((ref) => ref.caseId === item.caseId)).map((claim) => claim.claimId));
  }

  const originalItem = job.brief_result!.verify[0];
  const selectedArtifact = elmCase.artifacts[2];
  const selectedVersion = selectedArtifact.versions[0];
  const selectedRef = limitationHistory.evidence.find((ref) => ref.artifactId === selectedArtifact.artifactId)!;
  const selection: Selection = {
    caseId: elmCase.caseId, artifactId: selectedArtifact.artifactId, versionId: selectedVersion.versionId,
    passageIds: [selectedRef.passageId],
  };
  const briefItem: BriefItem = {
    ...originalItem, caseId: selection.caseId, artifactId: selection.artifactId, versionId: selection.versionId,
    claimIds: [...originalItem.claimIds],
  };
  const originalBriefClaims = job.brief_result!.claims.filter((claim) => originalItem.claimIds.includes(claim.claimId)).map(remapClaim);
  const originalBriefIds = new Set(originalBriefClaims.map((claim) => claim.claimId));
  const briefClaims = applySourceHistoryQualifications(corpus, originalBriefClaims);
  const briefQualifications = briefClaims.filter((claim) => !originalBriefIds.has(claim.claimId));
  briefItem.claimIds.push(...briefQualifications.filter((qualification) =>
    briefClaims.some((claim) => originalItem.claimIds.includes(claim.claimId) && claim.dependsOnClaimIds.includes(qualification.claimId))).map((claim) => claim.claimId));
  job.brief_result = {
    ...job.brief_result!, reuse: [], adapt: [], verify: [briefItem], claims: briefClaims,
    constraintReviews: job.brief_result!.constraintReviews
      .filter((review) => review.artifactId === sourceCase.artifacts[2].artifactId)
      .map(() => ({ caseId: selection.caseId, artifactId: selection.artifactId, versionId: selection.versionId, requestQuotes: ["client scope"] })),
  };
  job.assessment_result = assessment;
  job.brief_selections = [selection];
  return { corpus, job, countHistory };
}

test("portable exports preserve selected versions, reviewed checks, original hashes and exact excerpts deterministically", async () => {
  const { corpus, job } = await fixture();
  const pack = buildStarterPack(job, corpus, "https://demo.example");
  assert.deepEqual(pack, buildStarterPack(job, corpus, "https://demo.example"));
  assert.equal(pack.brief.withheldClaimCount, 2);
  assert.deepEqual(pack.inventory.map((item) => item.versionId), job.brief_selections!.map((item) => item.versionId));
  assert.equal(pack.records.find((record) => record.recordId === "grove-broad-admin")?.supersededById, "grove-scoped-setup");
  const selected = new Set(pack.inventory.map((item) => item.versionId));
  for (const item of pack.inventory) {
    assert.equal(item.sha256, corpus.versions.get(item.versionId)!.version.sha256);
    assert.equal(new URL(item.originalUrl).pathname, `/api/evidence/originals/${item.versionId}`);
    if (item.disposition === "verify") assert.match(item.status, /^BLOCKED/);
  }
  for (const record of pack.records) assert.ok(record.evidence.every((ref) => selected.has(ref.versionId)));
  const md = starterPackMarkdown(pack);
  const opened = JSON.parse(JSON.stringify(pack));
  for (const claim of [...pack.brief.claims, ...pack.blockingQuestions]) for (const ref of claim.sourceRefs) {
    const passage = opened.evidence.find((item: { passageId: string }) => item.passageId === ref.passageId);
    assert.equal(passage.excerpt, corpus.passages.get(ref.passageId)!.excerpt);
    assert.ok(selected.has(passage.versionId));
    assert.ok(md.includes(ref.passageId.replaceAll("-", "\\-")));
  }
  assert.ok(pack.blockingQuestions.some((claim) => claim.claimId === "check-2"));
  // All rendered prose, including source excerpts, must be inert Markdown text.
  pack.evidence[0].excerpt = "<script>alert(1)</script> [click](https://evil.example)";
  assert.ok(!starterPackMarkdown(pack).includes("<script>"));
});
test("assessment history exports as case context with exact provenance, not selected-procedure dependencies", async () => {
  const { corpus, job, countHistory } = await elmAssessmentContextFixture();
  const pack = buildStarterPack(job, corpus, "https://demo.example");
  const qualificationId = "source-history-elm-batch-count-discrepancy";
  const qualification = pack.assessmentHistory.find((claim) => claim.claimId === qualificationId);
  assert.equal(qualification?.text, countHistory.assertion);
  assert.deepEqual(qualification?.sourceRefs, countHistory.evidence);
  assert.equal(pack.brief.claims.some((claim) => claim.dependsOnClaimIds.includes(qualificationId)), false);

  const json = JSON.parse(JSON.stringify(pack)) as typeof pack;
  const exported = json.assessmentHistory.find((claim) => claim.claimId === qualificationId);
  assert.equal(exported?.text, countHistory.assertion);
  assert.deepEqual(exported?.sourceRefs, countHistory.evidence);
  const markdown = starterPackMarkdown(pack);
  const context = markdown.split("## Checked assessment historical context — case-level only, not selected-procedure history")[1]
    .split("## Reviewed decisions and lessons")[0];
  const escapedAssertion = countHistory.assertion.replace(/[\\`*_{}\[\]()<>#+.!|~\-]/gu, "\\$&").replace(/\r?\n/gu, "\n\n");
  assert.ok(context.includes(escapedAssertion));
  for (const phrase of ["four intentionally malformed amounts", "two rejects", "598 of 600 accepted", "unreconciled"]) assert.ok(context.includes(phrase));
  for (const ref of countHistory.evidence) {
    const citation = `${ref.caseId}/${ref.artifactId}/${ref.versionId}/${ref.passageId}`.replaceAll("-", "\\-");
    assert.ok(context.includes(citation));
    assert.ok(pack.evidence.some((passage) => passage.passageId === ref.passageId));
  }
  assert.deepEqual(qualification?.dependsOnClaimIds, []);
  for (const wrongRef of [
    { ...countHistory.evidence[0], versionId: "notes-2025-04-18" },
    { ...countHistory.evidence[0], artifactId: "batch-adapter-notes" },
  ]) {
    const wrongJob = structuredClone(job);
    const wrongQualification = wrongJob.assessment_result!.claims.find((claim) => claim.claimId === qualificationId)!;
    wrongQualification.sourceRefs[0] = wrongRef;
    const wrongPack = buildStarterPack(wrongJob, corpus, "https://demo.example");
    assert.equal(wrongPack.assessmentHistory.some((claim) => claim.claimId === qualificationId), false);
  }
});

test("a retained selected version is never replaced by a newer version of the same artifact", async () => {
  const { corpus, job } = await fixture();
  const original = corpus.versions.get(job.brief_selections![0].versionId)!;
  const newer = { ...original.version, versionId: "unselected-newer-version", sha256: "c".repeat(64), passages: [] };
  original.artifact.versions.push(newer);
  corpus.availableVersions.add(newer.versionId);
  corpus.versions.set(newer.versionId, { ...original, version: newer });
  const pack = buildStarterPack(job, corpus, "https://demo.example");
  assert.equal(pack.inventory[0].versionId, original.version.versionId);
  assert.equal(pack.inventory[0].sha256, original.version.sha256);
  assert.equal(JSON.stringify(pack).includes(newer.versionId), false);
});

test("export excludes unselected source claims and dependent recommendations instead of approving them", async () => {
  const { corpus, job } = await fixture();
  const foreign = [...corpus.passages.values()].find((passage) => passage.caseId !== job.brief_selections![0].caseId)!;
  job.brief_result!.claims[0].sourceRefs.push(foreign);
  const pack = buildStarterPack(job, corpus, "https://demo.example");
  assert.equal(pack.brief.claims.some((claim) => claim.claimId === "fact-0" || claim.claimId === "check-0"), false);
  assert.equal(pack.brief.reuse.length, 0);
  assert.equal(pack.inventory[0].disposition, "withheld");
  assert.match(pack.inventory[0].status, /^BLOCKED/);
  assert.equal(pack.evidence.some((passage) => passage.caseId === foreign.caseId), false);
});

test("checked briefs and both portable formats retain independently reviewed exact constraints, not hidden metadata or historical facts", async () => {
  const { corpus, job } = await fixture();
  const item = job.brief_result!.adapt[0];
  const selection = job.brief_selections!.find((selected) => selected.versionId === item.versionId)!;
  const quotes = ["seven business days", "at most 1,200 records", "audit and removal remain unverified"];
  job.request_text = `client scope; ${quotes.join("; ")}`;
  const original = job.brief_result!.claims.find((claim) => claim.claimId === item.dispositionClaimId)!;
  const recommendation: Claim = {
    ...original, requestQuotes: ["client scope", job.request_text, ...quotes],
    text: `Before adaptation, check the requested constraints: ${job.request_text}.`,
  };
  const fact = job.brief_result!.claims.find((claim) => claim.claimId === original.dependsOnClaimIds[0])!;
  const draft = { reuse: [], adapt: [item], verify: [], claims: [fact, recommendation] };
  const key = `${selection.caseId}/${selection.artifactId}/${selection.versionId}`;
  const schema = reviewSchema({ claimIds: draft.claims.map((claim) => claim.claimId), selections: [selection] }, job.request_text);
  const wireReview = { constraintQuotes: { [key]: [requestSpans(job.request_text)[0].spanId] }, claimVerdicts: Object.fromEntries(draft.claims.map((claim) => [claim.claimId, "supported"])) };
  const review = briefSupportReviewSchema.parse(schema.parse(wireReview));
  const requirements = { request: job.request_text, constraintReviews: review.constraintReviews };
  const check = (candidate = draft, verdicts = validateSupportReview(candidate.claims, review)) =>
    buildCheckedBrief(candidate, verdicts, validateBriefDraft(candidate, job.request_text, [selection], corpus), requirements);
  const checked = check();
  assert.equal(checked.adapt[0]?.versionId, selection.versionId);
  job.brief_result = checked;
  const pack = buildStarterPack(job, corpus, "https://demo.example");
  const json = JSON.parse(JSON.stringify(pack));
  const markdown = starterPackMarkdown(pack).split("## Checked brief claims / adaptation and verification checklist")[1]
    .split("## Blocking questions")[0].split("\n").filter((line) => !line.startsWith("Request quote:")).join("\n");
  for (const quote of quotes) {
    assert.ok(json.brief.claims.find((claim: Claim) => claim.claimId === recommendation.claimId).text.includes(quote));
    assert.ok(markdown.includes(quote));
  }
  assert.deepEqual(revalidateBrief(checked, job.request_text, corpus), checked);
  for (const text of [
    "Check configured expiry for a time-bound period before adaptation.",
    "Check seven days, at most 1,200 records; audit and removal remain unverified.",
    "Check seven business days, at most 1,200 records; audit and removal verified.",
  ]) {
    const lost = { ...draft, claims: [fact, { ...recommendation, text }] };
    const withheld = check(lost);
    assert.deepEqual(withheld.adapt, []);
    assert.equal(withheld.claims.some((claim) => claim.claimId === recommendation.claimId), false);
  }
  const historicalOnly = { ...draft, claims: [{ ...fact, text: quotes.join("; ") }, { ...recommendation, text: "Check configured expiry." }] };
  assert.deepEqual(check(historicalOnly).adapt, []);
  const unsupported = validateSupportReview(draft.claims, review);
  unsupported.set(fact.claimId, "uncertain");
  assert.deepEqual(check(draft, unsupported).adapt, []);
  const invented = { ...requirements, constraintReviews: [{ ...review.constraintReviews[0], requestQuotes: ["eight business days"] }] };
  assert.throws(() => buildCheckedBrief(draft, validateSupportReview(draft.claims, review), new Set(), invented), /independent exact request-constraint inventory/);
  assert.equal(schema.safeParse({ claimVerdicts: wireReview.claimVerdicts }).success, false);
  assert.equal(schema.safeParse({ ...wireReview, constraintQuotes: { "foreign/artifact/version": quotes } }).success, false);
  const { constraintReviews: _, ...legacy } = checked;
  assert.throws(() => revalidateBrief(legacy as BriefResult, job.request_text, corpus), EvidenceUnavailable);
  // Draft metadata is a second coverage signal when the independent reviewer misses a value.
  assert.deepEqual(buildCheckedBrief(
    { ...draft, claims: [fact, { ...recommendation, text: "Check configured expiry." }] },
    validateSupportReview(draft.claims, review), new Set(),
    { request: job.request_text, constraintReviews: [{ ...review.constraintReviews[0], requestQuotes: [] }] },
  ).adapt, []);
});

test("an assessment-accepted duration stays in the checked brief and both exports when brief review inventories nothing", async () => {
  const { corpus, job } = await fixture();
  const duration = "seven business days";
  const adapt = job.brief_result!.adapt[0];
  const sibling = job.brief_result!.reuse[0];
  job.request_text = `Check client scope for ${duration}.`;
  const recommendation = job.assessment_result!.claims.find((claim) => claim.claimId === adapt.dispositionClaimId)!;
  recommendation.requestQuotes = [job.request_text];
  recommendation.text = `The request states: ${job.request_text} Check named access before adaptation.`;
  job.assessment_result!.requestConstraints.identity_access = [job.request_text];
  const reviews = job.brief_result!.constraintReviews.map((review) => ({ ...review, requestQuotes: [] as string[] }));
  const floored = withAssessmentConstraintFloor(reviews, job.assessment_result!, job.request_text);
  assert.deepEqual(floored.find((review) => review.versionId === adapt.versionId)?.requestQuotes, [job.request_text]);
  assert.deepEqual(floored.find((review) => review.versionId === sibling.versionId)?.requestQuotes, ["client scope"]);
  const generic = structuredClone(job.brief_result!);
  generic.constraintReviews = floored;
  const adaptClaim = generic.claims.find((claim) => claim.claimId === adapt.dispositionClaimId)!;
  adaptClaim.requestQuotes = [];
  adaptClaim.text = "Check configured expiry before adaptation.";
  const withheld = buildCheckedBrief(generic, new Map(generic.claims.map((claim) => [claim.claimId, "supported" as const])), new Set(), { request: job.request_text, constraintReviews: floored });
  assert.equal(withheld.adapt.length, 0);
  assert.equal(withheld.claims.some((claim) => claim.text.includes(duration)), false);
  for (const claim of generic.claims.filter((claim) => claim.kind === "recommendation")) {
    claim.requestQuotes = [job.request_text];
    claim.text = `${job.request_text} Check this requirement before use. Audit and removal remain unverified.`;
  }
  const checked = buildCheckedBrief(generic, new Map(generic.claims.map((claim) => [claim.claimId, "supported" as const])), validateBriefDraft(generic, job.request_text, job.brief_selections!, corpus), { request: job.request_text, constraintReviews: floored });
  assert.equal(checked.adapt[0]?.versionId, adapt.versionId);
  assert.equal(checked.reuse[0]?.versionId, sibling.versionId);
  job.brief_result = checked;
  const pack = buildStarterPack(job, corpus, "https://demo.example");
  const markdown = starterPackMarkdown(pack).split("## Checked brief claims / adaptation and verification checklist")[1].split("## Blocking questions")[0];
  assert.ok(JSON.stringify(pack.brief.claims).includes(duration));
  assert.ok(markdown.includes(duration));
  assert.equal(markdown.includes("configured expiry"), false);
});

test("case-level requirement claims do not floor another item's brief coverage", async () => {
  const { job } = await fixture();
  const duration = "seven business days";
  const unrelated = "Security sign-off requires demonstrated removal.";
  const adapt = job.brief_result!.adapt[0];
  job.request_text = `Check client scope for ${duration}. ${unrelated}`;
  const recommendation = job.assessment_result!.claims.find((claim) => claim.claimId === adapt.dispositionClaimId)!;
  recommendation.requestQuotes = [duration];
  recommendation.text = `The request asks for ${duration} of named access.`;
  job.assessment_result!.requestConstraints.identity_access = [duration];
  job.assessment_result!.requestConstraints.recovery_operations = [unrelated];
  job.assessment_result!.claims.push({
    claimId: "unrelated-requirement", kind: "interpretation",
    text: `The current request states: ${unrelated}`,
    sourceRefs: recommendation.sourceRefs, requestQuotes: [], dependsOnClaimIds: [],
  });
  job.assessment_result!.comparisons.push({
    caseId: adapt.caseId, artifactId: adapt.artifactId, implicationEffect: "missing_evidence", dimension: "recovery_operations", requirementClaimId: "unrelated-requirement",
    evidenceClaimId: recommendation.claimId, relation: "unknown",
    assessmentClaimId: recommendation.claimId, implicationClaimId: recommendation.claimId,
  });
  const reviews = job.brief_result!.constraintReviews.map((review) => ({ ...review, requestQuotes: [] as string[] }));
  const floored = withAssessmentConstraintFloor(reviews, job.assessment_result!, job.request_text);
  const adaptQuotes = floored.find((review) => review.versionId === adapt.versionId)?.requestQuotes ?? [];
  assert.ok(adaptQuotes.includes(duration), "The item's own assessment-accepted quotation still floors its coverage.");
  assert.ok(!adaptQuotes.includes(unrelated), "A case-level requirement statement is not this artifact's relevance judgment.");
});

test("expiry, incomplete jobs, changed corpus and unavailable selected originals block a new pack", async () => {
  const { corpus, job } = await fixture();
  assert.throws(() => buildStarterPack({ ...job, expires_at: new Date(0) }, corpus, "https://demo.example"), (error) => error instanceof HttpFailure && error.status === 410);
  assert.throws(() => buildStarterPack({ ...job, brief_state: "running" }, corpus, "https://demo.example"), (error) => error instanceof HttpFailure && error.status === 409);
  assert.throws(() => buildStarterPack({ ...job, corpus_sha256: "a".repeat(64) }, corpus, "https://demo.example"), EvidenceUnavailable);
  corpus.availableVersions.delete(job.brief_selections![0].versionId);
  assert.throws(() => buildStarterPack(job, corpus, "https://demo.example"), EvidenceUnavailable);
});

test("real source corruption excludes the exact original and blocks export without replacing its version", async () => {
  const { corpus, job } = await fixture();
  const bytes = new TextEncoder().encode(JSON.stringify(corpus.manifest));
  const env = { ORIGINALS: { get: async (key: string) => key === "corpus/manifest.json"
    ? { size: bytes.length, arrayBuffer: async () => bytes.buffer }
    : { body: new Blob(["corrupted source"]).stream() } } } as unknown as Env;
  const corrupt = await loadCorpus(env);
  job.corpus_sha256 = corrupt.manifestSha256;
  assert.throws(() => buildStarterPack(job, corrupt, "https://demo.example"), EvidenceUnavailable);
});

test("missing or malformed capability cannot access either export format", async () => {
  for (const format of ["json", "markdown"]) for (const authorization of [undefined, "Bearer wrong"]) {
    const response = await app.request(`/api/jobs/00000000-0000-4000-8000-000000000005/pack/${format}`, { headers: authorization ? { Authorization: authorization } : {} }, {} as Env);
    assert.equal(response.status, 404);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "JOB_NOT_FOUND");
  }
});

test("normalized clause coverage retains a decisive sentence tail through checked read and both exports", async () => {
  const { corpus, job } = await fixture();
  const selection = job.brief_selections![1];
  job.request_text = `client scope requires ${"documented 😀 capabilities and ".repeat(22)}a bulk asynchronous route; the retired route is prohibited until explicit authorization.`;
  const spans = requestSpans(job.request_text);
  const schema = briefDraftSchemaFor(job.request_text, [selection], corpus, job.assessment_result!);
  const key = `${selection.caseId}/${selection.artifactId}/${selection.versionId}`;
  const label = assessmentPassageIds(corpus).get(selection.passageIds[0])!;
  const wire = { items: { [key]: {
    disposition: "adapt",
    recommendation: { text: "Adapt this checked work only after the explicit prerequisites.", sourceRefs: [label] },
    requestRecommendations: Object.fromEntries(spans.map((span) => [
      span.spanId, { text: "Verify this entire requested constraint before use.", sourceRefs: [label] },
    ])),
    claims: [],
  } } };
  const draft = schema.parse(wire);
  const review = briefSupportReviewSchema.parse(reviewSchema({ claimIds: draft.claims.map((claim) => claim.claimId), selections: [selection] }, job.request_text).parse({
    constraintQuotes: { [key]: [spans[0].spanId] }, claimVerdicts: Object.fromEntries(draft.claims.map((claim) => [claim.claimId, "supported"])),
  }));
  const requirements = { request: job.request_text, constraintReviews: review.constraintReviews, assessment: job.assessment_result! };
  const verdicts = validateSupportReview(draft.claims, review);
  const checked = buildCheckedBrief(draft, verdicts, validateBriefDraft(draft, job.request_text, [selection], corpus), requirements);
  assert.equal(checked.adapt[0]?.versionId, selection.versionId);
  assert.deepEqual(revalidateBrief(checked, job.request_text, corpus, job.assessment_result!), checked);
  job.brief_selections = [selection];
  job.brief_result = checked;
  const pack = buildStarterPack(job, corpus, "https://demo.example");
  const json = JSON.parse(JSON.stringify(pack));
  assert.ok(json.brief.claims.some((claim: Claim) => claim.text.includes("the retired route is prohibited until explicit authorization.")));
  assert.ok(starterPackMarkdown(pack).includes("the retired route is prohibited until explicit authorization"));
});

test("checked and independently reviewed requests require item-owned recommendations through exports", async () => {
  const { corpus, job } = await fixture();
  const selected = job.brief_selections!.slice(0, 2);
  const sibling = selected[0];
  const affected = selected[1];
  const request = "Keep each record for seven business days. Named read-only access remains valid for five business days. Confirm deletion after the retention window.";
  job.request_text = request;
  const spans = requestSpans(request);
  const quote = spans[0].text;
  const quoteId = spans[0].spanId;
  const identityQuote = spans[1].text;
  const identityQuoteId = spans[1].spanId;
  const extraQuote = spans[2].text;
  const extraQuoteId = spans[2].spanId;
  for (const claim of job.assessment_result!.claims) claim.requestQuotes = [];
  const affectedWork = job.assessment_result!.cases[0].artifactWork.find((work) => work.artifactId === affected.artifactId)!;
  const assessmentCarrier = job.assessment_result!.claims.find((claim) => claim.claimId === affectedWork.dispositionClaimId)!;
  assessmentCarrier.requestQuotes = [quote, identityQuote];
  assessmentCarrier.text = `The request requires ${quote} and ${identityQuote} Check the recorded procedure before use.`;
  const keyFor = (item: Selection) => `${item.caseId}/${item.artifactId}/${item.versionId}`;
  const schema = briefDraftSchemaFor(request, selected, corpus, job.assessment_result!);
  const labels = assessmentPassageIds(corpus);
  const boundQuoteIds = new Set([quoteId, identityQuoteId]);
  const makeWire = (siblingRecommendation = false) => ({
    items: Object.fromEntries(selected.map((item, index) => {
      const label = labels.get(item.passageIds[0])!;
      const own = item.versionId === affected.versionId;
      return [keyFor(item), {
        disposition: index === 0 ? "reuse" as const : "adapt" as const,
        recommendation: {
          text: index === 0 ? "Reuse the checked source for this request." : "Adapt the checked source for this request.",
          sourceRefs: [label],
        },
        requestRecommendations: Object.fromEntries(spans.map((span) => [
          span.spanId,
          (own && boundQuoteIds.has(span.spanId)) || (!own && siblingRecommendation && span.spanId === quoteId) ? {
            text: "Check the request condition against the selected procedure.",
            sourceRefs: [label],
          } : null,
        ])),
        claims: [{ text: "The selected source documents a retention workflow.", sourceRefs: [label] }],
      }];
    })),
  });
  assert.equal(makeWire().items[keyFor(affected)].requestRecommendations[extraQuoteId], null,
    "The independent third request span remains optional until a reviewer identifies it as relevant.");
  const evaluate = (
    affectedVerdict: "supported" | "unsupported" | "uncertain" = "supported",
    reviewerQuotes: string[] = [],
    siblingRecommendation = false,
    interpretationInstead = false,
  ) => {
    const draft = schema.parse(makeWire(siblingRecommendation));
    if (interpretationInstead) {
      const carrier = draft.claims.find((claim) => claim.sourceRefs[0].versionId === affected.versionId
        && claim.kind === "recommendation" && claim.requestQuotes.includes(quote))!;
      carrier.kind = "interpretation";
    }
    const prompt = briefReviewPrompt(request, selected, corpus, job.assessment_result!, draft);
    const rawReview = reviewSchema(prompt.reviewTargets!, request).parse({
      constraintQuotes: Object.fromEntries(selected.map((item) => [
        keyFor(item), item.versionId === affected.versionId ? reviewerQuotes.map((text) => requestSpans(request).find((span) => span.text === text)!.spanId) : [],
      ])),
      claimVerdicts: Object.fromEntries(draft.claims.map((claim) => [
        claim.claimId,
        claim.sourceRefs[0].versionId === affected.versionId && claim.kind === "recommendation" && claim.requestQuotes.includes(quote)
          ? affectedVerdict : "supported",
      ])),
    });
    const review = briefSupportReviewSchema.parse(rawReview);
    const verdicts = validateSupportReview(draft.claims, review);
    const checked = buildCheckedBrief(draft, verdicts, validateBriefDraft(draft, request, selected, corpus), {
      request, constraintReviews: review.constraintReviews, assessment: job.assessment_result!,
    });
    return {
      draft, checked,
      carrier: draft.claims.find((claim) => claim.sourceRefs[0].versionId === affected.versionId
        && claim.kind === "recommendation" && claim.requestQuotes.includes(quote)),
      review,
    };
  };

  const requiredNull = makeWire();
  Object.assign(requiredNull.items[keyFor(affected)].requestRecommendations, { [quoteId]: null });
  assert.equal(schema.safeParse(requiredNull).success, false, "A nullable request recommendation cannot replace checked assessment coverage.");
  const omittedRequired = makeWire();
  delete omittedRequired.items[keyFor(affected)].requestRecommendations[quoteId];
  assert.equal(schema.safeParse(omittedRequired).success, false);
  const interpreted = evaluate("supported", [], false, true);
  assert.deepEqual(interpreted.checked.adapt, [], "An interpretation is not a recommendation carrying the checked request span.");
  for (const verdict of ["uncertain", "unsupported"] as const) {
    const unaccepted = evaluate(verdict);
    assert.deepEqual(unaccepted.checked.adapt, [], `An ${verdict} request recommendation cannot carry required coverage.`);
  }
  const foreign = evaluate("unsupported", [], true);
  assert.deepEqual(foreign.checked.adapt, [], "Another item's supported recommendation cannot satisfy this item's checked quotation.");
  assert.deepEqual(foreign.checked.reuse.map((item) => item.versionId), [sibling.versionId]);

  const reviewerFoundExtraRequirement = evaluate("supported", [extraQuote]);
  assert.deepEqual(reviewerFoundExtraRequirement.checked.adapt, [],
    "An independent reviewer may discover an omitted nullable span and withhold the incomplete item.");
  assert.deepEqual(reviewerFoundExtraRequirement.checked.reuse.map((item) => item.versionId), [sibling.versionId]);

  const positive = evaluate("supported");
  assert.deepEqual(positive.checked.adapt.map((item) => item.versionId), [affected.versionId]);
  const identityCarrier = positive.draft.claims.find((claim) => claim.sourceRefs[0].versionId === affected.versionId
    && claim.kind === "recommendation" && claim.requestQuotes.includes(identityQuote))!;
  assert.ok(positive.carrier?.text.includes(quote) && positive.carrier.requestQuotes.includes(quote));
  assert.ok(identityCarrier.text.includes(identityQuote) && identityCarrier.requestQuotes.includes(identityQuote));
  assert.deepEqual(positive.review.constraintReviews.find((item) => item.versionId === affected.versionId)?.requestQuotes, [],
    "The positive case uses only the checked assessment's accepted quotations.");
  const checkedRead = revalidateBrief(positive.checked, request, corpus, job.assessment_result!);
  assert.deepEqual(checkedRead, positive.checked);
  job.brief_selections = selected;
  job.brief_result = checkedRead;
  const pack = buildStarterPack(job, corpus, "https://demo.example");
  const json = JSON.parse(JSON.stringify(pack));
  const exportedQuote = json.brief.claims.find((claim: Claim) => claim.claimId === positive.carrier!.claimId);
  const exportedIdentityQuote = json.brief.claims.find((claim: Claim) => claim.claimId === identityCarrier.claimId);
  assert.ok(exportedQuote?.text.includes(quote), "The checked JSON export retains the supported timing quotation.");
  assert.ok(exportedIdentityQuote?.text.includes(identityQuote), "The checked JSON export retains the supported identity quotation.");
  assert.ok(!json.brief.claims.some((claim: Claim) => claim.text.includes(extraQuote)),
    "An optional reviewer-irrelevant span is not forced into the checked brief or export.");
});

test("Ibis outcome excerpts retain failed-attempt and correction qualifications across parser, read and export", async () => {
  const { corpus, job } = await fixture();
  const source = [...corpus.passages.values()].find((passage) => passage.caseId === "ibis-verified-handover" && passage.artifactId === "operator-runbook" && passage.excerpt.includes("Exercise evidence:"))!;
  const selection: Selection = { caseId: source.caseId, artifactId: source.artifactId, versionId: source.versionId, passageIds: [source.passageId] };
  const ref = { caseId: source.caseId, artifactId: source.artifactId, versionId: source.versionId, passageId: source.passageId };
  const assessment = job.assessment_result!;
  const pastCase = corpus.manifest.cases.find((item) => item.caseId === source.caseId)!;
  const artifactClaims = pastCase.artifacts.map((artifact, index) => {
    const artifactRef = artifact.artifactId === source.artifactId ? ref : {
      caseId: source.caseId, artifactId: artifact.artifactId,
      versionId: artifact.versions[0].versionId, passageId: artifact.versions[0].passages[0].passageId,
    };
    return {
      artifact,
      refs: [artifactRef],
      historyId: `ibis-history-${index}`,
      operationId: `ibis-operation-${index}`,
      adaptationId: `ibis-adaptation-${index}`,
      checkId: `ibis-check-${index}`,
      claims: [{
        claimId: `ibis-history-${index}`, text: corpus.passages.get(artifactRef.passageId)!.excerpt, kind: "source_fact" as const,
        sourceRefs: [artifactRef], requestQuotes: [], dependsOnClaimIds: [],
      }],
    };
  });
  const selectedClaims = artifactClaims.find((item) => item.artifact.artifactId === source.artifactId)!;
  const recommendation: Claim = {
    claimId: "ibis-conditional-handover", kind: "recommendation",
    text: "Adapt the witnessed test handover after checking the current client's scope.",
    sourceRefs: selectedClaims.refs, requestQuotes: [], dependsOnClaimIds: [selectedClaims.historyId, selectedClaims.operationId],
  };
  const operationClaim: Claim = {
    claimId: selectedClaims.operationId, text: "The recorded operation is a recovery handover.", kind: "interpretation",
    sourceRefs: selectedClaims.refs, requestQuotes: [], dependsOnClaimIds: [selectedClaims.historyId],
  };
  const adaptationClaim: Claim = {
    claimId: selectedClaims.adaptationId, text: "Adapt the recorded handover to the current client.", kind: "recommendation",
    sourceRefs: selectedClaims.refs, requestQuotes: [], dependsOnClaimIds: [recommendation.claimId, selectedClaims.historyId],
  };
  const checkClaims: Claim[] = Object.entries(OPERATION_CHECKS.recovery_handover).map(([kind, text]) => ({
    claimId: kind === "checkpoint_replay" ? selectedClaims.checkId : `${selectedClaims.checkId}-${kind.replaceAll("_", "-")}`,
    text, kind: "recommendation", sourceRefs: selectedClaims.refs, requestQuotes: [],
    dependsOnClaimIds: [recommendation.claimId, selectedClaims.historyId],
  }));
  assessment.claims = applySourceHistoryQualifications(corpus, [
    ...assessment.claims, recommendation, operationClaim, adaptationClaim, ...checkClaims,
    ...artifactClaims.flatMap((item) => item.claims),
  ]);
  assessment.cases.push({
    caseId: source.caseId, availability: "available", outcome: "unknown", outcomeClaimIds: [],
    claimIds: artifactClaims.flatMap((item) => [
      ...item.claims.map((claim) => claim.claimId),
      ...(item.artifact.artifactId === source.artifactId ? [item.operationId, recommendation.claimId, item.adaptationId, ...checkClaims.map((claim) => claim.claimId)] : []),
    ]),
    artifactWork: artifactClaims.map((item) => ({
      artifactId: item.artifact.artifactId, availability: "available", exclusionReasons: [],
      disposition: item.artifact.artifactId === source.artifactId ? "adapt" : null,
      dispositionClaimId: item.artifact.artifactId === source.artifactId ? recommendation.claimId : null,
      claimIds: item.artifact.artifactId === source.artifactId
        ? [item.historyId, item.operationId, recommendation.claimId, item.adaptationId, ...checkClaims.map((claim) => claim.claimId)]
        : [item.historyId],
      blockerClaimIds: [], verificationClaimIds: item.artifact.artifactId === source.artifactId ? checkClaims.map((claim) => claim.claimId) : [],
    })),
  });
  assessment.artifactReviews.push(...artifactClaims.map((item) => {
    const selected = item.artifact.artifactId === source.artifactId;
    return {
      caseId: source.caseId, artifactId: item.artifact.artifactId, role: selected ? "starting_point" as const : "context_only" as const,
      verdict: "supported" as const, reasons: [],
      decision: {
        disposition: selected ? "adapt" as const : null,
        operation: selected ? "recovery_handover" as const : null,
        historicalEvidence: item.refs, requestQuotes: [],
        adaptations: selected ? [{ text: "Adapt the recorded handover to the current client.", sourceRefs: item.refs, requestQuotes: [] }] : [],
        checks: selected ? checkClaims.map((claim, index) => ({
          kind: Object.keys(OPERATION_CHECKS.recovery_handover)[index] as keyof typeof OPERATION_CHECKS.recovery_handover,
          text: claim.text, sourceRefs: item.refs, requestQuotes: [],
        })) : [],
        obligations: [],
      },
      claimFindings: [
        { claimId: item.historyId, verdict: "supported" as const, reason: null },
        ...(selected ? [
          { claimId: item.operationId, verdict: "supported" as const, reason: null },
          { claimId: item.adaptationId, verdict: "supported" as const, reason: null },
          ...checkClaims.map((claim) => ({ claimId: claim.claimId, verdict: "supported" as const, reason: null })),
        ] : []),
      ],
    };
  }));
  const key = `${selection.caseId}/${selection.artifactId}/${selection.versionId}`;
  const label = assessmentPassageIds(corpus).get(source.passageId)!;
  const draft = briefDraftSchemaFor(job.request_text, [selection], corpus, assessment).parse({ items: { [key]: {
    disposition: "adapt",
    recommendation: { text: "Adapt the checked test procedure after confirming current applicability.", sourceRefs: [label] },
    requestRecommendations: Object.fromEntries(requestSpans(job.request_text).map((span) => [
      span.spanId, { text: "Confirm client scope before using the recorded test procedure.", sourceRefs: [label] },
    ])),
    claims: [],
  } } });
  const requirements = { request: job.request_text, assessment, constraintReviews: [{ caseId: ref.caseId, artifactId: ref.artifactId, versionId: ref.versionId, requestQuotes: [job.request_text] }] };
  const checked = buildCheckedBrief(draft, new Map(draft.claims.map((claim) => [claim.claimId, "supported" as const])), validateBriefDraft(draft, job.request_text, [selection], corpus), requirements);
  assert.equal(checked.adapt.length, 1);
  assert.deepEqual(revalidateBrief(checked, job.request_text, corpus, assessment), checked);
  job.brief_result = checked;
  job.brief_selections = [selection];
  const pack = buildStarterPack(job, corpus, "https://demo.example");
  const history = pack.brief.claims.find((claim) => claim.claimId.startsWith("source-history-"))!;
  assert.ok(history.text.includes("first recovery attempt") && history.text.includes("corrected test archive"));
  assert.ok(history.sourceRefs.some((item) => item.artifactId === "delivery-log"), "Required historical provenance is retained, not dropped for being outside the selected procedure.");
  for (const citation of history.sourceRefs) assert.ok(pack.evidence.some((passage) => passage.passageId === citation.passageId));
  assert.ok(JSON.parse(JSON.stringify(pack)).brief.claims.some((claim: Claim) => claim.claimId === history.claimId));
  assert.ok(starterPackMarkdown(pack).includes("first recovery attempt"));
});
