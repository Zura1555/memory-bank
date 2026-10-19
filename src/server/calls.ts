import type { PoolClient } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { database, transaction } from "./db.ts";
import type { Env, WorkflowParams } from "./env.ts";
import { ModelCallError, callModel, modelConfig, type ModelConfig, type ModelReply, type ModelStage, type StageOutput, type ModelUsage } from "./model.ts";
import type { RepairIssue, RepairPlan } from "./repair.ts";
import type { StagePrompt } from "./prompts.ts";

export type ModelCallIndex = 1 | 2 | 3 | 4;

interface BegunAttempt {
  attemptId: string;
  cached: boolean;
}

const REPAIR_ALLOWANCE_MICRO_USD = 600_000;
const BASE_RESERVATION_MICRO_USD = 600_000;
const REPAIRED_RESERVATION_MICRO_USD = 1_200_000;

function modelProfileHash(config: ModelConfig): string {
  return createHash("sha256").update(JSON.stringify({
    provider: config.provider, api: config.api, model: config.model, url: config.url,
  })).digest("hex");
}

function hasKnownReportedCost(usage: ModelUsage | null): usage is ModelUsage & { reportedCostUsd: number } {
  return usage !== null && typeof usage.reportedCostUsd === "number"
    && Number.isFinite(usage.reportedCostUsd) && usage.reportedCostUsd >= 0;
}

function knownCostMicroUsd(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null || !("reportedCostUsd" in usage)) return null;
  const cost = usage.reportedCostUsd;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
  const microUsd = Math.ceil(cost * 1_000_000);
  return Number.isSafeInteger(microUsd) ? microUsd : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}



export class ReconciliationRequired extends Error {
  readonly attemptId: string;
  readonly code: string;
  constructor(attemptId: string, code = "MODEL_DISPATCH_UNCERTAIN") {
    super("A prior paid dispatch has an uncertain outcome and cannot be repeated.");
    this.name = "ReconciliationRequired";
    this.attemptId = attemptId;
    this.code = code;
  }
}

