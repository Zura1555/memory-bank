# Memory Bank

An English, evidence-backed reuse guide built from explicitly fictional client-onboarding work. The delivery lead reviews every checked comparison and remains the decision-maker. The dedicated `Zura1555/memory-bank` repository is private during implementation; this repository excludes the planning workspace and `.scratch` files. Production deployment and public release still require the planned review and separate approval.

## Local setup

1. Install Node.js 22+, Python 3.12+, and Docker Compose. Run `npm ci`.
2. Create a Python environment and install the offline parsers:

   ```sh
   python3 -m venv .venv
   . .venv/bin/activate
   pip install -r ingestion/requirements.txt
   ```

3. Copy `.dev.vars.example` to `.dev.vars`. Set `OPERATOR_TOKEN` to `openssl rand -hex 32`. Set `OPENROUTER_API_KEY` only when you are ready to make the approved paid model calls. Never commit `.dev.vars`.
4. Start local PostgreSQL: `docker compose up -d --wait postgres`. First initialization applies the SQL files in `migrations/` in filename order. The database is loopback-only on port 5433; the project-scoped `postgres_data` Docker volume preserves accounting and admission state across restarts and container recreation. Keep the same Compose project name/directory when returning to a campaign; another worktree/project gets a different volume, not the original ledger.
5. Build the curator manifest and audit: `npm run ingest`. Publish only to Wrangler local R2: `npm run publish:corpus`.
6. Run `npm run dev`, then open `http://127.0.0.1:8787`. The Worker builds the static UI before starting.

Admission is disabled by default. Before enabling it, verify the initial remaining OpenRouter credit and route pricing in the provider dashboard or read-only provider API (`GET /api/v1/credits` and `GET /api/v1/models`); round remaining credit down to integer microUSD. `/api/operator/budget` records that campaign balance (1 USD = 1,000,000 microUSD). Metadata checks do not qualify the model route or full workflow. The $5 maximum caps admission, not provider invoices. The $0.30-per-call and $0.60-per-phase values are holds, not hard charge limits. Reconcile every terminal phase—including successful ones—against actual provider usage before further admission; the hold remains until reconciled, and an overage blocks later admissions but cannot prevent the provider charge. Do not reset the balance to the post-spend dashboard remainder because the ledger also subtracts reconciled spend. Disable admission if external activity changes the balance. This endpoint cannot query, add, or top up credit.

The app has no fake AI fallback. Without a valid key and enabled ledger, paid jobs fail closed. Local queues, Workflows, and R2 use Wrangler's local platform implementation. Remote resources, secrets, provider qualification, public release, and deployment are not configured or performed by local setup.

## Operator-only local operations

Use `Authorization: Bearer $OPERATOR_TOKEN` with `/api/operator/status` to inspect active work, provider usage, reservations, and reconciliation history. `PUT /api/operator/budget` accepts `availableCreditMicroUsd` and `admissionEnabled`; it only sets the owner's verified existing balance and does not create credit.

Failed model attempts also expose `http_status`, `failure_phase`, and `failure_cause` to the operator. Phases distinguish request preparation, fetch, response headers/body, response validation, and output validation. Transport causes are limited to `deadline_exceeded`, `timeout`, `aborted`, and `transport_error`: only the call's own observed expired deadline yields `deadline_exceeded`; an upstream `TimeoutError` alone does not. Diagnostics retain no raw provider body, arbitrary error message, credential, request text, or stack. Generation IDs are bounded `gen-` identifiers, preserved from headers or a decoded envelope even when validation fails. These fields do not change holds, billing uncertainty, deadlines, or replay policy and cannot diagnose older failures retrospectively.

Verify operator authentication and concurrent database access with `node --env-file=.dev.vars --experimental-strip-types src/server/db.smoke.ts` while the local Worker is running. This read-only check submits no model jobs. Each database operation gets its own pool, and each checked-out connection is retired on release; neither sockets nor pending pool connections may cross Worker request contexts.

