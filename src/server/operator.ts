import * as z from "zod";
import type { Env } from "./env.ts";
import { database, transaction } from "./db.ts";
import { operatorAuthorized } from "./auth.ts";
import { HttpFailure } from "./errors.ts";
import { ModelCallError, modelConfig } from "./model.ts";

const CAMPAIGN_LIMIT_MICRO_USD = 5_000_000;

export const operatorBudgetSchema = z.object({
  availableCreditMicroUsd: z.number().int().safe().min(0).max(CAMPAIGN_LIMIT_MICRO_USD),
  admissionEnabled: z.boolean(),
}).strict();

export const operatorReconciliationSchema = z.object({
  reservationId: z.string().uuid(),
  actualMicroUsd: z.number().int().safe().min(0),
  note: z.string().trim().min(1).max(1_000),
  confirmAbandonedDispatch: z.boolean().optional(),
}).strict();

export type OperatorBudgetUpdate = z.infer<typeof operatorBudgetSchema>;
export type OperatorReconciliation = z.infer<typeof operatorReconciliationSchema>;

interface BudgetRow {
  campaign_limit_micro_usd: string;
  available_credit_micro_usd: string | null;
  held_micro_usd: string;
  reconciled_spend_micro_usd: string;
  admission_enabled: boolean;
}

export function requireOperator(env: Env, authorization: string | null): void {
  if (!operatorAuthorized(authorization, env.OPERATOR_TOKEN)) throw new HttpFailure(404, "NOT_FOUND");
}

export async function operatorStatus(env: Env): Promise<object> {
  const pool = database(env);
  const [budgetResult, controlResult, jobsResult, attemptsResult, reservationsResult, outboxResult, reconciliationsResult] = await Promise.all([
    pool.query<BudgetRow>(
      `SELECT campaign_limit_micro_usd, available_credit_micro_usd, held_micro_usd,
         reconciled_spend_micro_usd, admission_enabled FROM campaign_budget WHERE singleton`,
    ),
    pool.query<{ active_attempt_id: string | null }>("SELECT active_attempt_id FROM workflow_control WHERE singleton"),
    pool.query(
      `SELECT id, stage, assessment_state, brief_state, error_code, created_at, expires_at
       FROM jobs WHERE assessment_state IN ('queued', 'running', 'reconciliation_required')
         OR brief_state IN ('queued', 'running', 'reconciliation_required')
       ORDER BY created_at DESC LIMIT 25`,
    ),
    pool.query(
      `SELECT id, reservation_id, job_id, phase, call_index, state, requested_model, returned_model, provider,
         generation_id, usage, error_code, http_status, failure_phase, failure_cause, dispatched_at, completed_at
       FROM model_attempts ORDER BY created_at DESC LIMIT 50`,
    ),
    pool.query(
      `SELECT id, job_id, phase, attempt_no, amount_micro_usd, state, actual_micro_usd,
         reconciliation_note, created_at, reconciled_at
       FROM phase_reservations ORDER BY created_at DESC LIMIT 50`,
    ),
    pool.query(
      `SELECT o.job_id, o.phase, o.attempt_no, o.workflow_id, r.id AS reservation_id,
         o.published_at, o.created_at
       FROM job_outbox o JOIN phase_reservations r
         ON r.job_id = o.job_id AND r.phase = o.phase AND r.attempt_no = o.attempt_no
       ORDER BY o.created_at DESC LIMIT 50`,
    ),
    pool.query(
      `SELECT reservation_id, actual_micro_usd, note, operator_subject, confirmed_abandoned_dispatch, created_at
       FROM operator_reconciliations ORDER BY created_at DESC LIMIT 50`,
    ),
  ]);
  const budget = budgetResult.rows[0];
  if (!budget) throw new Error("CAMPAIGN_BUDGET_UNINITIALIZED");
  const limit = Number(budget.campaign_limit_micro_usd);
  const available = Number(budget.available_credit_micro_usd ?? 0);
  const held = Number(budget.held_micro_usd);
  const reconciled = Number(budget.reconciled_spend_micro_usd);
  return {
    campaign: {
      limitMicroUsd: limit,
      availableCreditMicroUsd: budget.available_credit_micro_usd === null ? null : available,
      heldMicroUsd: held,
      reconciledSpendMicroUsd: reconciled,
      headroomMicroUsd: Math.min(limit, available) - held - reconciled,
      admissionEnabled: budget.admission_enabled,
    },
    activeAttemptId: controlResult.rows[0]?.active_attempt_id ?? null,
    pendingJobs: jobsResult.rows,
    recentModelAttempts: attemptsResult.rows,
    reconciliations: reconciliationsResult.rows,
    workflows: outboxResult.rows,
  };
}

export async function updateOperatorBudget(env: Env, update: OperatorBudgetUpdate): Promise<void> {
  if (update.admissionEnabled) {
    try {
      if (!modelConfig(env).apiKey) throw new ModelCallError("MODEL_CREDENTIAL_UNAVAILABLE", null, false);
    } catch (error) {
      if (error instanceof ModelCallError) throw new HttpFailure(409, error.code);
      throw error;
    }
  }
  const result = await database(env).query(
    `UPDATE campaign_budget SET available_credit_micro_usd = $1, admission_enabled = $2, updated_at = now()
     WHERE singleton`,
    [update.availableCreditMicroUsd, update.admissionEnabled],
  );
  if (!result.rowCount) throw new Error("CAMPAIGN_BUDGET_UNINITIALIZED");
}

