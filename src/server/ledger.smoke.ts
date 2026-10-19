import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { assessmentDraftSchema } from "./schemas.ts";
import { ReconciliationRequired, claimJobRepair, loadStageAttempt, runPaidStage } from "./calls.ts";
import type { Env } from "./env.ts";
import { operatorStatus } from "./operator.ts";
import { startBrief } from "./admission.ts";
import type { Selection } from "../shared/protocol.ts";
import { expireJobContent } from "./retention.ts";
import { schemaRepairPlan, type RepairPlan } from "./repair.ts";

// Never reads .dev.vars, accepts a target database, or uses an existing Compose project.
const root = fileURLToPath(new URL("../../", import.meta.url));
const project = `memory-bank-ledger-smoke-${randomUUID()}`;
const stateDir = join(homedir(), ".local", "state", "memory-bank");
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(stateDir, "ledger-smoke-"));
const override = join(scratch, "compose.yaml");
writeFileSync(override, 'services:\n  postgres:\n    ports: !override ["127.0.0.1::5432"]\n', { mode: 0o600 });
const composeArgs = ["compose", "-p", project, "-f", join(root, "compose.yaml"), "-f", override];
function compose(args: string[], input?: Buffer): Buffer {
  return execFileSync("docker", [...composeArgs, ...args], { cwd: root, input, timeout: 720_000 });
}
const [jobId, reservationId, settledJobId, settledReservationId, settledAttemptId, outputJobId, outputReservationId] =
  Array.from({ length: 7 }, () => randomUUID());
let attemptId: string;
let outputAttemptId: string;
const repairJobId = randomUUID();
const repairReservationId = randomUUID();
let originalRepairAttemptId: string;
let cachedRepairAttemptId: string;
let durableRepairPlan: RepairPlan;
let repairProviderRequests = 0;
const repairedLedgerDraft = assessmentDraftSchema.parse({
  requestConstraints: { product_version: [], environment: [], scale: [], identity_access: [], recovery_operations: [] },
  cases: Array.from({ length: 8 }, (_, index) => ({ caseId: `synthetic-${index}`, outcome: "unknown" as const, artifactWork: [] })),
  leads: [], contrasts: [], clarifyingClaimIds: ["private-repaired-draft"], missingEvidenceRequests: [], claims: [],
});
const repairPrompt = {
  instructions: "Synthetic ledger-only draft",
  untrustedData: {},
  responseSchema: assessmentDraftSchema,
};
function repairEnv(connectionString: string): Env {
  return { APP_ENV: "development", LOCAL_DATABASE_URL: connectionString, OPENROUTER_API_KEY: "synthetic-only" } as Env;
}
const repairParams = {
  jobId: repairJobId, attemptId: repairReservationId, phase: "assessment" as const, workflowId: `${repairJobId}-assessment-1`,
};
const readyJobId = randomUUID();
const readyCapabilityHash = Buffer.alloc(32, 1);
const readySelections: Selection[] = [{ caseId: "case-1", artifactId: "procedure", versionId: "procedure-v1", passageIds: ["passage-b", "passage-a"] }];
let providerRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  providerRequests++;
  if (providerRequests === 2) return Response.json({
    id: "gen-synthetic-truncated", model: "openai/gpt-6-luna", provider: "OpenAI",
    choices: [{ finish_reason: "length", message: { content: "PRIVATE_SYNTHETIC_PARTIAL_OUTPUT" } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 },
  });
  if (providerRequests !== 1) throw new Error("PROVIDER_REPLAY_FORBIDDEN_IN_SMOKE");
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("x-opencode-session"), jobId);
  assert.match(headers.get("user-agent")!, /^memory-bank\//);
  return new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError("PRIVATE_SYNTHETIC_TRANSPORT_DETAIL")); },
  }), { headers: { "x-generation-id": "gen-synthetic-interrupted" } });
};

