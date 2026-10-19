ALTER TABLE phase_reservations
  DROP CONSTRAINT phase_reservations_amount_micro_usd_check,
  ADD CONSTRAINT phase_reservations_amount_micro_usd_check CHECK (amount_micro_usd IN (600000, 1200000)),
  ADD CONSTRAINT phase_reservations_id_job_phase_unique UNIQUE (id, job_id, phase);

ALTER TABLE model_attempts
  DROP CONSTRAINT model_attempts_call_index_check,
  ADD CONSTRAINT model_attempts_call_index_check CHECK (call_index IN (1, 2, 3, 4)),
  DROP CONSTRAINT model_attempts_state_check,
  ADD CONSTRAINT model_attempts_state_check CHECK (state IN ('prepared', 'dispatching', 'complete', 'invalid', 'failed', 'uncertain', 'reconciled')),
  ADD COLUMN raw_output jsonb,
  ADD COLUMN validation_issues jsonb,
  ADD COLUMN model_profile_sha256 text CHECK (model_profile_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT model_attempts_id_reservation_job_phase_unique UNIQUE (id, reservation_id, job_id, phase),
  ADD CONSTRAINT model_attempts_reservation_job_phase_fk
    FOREIGN KEY (reservation_id, job_id, phase)
    REFERENCES phase_reservations (id, job_id, phase),
  ADD CONSTRAINT model_attempts_invalid_usage_check CHECK (
    state <> 'invalid' OR (
      result_json IS NULL AND usage IS NOT NULL AND usage ? 'reportedCostUsd'
      AND jsonb_typeof(usage->'reportedCostUsd') = 'number'
      AND (usage->>'reportedCostUsd')::numeric >= 0
    )
  );

CREATE INDEX model_attempts_job_id_idx ON model_attempts (job_id);

CREATE TABLE job_repairs (
  job_id uuid PRIMARY KEY REFERENCES jobs(id),
  reservation_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('assessment', 'brief')),
  draft_attempt_id uuid NOT NULL,
  review_attempt_id uuid,
  plan_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (reservation_id, job_id, phase)
    REFERENCES phase_reservations (id, job_id, phase),
  FOREIGN KEY (draft_attempt_id, reservation_id, job_id, phase)
    REFERENCES model_attempts (id, reservation_id, job_id, phase),
  FOREIGN KEY (review_attempt_id, reservation_id, job_id, phase)
    REFERENCES model_attempts (id, reservation_id, job_id, phase),
  CHECK (review_attempt_id IS NULL OR review_attempt_id <> draft_attempt_id)
);
