import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { CreateJobResponse, Selection, StartBriefResponse, AssessmentResult, PhaseState } from "../shared/protocol.ts";
import type { Env } from "./env.ts";
import { database, transaction } from "./db.ts";
import { createCapability } from "./auth.ts";
import { loadCorpus, loadManifest } from "./corpus.ts";
import { HttpFailure } from "./errors.ts";
import { ownedJob } from "./jobs.ts";
import { validateSelections } from "./selections.ts";
import { revalidateAssessment } from "./gates.ts";

const RESERVATION_MICRO_USD = 600_000;
const JOB_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

interface BudgetRow {
  campaign_limit_micro_usd: string;
  available_credit_micro_usd: string | null;
  held_micro_usd: string;
  reconciled_spend_micro_usd: string;
  admission_enabled: boolean;
}

async function reserveBudget(client: PoolClient): Promise<void> {
  const result = await client.query<BudgetRow>(
    `SELECT campaign_limit_micro_usd, available_credit_micro_usd, held_micro_usd, reconciled_spend_micro_usd, admission_enabled
     FROM campaign_budget WHERE singleton FOR UPDATE`,
  );
  const budget = result.rows[0];
  if (!budget || !budget.admission_enabled || budget.available_credit_micro_usd === null) throw new HttpFailure(503, "ADMISSION_NOT_ENABLED");
  const authorized = Math.min(Number(budget.campaign_limit_micro_usd), Number(budget.available_credit_micro_usd));
  const headroom = authorized - Number(budget.held_micro_usd) - Number(budget.reconciled_spend_micro_usd);
  if (headroom < RESERVATION_MICRO_USD) throw new HttpFailure(402, "AUTHORIZED_CREDIT_EXHAUSTED");
  await client.query("UPDATE campaign_budget SET held_micro_usd = held_micro_usd + $1, updated_at = now() WHERE singleton", [RESERVATION_MICRO_USD]);
}

async function saveOutbox(client: PoolClient, jobId: string, phase: "assessment" | "brief", attemptNo: number): Promise<void> {
  const reservationId = randomUUID();
  const workflowId = `${jobId}-${phase}-${attemptNo}`;
  await client.query(
    "INSERT INTO phase_reservations (id, job_id, phase, attempt_no, amount_micro_usd) VALUES ($1, $2, $3, $4, $5)",
    [reservationId, jobId, phase, attemptNo, RESERVATION_MICRO_USD],
  );
  await client.query(
    "INSERT INTO job_outbox (id, job_id, phase, attempt_no, workflow_id) VALUES ($1, $2, $3, $4, $5)",
    [randomUUID(), jobId, phase, attemptNo, workflowId],
  );
  await client.query("UPDATE workflow_control SET active_attempt_id = $1, updated_at = now() WHERE singleton", [reservationId]);
}

async function lockWorkflow(client: PoolClient): Promise<void> {
  const result = await client.query<{ active_attempt_id: string | null }>(
    "SELECT active_attempt_id FROM workflow_control WHERE singleton FOR UPDATE",
  );
  if (!result.rowCount) throw new Error("WORKFLOW_CONTROL_UNINITIALIZED");
  if (result.rows[0].active_attempt_id) throw new HttpFailure(409, "WORKFLOW_BUSY", true);
}

export async function createAssessmentJob(env: Env, request: string): Promise<CreateJobResponse> {
  const corpus = await loadManifest(env);
  if (corpus.manifest.cases.length !== 8) throw new HttpFailure(503, "CORPUS_NOT_READY");
  if (new TextEncoder().encode(request).byteLength > 16 * 1024) throw new HttpFailure(413, "REQUEST_TOO_LARGE");
  const capability = await createCapability();
  const jobId = randomUUID();
  const expiresAt = new Date(Date.now() + JOB_LIFETIME_MS).toISOString();
  await transaction(database(env), async (client) => {
    await lockWorkflow(client);
    await reserveBudget(client);
    await client.query(
      "INSERT INTO jobs (id, capability_hash, request_text, corpus_version, corpus_sha256, expires_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [jobId, capability.hash, request, corpus.manifest.corpusVersion, corpus.manifestSha256, expiresAt],
    );
    await saveOutbox(client, jobId, "assessment", 1);
  });
  return { jobId, capability: capability.token, expiresAt };
}