async function beginAttempt(
  client: PoolClient, params: WorkflowParams, callIndex: ModelCallIndex, stage: ModelStage, env: Env,
): Promise<BegunAttempt> {
  if (callIndex >= 3) {
    const draftStage = params.phase === "assessment" ? "assessment_draft" : "brief_draft";
    const reviewStage = params.phase === "assessment" ? "assessment_review" : "brief_review";
    if ((callIndex === 3 && stage !== draftStage) || (callIndex === 4 && stage !== reviewStage)) {
      throw new ModelCallError("REPAIR_DISPATCH_NOT_ALLOWED", null, false);
    }
    const control = await client.query<{ active_attempt_id: string | null }>(
      "SELECT active_attempt_id FROM workflow_control WHERE singleton FOR UPDATE",
    );
    if (control.rows[0]?.active_attempt_id !== params.attemptId) {
      throw new ModelCallError("REPAIR_DISPATCH_NOT_ALLOWED", null, false);
    }
  }
  const reservation = await client.query<{ id: string; amount_micro_usd: string }>(
    `SELECT id, amount_micro_usd FROM phase_reservations
     WHERE id = $1 AND job_id = $2 AND phase = $3 AND state = 'held' FOR UPDATE`,
    [params.attemptId, params.jobId, params.phase],
  );
  if (!reservation.rowCount) {
    if (callIndex >= 3) throw new ModelCallError("REPAIR_DISPATCH_NOT_ALLOWED", null, false);
    throw new ReconciliationRequired(params.attemptId);
  }
  if (callIndex >= 3) {
    const job = await client.query<{ expires_at: Date; phase_state: string }>(
      `SELECT expires_at, ${params.phase === "assessment" ? "assessment_state" : "brief_state"} AS phase_state
       FROM jobs WHERE id = $1 FOR UPDATE`,
      [params.jobId],
    );
    const activeJob = job.rows[0];
    if (!activeJob || activeJob.phase_state !== "running" || activeJob.expires_at.getTime() <= Date.now()) {
      throw new ModelCallError("REPAIR_DISPATCH_NOT_ALLOWED", null, false);
    }
  }
  const repair = callIndex >= 3 ? await client.query<{
    phase: string;
    plan_json: RepairPlan | null;
    draft_attempt_id: string;
    review_attempt_id: string | null;
  }>(
    `SELECT phase, plan_json, draft_attempt_id, review_attempt_id FROM job_repairs
     WHERE job_id = $1 AND reservation_id = $2 FOR UPDATE`,
    [params.jobId, params.attemptId],
  ) : null;
  if (callIndex >= 3 && (Number(reservation.rows[0].amount_micro_usd) !== REPAIRED_RESERVATION_MICRO_USD
    || repair?.rows[0]?.phase !== params.phase || !repair.rows[0].plan_json)) {
    throw new ModelCallError("REPAIR_DISPATCH_NOT_ALLOWED", null, false);
  }
  const existing = await client.query<{ id: string; state: string; result_json: StageOutput | null }>(
    "SELECT id, state, result_json FROM model_attempts WHERE reservation_id = $1 AND call_index = $2 FOR UPDATE",
    [params.attemptId, callIndex],
  );
  if (existing.rowCount) {
    const attempt = existing.rows[0];
    if (attempt.state === "complete" || attempt.state === "invalid") {
      return { attemptId: attempt.id, cached: true };
    }
    throw new ReconciliationRequired(attempt.id);
  }
  const config = modelConfig(env);
  const profileHash = modelProfileHash(config);
  if (callIndex >= 3) {
    const attempts = await client.query<{
      id: string;
      reservation_id: string;
      phase: string;
      call_index: number;
      state: string;
      usage: unknown;
      requested_model: string;
      model_profile_sha256: string | null;
    }>(
      "SELECT id, reservation_id, phase, call_index, state, usage, requested_model, model_profile_sha256 FROM model_attempts WHERE job_id = $1 FOR UPDATE",
      [params.jobId],
    );
    const previous = attempts.rows.filter((item) => item.call_index < callIndex);
    const unresolved = previous.find((item) =>
      item.state === "prepared" || item.state === "dispatching" || item.state === "uncertain"
      || knownCostMicroUsd(item.usage) === null);
    if (unresolved) throw new ReconciliationRequired(unresolved.id);
    const repairRecord = repair?.rows[0];
    const trigger = repairRecord ? attempts.rows.find((item) => item.id === repairRecord.draft_attempt_id) : null;
    const triggerReview = repairRecord?.review_attempt_id
      ? attempts.rows.find((item) => item.id === repairRecord.review_attempt_id) : null;
    const repairDraft = previous.find((item) => item.reservation_id === params.attemptId && item.call_index === 3);
    if (attempts.rows.some((item) => item.reservation_id === params.attemptId && item.call_index > callIndex)
      || previous.some((item) => item.state !== "complete" && item.state !== "invalid")
      || !repairRecord || !trigger || trigger.reservation_id !== params.attemptId
      || trigger.phase !== params.phase || trigger.call_index !== 1 || trigger.requested_model !== config.model
      || trigger.model_profile_sha256 !== profileHash
      || (repairRecord.review_attempt_id === null
        ? attempts.rows.some((item) => item.reservation_id === params.attemptId && item.call_index === 2)
        : !triggerReview || triggerReview.reservation_id !== params.attemptId
          || triggerReview.phase !== params.phase || triggerReview.call_index !== 2 || triggerReview.state !== "complete")) {
      throw new ModelCallError("REPAIR_DISPATCH_NOT_ALLOWED", null, false);
    }
    if (callIndex === 4 && (!repairDraft || repairDraft.state !== "complete"
      || repairDraft.requested_model !== config.model || repairDraft.model_profile_sha256 !== profileHash
      || knownCostMicroUsd(repairDraft.usage) === null)) {
      throw new ModelCallError("REPAIR_DISPATCH_NOT_ALLOWED", null, false);
    }
    const phaseSpend = previous.filter((item) => item.reservation_id === params.attemptId)
      .reduce((total, item) => total + knownCostMicroUsd(item.usage)!, 0);
    if (!Number.isSafeInteger(phaseSpend) || phaseSpend >= REPAIRED_RESERVATION_MICRO_USD) {
      throw new ModelCallError("REPAIR_DISPATCH_NOT_ALLOWED", null, false);
    }
  }
  const id = randomUUID();
  await client.query(
    `INSERT INTO model_attempts (id, reservation_id, job_id, phase, call_index, state, requested_model, provider, model_profile_sha256, dispatched_at)
     VALUES ($1, $2, $3, $4, $5, 'dispatching', $6, $7, $8, now())`,
    [id, params.attemptId, params.jobId, params.phase, callIndex, config.model, new URL(config.url).host, profileHash],
  );
  return { attemptId: id, cached: false };
}

