import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import type { Selection } from "../shared/protocol.ts";

export const EXPOSED_REQUEST_ORDER = ["g2", "g3", "g4"] as const;
type ExposedRequestId = typeof EXPOSED_REQUEST_ORDER[number];
type JsonPrimitive = string | number | boolean | null;

export interface Criterion {
  criterionId: string;
  expected: JsonPrimitive | JsonPrimitive[];
}

export interface ExpectedEvidence {
  caseId: string;
  artifactId: string;
  versionId: string;
  lineStart: number;
  lineEnd: number;
  sourceExpectation: string;
}

export interface CampaignCase {
  requestId: ExposedRequestId;
  request: string;
  selections: Selection[];
  expectedEvidence: ExpectedEvidence[];
  criteria: Criterion[];
}

export interface FixedCampaign {
  protocolVersion: "issue32-exposed-g-v1";
  requestOrder: ExposedRequestId[];
  selectionSource: "humanSelectionExpectations.selections";
  cases: CampaignCase[];
}

export interface RuntimeProfile {
  profileId: string;
  provider: string;
  model: string;
  api: string;
  origin: string;
  serviceTier: string;
  maxTokens: number;
  stream: boolean;
  reasoning: { effort: string };
  routing: { only: string[]; order: string[]; allowFallbacks: boolean; requireParameters: boolean };
}

