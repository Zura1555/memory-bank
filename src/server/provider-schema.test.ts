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
import { validateSelections } from "./selections.ts";
import { isSourceHistoryQualification } from "./source-history.ts";
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
  const elmLimitRecord = corpus.manifest.cases.flatMap((item) => item.records)
    .find((record) => record.kind === "source_fact" && record.recordId === "elm-sandbox-limitations");
  assert.ok(elmLimitRecord?.kind === "source_fact");
  const fact = (label: string) => ({ kind: "source_fact", sourceRefs: [label], requestQuotes: [], dependsOnClaimIds: [] });
  type WireRequirement = { requestQuote: string; requirement: string; checkKind: string | null };
  type WireGroup = { adaptation: { text: string; sourceRefs: string[] } | null; requirements: WireRequirement[] };
  type WireChecks = Record<string, string[] | null>;
  const requirement = (quote: string, text: string, checkKind: string | null = null) => ({
    requestQuote: quote, requirement: text, checkKind,
  });
  const group = (label: string, text: string | null, requirements: WireRequirement[]): WireGroup => ({
    adaptation: text === null ? null : { text, sourceRefs: [label] }, requirements,
  });
  const checksFor = (operation: keyof typeof OPERATION_CHECKS, label: string, obligations: WireGroup[]): WireChecks => {
    const authoredRefsByKind: Record<string, string[]> = {};
    for (const item of obligations) for (const authored of item.requirements) {
      if (authored.checkKind !== null) (authoredRefsByKind[authored.checkKind] ??= []).push(label);
    }
    return Object.fromEntries(Object.keys(OPERATION_CHECKS[operation]).map((kind) => {
      const refs = [...new Set(authoredRefsByKind[kind] ?? [])];
      const requestDriven = kind === "client_operation_limits" || kind === "completion_feasibility";
      return [kind, requestDriven ? (refs.length ? refs : null) : [...new Set([label, ...refs])]];
    }));
  };
  const wire = {
    requestConstraints: constraints, clarifyingClaimIds: [],
    missingEvidenceRequests: [],
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
        const sourceHistoryPassageId = item.caseId === elmLimitRecord.caseId && artifact.artifactId === "batch-adapter-notes"
          ? elmLimitRecord.evidence[3].passageId
          : artifact.versions[0].passages[0].passageId;
        const label = labels.get(sourceHistoryPassageId)!;
        const operation = artifactIndex === 0 ? "api_adapter" : artifactIndex === 1 ? "recovery_handover" : "data_mapping";
        const quote = operation === "recovery_handover" ? spans[1].spanId : spans[0].spanId;
        const obligations = artifactIndex === 0
          ? [
            group(label, null, [requirement(spans[0].spanId, "within six hours")]),
            group(label, "Process 450 records while preserving the five-business-day access duration.", [
              requirement(spans[0].spanId, "450 records", "client_operation_limits"),
              requirement(spans[1].spanId, "five business days"),
            ]),
            group(label, "Preserve terminal status in a separate adaptation.", [
              requirement(spans[0].spanId, "terminal status"),
            ]),
          ]
          : [group(label, "Validate client compatibility before adapting this recorded procedure.", [
            requirement(quote, operation === "data_mapping" ? "450 records" : "five business days",
              operation === "data_mapping" ? "completion_feasibility" : null),
          ])];
        return [artifact.artifactId, {
          disposition: "adapt", operation, historicalEvidence: [label],
          obligations, checks: checksFor(operation, label, obligations),
        }];
      })),
    }])),
  };
  const unchangedDrafts = ["reuse", "verify"].map((disposition) => {
    const value = structuredClone(wire);
    const work = value.cases[first.caseId].artifactWork[firstArtifact.artifactId];
    work.disposition = disposition;
    work.obligations = [group(ownLabel, null, [requirement(spans[0].spanId, "within six hours")])];
    work.checks = disposition === "reuse" ? {} : checksFor("api_adapter", ownLabel, work.obligations);
    return value;
  });
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
    for (const [index, value] of invalid.entries()) assert.equal(validate(value), false, `Provider grammar must reject invalid draft ${index}.`);
  };
  try {
    const prompt = assessmentDraftPrompt(request, corpus);
    const gapDraft = { ...wire, missingEvidenceRequests: [{
      caseId: first.caseId, artifactId: firstArtifact.artifactId, text: "Provide current-tenant acceptance evidence; no implementation is offered.",
      sourceRefs: [ownLabel], requestQuotes: [spans[0].spanId],
    }] };
    type WireWork = {
      disposition: string | null; operation: string | null; historicalEvidence: string[];
      obligations: WireGroup[]; checks: WireChecks;
    };
    const alterFirstWork = (mutate: (work: WireWork) => void) => {
      const value = structuredClone(wire);
      mutate(value.cases[first.caseId].artifactWork[firstArtifact.artifactId] as WireWork);
      return value;
    };
    const wireWork = wire.cases[first.caseId].artifactWork[firstArtifact.artifactId] as WireWork;
    const requestTokens = [...new Set(request.match(/[\p{L}\p{N}]+/gu) ?? [])];
    const distinctRequirements = requestTokens.slice(0, 17).map((text) => {
      const span = spans.find((item) => item.text.includes(text))!;
      return requirement(span.spanId, text);
    });
    assert.equal(distinctRequirements.length, 17);
    const boundedEvidence = alterFirstWork((work) => { work.historicalEvidence = Array(16).fill(ownLabel); });
    const boundedAdaptations = alterFirstWork((work) => {
      const requirementTexts = ["450 records", "within six hours", "only after terminal status", "terminal status", "only after", "six hours", "records", "Verify"];
      work.obligations = requirementTexts.map((text) => group(ownLabel, `Apply ${text} as requested.`, [
        requirement(spans[0].spanId, text),
      ]));
      work.checks = checksFor("api_adapter", ownLabel, work.obligations);
    });
    const boundedChecks = alterFirstWork((work) => {
      work.checks.client_api_access = Array(16).fill(ownLabel);
    });
    const tooManyCheckRefs = alterFirstWork((work) => {
      work.checks.client_api_access = Array(17).fill(ownLabel);
    });
    const nullDisposition = alterFirstWork((work) => Object.assign(work, {
      disposition: null, operation: null, obligations: [], checks: {},
    }));
    const checkpointReplayMissing = structuredClone(wire);
    const missingRecoveryChecks = checkpointReplayMissing.cases[first.caseId].artifactWork[first.artifacts[1].artifactId].checks;
    assert.ok(Array.isArray(missingRecoveryChecks.witnessed_acceptance));
    delete missingRecoveryChecks.checkpoint_replay;
    const checkpointReplayNull = structuredClone(wire);
    const nullRecoveryChecks = checkpointReplayNull.cases[first.caseId].artifactWork[first.artifacts[1].artifactId].checks;
    assert.ok(Array.isArray(nullRecoveryChecks.witnessed_acceptance));
    nullRecoveryChecks.checkpoint_replay = null;
    const duplicateAcrossGroups = alterFirstWork((work) => {
      const changedGroup = work.obligations.find((item) => item.adaptation !== null)!;
      const requirement = structuredClone(changedGroup.requirements.find((item) => item.checkKind === null)!);
      work.obligations.push(group(ownLabel, null, [requirement]));
    });
    const allNullAdaptations = alterFirstWork((work) => {
      for (const group of work.obligations) group.adaptation = null;
    });
    const runtimeInvalidDrafts = [
      duplicateAcrossGroups,
      allNullAdaptations,
      alterFirstWork((work) => { work.checks.client_operation_limits = null; }),
      alterFirstWork((work) => { work.obligations[1]!.requirements[0]!.checkKind = null; }),
    ];
    const tooManyGroupRequirements = alterFirstWork((work) => {
      work.obligations = [group(ownLabel, `Apply ${distinctRequirements.map((item) => item.requirement).join(", ")}.`, distinctRequirements)];
      work.checks = checksFor("api_adapter", ownLabel, work.obligations);
    });
    const acceptedDrafts = [boundedEvidence, boundedAdaptations, boundedChecks, nullDisposition, ...unchangedDrafts];
    const invalidDrafts = [
      { ...gapDraft, missingEvidenceRequests: gapDraft.missingEvidenceRequests.map((item) => ({ ...item, sourceRefs: [foreignLabel] })) },
      { ...gapDraft, missingEvidenceRequests: gapDraft.missingEvidenceRequests.map((item) => ({ ...item, requestQuotes: [] })) },
      ...unchangedDrafts.map((draft) => {
        const value = structuredClone(draft);
        value.cases[first.caseId].artifactWork[firstArtifact.artifactId].obligations.push(structuredClone(wireWork.obligations[1]!));
        return value;
      }),
      alterFirstWork((work) => { work.disposition = "reuse"; work.checks = { ...wireWork.checks }; }),
      alterFirstWork((work) => {
        work.disposition = "reuse";
        work.checks = {};
        work.obligations = [group(ownLabel, null, [requirement(spans[0].spanId, "450 records", "client_operation_limits")])];
      }),
      alterFirstWork((work) => { work.disposition = "verify"; work.obligations = [wireWork.obligations[1]!]; }),
      alterFirstWork((work) => { work.obligations = []; }),
      ...[0, 17].map((count) => alterFirstWork((work) => { work.historicalEvidence = Array(count).fill(ownLabel); })),
      alterFirstWork((work) => { work.historicalEvidence = [foreignLabel]; }),
      alterFirstWork((work) => { delete (work as Partial<WireWork>).obligations; }),
      alterFirstWork((work) => { work.obligations = Array(17).fill(work.obligations[0]!); }),
      tooManyGroupRequirements,
      tooManyCheckRefs,
      alterFirstWork((work) => { delete work.checks.client_api_access; }),
      alterFirstWork((work) => { work.checks.client_api_access = null; }),
      alterFirstWork((work) => { work.checks.client_api_access = []; }),
      alterFirstWork((work) => { work.checks.client_api_access = [foreignLabel]; }),
      alterFirstWork((work) => { delete work.checks.client_operation_limits; }),
      alterFirstWork((work) => Object.assign(work, { checks: [] })),
      alterFirstWork((work) => Object.assign(work, { checks: { client_api_access: { sourceRefs: [ownLabel] } } })),
      ...[
        (work: WireWork) => { work.obligations[1]!.requirements[0]!.checkKind = "completion_feasibility"; },
        (work: WireWork) => { Object.assign(work.obligations[1]!.requirements[0]!, { checkSourceRefs: [] }); },
        (work: WireWork) => { Object.assign(work.obligations[1]!.requirements[0]!, { checkSourceRefs: [foreignLabel] }); },
        (work: WireWork) => { work.obligations[1]!.adaptation!.sourceRefs = [foreignLabel]; },
        (work: WireWork) => { work.obligations[1]!.adaptation!.sourceRefs = []; },
        (work: WireWork) => { work.obligations[1]!.requirements[0]!.requestQuote = "unknown-span"; },
        (work: WireWork) => { work.obligations[1]!.requirements[0]!.requirement = ""; },
        (work: WireWork) => { work.obligations[1]!.requirements[0]!.requirement = "x".repeat(501); },
        (work: WireWork) => { work.obligations[1]!.requirements = []; },
        (work: WireWork) => { Object.assign(work.obligations[0]!.requirements[0]!, { checkSourceRefs: [ownLabel] }); },
        (work: WireWork) => { work.operation = "not-an-operation"; },
        (work: WireWork) => { Object.assign(work, { operation: undefined }); },
        (work: WireWork) => { work.operation = null; },
        (work: WireWork) => { work.disposition = null; },
        (work: WireWork) => { Object.assign(work, { disposition: null, operation: null }); },
        (work: WireWork) => { Object.assign(work, { requestQuotes: [spans[0].spanId] }); },
        (work: WireWork) => { Object.assign(work, { adaptations: [wireWork.obligations[1]!.adaptation] }); },
        (work: WireWork) => { Object.assign(work.obligations[1]!.adaptation!, { obligations: [] }); },
        (work: WireWork) => { Object.assign(work.obligations[1]!.requirements[0]!, { requestQuotes: [spans[0].spanId] }); },
        (work: WireWork) => { Object.assign(work.obligations[1]!.requirements[0]!, { requiresAdaptation: true }); },
        (work: WireWork) => { Object.assign(work.obligations[1]!.requirements[0]!, { adaptationIndexes: ["0"] }); },
        (work: WireWork) => { Object.assign(work.obligations[1]!.requirements[0]!, { checkIndexes: ["0"] }); },
        (work: WireWork) => { Object.assign(work.checks, { text: "Provider-authored check text." }); },
        (work: WireWork) => { Object.assign(work.obligations[0]!, { requiresAdaptation: false }); },
        (work: WireWork) => { work.obligations = [{ requestQuote: spans[0].spanId, requirement: "450 records", checkKind: null, checkSourceRefs: [] } as unknown as WireGroup]; },
      ].map((mutate) => alterFirstWork(mutate)),
      (() => {
        const value = structuredClone(wire);
        const mappingWork = value.cases[first.caseId].artifactWork[first.artifacts[2].artifactId];
        mappingWork.checks.completion_feasibility = [foreignLabel];
        return value;
      })(),
      (() => { const value = structuredClone(wire); value.cases[first.caseId].reasons![0]!.sourceRefs = [ownLabel, ownLabel]; return value; })(),
      (() => { const value = structuredClone(wire); value.cases[first.caseId].comparisons![0]!.evidence.sourceRefs = [ownLabel, ownLabel]; return value; })(),
      (() => { const value = structuredClone(wire); value.claims[0]!.sourceRefs = [ownLabel, ownLabel]; return value; })(),
      (() => { const value = structuredClone(wire); value.requestConstraints.scale = ["unknown-span"]; return value; })(),
      (() => { const value = structuredClone(wire); delete value.cases[first.caseId]; return value; })(),
      { ...wire, invented: true },
    ];
    let normalized: unknown;
    await t.test("assessment_draft", async (stageTest) => {
      normalized = (await exchange("assessment_draft", prompt, wire, inspect(wire, [...invalidDrafts, checkpointReplayMissing, checkpointReplayNull], [
        gapDraft, ...acceptedDrafts, ...runtimeInvalidDrafts,
      ]))).output;
      for (const value of acceptedDrafts) await exchange("assessment_draft", prompt, value);
      for (const [index, value] of invalidDrafts.entries()) {
        await assert.rejects(exchange("assessment_draft", prompt, value), { code: "MODEL_OUTPUT_SCHEMA_INVALID" }, `Invalid draft ${index} must fail closed.`);
      }
      for (const value of runtimeInvalidDrafts) {
        await assert.rejects(exchange("assessment_draft", prompt, value), { code: "MODEL_OUTPUT_SCHEMA_INVALID" });
      }
      await stageTest.test("conditional handover rejects missing or null checkpoint replay despite witnessed acceptance", async () => {
        for (const value of [checkpointReplayMissing, checkpointReplayNull]) {
          await assert.rejects(exchange("assessment_draft", prompt, value), { code: "MODEL_OUTPUT_SCHEMA_INVALID" },
            "A conditional handover cannot proceed to review when checkpoint replay is absent.");
        }
      });
      await assert.rejects(exchange("assessment_draft", prompt, alterFirstWork((work) => {
        work.obligations[1]!.requirements[0]!.requirement = "a condition not stated in the request";
      })), { code: "MODEL_OUTPUT_SCHEMA_INVALID" });
      const adaptationRequirementTexts = ["450 records", "within six hours", "only after terminal status", "terminal status", "only after", "six hours", "records", "Verify", "status"];
      const withAdaptationCount = (count: number) => {
        const value = structuredClone(wire);
        const work = value.cases[first.caseId].artifactWork[firstArtifact.artifactId];
        work.obligations = adaptationRequirementTexts.slice(0, count).map((text) => group(ownLabel, `Apply ${text} as requested.`, [
          requirement(spans[0].spanId, text),
        ]));
        work.checks = checksFor("api_adapter", ownLabel, work.obligations);
        return value;
      };
      const eightAdaptations = withAdaptationCount(8);
      const nineAdaptations = withAdaptationCount(9);
      await exchange("assessment_draft", prompt, eightAdaptations, inspect(eightAdaptations, []));
      await assert.rejects(exchange("assessment_draft", prompt, nineAdaptations), { code: "MODEL_OUTPUT_SCHEMA_INVALID" });
      const extendedRequest = `${request} ${Array.from({ length: 7 }, (_, index) => `Extra requirement ${index}.`).join(" ")}`;
      const extendedSpans = requestSpans(extendedRequest);
      assert.equal(extendedSpans.length, 9);
      const requirementPairs = extendedSpans.map((_span, index) => index === 0
        ? ["450 records", "within six hours", "terminal status"]
        : index === 1
          ? ["five business days", "read-only access"]
          : [`Extra requirement ${index - 2}`, `requirement ${index - 2}`]);
      const withTotalRequirements = (count: number) => {
        const value = structuredClone(wire);
        const work = value.cases[first.caseId].artifactWork[firstArtifact.artifactId];
        let remaining = count;
        work.obligations = [];
        for (const [index, span] of extendedSpans.slice(0, 8).entries()) {
          if (remaining === 0) break;
          const texts = requirementPairs[index]!.slice(0, Math.min(remaining, requirementPairs[index]!.length));
          const requirements = texts.map((text) => requirement(span.spanId, text));
          work.obligations.push(group(ownLabel, index === 0 ? "Process 450 records within six hours, only after terminal status." : null, requirements));
          remaining -= texts.length;
        }
        assert.equal(remaining, 0);
        work.checks = checksFor("api_adapter", ownLabel, work.obligations);
        return value;
      };
      const sixteenRequirements = withTotalRequirements(16);
      const seventeenRequirements = withTotalRequirements(17);
      const extendedPrompt = assessmentDraftPrompt(extendedRequest, corpus);
      await exchange("assessment_draft", extendedPrompt, sixteenRequirements, inspect(sixteenRequirements, []));
      await assert.rejects(exchange("assessment_draft", extendedPrompt, seventeenRequirements), { code: "MODEL_OUTPUT_SCHEMA_INVALID" });
      const boundedDraft = parseAssessmentDraft(prompt.responseSchema!.parse(boundedEvidence), corpus);
      assert.equal(validateAssessmentDraft(boundedDraft, request, corpus).size, 0, "Repeated evidence labels must not create duplicate server-owned claim identities.");
    });
    // Continue inspecting the other stages even when the subset regression is red.
    const draft = parseAssessmentDraft(normalized ?? prompt.responseSchema!.parse(wire), corpus);
    const apiWork = draft.cases[0].artifactWork[0];
    const handoverWork = draft.cases[0].artifactWork[1];
    const apiDecision = apiWork.decision;
    assert.deepEqual(apiDecision.adaptations.map(({ requestQuotes }) => requestQuotes), [[spans[0].text, spans[1].text], [spans[0].text]]);
    assert.deepEqual(apiDecision.obligations.map(({ requestQuote, requirement, requiresAdaptation, adaptationClaimIds }) =>
      [requestQuote, requirement, requiresAdaptation, adaptationClaimIds]), [
      [spans[0].text, "within six hours", false, []],
      [spans[0].text, "450 records", true, ["artifact-0-0-adapt-0"]],
      [spans[1].text, "five business days", true, ["artifact-0-0-adapt-0"]],
      [spans[0].text, "terminal status", true, ["artifact-0-0-adapt-1"]],
    ]);
    const boundCheck = apiDecision.checks.find((check) => check.kind === "client_operation_limits");
    assert.ok(boundCheck);
    assert.deepEqual(boundCheck.requestQuotes, [spans[0].text]);
    assert.deepEqual(boundCheck.sourceRefs.map((ref) => ref.artifactId), [firstArtifact.artifactId]);
    const boundCheckClaimId = apiDecision.obligations[1].checkClaimIds[0]!;
    assert.ok(apiWork.verificationClaimIds.includes(boundCheckClaimId));
    assert.deepEqual(apiDecision.obligations.map(({ checkClaimIds }) => checkClaimIds), [
      [], [boundCheckClaimId], [], [],
    ]);
    const boundCheckClaim = draft.claims.find((claim) => claim.claimId === boundCheckClaimId)!;
    assert.equal(boundCheckClaim.kind, "recommendation");
    assert.equal(boundCheckClaim.text, boundCheck.text);
    assert.deepEqual(boundCheckClaim.sourceRefs, boundCheck.sourceRefs);
    assert.deepEqual(boundCheckClaim.requestQuotes, [spans[0].text]);
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
    assert.ok(reviewPrompt.reviewTargets!.artifacts![0].claimIds.history.includes(operationClaimId));
    const reviewWire: Record<string, any> = {
      requestConstraints: constraints,
      missingEvidenceReview: { verdict: "supported", reason: null },
      decisions: Object.fromEntries(reviewPrompt.reviewTargets!.artifacts!.map((item) => [`${item.caseId}/${item.artifactId}`, { disposition: item.disposition, role: "starting_point", verdict: "supported", reasons: [] }])),
      claimJudgments: Object.fromEntries(reviewPrompt.reviewTargets!.claimIds.map((claimId) => [claimId, { verdict: "supported", reason: null }])),
    };
    const operationRejectedWire = structuredClone(reviewWire);
    operationRejectedWire.claimJudgments[operationClaimId] = {
      verdict: "unsupported",
      reason: { explanation: "Synthetic historical interpretation is unsupported.", sourceRefs: [ownLabel], requestQuotes: [] },
    };
    const checkClaimId = boundCheckClaimId;
    const decisionKey = `${first.caseId}/${firstArtifact.artifactId}`;
    const checkRejectedWire = structuredClone(reviewWire);
    checkRejectedWire.claimJudgments[checkClaimId] = {
      verdict: "unsupported",
      reason: { explanation: "Synthetic prerequisite lacks independent support.", sourceRefs: [ownLabel], requestQuotes: [spans[0].spanId] },
    };
    let review: AssessmentReview | undefined;
    await t.test("assessment_review", async () => {
      const missing = structuredClone(reviewWire); delete missing.claimJudgments[draft.claims[0].claimId];
      const short = structuredClone(reviewWire); delete short.decisions[Object.keys(short.decisions)[0]];
      const long = structuredClone(reviewWire); long.decisions["foreign/artifact"] = Object.values(long.decisions)[0];
      const missingReason = structuredClone(checkRejectedWire);
      missingReason.claimJudgments[checkClaimId] = { verdict: "unsupported", reason: null };
      const unknownQuote = structuredClone(checkRejectedWire);
      unknownQuote.claimJudgments[checkClaimId].reason.requestQuotes = ["unknown-span"];
      const wrongCategory = structuredClone(reviewWire);
      wrongCategory.decisions[decisionKey].reasons = [{
        target: "check", claimId: checkClaimId, explanation: "Model-authored claim defect is forbidden.",
        sourceRefs: [ownLabel], requestQuotes: [spans[0].spanId],
      }];
      const supportedWithReason = structuredClone(reviewWire);
      supportedWithReason.claimJudgments[checkClaimId] = {
        verdict: "supported",
        reason: { explanation: "Supported finding with rejection reason.", sourceRefs: [ownLabel], requestQuotes: [] },
      };
      const foreign = structuredClone(reviewWire); foreign.claimJudgments.foreign = { verdict: "supported", reason: null };
      const missingAnswerReview = structuredClone(reviewWire); delete missingAnswerReview.missingEvidenceReview;
      const contradictoryAnswerReview = { ...reviewWire, missingEvidenceReview: { verdict: "supported", reason: {
        explanation: "A supported complete answer cannot own a negative reason.", sourceRefs: [ownLabel], requestQuotes: [],
      } } };
      const invalid = [missing, short, long, missingReason, unknownQuote, wrongCategory, supportedWithReason, foreign, missingAnswerReview, contradictoryAnswerReview];
      review = (await exchange("assessment_review", reviewPrompt, reviewWire, inspect(reviewWire, invalid, [operationRejectedWire, checkRejectedWire]))).output as AssessmentReview;
      for (const value of invalid) await assert.rejects(exchange("assessment_review", reviewPrompt, value), { code: "MODEL_OUTPUT_SCHEMA_INVALID" });
    });
    review ??= (await exchange("assessment_review", reviewPrompt, reviewWire)).output as AssessmentReview;
    const checked = buildCheckedAssessment(draft, validateSupportReview(draft.claims.filter((claim) => reviewPrompt.reviewTargets!.claimIds.includes(claim.claimId)), review), validateAssessmentDraft(draft, request, corpus), corpus, validateArtifactReview(draft, review), { request, constraints: review.requestConstraints, missingEvidenceReview: review.missingEvidenceReview });
    const reread = revalidateAssessment(checked, request, corpus);
    const qualifiedWork = draft.cases.find((item) => item.caseId === elmLimitRecord.caseId)!.artifactWork
      .find((work) => work.artifactId === "batch-adapter-notes")!;
    const changedObligation = qualifiedWork.decision.obligations.find((item) => item.requiresAdaptation)!;
    const obligationClaim = draft.claims.find((claim) => claim.claimId === changedObligation.claimId)!;
    const qualifierId = obligationClaim.dependsOnClaimIds.find((claimId) => claimId.startsWith("source-history-"))!;
    const qualifier = draft.claims.find((claim) => claim.claimId === qualifierId)!;
    assert.equal(isSourceHistoryQualification(corpus, qualifier), true);
    const persistedObligation = reread.claims.find((claim) => claim.claimId === obligationClaim.claimId)!;
    assert.ok(persistedObligation.dependsOnClaimIds.includes(qualifierId));
    assert.equal(reread.artifactReviews.find((item) => item.artifactId === "batch-adapter-notes")!
      .claimFindings.find((finding) => finding.claimId === obligationClaim.claimId)!.verdict, "supported");
    assert.ok(obligationClaim.dependsOnClaimIds.includes(qualifiedWork.dispositionClaimId));
    assert.ok(obligationClaim.dependsOnClaimIds.some((claimId) => qualifiedWork.claimIds
      .some((ownClaimId) => ownClaimId === claimId && ownClaimId.includes("-adapt-"))));
    const qualifiedSelection = [{
      caseId: elmLimitRecord.caseId,
      artifactId: "batch-adapter-notes",
      versionId: elmLimitRecord.evidence[3].versionId,
      passageIds: [elmLimitRecord.evidence[3].passageId],
    }];
    assert.deepEqual(validateSelections(qualifiedSelection, reread, corpus), qualifiedSelection,
      "A valid source-history qualifier may remain an extra dependency of obligation coverage through reread and selection.");
    const canonicalApiReview = reread.artifactReviews.find((item) => item.artifactId === firstArtifact.artifactId)!;
    assert.ok(canonicalApiReview.decision.checks.every((check) => check.sourceRefs.every((ref) => ref.caseId === first.caseId && ref.artifactId === firstArtifact.artifactId)));
    const independentOperationReview = reviewSchema(reviewPrompt.reviewTargets!, request).parse(operationRejectedWire) as AssessmentReview;
    const rejectedOperation = buildCheckedAssessment(draft, validateSupportReview(draft.claims.filter((claim) => reviewPrompt.reviewTargets!.claimIds.includes(claim.claimId)), independentOperationReview), validateAssessmentDraft(draft, request, corpus), corpus, validateArtifactReview(draft, independentOperationReview), { request, constraints: independentOperationReview.requestConstraints, missingEvidenceReview: independentOperationReview.missingEvidenceReview });
    assert.equal(rejectedOperation.cases[0].artifactWork.find((work) => work.artifactId === firstArtifact.artifactId)?.disposition, null);
    const selected = first.artifacts.slice(0, 2).map((artifact) => ({ caseId: first.caseId, artifactId: artifact.artifactId, versionId: artifact.versions[0].versionId, passageIds: [artifact.versions[0].passages[0].passageId] }));
    assert.deepEqual(validateSelections(selected, reread, corpus), selected,
      "The provider-normalized multi-span adaptation remains selectable after independent review and reread.");
    const keys = selected.map((item) => `${item.caseId}/${item.artifactId}/${item.versionId}`);
    const briefWire = { items: Object.fromEntries(selected.map((item) => {
      const label = labels.get(item.passageIds[0])!;
      return [`${item.caseId}/${item.artifactId}/${item.versionId}`, {
        disposition: "adapt",
        recommendation: { text: "Validate client compatibility before adapting this recorded procedure.", sourceRefs: [label] },
        requestRecommendations: Object.fromEntries(spans.map((span) => [
          span.spanId, { text: "Confirm the request before using this procedure.", sourceRefs: [label] },
        ])),
        claims: [{ text: "The selected source records an adapter workflow.", sourceRefs: [label] }],
      }];
    })) };
    const briefPrompt = briefDraftPrompt(request, selected, corpus, checked);
    let brief: BriefDraft | undefined;
    await t.test("brief_draft", async () => {
      const empty = structuredClone(briefWire);
      empty.items[keys[0]].requestRecommendations[spans[0].spanId].sourceRefs = [];
      const foreign = structuredClone(briefWire);
      foreign.items[keys[0]].requestRecommendations[spans[0].spanId].sourceRefs = [foreignLabel];
      const missing = structuredClone(briefWire); delete missing.items[keys[0]];
      const bounds = [0, 17].map((count) => {
        const value = structuredClone(briefWire);
        value.items[keys[0]].recommendation.sourceRefs = Array(count).fill(ownLabel);
        return value;
      });
      const bounded = structuredClone(briefWire);
      bounded.items[keys[0]].recommendation.sourceRefs = Array(16).fill(ownLabel);
      const unknownRequestKey = structuredClone(briefWire);
      Object.assign(unknownRequestKey.items[keys[0]].requestRecommendations, { "unknown-span": null });
      const missingRequiredRecommendations = spans.slice(0, 2).map((span) => {
        const value = structuredClone(briefWire);
        delete value.items[keys[0]].requestRecommendations[span.spanId];
        return value;
      });
      const nullRequiredRecommendations = spans.slice(0, 2).map((span) => {
        const value = structuredClone(briefWire);
        Object.assign(value.items[keys[0]].requestRecommendations, { [span.spanId]: null });
        return value;
      });
      const forbiddenDependencies = [
        (() => { const value = structuredClone(briefWire); Object.assign(value.items[keys[0]].recommendation, { dependsOnClaimIds: [] }); return value; })(),
        (() => { const value = structuredClone(briefWire); Object.assign(value.items[keys[0]].claims[0], { dependsOnClaimIds: [] }); return value; })(),
        (() => {
          const value = structuredClone(briefWire);
          Object.assign(value.items[keys[0]].requestRecommendations[spans[0].spanId], { dependsOnClaimIds: [] });
          return value;
        })(),
      ];
      const oldRequestQuotes = [
        (() => { const value = structuredClone(briefWire); Object.assign(value.items[keys[0]].recommendation, { requestQuotes: [spans[0].spanId] }); return value; })(),
        (() => { const value = structuredClone(briefWire); Object.assign(value.items[keys[0]].claims[0], { requestQuotes: [spans[0].spanId] }); return value; })(),
        (() => {
          const value = structuredClone(briefWire);
          Object.assign(value.items[keys[0]].requestRecommendations[spans[0].spanId], { requestQuotes: [spans[0].spanId] });
          return value;
        })(),
      ];
      const wrongKind = structuredClone(briefWire);
      Object.assign(wrongKind.items[keys[0]].claims[0], { kind: "recommendation" });
      const legacyGlobal = { ...briefWire, claims: [] };
      const legacyMembership = structuredClone(briefWire);
      Object.assign(legacyMembership.items[keys[0]], { dispositionClaimId: "model-id", claimIds: ["model-id"] });
      const foreignItem = structuredClone(briefWire);
      Object.assign(foreignItem.items, { "foreign/artifact/version": foreignItem.items[keys[0]] });
      const invalid = [
        empty, foreign, missing, ...bounds, unknownRequestKey, ...missingRequiredRecommendations,
        ...nullRequiredRecommendations, ...forbiddenDependencies, ...oldRequestQuotes,
        wrongKind, legacyGlobal, legacyMembership, foreignItem,
      ];
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