`POST /api/operator/reconciliations` accepts `reservationId`, `actualMicroUsd`, and a non-empty audit `note`. If a model attempt remains `dispatching`, wait at least two minutes, verify in provider records that it is no longer active, and include `confirmAbandonedDispatch: true`. Never reconcile an uncertain charge by assuming it was free. Reconciliation blocks replay and does not cancel an in-flight provider request.

### Local ledger durability and recovery

The data volume is not a backup. `docker compose down` retains it; **do not use `down --volumes`, `docker volume rm`, or volume pruning on a campaign ledger**. Restarting does not reset budgets, clear holds, or disable previously enabled admission. Existing volumes do not rerun initialization SQL; apply later migrations explicitly before Worker startup.

This Worker requires `migrations/0003_model_failure_diagnostics.sql` on existing databases. With application processing stopped and a verified private backup saved, apply it once after migration 0002:

```sh
docker compose exec -T postgres psql -U memory_bank -d memory_bank \
  -v ON_ERROR_STOP=1 --single-transaction < migrations/0003_model_failure_diagnostics.sql
```

New columns are nullable and constrained to safe values; historical rows remain unknown rather than being backfilled with a guessed failure cause. Fresh databases apply all migrations during initialization.

Cold initialization flushes real disk storage and can take minutes on this WSL host. The health check uses TCP so the temporary socket-only initialization server cannot report readiness before migrations finish. A ten-minute startup grace and PostgreSQL's [`PGCTLTIMEOUT=300`](https://www.postgresql.org/docs/17/app-pg-ctl.html) allow initialization/checkpointing to finish without disabling disk synchronization. These are local database startup controls, not changes to paid model deadlines or retry policy.

**Before replacing a running tmpfs installation:** stop/drain the app's Worker, queue, and Workflow processing and take the backup below before any database restart/recreation. Restore it into the durable setup before resuming. A previously lost tmpfs ledger cannot be recovered by adding a volume; do not reconstruct historical reservations or treat the approved lost-ledger exception as a reconciliation. This change does not initialize or authorize a replacement paid campaign.

With application processing stopped, save a private PostgreSQL custom archive outside Git and `/tmp`:

```sh
umask 077
backup_dir="$HOME/.local/state/memory-bank/backups"
mkdir -p "$backup_dir"
partial=$(mktemp "$backup_dir/ledger-XXXXXXXX.dump.partial")
backup="${partial%.partial}"
docker compose exec -T postgres pg_dump -U memory_bank -d memory_bank --format=custom > "$partial" &&
  mv "$partial" "$backup"
```

Only a successful dump is renamed to `.dump`. Retain the completed archive on durable storage; a second protected copy on a separate device/storage service is needed to survive host/disk loss. Archives contain private job and accounting data: never commit or publish them, and manage their retention separately from the app's seven-day expiry.

Restore a verified archive into a **new, empty database**, not over an existing ledger. Keep all app processing stopped:

```sh
# Set backup to the completed archive's absolute path if using a new shell.
docker compose exec -T postgres createdb -U memory_bank -T template0 memory_bank_restore
docker compose exec -T postgres pg_restore -U memory_bank -d memory_bank_restore \
  --exit-on-error --single-transaction < "$backup"
docker compose exec -T postgres psql -U memory_bank -d memory_bank_restore -v ON_ERROR_STOP=1 \
  -c 'UPDATE campaign_budget SET admission_enabled = false, updated_at = now() WHERE singleton AND admission_enabled;'
```

After every command succeeds, point development `LOCAL_DATABASE_URL` at `memory_bank_restore` and inspect `/api/operator/status` with the operator token before allowing app processing to resume. Verify the budget, holds, active reservation, model attempts, and reconciliation audit against the saved evidence. Keep paid admission closed until recovery and current credit are verified and the next run is separately authorized. Do not release an uncertain hold or replay a dispatch to discover its cost. Preserve the original database/archive while investigating any mismatch. A PostgreSQL archive does **not** back up R2 originals or Queue/Workflow checkpoints; those runtime resources need their own recovery checks before resuming work.