async function verify(connectionString: string, expected: unknown): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    const snapshot: Record<string, unknown> = {};
    for (const table of ["campaign_budget", "workflow_control", "jobs", "phase_reservations", "model_attempts", "job_outbox", "operator_reconciliations", "job_repairs"]) {
      snapshot[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    }
    assert.deepEqual(snapshot, expected, "Every ledger row must survive unchanged");
    const env = { APP_ENV: "development", LOCAL_DATABASE_URL: connectionString } as Env;
    for (const [job, reservation, attempt] of [
      [jobId, reservationId, attemptId], [settledJobId, settledReservationId, settledReservationId],
      [outputJobId, outputReservationId, outputAttemptId],
    ]) {
      await assert.rejects(runPaidStage(env, {
        jobId: job, attemptId: reservation, phase: "assessment", workflowId: `${job}-assessment-1`,
      }, 1, "assessment_draft", { instructions: "No dispatch permitted", untrustedData: {} }),
      (error: unknown) => error instanceof ReconciliationRequired && error.attemptId === attempt);
    }
    assert.deepEqual(await startBrief(env, readyJobId, readyCapabilityHash, readySelections), {
      jobId: readyJobId, briefState: "ready",
    }, "A persisted JSONB selection must resume the ready brief regardless of object or passage order");
    assert.equal(providerRequests, 2, "Replay must not add to the two synthetic provider requests");
    const repairEnvironment = repairEnv(connectionString);
    assert.equal(await runPaidStage(repairEnvironment, repairParams, 1, "assessment_draft", repairPrompt), originalRepairAttemptId);
    assert.equal(await runPaidStage(repairEnvironment, repairParams, 3, "assessment_draft", repairPrompt), cachedRepairAttemptId);
    assert.equal(await claimJobRepair(repairEnvironment, repairParams, originalRepairAttemptId, null, durableRepairPlan), "claimed");
    assert.equal(repairProviderRequests, 2, "Restart and duplicate claim cannot repeat either repair dispatch");
    for (const [table, rows] of Object.entries(snapshot)) {
      assert.deepEqual((await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows, rows,
        "Rejected replay must not mutate accounting");
    }
  } finally {
    await pool.end();
  }
}

