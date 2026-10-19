import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { ZodError } from "zod";
import type { AssessmentResult, Selection } from "../shared/protocol.ts";
import type { Env, WorkflowParams, UploadWorkflowParams } from "./env.ts";
import { database, transaction } from "./db.ts";
import { loadCorpus, type CorpusSnapshot } from "./corpus.ts";
import { claimJobRepair, loadStageAttempt, runPaidStage, ReconciliationRequired, type ModelCallIndex } from "./calls.ts";
import { ModelCallError, type ModelStage, type StageOutput } from "./model.ts";
import { PAID_STEP_TIMEOUT_SECONDS } from "./model-deadlines.ts";
import {
  assessmentDraftPrompt,
  assessmentReviewPrompt,
  briefDraftPrompt,
  briefReviewPrompt,
} from "./prompts.ts";
import type { StagePrompt } from "./prompts.ts";
import {
  parseAssessmentDraft,
  assessmentReviewSchema,
  briefDraftSchema,
  briefSupportReviewSchema,
} from "./schemas.ts";
import {
  buildCheckedAssessment,
  buildCheckedBrief,
  GateFailure,
  withAssessmentConstraintFloor,
  validateAssessmentDraft,
  validateBriefDraft,
  validateSupportReview,
  validateArtifactReview,
  revalidateAssessment,
} from "./gates.ts";
import { validateSelections } from "./selections.ts";
import {
  assessmentRepairPlan, briefRepairPlan, schemaRepairPlan, repairPrompt, assertRepairScope, assertRepairAccepted, type RepairPlan,
} from "./repair.ts";
import { processUpload } from "./uploads.ts";

interface WorkflowJob {
  request_text: string;
  corpus_version: string;
  corpus_sha256: string;
  assessment_state: string;
  brief_state: string;
  assessment_result: AssessmentResult | null;
  brief_selections: Selection[] | null;
  expires_at: Date;
  active_attempt_id: string | null;
}