export interface CandidateBinding {
  candidateId: string;
  sourceInventorySha256: string;
  corpusManifestSha256: string;
  corpusCatalogSha256: string;
  modelProfileSha256: string;
  campaignFreezeSha256: string;
}

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const selectionSchema = z.strictObject({
  caseId: z.string().min(1),
  artifactId: z.string().min(1),
  versionId: z.string().min(1),
  passageIds: z.array(z.string().min(1)).min(1).refine((ids) => new Set(ids).size === ids.length),
});
const expectedConditionalWorkSchema = z.strictObject({
  caseId: z.string().min(1),
  artifactId: z.string().min(1),
  versionId: z.string().min(1),
  disposition: z.string().min(1),
  reason: z.string().min(1),
});
const expectedEvidenceSchema = z.strictObject({
  caseId: z.string().min(1),
  artifactId: z.string().min(1),
  versionId: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  sourceExpectation: z.string().min(1),
});
const exposedKeySchema = z.strictObject({
  requestId: z.enum(EXPOSED_REQUEST_ORDER),
  request: z.string().min(1),
  expectedConclusion: z.string().min(1),
  expectedConditionalWork: z.array(expectedConditionalWorkSchema),
  expectedEvidence: z.array(expectedEvidenceSchema),
  decisiveValuesAndUncertainty: z.array(z.string().min(1)),
  acceptableUncertainty: z.array(z.string().min(1)),
  prohibitedRecommendations: z.array(z.string().min(1)),
  usefulImplementationSources: z.array(z.unknown()).optional(),
  humanSelectionExpectations: z.strictObject({
    actualSelectionRequired: z.boolean(),
    substitutionAllowed: z.boolean(),
    selections: z.array(selectionSchema),
    briefExpectation: z.string().min(1),
  }),
});
const fixedInputSchema = z.strictObject({
  protocolVersion: z.literal("issue32-exposed-g-v1"),
  requestOrder: z.array(z.enum(EXPOSED_REQUEST_ORDER)),
  requests: z.array(exposedKeySchema),
});
const requestSchema = z.strictObject({ requestId: z.enum(EXPOSED_REQUEST_ORDER), request: z.string() });
const criterionSchema = z.strictObject({
  criterionId: z.string().min(1),
  expected: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))]),
});
const fixedCampaignSchema = z.strictObject({
  protocolVersion: z.literal("issue32-exposed-g-v1"),
  requestOrder: z.array(z.enum(EXPOSED_REQUEST_ORDER)),
  selectionSource: z.literal("humanSelectionExpectations.selections"),
  cases: z.array(z.strictObject({
    requestId: z.enum(EXPOSED_REQUEST_ORDER),
    request: z.string().min(1),
    selections: z.array(selectionSchema),
    expectedEvidence: z.array(expectedEvidenceSchema),
    criteria: z.array(criterionSchema).min(1),
  })),
});
export const runtimeProfileSchema = z.strictObject({
  profileId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  api: z.string().min(1),
  origin: z.string().url(),
  serviceTier: z.string().min(1),
  maxTokens: z.number().int().positive(),
  stream: z.boolean(),
  reasoning: z.strictObject({ effort: z.string().min(1) }),
  routing: z.strictObject({
    only: z.array(z.string().min(1)).min(1),
    order: z.array(z.string().min(1)).min(1),
    allowFallbacks: z.boolean(),
    requireParameters: z.boolean(),
  }),
});
const candidateBindingSchema = z.strictObject({
  candidateId: z.string().min(1),
  sourceInventorySha256: hashSchema,
  corpusManifestSha256: hashSchema,
  corpusCatalogSha256: hashSchema,
  modelProfileSha256: hashSchema,
  campaignFreezeSha256: hashSchema,
});
const assessmentStateSchema = z.enum(["ready", "failed"]);
const briefStateSchema = z.enum(["ready", "failed", "not_started"]);
const resultObjectSchema = z.record(z.string(), z.unknown());
const runCaptureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: z.enum(EXPOSED_REQUEST_ORDER),
  campaignFreezeSha256: hashSchema,
  candidateId: z.string().min(1),
  sourceInventorySha256: hashSchema,
  corpusManifestSha256: hashSchema,
  corpusCatalogSha256: hashSchema,
  modelProfileSha256: hashSchema,
  assessmentState: assessmentStateSchema,
  assessmentResult: resultObjectSchema.nullable(),
  briefState: briefStateSchema,
  briefResult: resultObjectSchema.nullable(),
  selectionSource: z.enum(["persisted-job-record", "no-brief-submitted"]),
  selections: z.array(selectionSchema),
});
const criterionGradeSchema = z.strictObject({
  criterionId: z.string().min(1),
  verdict: z.enum(["pass", "fail", "uncertain"]),
  rationale: z.string().trim().min(1),
});
const graderSubmissionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  campaignFreezeSha256: hashSchema,
  candidate: z.strictObject({
    candidateId: z.string().min(1),
    sourceInventorySha256: hashSchema,
    corpusManifestSha256: hashSchema,
    corpusCatalogSha256: hashSchema,
    modelProfileSha256: hashSchema,
  }),
  graderIdentity: z.strictObject({
    reviewerId: z.string().trim().min(1),
    role: z.literal("independent-grader"),
    reviewedAt: z.string().min(1),
    independenceAttested: z.literal(true),
  }),
  requestOrder: z.array(z.string()),
  cases: z.array(z.strictObject({
    requestId: z.string().min(1),
    grades: z.array(criterionGradeSchema),
  })),
});
const passReceiptSchema = z.strictObject({
  requestOrder: z.array(z.string()),
  passed: z.boolean(),
  captureSha256: hashSchema,
  campaignFreezeSha256: hashSchema,
  candidateId: z.string().min(1),
  sourceInventorySha256: hashSchema,
  corpusManifestSha256: hashSchema,
  corpusCatalogSha256: hashSchema,
  modelProfileSha256: hashSchema,
});
const separateAuthorizationSchema = z.strictObject({
  authorizationId: z.string().trim().min(1),
  authorizedBy: z.string().trim().min(1),
  authorizedAt: z.string().min(1),
  scope: z.literal("h-one-shot"),
  exposedPassSha256: hashSchema,
  campaignFreezeSha256: hashSchema,
  candidateId: z.string().min(1),
  sourceInventorySha256: hashSchema,
  corpusManifestSha256: hashSchema,
  corpusCatalogSha256: hashSchema,
  modelProfileSha256: hashSchema,
});

