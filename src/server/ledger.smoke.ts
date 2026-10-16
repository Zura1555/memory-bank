import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { ReconciliationRequired, runPaidStage } from "./calls.ts";
import type { Env } from "./env.ts";

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
const [jobId, reservationId, attemptId, settledJobId, settledReservationId, settledAttemptId] =
  Array.from({ length: 6 }, () => randomUUID());
let providerRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { providerRequests++; throw new Error("PROVIDER_DISPATCH_FORBIDDEN_IN_SMOKE"); };

async function verify(connectionString: string, expected: unknown): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    const snapshot: Record<string, unknown> = {};
    for (const table of ["campaign_budget", "workflow_control", "jobs", "phase_reservations", "model_attempts", "job_outbox", "operator_reconciliations"]) {
      snapshot[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    }
    assert.deepEqual(snapshot, expected, "Every ledger row must survive unchanged");
    const env = { APP_ENV: "development", LOCAL_DATABASE_URL: connectionString } as Env;
    for (const [job, reservation, attempt] of [[jobId, reservationId, attemptId], [settledJobId, settledReservationId, settledReservationId]]) {
      await assert.rejects(runPaidStage(env, {
        jobId: job, attemptId: reservation, phase: "assessment", workflowId: `${job}-assessment-1`,
      }, 1, "assessment_draft", { instructions: "No dispatch permitted", untrustedData: {} }),
      (error: unknown) => error instanceof ReconciliationRequired && error.attemptId === attempt);
    }
    assert.equal(providerRequests, 0, "Uncertain and reconciled attempts must reject replay before provider access");
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
      UPDATE campaign_budget SET available_credit_micro_usd = 4000000, held_micro_usd = 600000,
        reconciled_spend_micro_usd = 12345 WHERE singleton;
      INSERT INTO jobs (id, request_text, corpus_version, corpus_sha256, stage, assessment_state, expires_at) VALUES
        ('${jobId}', 'Synthetic restart smoke', 'ledger-smoke', repeat('a', 64), 'reconciliation_required', 'reconciliation_required', now() + interval '1 day'),
        ('${settledJobId}', 'Synthetic settled smoke', 'ledger-smoke', repeat('a', 64), 'failed', 'failed', now() + interval '1 day');
      INSERT INTO phase_reservations (id, job_id, phase, attempt_no, amount_micro_usd, state, actual_micro_usd, reconciliation_note, reconciled_at) VALUES
        ('${reservationId}', '${jobId}', 'assessment', 1, 600000, 'held', NULL, NULL, NULL),
        ('${settledReservationId}', '${settledJobId}', 'assessment', 1, 600000, 'reconciled', 12345, 'Synthetic smoke only', now());
      UPDATE workflow_control SET active_attempt_id = '${reservationId}' WHERE singleton;
      INSERT INTO model_attempts (id, reservation_id, job_id, phase, call_index, state, requested_model, generation_id, error_code) VALUES
        ('${attemptId}', '${reservationId}', '${jobId}', 'assessment', 1, 'uncertain', 'smoke-no-provider', 'synthetic-uncertain', 'MODEL_DISPATCH_UNCERTAIN'),
        ('${settledAttemptId}', '${settledReservationId}', '${settledJobId}', 'assessment', 1, 'reconciled', 'smoke-no-provider', 'synthetic-settled', NULL);
      INSERT INTO job_outbox (id, job_id, phase, attempt_no, workflow_id)
        VALUES ('${randomUUID()}', '${jobId}', 'assessment', 1, '${jobId}-assessment-1');
      INSERT INTO operator_reconciliations (id, reservation_id, actual_micro_usd, note, operator_subject)
        VALUES ('${randomUUID()}', '${settledReservationId}', 12345, 'Synthetic smoke only; not provider billing', 'ledger-smoke');
      COMMIT;`);
    expected = {};
    for (const table of ["campaign_budget", "workflow_control", "jobs", "phase_reservations", "model_attempts", "job_outbox", "operator_reconciliations"]) {
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
  console.log("Restart preserved all seven ledger tables, disabled admission, active hold, audit, and replay guards.");

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
  console.log("Private backup outside /tmp restored every row into a fresh database; replay guards passed; provider requests: 0.");
} catch (error) {
  console.error(compose(["logs", "--no-color", "postgres"]).toString());
  throw error;
} finally {
  globalThis.fetch = originalFetch;
  // Only this randomly named project's synthetic volumes are removed, never the local campaign.
  compose(["down", "--volumes"]);
  rmSync(scratch, { recursive: true, force: true });
}