function normalizedSelections(selections: Selection[]): Selection[] {
  return selections.map((item) => ({ ...item, passageIds: [...item.passageIds].sort() }))
    .sort((a, b) => `${a.caseId}/${a.artifactId}/${a.versionId}`.localeCompare(`${b.caseId}/${b.artifactId}/${b.versionId}`));
}

function sameSelections(left: Selection[] | null, right: Selection[]): boolean {
  return left !== null && JSON.stringify(normalizedSelections(left)) === JSON.stringify(normalizedSelections(right));
}

export async function startBrief(env: Env, jobId: string, capability: Buffer, selections: Selection[]): Promise<StartBriefResponse> {
  const pool = database(env);
  const preflightJob = await ownedJob(pool, jobId, capability);
  if (preflightJob.assessment_state !== "ready" || !preflightJob.assessment_result) throw new HttpFailure(409, "ASSESSMENT_NOT_READY");
  const normalizedInput = normalizedSelections(selections);
  if (preflightJob.brief_state === "reconciliation_required") throw new HttpFailure(409, "RECONCILIATION_REQUIRED");
  if (preflightJob.brief_state === "queued" || preflightJob.brief_state === "running") {
    if (sameSelections(preflightJob.brief_selections, normalizedInput)) return { jobId, briefState: preflightJob.brief_state };
    throw new HttpFailure(409, "BRIEF_ALREADY_RUNNING");
  }
  if (preflightJob.brief_state === "ready" && sameSelections(preflightJob.brief_selections, normalizedInput)) {
    return { jobId, briefState: "ready" };
  }
  const corpus = await loadCorpus(env);
  if (preflightJob.corpus_version !== corpus.manifest.corpusVersion || preflightJob.corpus_sha256 !== corpus.manifestSha256) throw new HttpFailure(409, "CORPUS_CHANGED");
  const assessment = revalidateAssessment(preflightJob.assessment_result, preflightJob.request_text, corpus);
  const checkedSelections = normalizedSelections(validateSelections(normalizedInput, assessment, corpus));

  const result = await transaction(pool, async (client) => {
    await lockWorkflow(client);
    const currentResult = await client.query<{
      brief_state: PhaseState;
      assessment_state: PhaseState;
      assessment_result: AssessmentResult | null;
      brief_selections: Selection[] | null;
      expires_at: Date;
      corpus_version: string;
      corpus_sha256: string;
    }>(
      `SELECT brief_state, assessment_state, assessment_result, brief_selections, corpus_version, corpus_sha256, expires_at
       FROM jobs WHERE id = $1 AND capability_hash = $2 FOR UPDATE`,
      [jobId, capability],
    );
    const current = currentResult.rows[0];
    if (!current) throw new HttpFailure(404, "JOB_NOT_FOUND");
    if (current.expires_at.getTime() <= Date.now()) throw new HttpFailure(410, "JOB_EXPIRED");
    if (current.assessment_state !== "ready" || !current.assessment_result) throw new HttpFailure(409, "ASSESSMENT_NOT_READY");
    if (current.corpus_version !== corpus.manifest.corpusVersion || current.corpus_sha256 !== corpus.manifestSha256) throw new HttpFailure(409, "CORPUS_CHANGED");
    if (current.brief_state === "reconciliation_required") throw new HttpFailure(409, "RECONCILIATION_REQUIRED");
    if (current.brief_state === "queued" || current.brief_state === "running") {
      if (sameSelections(current.brief_selections, checkedSelections)) return { briefState: current.brief_state };
      throw new HttpFailure(409, "BRIEF_ALREADY_RUNNING");
    }
    if (current.brief_state === "ready" && sameSelections(current.brief_selections, checkedSelections)) {
      return { briefState: "ready" as const };
    }
    await reserveBudget(client);
    const nextAttempt = await client.query<{ next_no: number }>(
      "SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next_no FROM phase_reservations WHERE job_id = $1 AND phase = 'brief'",
      [jobId],
    );
    await client.query(
      `UPDATE jobs SET brief_state = 'queued', brief_result = NULL, brief_selections = $2::jsonb,
       brief_queued_at = now(), brief_processing_started_at = NULL, brief_finished_at = NULL,
       error_code = NULL, stage = 'queued' WHERE id = $1`,
      [jobId, JSON.stringify(checkedSelections)],
    );
    await saveOutbox(client, jobId, "brief", nextAttempt.rows[0].next_no);
    return { briefState: "queued" as const };
  });
  return { jobId, briefState: result.briefState };
}
