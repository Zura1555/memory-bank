import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { OPERATION_CHECKS } from "../shared/operations.ts";
import type { Env } from "./env.ts";
import { assessmentPassageIds, loadCorpus } from "./corpus.ts";
import { callModel, type ModelStage } from "./model.ts";
import { assessmentDraftPrompt, assessmentReviewPrompt, briefDraftPrompt, briefReviewPrompt, type StagePrompt } from "./prompts.ts";
import { assessmentDraftSchema, briefDraftSchema, parseAssessmentDraft, reviewSchema, type AssessmentReview, type BriefDraft } from "./schemas.ts";
import { buildCheckedAssessment, buildCheckedBrief, revalidateAssessment, revalidateBrief, validateAssessmentDraft, validateArtifactReview, validateBriefDraft, validateSupportReview } from "./gates.ts";
import { requestSpans } from "./request-constraints.ts";

// Offline contract for the non-fine-tuned OpenAI strict-output subset used by
// the pinned OpenRouter route. Not a provider emulator or upstream acceptance.
// https://platform.openai.com/docs/guides/structured-outputs#supported-schemas
function checkProviderSubset(root: Record<string, any>) {
  const keywords = new Set(["type", "properties", "required", "additionalProperties", "$defs", "$ref", "anyOf", "enum", "minLength", "maxLength", "pattern", "items", "minItems", "maxItems"]);
  let properties = 0;
  let enumValues = 0;
  let stringBudget = 0;
  let references = 0;
  const nodes = (node: Record<string, any>, path: string) => {
    for (const key of Object.keys(node)) assert.ok(keywords.has(key), `${path}: unsupported ${key}`);
    if (node.$ref) {
      assert.match(node.$ref, /^#\/\$defs\/[^/]+$/);
      assert.ok(root.$defs?.[node.$ref.split("/")[2]], `${path}: unresolved reference`);
      // Emit pure references, not dialect-dependent assertion siblings.
      assert.deepEqual(Object.keys(node), ["$ref"], `${path}: constrained reference`);
      references++;
    } else if (node.anyOf) {
      assert.ok(node.anyOf.length > 0);
    } else {
      assert.ok(["object", "array", "string", "boolean", "null", "integer", "number"].includes(node.type), `${path}: unsupported type`);
    }
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false, `${path}: object must be closed`);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${path}: every property must be required`);
      properties += Object.keys(node.properties).length;
      stringBudget += Object.keys(node.properties).join("").length;
    }
    if (node.type === "array") assert.ok(node.items && !Array.isArray(node.items), `${path}: homogeneous items required`);
    if (node.enum) {
      enumValues += node.enum.length;
      const bytes = node.enum.filter((value: unknown) => typeof value === "string").join("").length;
      stringBudget += bytes;
      if (node.enum.length > 250) assert.ok(bytes <= 15_000, `${path}: large enum string limit`);
    }
    for (const [name, child] of Object.entries(node.properties ?? {})) nodes(child as Record<string, any>, `${path}/properties/${name}`);
    for (const [name, child] of Object.entries(node.$defs ?? {})) {
      stringBudget += name.length;
      nodes(child as Record<string, any>, `${path}/$defs/${name}`);
    }
    if (node.items) nodes(node.items, `${path}/items`);
    node.anyOf?.forEach((child: Record<string, any>, index: number) => nodes(child, `${path}/anyOf/${index}`));
  };
  assert.equal(root.type, "object");
  assert.equal(root.anyOf, undefined);
  nodes(root, "#");
  assert.ok(properties <= 5_000, `property budget: ${properties}`);
  assert.ok(enumValues <= 1_000, `enum budget: ${enumValues}`);
  assert.ok(stringBudget <= 120_000, `schema string budget: ${stringBudget}`);
  assert.ok(references > 0, "Exercise reused definitions, not an inlined toy schema");
  const depth = (node: Record<string, any>, parents: Set<object>): number => {
    assert.ok(!parents.has(node), "These stage schemas must have finite nesting");
    const next = new Set([...parents, node]);
    if (node.$ref) return depth(root.$defs[node.$ref.split("/")[2]], next);
    if (node.anyOf) return Math.max(...node.anyOf.map((child: Record<string, any>) => depth(child, next)));
    if (node.type === "object") return 1 + Math.max(0, ...Object.values(node.properties).map((child) => depth(child as Record<string, any>, next)));
    if (node.type === "array") return 1 + depth(node.items, next);
    return 0;
  };
  assert.ok(depth(root, new Set()) <= 10, "schema nesting budget");
}

async function corpusFixture() {
  return loadCorpus({ ORIGINALS: { get: async (key: string) => {
    const path = key === "corpus/manifest.json" ? key : `corpus/originals/${key.split("/originals/")[1]}`;
    const bytes = await readFile(new URL(`../../${path}`, import.meta.url));
    return { size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer, body: new Blob([bytes]).stream() };
  } } } as unknown as Env);
}

test("all four production stages emit strict provider-subset schemas without weakening identities or cardinality", async (t) => {
  const corpus = await corpusFixture();
  const request = "Verify 450 records within six hours, only after terminal status 😀. Named read-only access for five business days remains unconfirmed.";
  const spans = requestSpans(request);
  const labels = assessmentPassageIds(corpus);
  const constraints = { product_version: [], environment: [], scale: [spans[0].spanId], identity_access: [spans[1].spanId], recovery_operations: [spans[0].spanId] };
  const first = corpus.manifest.cases[0];
  const firstArtifact = first.artifacts[0];
  const ownLabel = labels.get(firstArtifact.versions[0].passages[0].passageId)!;
  const foreignLabel = labels.get(first.artifacts[1].versions[0].passages[0].passageId)!;
  const fact = (label: string) => ({ kind: "source_fact", sourceRefs: [label], requestQuotes: [], dependsOnClaimIds: [] });
  const authored = (label: string) => ({ text: "Validate client compatibility before adapting this recorded procedure.", sourceRefs: [label], requestQuotes: [spans[0].spanId] });
  const wire = {
    requestConstraints: constraints, clarifyingClaimIds: [],
    claims: [{ ...fact(ownLabel), claimId: "historical-fact", caseId: first.caseId, outcomeEvidence: false }],
    cases: Object.fromEntries(corpus.manifest.cases.map((item, index) => [item.caseId, {
      outcome: "unknown", tier: index === 0 ? "lead" : "context",
      ...(index === 0 ? { state: "conditional", reasons: [fact(ownLabel)], comparisons: [{
        dimension: "scale", requirementQuote: spans[0].spanId, relation: "unknown",
        evidence: { sourceRefs: [ownLabel], requestQuotes: [] },
        assessment: { sourceRefs: [ownLabel], requestQuotes: [spans[0].spanId], dependsOnClaimIds: [] },
        implication: { artifactId: firstArtifact.artifactId, effect: "checked_decision" },
      }] } : {}),
      artifactWork: Object.fromEntries(item.artifacts.map((artifact, artifactIndex) => {
        const label = labels.get(artifact.versions[0].passages[0].passageId)!;
        const operation = artifactIndex === 0 ? "api_adapter" : "recovery_handover";
        return [artifact.artifactId, {
          disposition: "adapt", operation, historicalEvidence: [label], requestQuotes: [spans[0].spanId],
          adaptations: [authored(label)],
          checks: Object.entries(OPERATION_CHECKS[operation]).map(([kind]) => ({ kind, sourceRefs: [label], requestQuotes: [spans[0].spanId] })),
        }];
      })),
    }])),
  };
  const originalFetch = globalThis.fetch;
  const exchange = async (stage: ModelStage, prompt: StagePrompt, output: unknown, check?: (schema: Record<string, any>) => void) => {
    let schema: Record<string, any> | undefined;
    globalThis.fetch = async (_input, init) => {
      schema = JSON.parse(init!.body as string).response_format.json_schema.schema;
      return Response.json({ id: "gen-offline-contract", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }] });
    };
    const result = await callModel({ OPENROUTER_API_KEY: "synthetic-no-network" } as Env, stage, prompt);
    if (check) check(schema!);
    return result;
  };
  const inspect = (valid: unknown, invalid: unknown[], otherValid: unknown[] = []) => (schema: Record<string, any>) => {
    checkProviderSubset(schema);
    const validate = new Ajv2020({ strict: false }).compile(schema);
    for (const value of [valid, ...otherValid]) assert.equal(validate(value), true, JSON.stringify(validate.errors));
    for (const value of invalid) assert.equal(validate(value), false, "Provider grammar must reject the invalid contract");
  };
  try {
    const prompt = assessmentDraftPrompt(request, corpus);
    const invalidDrafts = [
      (() => { const value = structuredClone(wire); value.cases[first.caseId].artifactWork[firstArtifact.artifactId].adaptations = []; return value; })(),
      (() => { const value = structuredClone(wire); value.cases[first.caseId].artifactWork[firstArtifact.artifactId].checks = []; return value; })(),
      ...[0, 17].map((count) => { const value = structuredClone(wire); value.cases[first.caseId].artifactWork[firstArtifact.artifactId].historicalEvidence = Array(count).fill(ownLabel); return value; }),
      (() => { const value = structuredClone(wire); value.cases[first.caseId].artifactWork[firstArtifact.artifactId].historicalEvidence = [foreignLabel]; return value; })(),
      (() => { const value = structuredClone(wire); value.cases[first.caseId].artifactWork[firstArtifact.artifactId].operation = "recovery_handover"; return value; })(),
      (() => { const value = structuredClone(wire); Object.assign(value.cases[first.caseId].artifactWork[firstArtifact.artifactId].checks[0], { kind: "operating_authority" }); return value; })(),
      (() => { const value = structuredClone(wire); Object.assign(value.cases[first.caseId].artifactWork[firstArtifact.artifactId], { operation: undefined }); return value; })(),
      (() => { const value = structuredClone(wire); Object.assign(value.cases[first.caseId].artifactWork[firstArtifact.artifactId], { operation: null }); return value; })(),
      (() => {
        const value = structuredClone(wire);
        Object.assign(value.cases[first.caseId].artifactWork[firstArtifact.artifactId], { disposition: null, adaptations: [], checks: [] });
        return value;
      })(),
      (() => { const value = structuredClone(wire); Object.assign(value.cases[first.caseId].artifactWork[firstArtifact.artifactId].checks[0], { text: "Provider-authored check text." }); return value; })(),
      (() => { const value = structuredClone(wire); value.cases[first.caseId].artifactWork[firstArtifact.artifactId].checks[0].sourceRefs = [foreignLabel]; return value; })(),
      (() => { const value = structuredClone(wire); value.cases[first.caseId].artifactWork[firstArtifact.artifactId].checks[0].sourceRefs = ["missing-passage"]; return value; })(),
      (() => { const value = structuredClone(wire); value.cases[first.caseId].artifactWork[firstArtifact.artifactId].checks[0].requestQuotes = ["unknown-span"]; return value; })(),
      (() => { const value = structuredClone(wire); value.cases[first.caseId].artifactWork[firstArtifact.artifactId].checks.find((check) => check.kind === "client_operation_limits")!.requestQuotes = []; return value; })(),
      (() => { const value = structuredClone(wire); value.cases[first.caseId].artifactWork[firstArtifact.artifactId].checks.find((check) => check.kind === "client_operation_limits")!.requestQuotes = spans.map((span) => span.spanId); return value; })(),
      (() => { const value = structuredClone(wire); value.cases[first.caseId].reasons![0].sourceRefs = [ownLabel, ownLabel]; return value; })(),
      (() => { const value = structuredClone(wire); value.cases[first.caseId].comparisons![0].evidence.sourceRefs = [ownLabel, ownLabel]; return value; })(),
      (() => { const value = structuredClone(wire); value.claims[0].sourceRefs = [ownLabel, ownLabel]; return value; })(),
      (() => { const value = structuredClone(wire); value.requestConstraints.scale = ["unknown-span"]; return value; })(),
      (() => { const value = structuredClone(wire); delete value.cases[first.caseId]; return value; })(),
      { ...wire, invented: true },
    ];
    let normalized: unknown;
    await t.test("assessment_draft", async () => {
      const bounded = structuredClone(wire);
      bounded.cases[first.caseId].artifactWork[firstArtifact.artifactId].historicalEvidence = Array(16).fill(ownLabel);
      normalized = (await exchange("assessment_draft", prompt, wire, inspect(wire, invalidDrafts, [bounded]))).output;
      const boundedDraft = parseAssessmentDraft(prompt.responseSchema!.parse(bounded), corpus);
      assert.equal(validateAssessmentDraft(boundedDraft, request, corpus).size, 0, "Repeated evidence labels must not create duplicate server-owned claim identities.");
      for (const value of invalidDrafts) await assert.rejects(exchange("assessment_draft", prompt, value), { code: "MODEL_OUTPUT_SCHEMA_INVALID" });
    });
    // Continue inspecting the other stages even when the subset regression is red.
    const draft = parseAssessmentDraft(normalized ?? prompt.responseSchema!.parse(wire), corpus);
    const apiWork = draft.cases[0].artifactWork[0];
    const handoverWork = draft.cases[0].artifactWork[1];
    const operationClaimId = "artifact-0-0-operation";
    assert.ok(apiWork.claimIds.includes(operationClaimId));
    const operationClaim = draft.claims.find((claim) => claim.claimId === operationClaimId)!;
    assert.equal(operationClaim.kind, "interpretation");
    assert.ok(operationClaim.dependsOnClaimIds.length > 0);
    assert.ok(operationClaim.dependsOnClaimIds.every((claimId) => {
      const factClaim = draft.claims.find((claim) => claim.claimId === claimId);
      return factClaim?.kind === "source_fact" && factClaim.sourceRefs.every((ref) => ref.caseId === first.caseId && ref.artifactId === firstArtifact.artifactId);
    }));
    assert.deepEqual(operationClaim.sourceRefs, apiWork.decision.historicalEvidence);
    assert.ok(apiWork.decision.checks.every((check) => check.sourceRefs.every((ref) => ref.caseId === first.caseId && ref.artifactId === firstArtifact.artifactId)));
    assert.ok(handoverWork.decision.checks.every((check) => check.sourceRefs.every((ref) => ref.caseId === first.caseId && ref.artifactId === first.artifacts[1].artifactId)));
    const reviewPrompt = assessmentReviewPrompt(request, corpus, draft);
    assert.ok(reviewPrompt.reviewTargets!.claimIds.includes(operationClaimId));
    const reviewWire = {
      requestConstraints: constraints,
      decisions: Object.fromEntries(reviewPrompt.reviewTargets!.artifacts!.map((item) => [`${item.caseId}/${item.artifactId}`, { disposition: item.disposition, role: "starting_point", verdict: "supported", reasons: [] }])),
      claimVerdicts: Object.fromEntries(reviewPrompt.reviewTargets!.claimIds.map((claimId) => [claimId, "supported"])),
    };
    const operationRejectedWire = structuredClone(reviewWire);
    operationRejectedWire.claimVerdicts[operationClaimId] = "unsupported";
    let review: AssessmentReview | undefined;
    await t.test("assessment_review", async () => {
      const missing = structuredClone(reviewWire); delete missing.claimVerdicts[draft.claims[0].claimId];
      const short = structuredClone(reviewWire); delete short.decisions[Object.keys(short.decisions)[0]];
      const long = structuredClone(reviewWire); long.decisions["foreign/artifact"] = Object.values(long.decisions)[0];
      const invalid = [missing, short, long, { ...reviewWire, claimVerdicts: { ...reviewWire.claimVerdicts, foreign: "supported" } }];
      review = (await exchange("assessment_review", reviewPrompt, reviewWire, inspect(reviewWire, invalid, [operationRejectedWire]))).output as AssessmentReview;
      for (const value of invalid) await assert.rejects(exchange("assessment_review", reviewPrompt, value), { code: "MODEL_OUTPUT_SCHEMA_INVALID" });
    });
    review ??= (await exchange("assessment_review", reviewPrompt, reviewWire)).output as AssessmentReview;
    const checked = buildCheckedAssessment(draft, validateSupportReview(draft.claims.filter((claim) => reviewPrompt.reviewTargets!.claimIds.includes(claim.claimId)), review), validateAssessmentDraft(draft, request, corpus), corpus, validateArtifactReview(draft, review), { request, constraints: review.requestConstraints });
    const reread = revalidateAssessment(checked, request, corpus);
    const canonicalApiReview = reread.artifactReviews.find((item) => item.artifactId === firstArtifact.artifactId)!;
    assert.ok(canonicalApiReview.decision.checks.every((check) => check.sourceRefs.every((ref) => ref.caseId === first.caseId && ref.artifactId === firstArtifact.artifactId)));
    const independentOperationReview = reviewSchema(reviewPrompt.reviewTargets!, request).parse(operationRejectedWire) as AssessmentReview;
    const rejectedOperation = buildCheckedAssessment(draft, validateSupportReview(draft.claims.filter((claim) => reviewPrompt.reviewTargets!.claimIds.includes(claim.claimId)), independentOperationReview), validateAssessmentDraft(draft, request, corpus), corpus, validateArtifactReview(draft, independentOperationReview), { request, constraints: independentOperationReview.requestConstraints });
    assert.equal(rejectedOperation.cases[0].artifactWork.find((work) => work.artifactId === firstArtifact.artifactId)?.disposition, null);
    const selected = first.artifacts.slice(0, 2).map((artifact) => ({ caseId: first.caseId, artifactId: artifact.artifactId, versionId: artifact.versions[0].versionId, passageIds: [artifact.versions[0].passages[0].passageId] }));
    const keys = selected.map((item) => `${item.caseId}/${item.artifactId}/${item.versionId}`);
    const briefWire = { items: Object.fromEntries(selected.map((item) => {
      const label = labels.get(item.passageIds[0])!;
      return [`${item.caseId}/${item.artifactId}/${item.versionId}`, {
        disposition: "adapt",
        recommendation: { text: "Validate client compatibility before adapting this recorded procedure.", sourceRefs: [label], requestQuotes: [spans[0].spanId] },
        claims: [
          { kind: "recommendation", text: "Confirm the request's time window before using the procedure.", sourceRefs: [label], requestQuotes: [spans[1].spanId] },
        ],
      }];
    })) };
    const briefPrompt = briefDraftPrompt(request, selected, corpus, checked);
    let brief: BriefDraft | undefined;
    await t.test("brief_draft", async () => {
      const empty = structuredClone(briefWire); empty.items[keys[0]].claims[0].sourceRefs = [];
      const foreign = structuredClone(briefWire); foreign.items[keys[0]].recommendation.sourceRefs = [foreignLabel];
      const missing = structuredClone(briefWire); delete missing.items[keys[0]];
      const bounds = [0, 17].map((count) => { const value = structuredClone(briefWire); value.items[keys[0]].recommendation.sourceRefs = Array(count).fill(ownLabel); return value; });
      const bounded = structuredClone(briefWire); bounded.items[keys[0]].recommendation.sourceRefs = Array(16).fill(ownLabel);
      const forbiddenDependencies = [
        (() => { const value = structuredClone(briefWire); Object.assign(value.items[keys[0]].recommendation, { dependsOnClaimIds: [] }); return value; })(),
        (() => { const value = structuredClone(briefWire); Object.assign(value.items[keys[0]].claims[0], { dependsOnClaimIds: [] }); return value; })(),
      ];
      const legacyGlobal = { ...briefWire, claims: [] };
      const legacyMembership = structuredClone(briefWire);
      Object.assign(legacyMembership.items[keys[0]], { dispositionClaimId: "model-id", claimIds: ["model-id"] });
      const oldFacts = structuredClone(briefWire);
      Object.assign(oldFacts.items[keys[0]].claims[0], { kind: "source_fact" });
      const invalid = [empty, foreign, missing, ...bounds, ...forbiddenDependencies, oldFacts, legacyGlobal, legacyMembership, { items: { ...briefWire.items, "foreign/artifact/version": briefWire.items[keys[0]] } }];
      brief = briefDraftSchema.parse((await exchange("brief_draft", briefPrompt, briefWire, inspect(briefWire, invalid, [bounded]))).output);
      for (const value of invalid) await assert.rejects(exchange("brief_draft", briefPrompt, value), { code: "MODEL_OUTPUT_SCHEMA_INVALID" });
    });
    assert.ok(brief);
    assert.equal(brief.adapt.length, 2);
    assert.equal(validateBriefDraft(brief, request, selected, corpus).size, 0);
    const briefReview = briefReviewPrompt(request, selected, corpus, checked, brief);
    const briefReviewWire = { constraintQuotes: Object.fromEntries(keys.map((key) => [key, spans.map((span) => span.spanId)])), claimVerdicts: Object.fromEntries(brief.claims.map((item) => [item.claimId, "supported"])) };
    await t.test("brief_review", async () => {
      const missing = structuredClone(briefReviewWire); delete missing.claimVerdicts[brief!.claims[0].claimId];
      const quote = structuredClone(briefReviewWire); quote.constraintQuotes[keys[0]] = ["unknown-span"];
      const overflow = structuredClone(briefReviewWire); overflow.constraintQuotes[keys[0]] = Array(65).fill(spans[0].spanId);
      const invalid = [missing, quote, overflow, { ...briefReviewWire, claimVerdicts: { ...briefReviewWire.claimVerdicts, "assessment-only": "supported" } }, { ...briefReviewWire, constraintQuotes: { ...briefReviewWire.constraintQuotes, foreign: [] } }];
      const result = (await exchange("brief_review", briefReview, briefReviewWire, inspect(briefReviewWire, invalid))).output;
      for (const value of invalid) await assert.rejects(exchange("brief_review", briefReview, value), { code: "MODEL_OUTPUT_SCHEMA_INVALID" });
      const reviewed = result as { claimReviews: { claimId: string; verdict: "supported" }[]; constraintReviews: { caseId: string; artifactId: string; versionId: string; requestQuotes: string[] }[] };
      const pack = buildCheckedBrief(brief!, validateSupportReview(brief!.claims, reviewed), new Set(), { request, constraintReviews: reviewed.constraintReviews, assessment: checked });
      assert.equal(pack.adapt.length, 2);
      assert.deepEqual(revalidateBrief(pack, request, corpus, checked), pack);
    });
    assert.deepEqual(revalidateAssessment(checked, request, corpus), checked);
    assert.equal(assessmentDraftSchema.safeParse(normalized ?? prompt.responseSchema!.parse(wire)).success, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