async function readJob(env: Env, params: WorkflowParams): Promise<WorkflowJob | null> {
  const result = await database(env).query<WorkflowJob>(
    `SELECT j.request_text, j.corpus_version, j.corpus_sha256, j.assessment_state, j.brief_state,
       j.assessment_result, j.brief_selections, j.expires_at, c.active_attempt_id
     FROM jobs j CROSS JOIN workflow_control c WHERE j.id = $1 AND c.singleton`,
    [params.jobId],
  );
  return result.rows[0] ?? null;
}
async function hasUnresolvedDispatch(env: Env, params: WorkflowParams): Promise<boolean> {
  try {
    const result = await database(env).query<{ unresolved: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM model_attempts WHERE reservation_id = $1 AND state IN ('prepared', 'dispatching', 'uncertain')
       ) AS unresolved`,
      [params.attemptId],
    );
    return result.rows[0]?.unresolved ?? true;
  } catch {
    return true;
  }
}

async function startPhase(env: Env, params: WorkflowParams): Promise<void> {
  const pool = database(env);
  const result = await pool.query(
    params.phase === "assessment"
      ? `UPDATE jobs SET assessment_state = 'running', assessment_processing_started_at = COALESCE(assessment_processing_started_at, now()), stage = 'assembling'
         WHERE id = $1 AND assessment_state IN ('queued', 'running') AND expires_at > now()
           AND EXISTS (SELECT 1 FROM workflow_control WHERE singleton AND active_attempt_id = $2)`
      : `UPDATE jobs SET brief_state = 'running', brief_processing_started_at = COALESCE(brief_processing_started_at, now()), stage = 'assembling'
         WHERE id = $1 AND brief_state IN ('queued', 'running') AND expires_at > now()
           AND EXISTS (SELECT 1 FROM workflow_control WHERE singleton AND active_attempt_id = $2)`,
    [params.jobId, params.attemptId],
  );
  if (!result.rowCount) throw new Error("PHASE_NOT_RUNNABLE");
}

async function setStage(env: Env, params: WorkflowParams, stage: "drafting" | "reference_check" | "support_review"): Promise<void> {
  const result = await database(env).query(
    params.phase === "assessment"
      ? `UPDATE jobs SET stage = $3 WHERE id = $1 AND assessment_state = 'running'
           AND EXISTS (SELECT 1 FROM workflow_control WHERE singleton AND active_attempt_id = $2)`
      : `UPDATE jobs SET stage = $3 WHERE id = $1 AND brief_state = 'running'
           AND EXISTS (SELECT 1 FROM workflow_control WHERE singleton AND active_attempt_id = $2)`,
    [params.jobId, params.attemptId, stage],
  );
  if (!result.rowCount) throw new Error("PHASE_NOT_ACTIVE");
}

async function finishPhase(env: Env, params: WorkflowParams, result: AssessmentResult | object): Promise<void> {
  await transaction(database(env), async (client) => {
    const control = await client.query<{ active_attempt_id: string | null }>(
      "SELECT active_attempt_id FROM workflow_control WHERE singleton FOR UPDATE",
    );
    if (control.rows[0]?.active_attempt_id !== params.attemptId) throw new Error("WORKFLOW_OWNERSHIP_CHANGED");
    const updated = await client.query(
      params.phase === "assessment"
        ? `UPDATE jobs SET assessment_state = 'ready', assessment_finished_at = now(), assessment_result = $2::jsonb,
             error_code = NULL, stage = 'ready'
           WHERE id = $1 AND assessment_state = 'running' RETURNING id`
        : `UPDATE jobs SET brief_state = 'ready', brief_finished_at = now(), brief_result = $2::jsonb,
             error_code = NULL, stage = 'ready'
           WHERE id = $1 AND brief_state = 'running' RETURNING id`,
      [params.jobId, JSON.stringify(result)],
    );
    if (!updated.rowCount) throw new Error("PHASE_FINISH_STATE_INVALID");
    await client.query("UPDATE workflow_control SET active_attempt_id = NULL, updated_at = now() WHERE singleton AND active_attempt_id = $1", [params.attemptId]);
  });
}

async function finishFailure(env: Env, params: WorkflowParams, code: string, uncertain: boolean): Promise<void> {
  const pool = database(env);
  const state = uncertain ? "reconciliation_required" : "failed";
  await transaction(pool, async (client) => {
    await client.query(
      params.phase === "assessment"
        ? `UPDATE jobs SET assessment_state = $3, assessment_finished_at = now(), error_code = $4, stage = $3
           WHERE id = $1 AND assessment_state IN ('queued', 'running')
             AND EXISTS (SELECT 1 FROM workflow_control WHERE singleton AND active_attempt_id = $2)`
        : `UPDATE jobs SET brief_state = $3, brief_finished_at = now(), error_code = $4, stage = $3
           WHERE id = $1 AND brief_state IN ('queued', 'running')
             AND EXISTS (SELECT 1 FROM workflow_control WHERE singleton AND active_attempt_id = $2)`,
      [params.jobId, params.attemptId, state, code],
    );
    if (!uncertain) {
      await client.query("UPDATE workflow_control SET active_attempt_id = NULL, updated_at = now() WHERE singleton AND active_attempt_id = $1", [params.attemptId]);
    }
  });
}

function failureCode(error: unknown): { code: string; uncertain: boolean } {
  if (error instanceof ReconciliationRequired) return { code: error.code, uncertain: true };
  if (error instanceof ModelCallError) return { code: error.code, uncertain: error.uncertain };
  if (error instanceof GateFailure || error instanceof ZodError) return { code: "STRUCTURAL_CHECK_FAILED", uncertain: false };
  return { code: "INTERNAL_FAILURE", uncertain: false };
}

async function paidStep(
  env: Env, params: WorkflowParams, step: WorkflowStep, name: string,
  callIndex: ModelCallIndex, stage: ModelStage, prompt: StagePrompt,
): Promise<string> {
  const outcome = await step.do(name, {
    retries: { limit: 0, delay: "1 second" },
    timeout: `${PAID_STEP_TIMEOUT_SECONDS} seconds`,
    sensitive: "output",
  }, async () => {
    try {
      return { attemptId: await runPaidStage(env, params, callIndex, stage, prompt) };
    } catch (error) {
      return { failure: failureCode(error) };
    }
  });
  if (outcome.failure) throw new ModelCallError(outcome.failure.code, null, outcome.failure.uncertain);
  return outcome.attemptId;
}

async function checkedPhase<Draft, Checked>(
  env: Env,
  params: WorkflowParams,
  step: WorkflowStep,
  prompt: StagePrompt,
  corpus: CorpusSnapshot,
  parseDraft: (output: StageOutput) => Draft,
  prepareReview: (draft: Draft) => StagePrompt,
  check: (draft: Draft, output: StageOutput, reviewPrompt: StagePrompt, repairedPlan: RepairPlan | null) => { checked: Checked; plan: RepairPlan | null },
): Promise<Checked> {
  const draftStage = `${params.phase}_draft` as ModelStage;
  const reviewStage = `${params.phase}_review` as ModelStage;
  await setStage(env, params, "drafting");
  let draftAttemptId = await paidStep(env, params, step, `${params.phase}-draft`, 1, draftStage, prompt);
  let repaired = false;
  let repairScope: { original: unknown; plan: RepairPlan } | null = null;
  while (true) {
    const attempt = await loadStageAttempt(env, draftAttemptId);
    if (repaired && attempt.usage.reportedCostUsd === null) throw new ReconciliationRequired(draftAttemptId);
    if (repairScope) assertRepairScope(repairScope.original, attempt.rawOutput, repairScope.plan);
    let draft: Draft | undefined;
    let plan: RepairPlan | null = null;
    let reviewAttemptId: string | null = null;
    if (attempt.state === "invalid") {
      plan = schemaRepairPlan(attempt.issues);
    } else {
      try {
        draft = parseDraft(attempt.output!);
      } catch (error) {
        if (!(error instanceof ZodError)) throw error;
        plan = schemaRepairPlan(error.issues.map(({ path, message }) => ({
          path: path.filter((part): part is string | number => typeof part !== "symbol"), message,
        })));
      }
    }
    if (draft !== undefined) {
      await setStage(env, params, "reference_check");
      const reviewPrompt = prepareReview(draft);
      await setStage(env, params, "support_review");
      reviewAttemptId = await paidStep(
        env, params, step, `${params.phase}-${repaired ? "repair-" : ""}support-review`,
        repaired ? 4 : 2, reviewStage, reviewPrompt,
      );
      const review = await loadStageAttempt(env, reviewAttemptId);
      if (repaired && review.usage.reportedCostUsd === null) throw new ReconciliationRequired(reviewAttemptId);
      if (!review.output || review.state !== "complete") throw new GateFailure("INVALID_REVIEW", "Independent review must be complete.");
      const evaluated = check(draft, review.output, reviewPrompt, repairScope?.plan ?? null);
      plan = evaluated.plan;
      if (plan === null) return evaluated.checked;
    }
    if (repaired) throw new ModelCallError("REPAIR_REJECTED", null, false);
    if (plan === null) throw new ModelCallError("REPAIR_NOT_ACTIONABLE", null, false);
    for (const availability of corpus.caseAvailability.values()) {
      if (availability !== "available") throw new GateFailure("REPAIR_EVIDENCE_UNAVAILABLE", "Repair requires complete verified original evidence.");
    }
    const plannedRepair = plan;
    const admission = await step.do(`${params.phase}-repair-admission`, {
      retries: { limit: 0, delay: "1 second" }, sensitive: "output",
    }, async () => {
      try { return { value: await claimJobRepair(env, params, draftAttemptId, reviewAttemptId, plannedRepair) }; }
      catch (error) { return { failure: failureCode(error) }; }
    });
    if (admission.failure) {
      if (admission.failure.uncertain) throw new ReconciliationRequired(params.attemptId);
      throw new ModelCallError(admission.failure.code, null, false);
    }
    if (admission.value !== "claimed") {
      throw new ModelCallError(admission.value === "exhausted" ? "REPAIR_EXHAUSTED" : "REPAIR_CREDIT_EXHAUSTED", null, false);
    }
    repairScope = { original: attempt.rawOutput, plan };
    await setStage(env, params, "drafting");
    draftAttemptId = await paidStep(
      env, params, step, `${params.phase}-repair-draft`, 3, draftStage, repairPrompt(prompt, attempt.rawOutput, plan),
    );
    repaired = true;
  }
}

export class MemoryBankWorkflow extends WorkflowEntrypoint<Env, WorkflowParams | UploadWorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams | UploadWorkflowParams>, step: WorkflowStep): Promise<void> {
    if ("uploadId" in event.payload) {
      const upload = event.payload;
      await step.do("extract-and-index-private-source", {
        retries: { limit: 0, delay: "1 second" }, timeout: "5 minutes", sensitive: "output",
      }, () => processUpload(this.env, upload.owner, upload.uploadId));
      return;
    }
    const params = event.payload;
    let job: WorkflowJob | null = null;
    try {
      job = await readJob(this.env, params);
      if (!job || job.expires_at.getTime() <= Date.now()) throw new Error("JOB_UNAVAILABLE");
      if (job.active_attempt_id !== params.attemptId) return;
      const phaseState = params.phase === "assessment" ? job.assessment_state : job.brief_state;
      if (["ready", "failed", "reconciliation_required"].includes(phaseState)) return;
      if (phaseState !== "queued" && phaseState !== "running") throw new Error("PHASE_NOT_RUNNABLE");
      await startPhase(this.env, params);
      const corpus = await loadCorpus(this.env);
      if (corpus.manifest.corpusVersion !== job.corpus_version || corpus.manifestSha256 !== job.corpus_sha256) throw new Error("CORPUS_CHANGED");
      if (params.phase === "assessment") {
        const request = job.request_text;
        const checked = await checkedPhase(
          this.env, params, step, assessmentDraftPrompt(request, corpus), corpus,
          (output) => {
            const draft = parseAssessmentDraft(output, corpus);
            return { draft, invalidRefs: validateAssessmentDraft(draft, request, corpus) };
          },
          ({ draft }) => assessmentReviewPrompt(request, corpus, draft),
          ({ draft, invalidRefs }, output, reviewPrompt, repairedPlan) => {
            const review = assessmentReviewSchema.parse(output);
            const verdicts = validateSupportReview(draft.claims.filter((claim) => reviewPrompt.reviewTargets!.claimIds.includes(claim.claimId)), review);
            const artifactRoles = validateArtifactReview(draft, review);
            const checked = buildCheckedAssessment(draft, verdicts, invalidRefs, corpus, artifactRoles, {
              request, constraints: review.requestConstraints, missingEvidenceReview: review.missingEvidenceReview,
            });
            if (repairedPlan) assertRepairAccepted(request, repairedPlan, draft, review, checked);
            return { checked, plan: assessmentRepairPlan(request, corpus, draft, review, checked) };
          },
        );
        await finishPhase(this.env, params, checked);
      } else {
        if (job.assessment_state !== "ready" || !job.assessment_result || !job.brief_selections?.length) throw new Error("BRIEF_PREREQUISITE_MISSING");
        const request = job.request_text;
        const selections = job.brief_selections;
        const assessment = revalidateAssessment(job.assessment_result, request, corpus);
        validateSelections(selections, assessment, corpus);
        const checked = await checkedPhase(
          this.env, params, step, briefDraftPrompt(request, selections, corpus, assessment), corpus,
          (output) => {
            const draft = briefDraftSchema.parse(output);
            return { draft, invalidRefs: validateBriefDraft(draft, request, selections, corpus) };
          },
          ({ draft }) => briefReviewPrompt(request, selections, corpus, assessment, draft),
          ({ draft, invalidRefs }, output, _reviewPrompt, repairedPlan) => {
            const review = briefSupportReviewSchema.parse(output);
            const verdicts = validateSupportReview(draft.claims, review);
            const checked = buildCheckedBrief(draft, verdicts, invalidRefs, {
              request, constraintReviews: withAssessmentConstraintFloor(review.constraintReviews, assessment, request), assessment,
            });
            if (repairedPlan) assertRepairAccepted(request, repairedPlan, draft, review, checked);
            return { checked, plan: briefRepairPlan(request, corpus, assessment, selections, draft, review, checked) };
          },
        );
        await finishPhase(this.env, params, checked);
      }
    } catch (error) {
      const reportedFailure = failureCode(error);
      const failure = reportedFailure.uncertain || await hasUnresolvedDispatch(this.env, params)
        ? { ...reportedFailure, uncertain: true }
        : reportedFailure;
      try {
        await finishFailure(this.env, params, failure.code, failure.uncertain);
      } catch {
        console.error("Memory Bank workflow status could not be committed.");
        throw new Error("WORKFLOW_STATUS_COMMIT_FAILED");
      }
      if (failure.uncertain) return;
    }
  }
}