export async function runPaidStage(
  env: Env,
  params: WorkflowParams,
  callIndex: ModelCallIndex,
  stage: ModelStage,
  prompt: StagePrompt,
): Promise<string> {
  const pool = database(env);
  const begun = await pool.connect();
  let attempt: BegunAttempt;
  try {
    await begun.query("BEGIN");
    attempt = await beginAttempt(begun, params, callIndex, stage, env);
    await begun.query("COMMIT");
  } catch (error) {
    await begun.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    begun.release();
  }
  if (attempt.cached) return attempt.attemptId;

  let reply: ModelReply;
  try {
    reply = await callModel(env, stage, prompt, params.jobId);
  } catch (error) {
    if (error instanceof ModelCallError && error.repairableDraft && hasKnownReportedCost(error.usage)) {
      try {
        const updated = await pool.query(
          `UPDATE model_attempts a SET state = 'invalid', error_code = $2, generation_id = $3,
             http_status = $4, failure_phase = $5, failure_cause = $6, usage = $7::jsonb,
             returned_model = COALESCE($8, returned_model), provider = COALESCE($9, provider),
             raw_output = CASE WHEN j.expires_at > clock_timestamp() THEN $10::jsonb ELSE NULL END,
             validation_issues = CASE WHEN j.expires_at > clock_timestamp() THEN $11::jsonb ELSE NULL END,
             result_json = NULL, completed_at = clock_timestamp()
           FROM jobs j WHERE a.id = $1 AND a.job_id = j.id AND a.state = 'dispatching' RETURNING a.id`,
          [attempt.attemptId, error.code, error.generationId, error.status, error.failurePhase, error.failureCause,
            JSON.stringify(error.usage), error.usage.returnedModel, error.usage.provider,
            JSON.stringify(error.repairableDraft.output), JSON.stringify(error.repairableDraft.issues)],
        );
        if (!updated.rowCount) throw new Error("MODEL_ATTEMPT_STATE_CHANGED");
      } catch {
        throw new ReconciliationRequired(attempt.attemptId);
      }
      return attempt.attemptId;
    }
    const code = error instanceof ModelCallError ? error.code : "MODEL_DISPATCH_UNCERTAIN";
    const state = error instanceof ModelCallError && !error.uncertain ? "failed" : "uncertain";
    try {
      const updated = await pool.query(
        `UPDATE model_attempts SET state = $2, error_code = $3, generation_id = $4,
           http_status = $5, failure_phase = $6, failure_cause = $7, usage = $8::jsonb,
           returned_model = COALESCE($9, returned_model), provider = COALESCE($10, provider), completed_at = now()
         WHERE id = $1 AND state = 'dispatching'`,
        [attempt.attemptId, state, code, error instanceof ModelCallError ? error.generationId : null,
          error instanceof ModelCallError ? error.status : null,
          error instanceof ModelCallError ? error.failurePhase : null,
          error instanceof ModelCallError ? error.failureCause : null,
          error instanceof ModelCallError && error.usage ? JSON.stringify(error.usage) : null,
          error instanceof ModelCallError ? error.usage?.returnedModel ?? null : null,
          error instanceof ModelCallError ? error.usage?.provider ?? null : null],
      );
      if (!updated.rowCount) throw new Error("MODEL_ATTEMPT_STATE_CHANGED");
    } catch {
      throw new ReconciliationRequired(attempt.attemptId);
    }
    if (state === "uncertain") throw new ReconciliationRequired(attempt.attemptId, code);
    throw error;
  }
  const unknownRepairCost = callIndex >= 3 && !hasKnownReportedCost(reply.usage);

  try {
    const updated = await pool.query(
      `UPDATE model_attempts a SET state = $8, error_code = $9, returned_model = $2, provider = $3, generation_id = $4,
       usage = $5::jsonb, result_json = CASE WHEN j.expires_at > clock_timestamp() THEN $6::jsonb ELSE NULL END,
       raw_output = CASE WHEN j.expires_at > clock_timestamp() THEN $7::jsonb ELSE NULL END,
       completed_at = clock_timestamp()
       FROM jobs j WHERE a.id = $1 AND a.job_id = j.id AND a.state = 'dispatching' RETURNING a.id`,
      [attempt.attemptId, reply.usage.returnedModel, reply.usage.provider, reply.usage.responseId,
        JSON.stringify(reply.usage), JSON.stringify(reply.output), JSON.stringify(reply.rawOutput),
        unknownRepairCost ? "uncertain" : "complete", unknownRepairCost ? "MODEL_USAGE_UNAVAILABLE" : null],
    );
    if (!updated.rowCount) throw new Error("MODEL_ATTEMPT_STATE_CHANGED");
  } catch {
    throw new ReconciliationRequired(attempt.attemptId);
  }
  if (unknownRepairCost) throw new ReconciliationRequired(attempt.attemptId, "MODEL_USAGE_UNAVAILABLE");
  return attempt.attemptId;
}