export type CriterionVerdict = "pass" | "fail" | "uncertain";
export type CampaignRunCapture = z.infer<typeof runCaptureSchema>;
type RunCaptureData = CampaignRunCapture;
type GradeSubmission = z.infer<typeof graderSubmissionSchema>;
type CriterionGrade = z.infer<typeof criterionGradeSchema>;
const verifiedRunCaptureBrand: unique symbol = Symbol("verified-run-capture");
export type VerifiedRunCapture = RunCaptureData & { captureSha256: string; runReady: boolean; [verifiedRunCaptureBrand]: true };
export type GraderSubmission = GradeSubmission;
export type PassReceipt = z.infer<typeof passReceiptSchema>;
export type SeparateHAuthorization = z.infer<typeof separateAuthorizationSchema>;

export interface CaseGradeResult {
  requestId: string;
  runCaptureSha256: string | null;
  selectionCheck: "pass" | "fail";
  runReady: boolean;
  criteria: {
    criterionId: string;
    expected: Criterion["expected"];
    verdict: CriterionVerdict | "missing" | "malformed";
    rationale?: string;
  }[];
  errors: string[];
  passed: boolean;
}

export interface CampaignGradeResult {
  protocolVersion: FixedCampaign["protocolVersion"];
  requestOrder: ExposedRequestId[];
  candidateBinding: CandidateBinding;
  gradeCaptureSha256: string;
  graderIdentity: GradeSubmission["graderIdentity"] | null;
  cases: CaseGradeResult[];
  errors: string[];
  passed: boolean;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalSelections(value: unknown): string | null {
  const parsed = z.array(selectionSchema).safeParse(value);
  if (!parsed.success) return null;
  const identities: string[] = [];
  const seen = new Set<string>();
  for (const selection of parsed.data) {
    const identity = JSON.stringify([selection.caseId, selection.artifactId, selection.versionId]);
    if (seen.has(identity)) return null;
    seen.add(identity);
    identities.push(JSON.stringify([selection.caseId, selection.artifactId, selection.versionId, [...selection.passageIds].sort()]));
  }
  return JSON.stringify(identities.sort());
}

export function selectionsMatch(expected: unknown, actual: unknown): boolean {
  const left = canonicalSelections(expected);
  return left !== null && left === canonicalSelections(actual);
}

function addArrayCriteria<T extends object>(criteria: Criterion[], base: string, values: T[], fields: (keyof T)[]): void {
  if (values.length === 0) {
    criteria.push({ criterionId: base, expected: [] });
    return;
  }
  values.forEach((entry, index) => {
    for (const field of fields) {
      const value = entry[field];
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error(`INVALID_CRITERION:${base}[${index}].${String(field)}`);
      }
      criteria.push({ criterionId: `${base}[${index}].${String(field)}`, expected: value });
    }
  });
}

export function parseRuntimeProfile(value: unknown): RuntimeProfile {
  return runtimeProfileSchema.parse(value);
}

export function parseFixedCampaign(value: unknown): FixedCampaign {
  const campaign = fixedCampaignSchema.parse(value);
  if (JSON.stringify(campaign.requestOrder) !== JSON.stringify(EXPOSED_REQUEST_ORDER)
    || JSON.stringify(campaign.cases.map((item) => item.requestId)) !== JSON.stringify(EXPOSED_REQUEST_ORDER)) {
    throw new Error("INVALID_FIXED_CAMPAIGN_ORDER");
  }
  for (const item of campaign.cases) {
    if (new Set(item.criteria.map((criterion) => criterion.criterionId)).size !== item.criteria.length
      || !selectionsMatch(item.selections, item.selections)) throw new Error(`INVALID_FIXED_CAMPAIGN_CASE:${item.requestId}`);
  }
  return campaign;
}

