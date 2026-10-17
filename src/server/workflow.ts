import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { AssessmentResult, Selection } from "../shared/protocol.ts";
import type { Env, WorkflowParams } from "./env.ts";
import { database, transaction } from "./db.ts";
import { loadCorpus } from "./corpus.ts";
import { loadStageOutput, runPaidStage, ReconciliationRequired } from "./calls.ts";
import { ModelCallError, type ModelStage } from "./model.ts";
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
  validateAssessmentDraft,
  validateBriefDraft,
  validateSupportReview,
  validateArtifactReview,
  revalidateAssessment,
} from "./gates.ts";
import { validateSelections } from "./selections.ts";

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
  const stateColumn = params.phase === "assessment" ? "assessment_state" : "brief_state";
  const startedColumn = params.phase === "assessment" ? "assessment_processing_started_at" : "brief_processing_started_at";
  const result = await pool.query(
    `UPDATE jobs SET ${stateColumn} = 'running', ${startedColumn} = COALESCE(${startedColumn}, now()), stage = 'assembling'
     WHERE id = $1 AND ${stateColumn} IN ('queued', 'running') AND expires_at > now()
       AND EXISTS (SELECT 1 FROM workflow_control WHERE singleton AND active_attempt_id = $2)`,
    [params.jobId, params.attemptId],
  );
  if (!result.rowCount) throw new Error("PHASE_NOT_RUNNABLE");
}

async function setStage(env: Env, params: WorkflowParams, stage: "drafting" | "reference_check" | "support_review"): Promise<void> {
  const column = params.phase === "assessment" ? "assessment_state" : "brief_state";
  const result = await database(env).query(
    `UPDATE jobs SET stage = $3 WHERE id = $1 AND ${column} = 'running'
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
    const stateColumn = params.phase === "assessment" ? "assessment_state" : "brief_state";
    const finishedColumn = params.phase === "assessment" ? "assessment_finished_at" : "brief_finished_at";
    const resultColumn = params.phase === "assessment" ? "assessment_result" : "brief_result";
    const updated = await client.query(
      `UPDATE jobs SET ${stateColumn} = 'ready', ${finishedColumn} = now(), ${resultColumn} = $2::jsonb,
         error_code = NULL, stage = 'ready'
       WHERE id = $1 AND ${stateColumn} = 'running' RETURNING id`,
      [params.jobId, JSON.stringify(result)],
    );
    if (!updated.rowCount) throw new Error("PHASE_FINISH_STATE_INVALID");
    await client.query("UPDATE workflow_control SET active_attempt_id = NULL, updated_at = now() WHERE singleton AND active_attempt_id = $1", [params.attemptId]);
  });
}

async function finishFailure(env: Env, params: WorkflowParams, code: string, uncertain: boolean): Promise<void> {
  const pool = database(env);
  const stateColumn = params.phase === "assessment" ? "assessment_state" : "brief_state";
  const finishedColumn = params.phase === "assessment" ? "assessment_finished_at" : "brief_finished_at";
  const state = uncertain ? "reconciliation_required" : "failed";
  await transaction(pool, async (client) => {
    await client.query(
      `UPDATE jobs SET ${stateColumn} = $3, ${finishedColumn} = now(), error_code = $4, stage = $3
       WHERE id = $1 AND ${stateColumn} IN ('queued', 'running')
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
  if (error instanceof GateFailure) return { code: "STRUCTURAL_CHECK_FAILED", uncertain: false };
  return { code: "INTERNAL_FAILURE", uncertain: false };
}

async function paidStep(
  env: Env, params: WorkflowParams, step: WorkflowStep, name: string,
  callIndex: 1 | 2, stage: ModelStage, prompt: StagePrompt,
): Promise<string> {
  const outcome = await step.do(name, {
    retries: { limit: 0, delay: "1 second" },
    timeout: "135 seconds",
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

export class MemoryBankWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<void> {
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
        const draftPrompt = assessmentDraftPrompt(request, corpus);
        await setStage(this.env, params, "drafting");
        const draftAttemptId = await paidStep(this.env, params, step, "assessment-draft", 1, "assessment_draft", draftPrompt);
        const draft = parseAssessmentDraft(await loadStageOutput(this.env, draftAttemptId), corpus);
        await setStage(this.env, params, "reference_check");
        const invalidRefs = validateAssessmentDraft(draft, request, corpus);
        const reviewPrompt = assessmentReviewPrompt(request, corpus, draft);
        await setStage(this.env, params, "support_review");
        const reviewAttemptId = await paidStep(this.env, params, step, "assessment-support-review", 2, "assessment_review", reviewPrompt);
        const review = assessmentReviewSchema.parse(await loadStageOutput(this.env, reviewAttemptId));
        const verdicts = validateSupportReview(draft.claims, review);
        const artifactRoles = validateArtifactReview(draft, review);
        const checked = buildCheckedAssessment(draft, verdicts, invalidRefs, corpus, artifactRoles, { request, constraints: review.requestConstraints });
        await finishPhase(this.env, params, checked);
      } else {
        if (job.assessment_state !== "ready" || !job.assessment_result || !job.brief_selections?.length) throw new Error("BRIEF_PREREQUISITE_MISSING");
        const request = job.request_text;
        const selections = job.brief_selections;
        const assessment = revalidateAssessment(job.assessment_result, request, corpus);
        validateSelections(selections, assessment, corpus);
        const draftPrompt = briefDraftPrompt(request, selections, corpus, assessment);
        await setStage(this.env, params, "drafting");
        const draftAttemptId = await paidStep(this.env, params, step, "brief-draft", 1, "brief_draft", draftPrompt);
        const draft = briefDraftSchema.parse(await loadStageOutput(this.env, draftAttemptId));
        await setStage(this.env, params, "reference_check");
        const invalidRefs = validateBriefDraft(draft, request, selections, corpus);
        const reviewPrompt = briefReviewPrompt(request, selections, corpus, assessment, draft);
        await setStage(this.env, params, "support_review");
        const reviewAttemptId = await paidStep(this.env, params, step, "brief-support-review", 2, "brief_review", reviewPrompt);
        const review = briefSupportReviewSchema.parse(await loadStageOutput(this.env, reviewAttemptId));
        const verdicts = validateSupportReview(draft.claims, review);
        const checked = buildCheckedBrief(draft, verdicts, invalidRefs, { request, constraintReviews: review.constraintReviews });
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