export async function loadStageAttempt(env: Env, attemptId: string): Promise<{
  state: "complete" | "invalid";
  output: StageOutput | null;
  rawOutput: unknown;
  issues: RepairIssue[];
  usage: ModelUsage;
}> {
  const result = await database(env).query<{
    state: string;
    result_json: StageOutput | null;
    raw_output: unknown;
    validation_issues: RepairIssue[] | null;
    usage: ModelUsage | null;
    expires_at: Date;
  }>(
    `SELECT a.state, a.result_json, a.raw_output, a.validation_issues, a.usage, j.expires_at
     FROM model_attempts a JOIN jobs j ON j.id = a.job_id WHERE a.id = $1`,
    [attemptId],
  );
  const attempt = result.rows[0];
  if (!attempt || (attempt.state !== "complete" && attempt.state !== "invalid")) {
    throw new ReconciliationRequired(attemptId);
  }
  if (attempt.expires_at.getTime() <= Date.now()) throw new ModelCallError("JOB_EXPIRED", null, false);
  if (!attempt.usage) throw new ModelCallError("MODEL_USAGE_UNAVAILABLE", null, false);
  return {
    state: attempt.state,
    output: attempt.result_json,
    rawOutput: attempt.raw_output,
    issues: attempt.validation_issues ?? [],
    usage: attempt.usage,
  };
}