export function buildExposedCampaign(protocol: unknown, requests: unknown): FixedCampaign {
  const parsedProtocol = fixedInputSchema.safeParse(protocol);
  const parsedRequests = z.array(requestSchema).safeParse(requests);
  if (!parsedProtocol.success || !parsedRequests.success
    || JSON.stringify(parsedProtocol.data.requestOrder) !== JSON.stringify(EXPOSED_REQUEST_ORDER)
    || JSON.stringify(parsedRequests.data.map((item) => item.requestId)) !== JSON.stringify(EXPOSED_REQUEST_ORDER)) {
    throw new Error("INVALID_CAMPAIGN_INPUT_OR_ORDER");
  }
  const keysById = new Map<ExposedRequestId, z.infer<typeof exposedKeySchema>>();
  for (const key of parsedProtocol.data.requests) {
    if (keysById.has(key.requestId)) throw new Error(`DUPLICATE_KEY:${key.requestId}`);
    keysById.set(key.requestId, key);
  }
  const requestsById = new Map(parsedRequests.data.map((request) => [request.requestId, request]));
  const campaignCases: CampaignCase[] = [];
  for (const requestId of EXPOSED_REQUEST_ORDER) {
    const key = keysById.get(requestId);
    const requestInput = requestsById.get(requestId);
    if (!key || !requestInput || key.request !== requestInput.request) throw new Error(`MISSING_OR_MISMATCHED_REQUEST:${requestId}`);
    if (requestId === "g4" && key.usefulImplementationSources === undefined) throw new Error("MISSING_USEFUL_SOURCE_CRITERION:g4");
    if (key.usefulImplementationSources?.length) throw new Error(`UNSUPPORTED_IMPLEMENTATION_SOURCE_CRITERION:${requestId}`);
    const expectations = key.humanSelectionExpectations;
    if (expectations.actualSelectionRequired !== (expectations.selections.length > 0) || expectations.substitutionAllowed) {
      throw new Error(`INVALID_SELECTION_EXPECTATION:${requestId}`);
    }
    const selections = expectations.selections.map((selection) => ({ ...selection, passageIds: [...selection.passageIds] }));
    const selectionIds = selections.map((selection) => JSON.stringify([selection.caseId, selection.artifactId, selection.versionId])).sort();
    if (new Set(selectionIds).size !== selectionIds.length) throw new Error(`DUPLICATE_FIXED_SELECTION:${requestId}`);
    const workIds = key.expectedConditionalWork.map((work) => JSON.stringify([work.caseId, work.artifactId, work.versionId])).sort();
    if (JSON.stringify(selectionIds) !== JSON.stringify(workIds)) throw new Error(`SELECTION_WORK_MISMATCH:${requestId}`);

    const criteria: Criterion[] = [{ criterionId: "expectedConclusion", expected: key.expectedConclusion }];
    addArrayCriteria(criteria, "expectedConditionalWork", key.expectedConditionalWork, ["caseId", "artifactId", "versionId", "disposition", "reason"]);
    addArrayCriteria(criteria, "expectedEvidence", key.expectedEvidence, ["caseId", "artifactId", "versionId", "lineStart", "lineEnd", "sourceExpectation"]);
    for (const [name, values] of [
      ["decisiveValuesAndUncertainty", key.decisiveValuesAndUncertainty],
      ["acceptableUncertainty", key.acceptableUncertainty],
      ["prohibitedRecommendations", key.prohibitedRecommendations],
    ] as const) {
      if (values.length === 0) criteria.push({ criterionId: name, expected: [] });
      else values.forEach((expected, index) => criteria.push({ criterionId: `${name}[${index}]`, expected }));
    }
    if (key.usefulImplementationSources !== undefined) criteria.push({ criterionId: "usefulImplementationSources", expected: [] });
    criteria.push(
      { criterionId: "humanSelectionExpectations.actualSelectionRequired", expected: expectations.actualSelectionRequired },
      { criterionId: "humanSelectionExpectations.substitutionAllowed", expected: expectations.substitutionAllowed },
      { criterionId: "humanSelectionExpectations.briefExpectation", expected: expectations.briefExpectation },
    );
    if (new Set(criteria.map((criterion) => criterion.criterionId)).size !== criteria.length) throw new Error(`DUPLICATE_CRITERION:${requestId}`);
    campaignCases.push({ requestId, request: key.request, selections, expectedEvidence: key.expectedEvidence, criteria });
  }
  return parseFixedCampaign({
    protocolVersion: "issue32-exposed-g-v1",
    requestOrder: [...EXPOSED_REQUEST_ORDER],
    selectionSource: "humanSelectionExpectations.selections",
    cases: campaignCases,
  });
}


