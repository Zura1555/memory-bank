CREATE TABLE campaign_budget (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  campaign_limit_micro_usd bigint NOT NULL DEFAULT 5000000 CHECK (campaign_limit_micro_usd BETWEEN 1 AND 5000000),
  available_credit_micro_usd bigint CHECK (available_credit_micro_usd BETWEEN 0 AND 5000000),
  held_micro_usd bigint NOT NULL DEFAULT 0 CHECK (held_micro_usd >= 0),
  reconciled_spend_micro_usd bigint NOT NULL DEFAULT 0 CHECK (reconciled_spend_micro_usd >= 0),
  admission_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO campaign_budget (singleton) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE workflow_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_attempt_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO workflow_control (singleton) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  capability_hash bytea CHECK (capability_hash IS NULL OR octet_length(capability_hash) = 32),
  request_text text NOT NULL CHECK (octet_length(request_text) <= 16384),
  corpus_version text NOT NULL CHECK (corpus_version ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  corpus_sha256 text NOT NULL CHECK (corpus_sha256 ~ '^[a-f0-9]{64}$'),
  stage text NOT NULL DEFAULT 'queued' CHECK (stage IN ('queued', 'assembling', 'drafting', 'reference_check', 'support_review', 'ready', 'failed', 'reconciliation_required')),
  assessment_state text NOT NULL DEFAULT 'queued' CHECK (assessment_state IN ('queued', 'running', 'ready', 'failed', 'reconciliation_required')),
  brief_state text NOT NULL DEFAULT 'not_started' CHECK (brief_state IN ('not_started', 'queued', 'running', 'ready', 'failed', 'reconciliation_required')),
  assessment_result jsonb,
  brief_result jsonb,
  brief_selections jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  assessment_queued_at timestamptz NOT NULL DEFAULT now(),
  assessment_processing_started_at timestamptz,
  assessment_finished_at timestamptz,
  brief_queued_at timestamptz,
  brief_processing_started_at timestamptz,
  brief_finished_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX jobs_expiry_idx ON jobs (expires_at);

CREATE TABLE phase_reservations (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  phase text NOT NULL CHECK (phase IN ('assessment', 'brief')),
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd = 600000),
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'reconciled')),
  actual_micro_usd bigint,
  reconciliation_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reconciled_at timestamptz,
  UNIQUE (job_id, phase, attempt_no)
);

CREATE TABLE model_attempts (
  id uuid PRIMARY KEY,
  reservation_id uuid NOT NULL REFERENCES phase_reservations(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  phase text NOT NULL CHECK (phase IN ('assessment', 'brief')),
  call_index smallint NOT NULL CHECK (call_index IN (1, 2)),
  state text NOT NULL CHECK (state IN ('prepared', 'dispatching', 'complete', 'failed', 'uncertain', 'reconciled')),
  requested_model text NOT NULL,
  returned_model text,
  provider text,
  generation_id text,
  usage jsonb,
  result_json jsonb,
  error_code text,
  dispatched_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reservation_id, call_index)
);
CREATE INDEX model_attempts_job_result_idx ON model_attempts (job_id) WHERE result_json IS NOT NULL;

CREATE TABLE job_outbox (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  phase text NOT NULL CHECK (phase IN ('assessment', 'brief')),
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  workflow_id text NOT NULL UNIQUE,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, phase, attempt_no)
);
CREATE INDEX job_outbox_pending_idx ON job_outbox (created_at) WHERE published_at IS NULL;

CREATE TABLE operator_reconciliations (
  id uuid PRIMARY KEY,
  reservation_id uuid NOT NULL REFERENCES phase_reservations(id),
  actual_micro_usd bigint NOT NULL CHECK (actual_micro_usd >= 0),
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 1000),
  operator_subject text NOT NULL,
  confirmed_abandoned_dispatch boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reservation_id)
);
