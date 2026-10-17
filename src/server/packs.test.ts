import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AssessmentResult, BriefItem, BriefResult, Claim, Selection } from "../shared/protocol.ts";
import { EvidenceUnavailable, loadCorpus, type CorpusManifest, type CorpusSnapshot } from "./corpus.ts";
import { HttpFailure } from "./errors.ts";
import type { JobRecord } from "./jobs.ts";
import type { Env } from "./env.ts";
import { buildStarterPack, starterPackMarkdown } from "./packs.ts";
import { app } from "./http.ts";
import { buildCheckedBrief, revalidateBrief, validateBriefDraft, validateSupportReview, withAssessmentConstraintFloor } from "./gates.ts";
import { briefSupportReviewSchema, reviewSchema } from "./schemas.ts";

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
      { claimId: `fact-${index}`, text: "Recorded source context.", kind: "source_fact", sourceRefs, requestQuotes: [], dependsOnClaimIds: [] },
      { claimId: `check-${index}`, text: "Check client scope before use; unresolved scope blocks unchanged reuse.", kind: "recommendation", sourceRefs, requestQuotes: ["client scope"], dependsOnClaimIds: [`fact-${index}`] },
    ];
  });
  const items: BriefItem[] = selections.map((selection, index) => ({ ...selection, disposition: index === 0 ? "reuse" : index === 1 ? "adapt" : "verify", dispositionClaimId: `check-${index}`, claimIds: [`fact-${index}`, `check-${index}`] }));
  const brief: BriefResult = { reuse: items.filter((item) => item.disposition === "reuse"), adapt: items.filter((item) => item.disposition === "adapt"), verify: items.filter((item) => item.disposition === "verify"), claims, constraintReviews: selections.map(({ caseId, artifactId, versionId }) => ({ caseId, artifactId, versionId, requestQuotes: ["client scope"] })), withheldClaimCount: 2 };
  const assessment: AssessmentResult = {
    conclusion: "cannot_be_established", clarifyingClaimIds: [], comparisons: [], nextActions: [], leads: [], contrasts: [], claims: [...claims], withheldClaimCount: 0,
    requestConstraints: { product_version: [], environment: [], scale: [], identity_access: [], recovery_operations: [] },
    artifactReviews: pastCase.artifacts.map((artifact) => ({ caseId: pastCase.caseId, artifactId: artifact.artifactId, role: "starting_point" })),
    cases: [{ caseId: pastCase.caseId, availability: "available", outcome: "unknown", outcomeClaimIds: [], claimIds: claims.map((claim) => claim.claimId), artifactWork: items.map((item) => ({ artifactId: item.artifactId, availability: "available", exclusionReasons: [], disposition: item.disposition, dispositionClaimId: item.dispositionClaimId, claimIds: item.claimIds, blockerClaimIds: [], verificationClaimIds: item.disposition === "verify" ? [item.dispositionClaimId] : [] })) }],
  };
  for (const work of assessment.cases[0].artifactWork) {
    const recommendation = claims.find((claim) => claim.claimId === work.dispositionClaimId)!;
    const classificationId = `classification-${work.dispositionClaimId}`;
    assessment.claims.push({
      ...recommendation, claimId: classificationId, kind: "interpretation",
      text: `Artifact disposition: ${work.disposition}.`, dependsOnClaimIds: [...work.claimIds],
    });
    work.claimIds = [...work.claimIds, classificationId];
  }
  const job: JobRecord = {
    id: "00000000-0000-4000-8000-000000000005", request_text: "Check client scope", corpus_version: manifest.corpusVersion, corpus_sha256: corpus.manifestSha256,
    stage: "ready", assessment_state: "ready", brief_state: "ready", assessment_result: assessment, brief_result: brief, brief_selections: selections, error_code: null,
    created_at: new Date("2026-10-15T00:00:00Z"), expires_at: new Date("2099-10-22T00:00:00Z"), assessment_queued_at: new Date("2026-10-15T00:00:00Z"), assessment_processing_started_at: null, assessment_finished_at: null, brief_queued_at: null, brief_processing_started_at: null, brief_finished_at: null,
  };
  return { corpus, job };
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
  const wireReview = { constraintQuotes: { [key]: [job.request_text] }, claimVerdicts: Object.fromEntries(draft.claims.map((claim) => [claim.claimId, "supported"])) };
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
  recommendation.requestQuotes = [duration];
  recommendation.text = `The request asks for ${duration} of named access.`;
  job.assessment_result!.requestConstraints.identity_access = [duration];
  const reviews = job.brief_result!.constraintReviews.map((review) => ({ ...review, requestQuotes: [] as string[] }));
  const floored = withAssessmentConstraintFloor(reviews, job.assessment_result!, job.request_text);
  assert.deepEqual(floored.find((review) => review.versionId === adapt.versionId)?.requestQuotes, [duration, "client scope"]);
  assert.deepEqual(floored.find((review) => review.versionId === sibling.versionId)?.requestQuotes, ["client scope"]);
  const generic = structuredClone(job.brief_result!);
  generic.constraintReviews = floored;
  const adaptClaim = generic.claims.find((claim) => claim.claimId === adapt.dispositionClaimId)!;
  adaptClaim.requestQuotes = [];
  adaptClaim.text = "Check configured expiry before adaptation.";
  const withheld = buildCheckedBrief(generic, new Map(generic.claims.map((claim) => [claim.claimId, "supported" as const])), new Set(), { request: job.request_text, constraintReviews: floored });
  assert.equal(withheld.adapt.length, 0);
  assert.equal(withheld.claims.some((claim) => claim.text.includes(duration)), false);
  adaptClaim.requestQuotes = [duration, "client scope"];
  adaptClaim.text = `Before adaptation, check client scope for the requested ${duration} access period. Audit and removal remain unverified.`;
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
    caseId: adapt.caseId, dimension: "recovery_operations", requirementClaimId: "unrelated-requirement",
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