export async function reconcileReservation(env: Env, input: OperatorReconciliation): Promise<{ reservationId: string; alreadyReconciled: boolean }> {
  return transaction(database(env), async (client) => {
    const reservationResult = await client.query<{
      id: string;
      job_id: string;
      phase: "assessment" | "brief";
      state: "held" | "reconciled";
      amount_micro_usd: string;
      actual_micro_usd: string | null;
      note: string | null;
    }>(
      `SELECT id, job_id, phase, state, amount_micro_usd, actual_micro_usd, reconciliation_note AS note
       FROM phase_reservations WHERE id = $1 FOR UPDATE`,
      [input.reservationId],
    );
    const reservation = reservationResult.rows[0];
    if (!reservation) throw new HttpFailure(404, "RESERVATION_NOT_FOUND");
    if (reservation.state === "reconciled") {
      if (Number(reservation.actual_micro_usd) === input.actualMicroUsd && reservation.note === input.note) {
        return { reservationId: input.reservationId, alreadyReconciled: true };
      }
      throw new HttpFailure(409, "RESERVATION_ALREADY_RECONCILED");
    }
    const attempts = await client.query<{ id: string; state: string; dispatching_old_enough: boolean | null }>(
      `SELECT id, state, dispatched_at <= clock_timestamp() - interval '2 minutes' AS dispatching_old_enough
       FROM model_attempts WHERE reservation_id = $1 FOR UPDATE`,
      [input.reservationId],
    );
    if (attempts.rows.some((attempt) => attempt.state === "prepared")) {
      throw new HttpFailure(409, "MODEL_ATTEMPT_STILL_ACTIVE");
    }
    const dispatching = attempts.rows.filter((attempt) => attempt.state === "dispatching");
    if (dispatching.some((attempt) => attempt.dispatching_old_enough !== true)
      || (dispatching.length > 0 && input.confirmAbandonedDispatch !== true)) {
      throw new HttpFailure(409, "MODEL_ATTEMPT_STILL_ACTIVE");
    }
    if (attempts.rows.length === 0 && input.actualMicroUsd !== 0) throw new HttpFailure(400, "NO_MODEL_DISPATCH_RECORDED");
    const control = await client.query<{ active_attempt_id: string | null }>(
      "SELECT active_attempt_id FROM workflow_control WHERE singleton FOR UPDATE",
    );
    const active = control.rows[0]?.active_attempt_id === input.reservationId;
    const job = await client.query<{ state: string }>(
      reservation.phase === "assessment"
        ? "SELECT assessment_state AS state FROM jobs WHERE id = $1 FOR UPDATE"
        : "SELECT brief_state AS state FROM jobs WHERE id = $1 FOR UPDATE",
      [reservation.job_id],
    );
    const currentPhase = ["queued", "running", "reconciliation_required"].includes(job.rows[0]?.state ?? "");
    const latest = await client.query<{ id: string }>(
      "SELECT id FROM phase_reservations WHERE job_id = $1 AND phase = $2 ORDER BY attempt_no DESC LIMIT 1",
      [reservation.job_id, reservation.phase],
    );
    const ownsPhase = active || (!control.rows[0]?.active_attempt_id && currentPhase && latest.rows[0]?.id === input.reservationId);
    const held = await client.query(
      `UPDATE campaign_budget SET held_micro_usd = held_micro_usd - $1,
         reconciled_spend_micro_usd = reconciled_spend_micro_usd + $2, updated_at = now()
       WHERE singleton AND held_micro_usd >= $1`,
      [reservation.amount_micro_usd, input.actualMicroUsd],
    );
    if (!held.rowCount) throw new Error("LEDGER_HOLD_MISSING");
    await client.query(
      `UPDATE phase_reservations SET state = 'reconciled', actual_micro_usd = $2,
         reconciliation_note = $3, reconciled_at = now() WHERE id = $1`,
      [input.reservationId, input.actualMicroUsd, input.note],
    );
    await client.query(
      `UPDATE model_attempts SET state = 'reconciled', result_json = NULL, error_code = 'OWNER_RECONCILED', completed_at = now()
       WHERE reservation_id = $1 AND state IN ('dispatching', 'uncertain')`,
      [input.reservationId],
    );
    await client.query(
      `INSERT INTO operator_reconciliations
         (id, reservation_id, actual_micro_usd, note, operator_subject, confirmed_abandoned_dispatch)
       VALUES (gen_random_uuid(), $1, $2, $3, 'authenticated-owner', $4)`,
      [input.reservationId, input.actualMicroUsd, input.note, input.confirmAbandonedDispatch === true],
    );
    if (ownsPhase) {
      await client.query(
        reservation.phase === "assessment"
          ? `UPDATE jobs SET assessment_state = 'failed', assessment_finished_at = now(), error_code = 'OWNER_RECONCILED', stage = 'failed'
             WHERE id = $1 AND assessment_state IN ('queued', 'running', 'reconciliation_required')`
          : `UPDATE jobs SET brief_state = 'failed', brief_finished_at = now(), error_code = 'OWNER_RECONCILED', stage = 'failed'
             WHERE id = $1 AND brief_state IN ('queued', 'running', 'reconciliation_required')`,
        [reservation.job_id],
      );
    }
    if (active) {
      await client.query(
        "UPDATE workflow_control SET active_attempt_id = NULL, updated_at = now() WHERE singleton AND active_attempt_id = $1",
        [input.reservationId],
      );
    }
    return { reservationId: input.reservationId, alreadyReconciled: false };
  });
}
