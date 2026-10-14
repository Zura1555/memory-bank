import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { Env, WorkflowParams } from "./env.ts";
import { database } from "./db.ts";
import { ModelCallError, callOpenRouter, type ModelStage, type StageOutput } from "./openrouter.ts";
import type { StagePrompt } from "./prompts.ts";

interface BegunAttempt {
  attemptId: string;
  cached: boolean;
}

export class ReconciliationRequired extends Error {
  constructor(readonly attemptId: string) {
    super("A prior paid dispatch has an uncertain outcome and cannot be repeated.");
    this.name = "ReconciliationRequired";
  }
}

async function beginAttempt(client: PoolClient, params: WorkflowParams, callIndex: 1 | 2): Promise<BegunAttempt> {
  const reservation = await client.query<{ id: string }>(
    "SELECT id FROM phase_reservations WHERE id = $1 AND job_id = $2 AND phase = $3 AND state = 'held' FOR UPDATE",
    [params.attemptId, params.jobId, params.phase],
  );
  if (!reservation.rowCount) throw new ReconciliationRequired(params.attemptId);
  const existing = await client.query<{ id: string; state: string; result_json: StageOutput | null }>(
    "SELECT id, state, result_json FROM model_attempts WHERE reservation_id = $1 AND call_index = $2 FOR UPDATE",
    [params.attemptId, callIndex],
  );
  if (existing.rowCount) {
    const attempt = existing.rows[0];
    if (attempt.state === "complete" && attempt.result_json) return { attemptId: attempt.id, cached: true };
    throw new ReconciliationRequired(attempt.id);
  }
  const id = randomUUID();
  await client.query(
    `INSERT INTO model_attempts (id, reservation_id, job_id, phase, call_index, state, requested_model, dispatched_at)
     VALUES ($1, $2, $3, $4, $5, 'dispatching', 'openai/gpt-6-luna', now())`,
    [id, params.attemptId, params.jobId, params.phase, callIndex],
  );
  return { attemptId: id, cached: false };
}

export async function runPaidStage(
  env: Env,
  params: WorkflowParams,
  callIndex: 1 | 2,
  stage: ModelStage,
  prompt: StagePrompt,
): Promise<string> {
  const pool = database(env);
  const begun = await pool.connect();
  let attempt: BegunAttempt;
  try {
    await begun.query("BEGIN");
    attempt = await beginAttempt(begun, params, callIndex);
    await begun.query("COMMIT");
  } catch (error) {
    await begun.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    begun.release();
  }
  if (attempt.cached) return attempt.attemptId;

  let reply: Awaited<ReturnType<typeof callOpenRouter>>;
  try {
    reply = await callOpenRouter(env, stage, prompt);
  } catch (error) {
    const code = error instanceof ModelCallError ? error.code : "MODEL_DISPATCH_UNCERTAIN";
    const state = error instanceof ModelCallError && !error.uncertain ? "failed" : "uncertain";
    try {
      const updated = await pool.query(
        "UPDATE model_attempts SET state = $2, error_code = $3, completed_at = now() WHERE id = $1 AND state = 'dispatching'",
        [attempt.attemptId, state, code],
      );
      if (!updated.rowCount) throw new Error("MODEL_ATTEMPT_STATE_CHANGED");
    } catch {
      throw new ReconciliationRequired(attempt.attemptId);
    }
    if (state === "uncertain") throw new ReconciliationRequired(attempt.attemptId);
    throw error;
  }

  try {
    const updated = await pool.query(
      `UPDATE model_attempts a SET state = 'complete', returned_model = $2, provider = $3, generation_id = $4,
       usage = $5::jsonb, result_json = CASE WHEN j.expires_at > clock_timestamp() THEN $6::jsonb ELSE NULL END,
       completed_at = clock_timestamp()
       FROM jobs j WHERE a.id = $1 AND a.job_id = j.id AND a.state = 'dispatching' RETURNING a.id`,
      [attempt.attemptId, reply.usage.returnedModel, reply.usage.provider, reply.usage.responseId,
        JSON.stringify(reply.usage), JSON.stringify(reply.output)],
    );
    if (!updated.rowCount) throw new Error("MODEL_ATTEMPT_STATE_CHANGED");
  } catch {
    throw new ReconciliationRequired(attempt.attemptId);
  }
  return attempt.attemptId;
}

export async function loadStageOutput(env: Env, attemptId: string): Promise<StageOutput> {
  const result = await database(env).query<{
    state: string;
    result_json: StageOutput | null;
    expires_at: Date;
  }>(
    `SELECT a.state, a.result_json, j.expires_at
     FROM model_attempts a JOIN jobs j ON j.id = a.job_id WHERE a.id = $1`,
    [attemptId],
  );
  const attempt = result.rows[0];
  if (!attempt || attempt.state !== "complete") throw new ReconciliationRequired(attemptId);
  if (attempt.expires_at.getTime() <= Date.now()) throw new ModelCallError("JOB_EXPIRED", null, false);
  if (!attempt.result_json) throw new ModelCallError("MODEL_RESULT_UNAVAILABLE", null, false);
  return attempt.result_json;
}