Run `node --experimental-transform-types src/server/ledger.smoke.ts` for an isolated, no-paid-call recovery check (Docker Compose 2.24.4+). It creates a random Compose project with a loopback ephemeral port, seeds only synthetic accounting, and drives actual paid-stage failure persistence with one intercepted synthetic provider response (no provider network access). It checks operator diagnostics, exact rows and replay rejection after restart/container recreation, and private archive restoration outside `/tmp` into a fresh database. It removes only its own synthetic containers/volumes/archive; it never reads `.dev.vars` or touches the campaign database. The [diagnostics verification record](docs/qualification-2026-10-15.md#dispatch-diagnostics-and-visitor-disclosure--2026-10-16) distinguishes this local proof from paid qualification.

Observed local verification (2026-10-16): the smoke failed against tmpfs after restart with cleared budgets/holds, an empty attempt/reservation/audit ledger, and a lost active lock. With the named volume and durable-startup settings, all seven tables survived restart and container recreation unchanged; a custom archive restored the same rows into a fresh database. Uncertain and reconciled attempts rejected replay before provider access in every verification phase; provider requests were zero and admission stayed disabled. This verifies synthetic local ledger recovery, not restoration of the lost historical reservation or qualification of a paid workflow.

## Application boundaries

- The runtime reads the published eight-case manifest and exact originals from R2; it verifies SHA-256 before using a source or serving a download.
- `ingestion/` is offline curator tooling. It supports native text/CSV and format-aware Office/PDF/image paths; scans and visual observations require a hash-bound human-audited sidecar. Missing or incomplete extraction is excluded, never guessed.
- `evaluation/keys.json` is offline-only and is not copied into `dist/`, R2, prompts, or application routes. Do not use evaluation keys for prompt tuning.
- Anonymous job capabilities protect status/results. Application request/results expire after seven days; minimal accounting/idempotency records remain for operator reconciliation. Workflow checkpoint retention is configured for seven days; provider/platform/backup retention is separate and is not promised to be zero.
- Before submission, the intake identifies OpenRouter/OpenAI processing, deployed Cloudflare/Neon storage/processing, local-development equivalents, and links the provider/platform privacy policies. It distinguishes seven-day application expiry from separate upstream/platform/backup retention, retained billing/replay records, and downloaded packs. The active job's exact expiry is visible during assessment, selection, and brief review, not only export. Terminal panels show the API's safe failure explanation without operator-only diagnostics.
- Queue/Workflow duplicates use stable IDs. Paid model calls have no automatic retries or fallback; uncertain dispatch requires operator reconciliation.
- Human-reviewed decision and lesson cards live in the versioned curator corpus, not expiring jobs. Browse `/?knowledge`, address a record with `/?knowledge=<recordId>`, or inspect it in case details. Cards link exact supporting passages/originals and mark superseded advice as history. Applying a lesson still requires the existing checked, request-specific recommendation pipeline; no new paid stage is added. See [curator authoring and review](ingestion/README.md#decision-and-lesson-records).

### Explainable reuse workbench

Checked leads and contrasts now show compact requirement / past-evidence / applicability / reuse-implication tables. Only relevant product/version, environment, scale, identity/access, and recovery/operating dimensions appear. Each cell resolves to an accepted checked claim; missing constraints remain **Unknown**, not a numeric similarity score or an inferred match. Exact-passage inspection remains available directly from the table. Up to three checked next actions explain what to verify and why it affects reuse, without a background service or another paid model stage.

Drafting and independent review each extract a five-dimension request-constraint inventory using exact request quotations. A comparison can call a requirement unstated only when both inventories agree it is absent. Presence disagreements withhold the assessment and its dependent recommendations even when claim verdicts say supported; source facts remain inspectable. A stated but unconfirmed requirement is not proof of client capability, permission, or success. The review inventory is retained and rechecked on status, brief admission, and export; the browser also validates it. This adds no model stage.

Generated comparisons belong inside each lead/contrast rather than in an independent global list. The parser assigns case ownership from containment and retains the 24-row total bound; exact case-scoped citations and the lead/contrast ownership gate are unchanged. The checked API/UI still receives the flat reviewed comparison table.

Artifact dispositions are independently reviewed classification decisions, not labels inferred from supported recommendation prose. This includes non-lead work. Reuse requires supported unchanged use without a decisive blocker/unresolved check; Adapt needs usable starting material and concrete changes/checks; Verify needs a concrete decision-critical check. Contradictory or unestablished work is visibly withheld, never silently relabeled, and cannot supply lead membership, selections, or next actions. Supported Adapt work remains available. Older stored dispositions lacking the classification review are withheld on read.

Submitting clarification starts a new checked assessment and immediately invalidates artifact/version/passage selections, including when admission fails. The tab retains only the immediately previous checked assessment, read-only, until its original seven-day expiry; a new request or page reload discards it. A supported disposition-change summary shows both prior and current recommendation evidence. A missing/withheld recommendation is not reported as an established change, and the UI does not infer that clarification alone caused a model-output difference. No capability, result history, or selection is written to browser storage.

Existing databases require `migrations/0002_assessment_workbench.sql` and `migrations/0003_model_failure_diagnostics.sql` before Worker startup; drain active workflows before changing the strict draft/review schema. Older stored assessments without the required request-constraint review are unavailable and need a new checked assessment. No empty inventory, repaired comparison, or automatic paid rerun is fabricated.

The [workbench verification record](docs/workbench-2026-10-15.md) records approved real UI runs, exact charges, source checks, latency limits, and conservative clarification outcomes. A withdrawn prior lead is labeled “not established,” never silently replaced with a withheld recommendation.

### Evidence inspector

The evidence inspector uses Base UI Dialog with the existing CSS tokens, including dark mode. Escape, the close button, or an outside press dismiss it; focus returns to the invoking inspection control. Each selected source reference mounts fresh passage state, aborting retrieval on close or replacement so a late response cannot overwrite another passage. Validation and exact-original downloads still use the existing evidence endpoints.

`/api/*` runs through the Worker before SPA asset handling so download navigations return the exact original rather than `index.html`. With the local Worker running and corpus published, run `node --experimental-strip-types src/server/evidence.smoke.ts` to check navigation-mode original downloads, SHA-256, and exact passage identity without model calls.

The document-first hierarchy, muted provenance, neutral dismissal, and separated header follow public Anduin [document review](https://support.anduintransact.com/en_US/investor-data-management/review-submitted-requests) and [source-linked review](https://developers.anduintransact.com/docs/handling-digital-vs-ocr-processed-subscriptions) references. These are observed product patterns, not access to Anduin's private design tokens; no second theme is introduced.

For a browser regression smoke, open checked passages from both checked examples and selected work. Verify Tab/Shift+Tab containment, visible focus, Escape/close focus return, loading, failed and mismatched-source responses, and closing/reopening another passage while retrieval is delayed. Check exact-original bytes against the retained source, then inspect 320px-wide and dark-mode layouts. Replaying an existing checked assessment avoids new paid model calls; it does not qualify the AI workflow.

### Evidence-linked starter packs

A ready checked brief offers **Download Markdown pack** and **Download JSON manifest**. Both are deterministic projections of the existing checked result and pinned corpus; exporting adds no model call, reservation, workflow, or storage service. Review separates checked reusable starting points, required adaptations, and visibly blocked verification. None is production approval.

`GET /api/jobs/:jobId/pack/markdown` and `/pack/json` require the existing bearer capability, an unexpired ready job, checked assessment/brief, and validated selections. Each pack contains the client request, pinned corpus version/SHA-256, selected case/artifact/version inventory, original SHA-256 and exact-original link, checked recommendation/checklist claim IDs and dependencies, selected-source blocking questions/checks, reviewed decision/lesson context, and cited passage IDs, locations, source kinds, and verbatim excerpts. Brief and assessment claim IDs have separate namespaces. Records are included only when all their evidence belongs to selected versions; historical superseded advice is marked, and reviewed context does not establish new request applicability. Unselected-source claims and their dependants are excluded; incomplete recommendations remain blocked rather than being inferred. Missing, changed, or corrupt selected evidence blocks export explicitly, without switching versions.

Jobs and capabilities expire after seven days; no new export is available afterward. An already downloaded pack remains readable offline because excerpts and checked reasoning are preserved, but **original bytes are linked, not bundled**. Original links require the live demo/corpus and have no indefinite-availability guarantee. Download and retain needed exact originals separately. Export never edits source text or original files. All data is fictional; the demo evidence routes are public, and source-level authorization remains a separate release gate before confidential real data.

Focused coverage: `node --experimental-strip-types --test src/server/packs.test.ts`. Browser smoke: replay an existing owned ready checked job without paid admission, choose its exact version/passages, open the checked brief, download both formats, and open the saved files. Compare every inventory version/hash and cited excerpt against the retained original/manifest; confirm verify-only work is blocked. Try missing/wrong capabilities, expiry, and a locally corrupted selected original; restore exact local evidence afterward.

Observed local verification (2026-10-15): the existing checked Cedar mapping brief was replayed through the UI; only admission receipts were replayed, while status, pack generation, and original downloads used the real Worker/PostgreSQL/R2. Downloaded Markdown (9,084 bytes) and JSON (13,036 bytes) matched `cedar-batch-import/mapping/map-2025-02-11`, original SHA-256 `7dd4e8ae29cdd878b579364f03207430cfd0e904b7e75eeb01e4f9bfaf09644a`, and all six cited excerpts. Missing/wrong capabilities returned 404, expiry returned 410, and local source corruption returned 503 with a visible export-blocked error. No new paid calls were made. This verifies export, not a new AI qualification run.

### Retained-version picker

Selected work uses Base UI Select for artifacts with multiple checked retained versions. The picker follows the work draft; changing versions clears passage selections. Checkboxes and textareas remain native, and the picker uses the shared CSS tokens in light and dark mode.

For a browser smoke, choose a multi-version artifact, select a passage, and switch versions by pointer and by keyboard (Arrow keys/Home/End, then Enter). Confirm the previous passages are cleared, the brief action stays disabled until a new passage is selected, and the submitted brief contains only the chosen version and its passages. Verify the “Retained version” label, announced selected value, visible keyboard focus, Escape dismissal/focus return, draft persistence after going back to checked examples, and open/closed layouts at 320px and in dark mode. Browser-only assessment fixtures exercise the UI without paid calls; they do not qualify the model or Worker workflow.

### Shared Anduin colors

The existing shared CSS roles now use Anduin's observed public blue `#0158AE`, navy `#162950`, and decorative blue-gray `#CCD2DB`. Actions, links, evidence accents, focus, and the Base UI picker/dialog share light/dark roles; semantic green/amber/red/unknown labels remain distinct. Small muted text and functional control borders use contrast-safe assignments rather than copying low-contrast website values.

See the [source selectors, explicit application/dark-mode derivations, measured contrast pairs, and browser screenshot record](docs/anduin-palette-2026-10-15.md). This is website-matched branding, not a claim of access to private product tokens. Browser replay proof is separate from paid workflow qualification.

## Verification and release gates

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run ingest`. Then exercise the local Worker and verify source downloads, capability ownership, budget-denied admission, queue/outbox recovery, workflow state transitions, and retention cleanup. Paid qualification requires the approved existing credit, a valid key, and measured full P1–P4 runs; freeze configuration before H1–H4. Record real model usage/cost, queue wait, phase processing time, full-context fit, extraction fidelity, memory, replay behavior, and source/version access. Do not claim these results from fictional fixtures or code inspection.

The [qualification report](docs/qualification-2026-10-15.md) preserves the original false-absence defect, dual-pass constraint fix, and structurally owned comparisons. Final-contract P1 and P3 completed assessment-to-brief with their central safety facts intact. **Qualification failed overall:** P2 withheld its relevant Elm implementation material and produced no useful lead; P4 offered context-only request artifacts as Adapt and did not establish the expected bounded-corpus no-useful-precedent conclusion. Held-out requests remain unopened, and total-isolate memory remains unqualified despite measured JS heap. No output was repaired or relabeled. Billing monitoring remains stopped; no purchase, merge, or deployment is implied.

Remote deployment requires separately approved Cloudflare/Neon resources and credentials, including Hyperdrive, Queue/dead-letter queue, Workflow, R2, and the deployed static asset binding. Keep the repository private until the source/secrets review is complete; make it public only under the approved submission plan.