export function verifyRunCapture(value: unknown, captureSha256: string, campaign: FixedCampaign, binding: CandidateBinding): VerifiedRunCapture {
  const parsed = runCaptureSchema.parse(value);
  if (!hashSchema.safeParse(captureSha256).success || parsed.campaignFreezeSha256 !== binding.campaignFreezeSha256
    || parsed.candidateId !== binding.candidateId || parsed.sourceInventorySha256 !== binding.sourceInventorySha256
    || parsed.corpusManifestSha256 !== binding.corpusManifestSha256 || parsed.corpusCatalogSha256 !== binding.corpusCatalogSha256
    || parsed.modelProfileSha256 !== binding.modelProfileSha256 || !campaign.requestOrder.includes(parsed.requestId)) {
    throw new Error(`RUN_CAPTURE_PROVENANCE_MISMATCH:${parsed.requestId}`);
  }
  const isNoBriefCase = parsed.requestId === "g4";
  if ((isNoBriefCase && (parsed.briefState !== "not_started" || parsed.briefResult !== null || parsed.selections.length !== 0 || parsed.selectionSource !== "no-brief-submitted"))
    || (!isNoBriefCase && parsed.selectionSource !== "persisted-job-record")
    || (parsed.assessmentState === "ready") !== (parsed.assessmentResult !== null)
    || (parsed.briefState === "ready") !== (parsed.briefResult !== null)
    || (parsed.briefState === "not_started" && parsed.briefResult !== null)) {
    throw new Error(`RUN_CAPTURE_STATE_MISMATCH:${parsed.requestId}`);
  }
  const runReady = isNoBriefCase
    ? parsed.assessmentState === "ready" && parsed.assessmentResult !== null
    : parsed.assessmentState === "ready" && parsed.assessmentResult !== null && parsed.briefState === "ready" && parsed.briefResult !== null;
  return { ...parsed, captureSha256, runReady, [verifiedRunCaptureBrand]: true };
}

function sameGradeCandidate(submission: GradeSubmission, capture: VerifiedRunCapture): boolean {
  return submission.campaignFreezeSha256 === capture.campaignFreezeSha256
    && submission.candidate.candidateId === capture.candidateId
    && submission.candidate.sourceInventorySha256 === capture.sourceInventorySha256
    && submission.candidate.corpusManifestSha256 === capture.corpusManifestSha256
    && submission.candidate.corpusCatalogSha256 === capture.corpusCatalogSha256
    && submission.candidate.modelProfileSha256 === capture.modelProfileSha256;
}