export async function claimJobRepair(
  env: Env,
  params: WorkflowParams,
  draftAttemptId: string,
  reviewAttemptId: string | null,
  plan: RepairPlan,
): Promise<"claimed" | "exhausted" | "credit_exhausted"> {
  return transaction(database(env), async (client) => {
    const control = await client.query<{ active_attempt_id: string | null }>(
      "SELECT active_attempt_id FROM workflow_control WHERE singleton FOR UPDATE",
    );
    const budgetResult = await client.query<{
      campaign_limit_micro_usd: string;
      available_credit_micro_usd: string | null;
      held_micro_usd: string;
      reconciled_spend_micro_usd: string;
    }>(
      `SELECT campaign_limit_micro_usd, available_credit_micro_usd, held_micro_usd, reconciled_spend_micro_usd
       FROM campaign_budget WHERE singleton FOR UPDATE`,
    );
    const reservationResult = await client.query<{
      id: string;
      attempt_no: number;
      state: string;
      amount_micro_usd: string;
    }>(
      `SELECT id, attempt_no, state, amount_micro_usd FROM phase_reservations
       WHERE id = $1 AND job_id = $2 AND phase = $3 FOR UPDATE`,
      [params.attemptId, params.jobId, params.phase],
    );
    const phaseColumn = params.phase === "assessment" ? "assessment_state" : "brief_state";
    const jobResult = await client.query<{ expires_at: Date; phase_state: string }>(
      `SELECT expires_at, ${phaseColumn} AS phase_state FROM jobs WHERE id = $1 FOR UPDATE`,
      [params.jobId],
    );
    const existing = await client.query<{
      reservation_id: string;
      phase: string;
      draft_attempt_id: string;
      review_attempt_id: string | null;
      plan_json: RepairPlan | null;
    }>(
      `SELECT reservation_id, phase, draft_attempt_id, review_attempt_id, plan_json
       FROM job_repairs WHERE job_id = $1 FOR UPDATE`,
      [params.jobId],
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      return row.reservation_id === params.attemptId && row.phase === params.phase
        && row.draft_attempt_id === draftAttemptId && row.review_attempt_id === reviewAttemptId
        && row.plan_json !== null && stableJson(row.plan_json) === stableJson(plan)
        ? "claimed" : "exhausted";
    }
    const reservation = reservationResult.rows[0];
    const job = jobResult.rows[0];
    if (control.rows[0]?.active_attempt_id !== params.attemptId || !job
      || job.phase_state !== "running" || job.expires_at.getTime() <= Date.now()
      || !budgetResult.rowCount
      || !reservation || reservation.state !== "held" || reservation.attempt_no !== 1
      || Number(reservation.amount_micro_usd) !== BASE_RESERVATION_MICRO_USD) return "exhausted";
    const latest = await client.query<{ id: string }>(
      "SELECT id FROM phase_reservations WHERE job_id = $1 AND phase = $2 ORDER BY attempt_no DESC LIMIT 1",
      [params.jobId, params.phase],
    );
    if (latest.rows[0]?.id !== reservation.id) return "exhausted";
    const attempts = await client.query<{
      id: string;
      reservation_id: string;
      phase: string;
      call_index: number;
      state: string;
      usage: unknown;
      model_profile_sha256: string | null;
    }>(
      "SELECT id, reservation_id, phase, call_index, state, usage, model_profile_sha256 FROM model_attempts WHERE job_id = $1 FOR UPDATE",
      [params.jobId],
    );
    const draft = attempts.rows.find((item) => item.id === draftAttemptId);
    const review = reviewAttemptId === null ? null : attempts.rows.find((item) => item.id === reviewAttemptId);
    const unresolved = attempts.rows.find((item) =>
      item.state === "prepared" || item.state === "dispatching" || item.state === "uncertain" || knownCostMicroUsd(item.usage) === null);
    if (unresolved) throw new ReconciliationRequired(unresolved.id);
    if (attempts.rows.some((item) => item.call_index > 2
      || (item.state !== "complete" && item.state !== "invalid"))
      || !draft || draft.reservation_id !== params.attemptId || draft.phase !== params.phase || draft.call_index !== 1
      || (draft.state !== "complete" && draft.state !== "invalid")
      || draft.model_profile_sha256 !== modelProfileHash(modelConfig(env))
      || (reviewAttemptId !== null && (!review || review.reservation_id !== params.attemptId
        || review.phase !== params.phase || review.call_index !== 2 || review.state !== "complete"))
      || (review != null && review.model_profile_sha256 !== draft.model_profile_sha256)
      || (reviewAttemptId === null && attempts.rows.some((item) => item.reservation_id === params.attemptId && item.call_index === 2))) {
      return "exhausted";
    }

    const budget = budgetResult.rows[0];
    if (budget.available_credit_micro_usd === null) return "credit_exhausted";
    const headroom = Math.min(Number(budget.campaign_limit_micro_usd), Number(budget.available_credit_micro_usd))
      - Number(budget.held_micro_usd) - Number(budget.reconciled_spend_micro_usd);
    if (headroom < REPAIR_ALLOWANCE_MICRO_USD) return "credit_exhausted";

    const grown = await client.query(
      `UPDATE phase_reservations SET amount_micro_usd = $2
       WHERE id = $1 AND state = 'held' AND amount_micro_usd = $3`,
      [params.attemptId, REPAIRED_RESERVATION_MICRO_USD, BASE_RESERVATION_MICRO_USD],
    );
    const held = await client.query(
      "UPDATE campaign_budget SET held_micro_usd = held_micro_usd + $1, updated_at = now() WHERE singleton",
      [REPAIR_ALLOWANCE_MICRO_USD],
    );
    if (!grown.rowCount || !held.rowCount) throw new Error("REPAIR_RESERVATION_GROW_FAILED");
    await client.query(
      `INSERT INTO job_repairs
         (job_id, reservation_id, phase, draft_attempt_id, review_attempt_id, plan_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [params.jobId, params.attemptId, params.phase, draftAttemptId, reviewAttemptId, JSON.stringify(plan)],
    );
    return "claimed";
  });
}