try {
  compose(["up", "-d", "--wait", "postgres"]);
  const address = compose(["port", "postgres", "5432"]).toString().trim();
  const connectionString = `postgresql://memory_bank:local_only@${address}/memory_bank`;
  const pool = new Pool({ connectionString });
  let expected: Record<string, unknown>;
  try {
    const initial = (await pool.query("SELECT available_credit_micro_usd, admission_enabled FROM campaign_budget")).rows[0];
    assert.deepEqual(initial, { available_credit_micro_usd: null, admission_enabled: false });
    // Synthetic state only: no historical IDs, provider charges, credentials, or paid jobs.
    await pool.query(`BEGIN;
      UPDATE campaign_budget SET available_credit_micro_usd = 4000000, held_micro_usd = 1200000,
        reconciled_spend_micro_usd = 12345 WHERE singleton;
      INSERT INTO jobs (id, request_text, corpus_version, corpus_sha256, stage, assessment_state, expires_at) VALUES
        ('${jobId}', 'Synthetic restart smoke', 'ledger-smoke', repeat('a', 64), 'reconciliation_required', 'reconciliation_required', now() + interval '1 day'),
        ('${settledJobId}', 'Synthetic settled smoke', 'ledger-smoke', repeat('a', 64), 'failed', 'failed', now() + interval '1 day'),
        ('${outputJobId}', 'Synthetic incomplete output smoke', 'ledger-smoke', repeat('a', 64), 'reconciliation_required', 'reconciliation_required', now() + interval '1 day');
      INSERT INTO phase_reservations (id, job_id, phase, attempt_no, amount_micro_usd, state, actual_micro_usd, reconciliation_note, reconciled_at) VALUES
        ('${reservationId}', '${jobId}', 'assessment', 1, 600000, 'held', NULL, NULL, NULL),
        ('${settledReservationId}', '${settledJobId}', 'assessment', 1, 600000, 'reconciled', 12345, 'Synthetic smoke only', now()),
        ('${outputReservationId}', '${outputJobId}', 'assessment', 1, 600000, 'held', NULL, NULL, NULL);
      UPDATE workflow_control SET active_attempt_id = '${reservationId}' WHERE singleton;
      INSERT INTO model_attempts (id, reservation_id, job_id, phase, call_index, state, requested_model, generation_id, error_code) VALUES
        ('${settledAttemptId}', '${settledReservationId}', '${settledJobId}', 'assessment', 1, 'reconciled', 'smoke-no-provider', 'synthetic-settled', NULL);
      INSERT INTO job_outbox (id, job_id, phase, attempt_no, workflow_id)
        VALUES ('${randomUUID()}', '${jobId}', 'assessment', 1, '${jobId}-assessment-1');
      INSERT INTO operator_reconciliations (id, reservation_id, actual_micro_usd, note, operator_subject)
        VALUES ('${randomUUID()}', '${settledReservationId}', 12345, 'Synthetic smoke only; not provider billing', 'ledger-smoke');
      COMMIT;`);
    await pool.query(
      `INSERT INTO jobs (id, capability_hash, request_text, corpus_version, corpus_sha256, stage,
         assessment_state, assessment_result, brief_state, brief_selections, expires_at)
       VALUES ($1, $2, 'Synthetic ready brief', 'ledger-smoke', repeat('a', 64), 'ready',
         'ready', '{}'::jsonb, 'ready', $3::jsonb, now() + interval '1 day')`,
      [readyJobId, readyCapabilityHash, JSON.stringify(readySelections)],
    );
    const env = {
      APP_ENV: "development", LOCAL_DATABASE_URL: connectionString,
      MODEL_PROVIDER: "opencode-go", MODEL_API: "responses", MODEL_NAME: "synthetic-model", OPENCODE_API_KEY: "synthetic-only",
    } as Env;
    await assert.rejects(runPaidStage(env, {
      jobId, attemptId: reservationId, phase: "assessment", workflowId: `${jobId}-assessment-1`,
    }, 1, "assessment_draft", { instructions: "Synthetic interrupted-body smoke", untrustedData: {} }),
    (error: unknown) => {
      assert.ok(error instanceof ReconciliationRequired);
      assert.equal(error.code, "MODEL_DISPATCH_UNCERTAIN");
      attemptId = error.attemptId;
      return true;
    });
    const diagnostic = (await pool.query(
      `SELECT state, error_code, generation_id, http_status, failure_phase, failure_cause, requested_model, provider
       FROM model_attempts WHERE id = $1`, [attemptId!],
    )).rows[0];
    assert.deepEqual(diagnostic, {
      state: "uncertain", error_code: "MODEL_DISPATCH_UNCERTAIN", generation_id: "gen-synthetic-interrupted",
      http_status: 200, failure_phase: "response_body", failure_cause: "transport_error",
      requested_model: "synthetic-model", provider: "opencode.ai",
    });
    const status = await operatorStatus(env) as { recentModelAttempts: { id: string }[] };
    assert.deepEqual(
      Object.fromEntries(Object.entries(status.recentModelAttempts.find((attempt) => attempt.id === attemptId)!)
        .filter(([key]) => key in diagnostic)), diagnostic,
    );
    assert.ok(!JSON.stringify(status).includes("PRIVATE_SYNTHETIC_TRANSPORT_DETAIL"));
    await assert.rejects(runPaidStage({
      APP_ENV: "development", LOCAL_DATABASE_URL: connectionString, OPENROUTER_API_KEY: "synthetic-only",
    } as Env, {
      jobId: outputJobId, attemptId: outputReservationId, phase: "assessment", workflowId: `${outputJobId}-assessment-1`,
    }, 1, "assessment_draft", { instructions: "Synthetic incomplete output smoke", untrustedData: {} }),
    (error: unknown) => {
      assert.ok(error instanceof ReconciliationRequired);
      assert.equal(error.code, "MODEL_OUTPUT_TOKEN_LIMIT");
      outputAttemptId = error.attemptId;
      return true;
    });
    const outputDiagnostic = (await pool.query(
      `SELECT state, error_code, generation_id, usage, returned_model, provider, result_json
       FROM model_attempts WHERE id = $1`, [outputAttemptId!],
    )).rows[0];
    assert.deepEqual(outputDiagnostic, {
      state: "uncertain", error_code: "MODEL_OUTPUT_TOKEN_LIMIT", generation_id: "gen-synthetic-truncated",
      usage: { promptTokens: 100, completionTokens: 20, reportedCostUsd: 0.001,
        responseId: "gen-synthetic-truncated", requestedModel: "openai/gpt-6-luna",
        returnedModel: "openai/gpt-6-luna", provider: "OpenAI" },
      returned_model: "openai/gpt-6-luna", provider: "OpenAI", result_json: null,
    });
    const outputStatus = await operatorStatus(env) as { recentModelAttempts: { id: string }[] };
    assert.deepEqual(
      Object.fromEntries(Object.entries(outputStatus.recentModelAttempts.find((attempt) => attempt.id === outputAttemptId)!)
        .filter(([key]) => key in outputDiagnostic)),
      Object.fromEntries(Object.entries(outputDiagnostic).filter(([key]) => key !== "result_json")),
    );
    assert.ok(!JSON.stringify(outputStatus).includes("PRIVATE_SYNTHETIC_"));
    assert.deepEqual((await pool.query("SELECT held_micro_usd, reconciled_spend_micro_usd, admission_enabled FROM campaign_budget")).rows[0],
      { held_micro_usd: "1200000", reconciled_spend_micro_usd: "12345", admission_enabled: false });
    console.log("Real paid-stage failures retained safe causes and reported usage without exposing output or releasing holds; two synthetic responses, no provider network access.");
    await pool.query(
      `INSERT INTO jobs (id, request_text, corpus_version, corpus_sha256, stage, assessment_state, expires_at)
       VALUES ($1, 'Private synthetic repair', 'ledger-smoke', repeat('b',64), 'drafting', 'running', now()+interval '1 day')`, [repairJobId],
    );
    await pool.query(
      `INSERT INTO phase_reservations (id,job_id,phase,attempt_no,amount_micro_usd,state)
       VALUES ($1,$2,'assessment',1,600000,'held')`, [repairReservationId, repairJobId],
    );
    await pool.query("UPDATE campaign_budget SET held_micro_usd=held_micro_usd+600000 WHERE singleton");
    await pool.query("UPDATE workflow_control SET active_attempt_id=$1 WHERE singleton", [repairReservationId]);
    const failureFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      repairProviderRequests++;
      assert.ok(repairProviderRequests <= 2, "REPAIR_REPLAY_FORBIDDEN");
      return Response.json({
        id: `gen-synthetic-repair-${repairProviderRequests}`, model: "openai/gpt-6-luna", provider: "OpenAI",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(repairProviderRequests === 1
          ? { privateInvalidDraft: "not the required schema" } : repairedLedgerDraft) } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
      });
    };
    try {
      const repairEnvironment = repairEnv(connectionString);
      originalRepairAttemptId = await runPaidStage(repairEnvironment, repairParams, 1, "assessment_draft", repairPrompt);
      const invalid = await loadStageAttempt(repairEnvironment, originalRepairAttemptId);
      assert.equal(invalid.state, "invalid");
      durableRepairPlan = schemaRepairPlan(invalid.issues);
      assert.deepEqual(await Promise.all([
        claimJobRepair(repairEnvironment, repairParams, originalRepairAttemptId, null, durableRepairPlan),
        claimJobRepair(repairEnvironment, repairParams, originalRepairAttemptId, null, durableRepairPlan),
      ]), ["claimed", "claimed"]);
      assert.equal((await pool.query("SELECT held_micro_usd FROM campaign_budget")).rows[0].held_micro_usd, "2400000",
        "Concurrent claims must grow the original hold exactly once");
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM job_repairs WHERE job_id=$1", [repairJobId])).rows[0].count, 1);
      await assert.rejects(runPaidStage({ ...repairEnvironment, MODEL_BASE_URL: "http://localhost:1/different" }, repairParams,
        3, "assessment_draft", repairPrompt), { code: "REPAIR_DISPATCH_NOT_ALLOWED" });
      assert.equal(repairProviderRequests, 1, "Profile drift cannot dispatch a repair");
      cachedRepairAttemptId = await runPaidStage(repairEnvironment, repairParams, 3, "assessment_draft", repairPrompt);
      const repaired = await loadStageAttempt(repairEnvironment, cachedRepairAttemptId);
      assert.equal(repaired.state, "complete");
      assert.deepEqual(repaired.rawOutput, repairedLedgerDraft);
      assert.ok(!JSON.stringify(await operatorStatus(repairEnvironment)).includes("private-repaired-draft"), "Status must not disclose drafts");
    } finally {
      globalThis.fetch = failureFetch;
    }
    expected = {};
    for (const table of ["campaign_budget", "workflow_control", "jobs", "phase_reservations", "model_attempts", "job_outbox", "operator_reconciliations", "job_repairs"]) {
      expected[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    }
  } finally {
    await pool.end();
  }
  await verify(connectionString, expected);
  compose(["restart", "postgres"]);
  compose(["up", "-d", "--wait", "postgres"]);
  const restartedAddress = compose(["port", "postgres", "5432"]).toString().trim();
  await verify(`postgresql://memory_bank:local_only@${restartedAddress}/memory_bank`, expected);
  console.log("Restart preserved all eight ledger tables, disabled admission, original and repair holds, and cached dispatches.");

  // Container replacement is stronger than restart: only the named volume can retain this state.
  compose(["up", "-d", "--wait", "--force-recreate", "postgres"]);
  const recreatedAddress = compose(["port", "postgres", "5432"]).toString().trim();
  const recreatedConnection = `postgresql://memory_bank:local_only@${recreatedAddress}/memory_bank`;
  await verify(recreatedConnection, expected);
  console.log("Container recreation preserved the same accounting and replay guards.");

  const backup = join(scratch, "ledger.dump");
  writeFileSync(backup, compose(["exec", "-T", "postgres", "pg_dump", "-U", "memory_bank", "-d", "memory_bank", "--format=custom"]), { mode: 0o600 });
  compose(["exec", "-T", "postgres", "createdb", "-U", "memory_bank", "-T", "template0", "memory_bank_restore"]);
  compose(["exec", "-T", "postgres", "pg_restore", "-U", "memory_bank", "-d", "memory_bank_restore", "--exit-on-error", "--single-transaction"], readFileSync(backup));
  compose(["exec", "-T", "postgres", "psql", "-U", "memory_bank", "-d", "memory_bank_restore", "-v", "ON_ERROR_STOP=1", "-c",
    "UPDATE campaign_budget SET admission_enabled = false, updated_at = now() WHERE singleton AND admission_enabled;"]);
  const restoredConnection = new URL(recreatedConnection);
  restoredConnection.pathname = "/memory_bank_restore";
  await verify(restoredConnection.href, expected);
  console.log("Private backup outside /tmp restored every row, including failure diagnostics; replay added zero provider requests.");

  const expiryPool = new Pool({ connectionString: restoredConnection.href });
  const expiryEnv = repairEnv(restoredConnection.href);
  try {
    await expiryPool.query("UPDATE jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [repairJobId]);
    await expireJobContent(expiryEnv);
    const expiredAttempts = (await expiryPool.query(
      "SELECT state,usage,result_json,raw_output,validation_issues FROM model_attempts WHERE job_id=$1 ORDER BY call_index", [repairJobId],
    )).rows;
    assert.deepEqual(expiredAttempts.map((row) => [row.state, row.result_json, row.raw_output, row.validation_issues]), [
      ["invalid", null, null, null], ["complete", null, null, null],
    ]);
    assert.ok(expiredAttempts.every((row) => row.usage.reportedCostUsd === 0), "Expiry must retain usage");
    assert.equal((await expiryPool.query("SELECT plan_json FROM job_repairs WHERE job_id=$1", [repairJobId])).rows[0].plan_json, null);
    const lateJobId = randomUUID();
    const lateReservationId = randomUUID();
    await expiryPool.query(
      `INSERT INTO jobs(id,request_text,corpus_version,corpus_sha256,stage,assessment_state,expires_at)
       VALUES($1,'Synthetic late repair','ledger-smoke',repeat('c',64),'drafting','running',now()+interval '1 day')`, [lateJobId],
    );
    await expiryPool.query(
      `INSERT INTO phase_reservations(id,job_id,phase,attempt_no,amount_micro_usd,state)
       VALUES($1,$2,'assessment',1,600000,'held')`, [lateReservationId, lateJobId],
    );
    await expiryPool.query("UPDATE campaign_budget SET held_micro_usd=held_micro_usd+600000 WHERE singleton");
    await expiryPool.query("UPDATE workflow_control SET active_attempt_id=$1 WHERE singleton", [lateReservationId]);
    const lateParams = { jobId: lateJobId, attemptId: lateReservationId, phase: "assessment" as const, workflowId: `${lateJobId}-assessment-1` };
    const failureFetch = globalThis.fetch;
    let lateCalls = 0;
    globalThis.fetch = async () => {
      lateCalls++;
      assert.ok(lateCalls <= 2, "LATE_REPAIR_REPLAY_FORBIDDEN");
      if (lateCalls === 2) await expiryPool.query("UPDATE jobs SET created_at=clock_timestamp()-interval '7 days', expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [lateJobId]);
      return Response.json({
        id: `gen-synthetic-late-${lateCalls}`, model: "openai/gpt-6-luna", provider: "OpenAI",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(lateCalls === 1 ? { invalid: true } : repairedLedgerDraft) } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, ...(lateCalls === 1 ? { cost: 0 } : {}) },
      });
    };
    try {
      const invalidId = await runPaidStage(expiryEnv, lateParams, 1, "assessment_draft", repairPrompt);
      const plan = schemaRepairPlan((await loadStageAttempt(expiryEnv, invalidId)).issues);
      assert.equal(await claimJobRepair(expiryEnv, lateParams, invalidId, null, plan), "claimed");
      await assert.rejects(runPaidStage(expiryEnv, lateParams, 3, "assessment_draft", repairPrompt),
        (error: unknown) => error instanceof ReconciliationRequired);
      await expireJobContent(expiryEnv);
      const rows = (await expiryPool.query(
        "SELECT state,usage,result_json,raw_output,validation_issues FROM model_attempts WHERE job_id=$1 ORDER BY call_index", [lateJobId],
      )).rows;
      assert.deepEqual(rows.map((row) => [row.state, row.result_json, row.raw_output, row.validation_issues]), [
        ["invalid", null, null, null], ["uncertain", null, null, null],
      ]);
      assert.equal(rows[1].usage.reportedCostUsd, null);
      assert.equal((await expiryPool.query("SELECT plan_json FROM job_repairs WHERE job_id=$1", [lateJobId])).rows[0].plan_json, null);
      assert.equal((await expiryPool.query("SELECT active_attempt_id FROM workflow_control")).rows[0].active_attempt_id, lateReservationId);
      assert.equal((await expiryPool.query("SELECT held_micro_usd FROM campaign_budget")).rows[0].held_micro_usd, "3600000");
      assert.equal(lateCalls, 2);
    } finally {
      globalThis.fetch = failureFetch;
    }
    console.log("Expiry scrubbed draft/plan content; late unknown-cost repair stayed uncertain with its hold and control intact.");
  } finally {
    await expiryPool.end();
  }
} catch (error) {
  console.error(compose(["logs", "--no-color", "postgres"]).toString());
  throw error;
} finally {
  globalThis.fetch = originalFetch;
  // Only this randomly named project's synthetic volumes are removed, never the local campaign.
  compose(["down", "--volumes"]);
  rmSync(scratch, { recursive: true, force: true });
}