export function gradeCampaign(campaign: FixedCampaign, captures: VerifiedRunCapture[], input: unknown, gradeCaptureSha256: string): CampaignGradeResult {
  const parsedInput = graderSubmissionSchema.safeParse(input);
  const errors: string[] = [];
  if (!hashSchema.safeParse(gradeCaptureSha256).success) errors.push("MISSING_GRADE_CAPTURE_HASH");
  if (!parsedInput.success) errors.push("MALFORMED_OR_UNIDENTIFIED_GRADES");
  const submission = parsedInput.success ? parsedInput.data : null;
  const rows = submission?.cases ?? [];
  const gradeOrderValid = JSON.stringify(submission?.requestOrder ?? []) === JSON.stringify(campaign.requestOrder)
    && JSON.stringify(rows.map((row) => row.requestId)) === JSON.stringify(campaign.requestOrder);
  if (!gradeOrderValid) errors.push("GRADE_ORDER_MISMATCH");
  const captureOrderValid = JSON.stringify(captures.map((item) => item.requestId)) === JSON.stringify(campaign.requestOrder);
  if (!captureOrderValid) errors.push("RUN_CAPTURE_ORDER_MISMATCH");
  if (captures.length !== campaign.cases.length) errors.push("RUN_CAPTURE_COUNT_MISMATCH");
  const capturesById = new Map<string, VerifiedRunCapture[]>();
  for (const capture of captures) {
    const found = capturesById.get(capture.requestId) ?? [];
    found.push(capture);
    capturesById.set(capture.requestId, found);
  }
  const graderBindingValid = submission !== null && captures.length === campaign.cases.length
    && captures.every((capture) => sameGradeCandidate(submission, capture));
  if (submission && !graderBindingValid) errors.push("GRADE_CAPTURE_PROVENANCE_MISMATCH");

  const caseResults = campaign.cases.map((expectedCase) => {
    const caseErrors: string[] = [];
    const runMatches = capturesById.get(expectedCase.requestId) ?? [];
    const run = runMatches.length === 1 ? runMatches[0] : undefined;
    if (runMatches.length !== 1) caseErrors.push(runMatches.length === 0 ? "MISSING_RUN_CAPTURE" : "DUPLICATE_RUN_CAPTURE");
    if (run && !run.runReady) caseErrors.push("RUN_NOT_COMPLETE");
    if (!captureOrderValid) caseErrors.push("RUN_CAPTURE_ORDER_MISMATCH");
    const selectionCheck: CaseGradeResult["selectionCheck"] = run && selectionsMatch(expectedCase.selections, run.selections) ? "pass" : "fail";
    if (selectionCheck === "fail") caseErrors.push("SELECTION_IDENTITY_MISMATCH");
    if (!gradeOrderValid) caseErrors.push("GRADE_ORDER_MISMATCH");
    if (!graderBindingValid) caseErrors.push("GRADE_CAPTURE_PROVENANCE_MISMATCH");
    if (!parsedInput.success) caseErrors.push("MALFORMED_OR_UNIDENTIFIED_GRADES");
    const gradeRows = submission?.cases.filter((row) => row.requestId === expectedCase.requestId) ?? [];
    if (gradeRows.length !== 1) caseErrors.push(gradeRows.length === 0 ? "MISSING_CASE_GRADE" : "DUPLICATE_CASE_GRADE");
    const gradeRow = gradeRows.length === 1 ? gradeRows[0] : undefined;
    const byCriterionId = new Map<string, CriterionGrade[]>();
    for (const grade of gradeRow?.grades ?? []) {
      const found = byCriterionId.get(grade.criterionId) ?? [];
      found.push(grade);
      byCriterionId.set(grade.criterionId, found);
    }
    const expectedIds = new Set(expectedCase.criteria.map((criterion) => criterion.criterionId));
    if ([...byCriterionId.keys()].some((id) => !expectedIds.has(id))) caseErrors.push("UNEXPECTED_CRITERION_GRADE");
    const criteria = expectedCase.criteria.map((criterion) => {
      const matches = byCriterionId.get(criterion.criterionId) ?? [];
      if (!parsedInput.success) return { criterionId: criterion.criterionId, expected: criterion.expected, verdict: "malformed" as const };
      if (matches.length === 0) return { criterionId: criterion.criterionId, expected: criterion.expected, verdict: "missing" as const };
      if (matches.length !== 1) return { criterionId: criterion.criterionId, expected: criterion.expected, verdict: "malformed" as const };
      return { criterionId: criterion.criterionId, expected: criterion.expected, verdict: matches[0].verdict, rationale: matches[0].rationale };
    });
    if (criteria.some((criterion) => criterion.verdict !== "pass")) caseErrors.push("CRITERION_NOT_PASSED");
    const passed = caseErrors.length === 0 && run?.runReady === true && selectionCheck === "pass"
      && criteria.every((criterion) => criterion.verdict === "pass");
    return {
      requestId: expectedCase.requestId,
      runCaptureSha256: run?.captureSha256 ?? null,
      selectionCheck,
      runReady: run?.runReady ?? false,
      criteria,
      errors: caseErrors,
      passed,
    };
  });
  const candidateBinding: CandidateBinding = submission && captures[0] ? {
    candidateId: captures[0].candidateId,
    sourceInventorySha256: captures[0].sourceInventorySha256,
    corpusManifestSha256: captures[0].corpusManifestSha256,
    corpusCatalogSha256: captures[0].corpusCatalogSha256,
    modelProfileSha256: captures[0].modelProfileSha256,
    campaignFreezeSha256: captures[0].campaignFreezeSha256,
  } : {
    candidateId: "unbound", sourceInventorySha256: "0".repeat(64), corpusManifestSha256: "0".repeat(64),
    corpusCatalogSha256: "0".repeat(64), modelProfileSha256: "0".repeat(64), campaignFreezeSha256: "0".repeat(64),
  };
  const passed = errors.length === 0 && caseResults.length === campaign.cases.length && caseResults.every((item) => item.passed);
  return {
    protocolVersion: campaign.protocolVersion,
    requestOrder: [...campaign.requestOrder],
    candidateBinding,
    gradeCaptureSha256,
    graderIdentity: submission?.graderIdentity ?? null,
    cases: caseResults,
    errors,
    passed,
  };
}

export function deriveHGate(pass: PassReceipt | null, authorization: SeparateHAuthorization | null): { status: "blocked" | "eligible"; blockers: string[] } {
  const blockers: string[] = [];
  const parsedPass = passReceiptSchema.safeParse(pass);
  const parsedAuthorization = separateAuthorizationSchema.safeParse(authorization);
  if (!parsedPass.success || !parsedPass.data.passed || JSON.stringify(parsedPass.data.requestOrder) !== JSON.stringify(EXPOSED_REQUEST_ORDER)) {
    blockers.push("COMPLETE_EXPOSED_PASS_REQUIRED");
  }
  if (!parsedAuthorization.success || !Number.isFinite(Date.parse(parsedAuthorization.data.authorizedAt))) {
    blockers.push("SEPARATE_H_AUTHORIZATION_REQUIRED");
  }
  if (parsedPass.success && parsedAuthorization.success) {
    const authorized = parsedAuthorization.data;
    const receipt = parsedPass.data;
    if (authorized.exposedPassSha256 !== receipt.captureSha256) blockers.push("AUTHORIZATION_NOT_BOUND_TO_EXPOSED_PASS");
    if (authorized.campaignFreezeSha256 !== receipt.campaignFreezeSha256
      || authorized.candidateId !== receipt.candidateId
      || authorized.sourceInventorySha256 !== receipt.sourceInventorySha256
      || authorized.corpusManifestSha256 !== receipt.corpusManifestSha256
      || authorized.corpusCatalogSha256 !== receipt.corpusCatalogSha256
      || authorized.modelProfileSha256 !== receipt.modelProfileSha256) {
      blockers.push("AUTHORIZATION_NOT_BOUND_TO_CANDIDATE");
    }
  }
  return { status: blockers.length === 0 ? "eligible" : "blocked", blockers };
}

export async function writeImmutableCapture(directory: string, filename: string, value: unknown): Promise<string> {
  if (!/^[a-z0-9][a-z0-9.-]*\.json$/.test(filename)) throw new Error("INVALID_CAPTURE_NAME");
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const digest = sha256(bytes);
  await writeFile(join(directory, filename), bytes, { flag: "wx", mode: 0o600 });
  await writeFile(join(directory, `${filename}.sha256`), `${digest}  ${filename}\n`, { flag: "wx", mode: 0o600 });
  return digest;
}
