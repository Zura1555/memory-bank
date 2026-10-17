# Memory Bank

An English, evidence-backed reuse guide built from explicitly fictional client-onboarding work. The delivery lead reviews every checked comparison and remains the decision-maker. The dedicated `Zura1555/memory-bank` repository remains private; this repository excludes the planning workspace and `.scratch` files. Production infrastructure is deployed with paid admission disabled; model qualification and public repository release remain separate gates.

## Local setup

1. Install Node.js 22.18+ (verified with 24.19), Python 3.12+, and Docker Compose. Run `npm ci`.
2. Create a Python environment and install the offline parsers:

   ```sh
   python3 -m venv .venv
   . .venv/bin/activate
   pip install -r ingestion/requirements.txt
   ```

3. Copy `.dev.vars.example` to `.dev.vars`. Set `OPERATOR_TOKEN` to `openssl rand -hex 32`. Set `OPENROUTER_API_KEY` only when you are ready to make the approved paid model calls. Never commit `.dev.vars`.
4. Start local PostgreSQL: `docker compose up -d --wait postgres`. First initialization applies the SQL files in `migrations/` in filename order. The database is loopback-only on port 5433; the project-scoped `postgres_data` Docker volume preserves accounting and admission state across restarts and container recreation. Keep the same Compose project name/directory when returning to a campaign; another worktree/project gets a different volume, not the original ledger.
5. Build the curator manifest and audit: `npm run ingest`. Publish only to cf local R2: `npm run publish:corpus`.
6. Run `npm run dev`, then open `http://127.0.0.1:8787`. This builds with `cf` and serves the bundled Worker using Vite preview in development mode. Restart after edits; there is no hot reload. Bundling preserves startup-time AJV schema compilation, which the Vite development module runner rejects as dynamic code generation.

Admission is disabled by default. Before enabling it, verify the initial remaining OpenRouter credit and route pricing in the provider dashboard or read-only provider API (`GET /api/v1/credits` and `GET /api/v1/models`); round remaining credit down to integer microUSD. `/api/operator/budget` records that campaign balance (1 USD = 1,000,000 microUSD). Metadata checks do not qualify the model route or full workflow. The $5 maximum caps admission, not provider invoices. The $0.30-per-call and $0.60-per-phase values are holds, not hard charge limits. Reconcile every terminal phase—including successful ones—against actual provider usage before further admission; the hold remains until reconciled, and an overage blocks later admissions but cannot prevent the provider charge. Do not reset the balance to the post-spend dashboard remainder because the ledger also subtracts reconciled spend. Disable admission if external activity changes the balance. This endpoint cannot query, add, or top up credit.

The app has no fake AI fallback. Without a valid key and enabled ledger, paid jobs fail closed. Local queues, Workflows, and R2 use the cf local platform simulation, persisted under the project's `.cloudflare/state`; the corpus publisher explicitly selects the same store as Vite. Local setup never provisions or deploys remote infrastructure. Production uses the separate resources below; no Wrangler dependency or configuration is used.

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
- `evaluation/keys.json` is offline-only and is not copied into `.cloudflare/output/`, R2, prompts, or application routes. Do not use evaluation keys for prompt tuning.
- Anonymous job capabilities protect status/results. Application request/results expire after seven days; minimal accounting/idempotency records remain for operator reconciliation. Workflow checkpoint retention is configured for seven days; provider/platform/backup retention is separate and is not promised to be zero.
- Before submission, the intake identifies OpenRouter/OpenAI processing, deployed Cloudflare/Neon storage/processing, local-development equivalents, and links the provider/platform privacy policies. It distinguishes seven-day application expiry from separate upstream/platform/backup retention, retained billing/replay records, and downloaded packs. The active job's exact expiry is visible during assessment, selection, and brief review, not only export. Terminal panels show the API's safe failure explanation without operator-only diagnostics.
- Queue/Workflow duplicates use stable IDs. Paid model calls have no automatic retries or fallback; uncertain dispatch requires operator reconciliation.
- Human-reviewed decision and lesson cards live in the versioned curator corpus, not expiring jobs. Browse `/?knowledge`, address a record with `/?knowledge=<recordId>`, or inspect it in case details. Cards link exact supporting passages/originals and mark superseded advice as history. Applying a lesson still requires the existing checked, request-specific recommendation pipeline; no new paid stage is added. See [curator authoring and review](ingestion/README.md#decision-and-lesson-records).

### Workspace shell and Sources

The shared shell uses the installed Base UI Navigation Menu, Drawer, Button, Separator, Field, Input, Select, and Collapsible primitives with the existing Anduin CSS tokens. Desktop has a persistent sidebar; screens up to 900px use a labelled, swipe-dismissible navigation drawer. Ask (`/`), Sources (`/?sources`), and reviewed knowledge (`/?knowledge` and permanent record links) are real destinations. History and Saved remain in a native disclosure inside Ask, not separate shell destinations. Global search, account controls, and decorative unsupported actions are omitted.

Same-tab navigation and Back/Forward retain the mounted Ask request, checked result, current step, and artifact/version/passage selections. Existing polling, expiry, and clarification invalidation remain unchanged. Navigation does not submit model work. Reload discards in-memory results and selections; only the existing local History/Saved receipts persist (see privacy and retention below). No job capability or result is added to URLs. Escape/close returns drawer focus to its trigger; choosing a destination moves focus to the main content after dismissal.

`GET /api/sources` projects the published corpus into retained source versions: case/artifact ownership, titles, MIME type, stated date, fictional label, availability, and exact passage references/source kinds. It does not expose storage paths, evaluation keys, or job capabilities. Original hashes are checked through the existing corpus loader. Missing, corrupt, and incomplete originals have no inspectable passage controls or download links in the browser; direct evidence routes continue to enforce their own integrity checks. Sources combines title/case-name search with case and file-type filters, explicit no-result/error states, and the existing evidence inspector and exact-original downloads. Browsing is not an AI relevance assessment and does not make an artifact eligible for a brief.

Observed local browser verification (2026-10-17): all four workflow steps, draft/selection retention across navigation, Back/Forward, permanent knowledge links, matching/empty/combined filters, source retrieval errors, exact-original SHA-256, evidence Escape/focus return, and both pack download controls passed at 1440×1000 and 320×1000 in light and dark schemes. Mobile drawer keyboard containment, Escape/focus return, destination focus, and open-drawer desktop resize passed. Document overflow was checked against `documentElement.clientWidth`, including classic scrollbars; the old 320px document minimum width was removed rather than hiding overflow. A separate explicitly UI-only second-version fixture cleared old passage selections and blocked brief submission until reselection in all four viewport/scheme combinations; it was never published or submitted for a brief.

The workflow smoke replayed an existing accepted P1 job and its retained pack bytes. Source inventory used all 24 originals in the isolated local Worker/R2; passage inspection and SHA-256-verified original downloads also hit that real Worker rather than fixtures. No paid calls, deployment, admission changes, or AI requalification were performed.

Visual evidence: [desktop light](docs/images/shell-light-1440.webp), [desktop dark](docs/images/shell-dark-1440.webp), [320px light](docs/images/shell-light-320.webp), and [320px dark](docs/images/shell-dark-320.webp). Contact sheets include Ask, Sources, checked examples, selected work, checked brief, and evidence inspection; narrow sheets also include the navigation drawer. These are UI-replay evidence, not new AI-workflow qualification.

Repeat the README's existing evidence/export smokes, then navigate away from and back to an unsubmitted request and selected work. Verify Back/Forward, current-location labels, keyboard drawer/evidence dismissal, version-change passage clearing, and `documentElement.scrollWidth <= documentElement.clientWidth` at 320px in both schemes. Run `node --experimental-strip-types --test src/server/sources.test.ts` for missing/corrupt/incomplete-original browsing and exact-identity regression coverage.

Issue #26 acceptance recheck (2026-10-17): the existing Sources destination browsed all 24 published local Worker/R2 originals; combined title/case-name, case, and file-type filters, no results, and Clear filters passed. Keyboard inspection, dialog Tab containment, Escape/focus return, and 1440px/320px light/dark layouts passed without document overflow. The browser downloaded `request-2025-02-03` (1,034 bytes), byte-identical to the retained Cedar request, SHA-256 `583d72848dd4ddae1fd6439f478d68c5f67099d76e5fc07d0715fe0e3e7303c9`; `node --experimental-strip-types src/server/evidence.smoke.ts` also verified navigation-mode bytes and passage identity. Reviewed knowledge and its permanent correction link remained accessible. UI-only response fixtures checked unavailable/incomplete controls, failed/mismatched passage retrieval, and all three audited OCR/visual labels (the current corpus is native text). The source regression additionally verifies distinct retained versions and rejects old-version passage/download access when that original is missing, corrupt, or incomplete—even while another version remains available. No model calls, admission changes, or deployment.

### Ask: requests, checked sources, and reuse briefs

Ask keeps the existing four-step checked pipeline: client request → checked examples → explicit artifact/version/passage selection → checked reuse brief and pack exports. Three authored suggestions draw only on the fictional Cedar sandbox import, Grove scoped test access, and Ibis operator handover source requests. They do not use held-out evaluation requests or keys. Choosing a suggestion fills and focuses the editable request; it makes no API call. Submission alone requests admission. The submitted request and clarification stay visible through selection, brief review, denied admission, and failure.

Actual job states drive presentation: admission pending, status retrieval, queue wait, assembling, drafting (not yet checked), reference checks, and separate support review. Nothing claims to search/rank or invents a match percentage, progress estimate, or per-stage duration. Only server-reported aggregate queue/processing timings appear separately. Disabled paid admission, exhausted authorized credit, and workflow-busy denials differ from unconfirmed service failures, failed checks, reconciliation, withheld findings, and a checked no-useful-precedent conclusion. No paid retry or new model stage is added.

Checked source cards accompany supported leads. Their case/artifact/version/passage identities come only from accepted artifact work claims, never corpus browsing or blocker-only citations. Unavailable artifacts/cases and withheld work cannot supply selectable passages. The same projection feeds the existing version/passage picker and matches the server's selection boundary; blocker and verification claims remain inspectable, but do not independently authorize selection. Checked recommendations retain Reuse/Adapt/Verify, contrasts, unknown applicability, withheld counts, and fictional labels. Brief drafts are cleared when a new brief receipt is accepted and stay hidden until checks pass.

Verification and replay limits for issue #25 are recorded in [the UI verification record](docs/workbench-2026-10-15.md#ask-presentation-verification--2026-10-17). These checks prove presentation and request contracts, not model qualification; production paid admission remains disabled.

### Explainable reuse workbench

Checked leads and contrasts now show compact requirement / past-evidence / applicability / reuse-implication tables. Only relevant product/version, environment, scale, identity/access, and recovery/operating dimensions appear. Each cell resolves to an accepted checked claim; missing constraints remain **Unknown**, not a numeric similarity score or an inferred match. Exact-passage inspection remains available directly from the table. Up to three checked next actions explain what to verify and why it affects reuse, without a background service or another paid model stage.

Drafting and independent review each extract a five-dimension request-constraint inventory from schema-bound quotations of the current request, separated from historical client requests. Both passes can classify the request independently, but cannot put historical text into that inventory. A comparison can call a requirement unstated only when both inventories agree it is absent. Presence disagreements withhold the assessment and its dependent recommendations even when claim verdicts say supported; source facts remain inspectable. A stated but unconfirmed requirement is not proof of capability, permission, or success. The review inventory is retained and rechecked on status, brief admission, export, and in the browser. This adds no model stage.

Each generated case has one tier—lead, contrast, or context—so it cannot independently nominate itself in both result lists. Comparisons belong to its lead/contrast case entry; the parser derives the existing API lists and case ownership, retaining the 24-row total bound and unchanged ownership gate. Global claim generation binds each owning case to its available source passages; cross-case assertions must be split into separately sourced claims. The checked API/UI still receives the flat reviewed comparison table. Brief generation is bound to the delivery lead's exact selected artifact/version identities, not other artifacts in full-case background.

Brief review independently inventories decisive request constraints for every exact selected artifact/version, including values, units and uncertainty qualifiers. The server requires both those quotations and the draft's recommendation quotations in supported, visible recommendation text for that item; request metadata or historical source facts alone do not count. Missing coverage withholds recommendations and their dependants, never repairs prose or echoes unchecked request text. The checked inventory survives status revalidation and both exports. This keeps four calls per complete workflow. See the [issue #34 local verification and remaining paid gates](docs/qualification-2026-10-15.md#selected-brief-constraint-preservation-issue-34--2026-10-17).

Artifact dispositions are independently reviewed classification decisions, not labels inferred from supported recommendation prose. This includes non-lead work. Reuse requires supported unchanged use without a decisive blocker/unresolved check; Adapt needs usable starting material and concrete changes/checks; Verify needs a concrete decision-critical check. Contradictory or unestablished work is visibly withheld, never silently relabeled, and cannot supply lead membership, selections, or next actions. Supported Adapt work remains available. Older stored dispositions lacking the classification review are withheld on read.

Independent review assigns every assessed artifact a role: `starting_point`, `context_only`, `not_relevant`, or `unresolved`. Only source-established starting material can become Reuse/Adapt; unknown new-client compatibility does not erase a conditional Adapt starting point, and still blocks unchanged Reuse. Explicit null exclusions require a self-contained, cited explanation and no authored dependencies; no new work category or paid stage is added. Context-only material can supply a concrete supported Verify check, never an implementation lead; inapplicable work cannot be selected. The server derives the aggregate conclusion from the complete reviewed roles and surviving work, rather than requesting a second, potentially contradictory model label. Bounded no-useful-precedent requires complete source availability and settled negative roles, not invented outcomes. Roles are retained and rechecked on reads, brief admission, export, and in the browser. Missing legacy review fails closed; revalidation never upgrades a stored uncertain conclusion.

Checked findings and targeted clarification share one screen: a sticky question/answer panel alongside findings on wide screens, stacked on narrower screens. The current request context and most recently submitted clarification remain visible while admission/checking is pending or fails. Editing answers never submits work; only **Recheck with these answers** uses the existing fresh-assessment API. No conversational stage, automatic resubmission, or transcript persistence is added.

Submitting clarification immediately invalidates artifact/version/passage selections and the dependent brief, including server admission failure and the local UTF-8 request-size rejection. A running brief does not block clarification; its late receipt/status cannot replace the new assessment. The tab retains only the immediately previous checked assessment (not its brief), read-only, until its original seven-day expiry, also checked on focus/resume. A new request or page reload discards this in-memory comparison. A supported disposition-change summary shows both prior and current recommendation evidence. Missing/withheld recommendations are not established changes; historical uncertainty, withheld counts, contrasts, availability, and supported outcomes remain visible, and failed checks are not no-precedent conclusions. The UI does not infer that clarification alone caused a model-output difference. History bookmarks can explicitly reopen a live job after reload, but never restore previous selections or comparison snapshots.

Existing databases require `migrations/0002_assessment_workbench.sql` and `migrations/0003_model_failure_diagnostics.sql` before Worker startup; drain active workflows before changing the strict draft/review schema. Older stored assessments without the required request-constraint review, and briefs without independent per-selection constraint review, are unavailable. They require an explicitly requested fresh checked workflow; no empty review inventory, repaired comparison/brief, or automatic paid rerun is fabricated. Already downloaded historical packs remain unchanged and are not retroactively qualified.

The [workbench verification record](docs/workbench-2026-10-15.md) records approved real UI runs, exact charges, source checks, latency limits, and conservative clarification outcomes. A withdrawn prior lead is labeled “not established,” never silently replaced with a withheld recommendation.

### Browser-local History and Saved: privacy and retention

Accepted job receipts automatically enter **History**. **Save checked job** bookmarks a server-validated assessment or reuse brief in **Saved**; both lists reference the same job, with one entry per job identity. Unsave / Clear Saved keeps History; Remove / Clear History and Saved deletes local bookmarks, not remote jobs or downloaded files. Reopen makes only the existing bearer-authenticated status/results read: it never resubmits a paid assessment or brief, and clears prior artifact/version/passage selections before validating the live response.

The `memory-bank.jobs.v1` localStorage key contains only a request label (at most 100 characters), job ID, bearer capability, original server-provided expiry, and saved flag. It never contains full request bodies, sources, generated results, selections, comparison snapshots, or exported packs. This is **this browser/device only**, not account sync or a durable archive. Anyone with access to this browser's local data can use its live capabilities: do not retain entries on a shared browser. Capabilities are never put in URLs, rendered markup, application logs, screenshots, issue reports, or exports; local labels render as inert text.

History and Saved share the job's original seven-day expiry. Saving, unsaving, reopening, and starting a brief never extend it. The workspace removes expired labels and capabilities at its expiry timer and on reload/focus/visibility/storage refresh; active request/results and evidence dialogs are cleared at expiry too. A closed or suspended browser cannot execute deletion: cleanup runs when the workspace next runs/resumes, and the server independently denies expired access regardless of local data. Missing/404 and expired/410 jobs are removed on validation, with no cached result fallback. Already downloaded packs remain independent offline files and are not erased by local cleanup.

Unavailable/full storage shows a persistence failure while leaving the main tab workflow usable; a failed save is never marked successful. Malformed local data is discarded with an error rather than trusted. If retention cleanup cannot rewrite the key, it attempts to remove the whole key; if browser storage itself blocks access/removal, use browser site-data settings to erase it. No browser application can promise physical deletion while storage access is denied.

Focused deterministic check: `node --experimental-strip-types --test src/ui/local-jobs.test.ts`. Observed Chromium smoke (2026-10-17) used built browser assets and synthetic, bearer-checking job API fixtures, not paid model calls: acceptance/save; reload and keyboard reopen of assessment/brief; duplicate receipt; unsave, remove, both clear actions; original-expiry purge; missing job; malformed/quota/blocked storage; selection reset (two checked choices → zero); keyboard focus; and 320px light/dark layouts without page overflow. Worker preview was unavailable in this task worktree because its Hyperdrive development connection was not configured; these browser checks do not claim a new live Worker/database qualification.

After integrating the workspace shell, Chromium also verified that leaving Ask closes its evidence dialog without dropping the saved job, reload/reopen remains read-only, and expiry clears bookmarks and active results while Ask is hidden. A forced early expiry callback reproduced retained in-memory results; the expiry effect now rearms until the original deadline and the same browser check passes.


### Evidence inspector

The evidence inspector uses Base UI Dialog with the existing CSS tokens, including dark mode. Escape, the close button, or an outside press dismiss it; focus returns to the invoking inspection control. Each selected source reference mounts fresh passage state, aborting retrieval on close or replacement so a late response cannot overwrite another passage. Validation and exact-original downloads still use the existing evidence endpoints.

The dialog always identifies the **requested** case, artifact, retained version, and passage, including loading/failure states; this is not a claim that retrieval succeeded. Only a response matching all four identities can display an excerpt or an original-download link. Source-kind labels distinguish native text, audited OCR transcription, audited visual observation, and audited visual interpretation; observations/interpretations are never relabelled as native text or generated summaries. Sources cards explicitly label each retained version rather than implying “latest.”

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

## Production deployment

Live URL: **<https://memory-bank.zura-tran.workers.dev>**. The owner authorized infrastructure deployment on 2026-10-16 and selected the `Zura.tran@gmail.com` Cloudflare account. This is a live corpus/UI deployment with **paid assessment and brief admission disabled**, not successful model qualification.

| Resource | Production identity |
| --- | --- |
| Cloudflare account / Worker | `6d5eb3fa868f53e83e13401577cdfc01` / `memory-bank` |
| Neon | `memory-bank-production` (`hidden-dream-29034304`), PostgreSQL 17, Singapore `aws-ap-southeast-1`, 0.25 CU on the existing free organization |
| Hyperdrive | `0880749f093c4bdaab7dd377c76f68b4`; query caching disabled so admission/accounting reads are not cached |
| R2 | Private bucket `memory-bank-originals`; 24 exact fictional originals and the `fictional-onboarding-v2` manifest |
| Queue / Workflow / cron | `memory-bank-jobs`, `memory-bank-jobs-dead`, `memory-bank-workflow`, every-minute outbox/retention handler |

`cloudflare.config.ts` is the single binding/trigger configuration. The pinned `cf` CLI and Cloudflare Vite plugin beta build both Worker and browser assets into `.cloudflare/output/v0/`; `index.html` is at the repository root. Production always sets `APP_ENV=production` and uses Hyperdrive, never `LOCAL_DATABASE_URL`. `npm run dev` explicitly selects development mode.

At the initial production deployment, Neon database `memory_bank` had migrations `0001_init.sql` and `0002_assessment_workbench.sql` applied atomically. It was a separate, initially empty ledger: no historical local reservations, lost rows, or charges were reconstructed; admission was false, available credit null and holds zero. This historical observation does not establish that migration `0003_model_failure_diagnostics.sql` has been applied. Do not rerun the initial CREATE TABLE migration against this initialized database.

Because `main` automatically deploys, the database prerequisite below must be satisfied before merging this revision into `main`, not merely before a manual deploy.

Production secrets are Cloudflare `secret_text` bindings: `OPERATOR_TOKEN` (freshly generated, separate from local) and `OPENROUTER_API_KEY`. Their local deployment copy is `.dev.vars.production`; the direct Neon `DATABASE_URL` is in `.env.production`. Both files are Git-ignored and mode 0600. Keep these files private and back them up in a password manager; never paste them into an issue or commit. Do not upload `.env.production` as Worker secrets or copy local development variables into production.

To update this deployment from an authenticated checkout:

1. Run `npm ci`, `npm run typecheck`, and `npm test`.
2. Before deploying this revision to an existing database, keep admission disabled, drain processing, take and verify a private backup, and apply any missing migrations in order, including `0003_model_failure_diagnostics.sql`. Its diagnostic columns are required even for authenticated operator status. Verify the schema before code cutover; this instruction is not authorization to migrate or deploy production.
3. For an approved corpus edition change only, run `npm run ingest` and `npm run publish:corpus:production`. The default `npm run publish:corpus` stays local.
4. Run `npm run deploy:check`, then `npm run deploy`. The first builds/validates without API writes; the second builds and deploys with `.dev.vars.production`. No dashboard build command or Wrangler is required.
5. With admission still disabled, run `npm run smoke:production`. It checks health/static assets, operator access control, every complete original's SHA-256, rejected paid admission, and unchanged accounting. Its two-second address-attempt timeout avoids Node's too-short default on this WSL network; it does not retry requests or enable admission.

Observed deployment verification: `cf deploy` installed the Worker, Queue consumer/producer, Workflow, and cron. Live authenticated status proved the Worker→Hyperdrive→Neon connection and closed empty ledger; all 24 original downloads matched manifest SHA-256 values. Chromium rendered the app and three reviewed knowledge records, opened exact passage evidence, and displayed HTTP 503 on a denied assessment request. No paid call or credit purchase was made. The existing 25 TypeScript tests and one Python test passed. This does not establish paid workflow execution, model quality/latency, or production recovery qualification.

### GitHub automatic deployment

Cloudflare Workers Builds is connected to the private `Zura1555/memory-bank` GitHub repository. Pushes to **`main`** automatically build and deploy the existing production Worker. Preview builds are disabled; feature branches do not deploy against the production database. There is no second GitHub Actions deployment pipeline.

| Setting | Value |
| --- | --- |
| Build / deploy commands | `npm run typecheck && npm run build` / `npx cf deploy --prebuilt --mode production` |
| Branch / root directory | `main` / `/` |
| Build runtime | Node.js `24.19.0`, pinned npm dependencies, build cache enabled |
| Repository connection / production trigger | `ae220010-2dd7-4a19-8916-4588943ac989` / `f026b4df-6f19-4b70-b258-8cee7930a1e0` |
| Deployment credentials | Dedicated `memory-bank production` build token, scoped to the selected Cloudflare account |

The hosted deploy command intentionally differs from `npm run deploy`: it deploys the build once and preserves existing Worker runtime secrets without requiring the private `.dev.vars.production` file in GitHub or the build environment. The build token has account-read, Worker-write, R2-read, Queue-write, and Hyperdrive-read permissions; no Neon or OpenRouter credentials were added to GitHub. Corpus publishing and database migrations remain explicit operator actions, not automatic push side effects. Git deployment does not enable paid admission.

Inspect builds under [Memory Bank → Settings → Builds](https://dash.cloudflare.com/6d5eb3fa868f53e83e13401577cdfc01/workers/services/view/memory-bank/production/settings/builds), or run `npx cf builds triggers list --external-script-id b1adf51e4e0144388cfc1166d609a5cf`.

## Verification and release gates

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run ingest`. Then exercise the local Worker and verify source downloads, capability ownership, budget-denied admission, queue/outbox recovery, workflow state transitions, and retention cleanup. Paid qualification requires the approved existing credit, a valid key, and measured full P1–P4 runs; freeze configuration before H1–H4. Record real model usage/cost, queue wait, phase processing time, full-context fit, extraction fidelity, memory, replay behavior, and source/version access. Do not claim these results from fictional fixtures or code inspection.

The [qualification report](docs/qualification-2026-10-15.md#remaining-gate-investigation-and-correction--2026-10-17) preserves all failed evaluations and subsequent corrections. Final exposed checks completed 12 assessments and 11 selected briefs; independent semantic review passed, unchanged-output replay checked 2,675 canonical references, 22 live pack exports and all 24 original hashes. **The four freshly frozen requests did not qualify: F3 passed; F1 excluded required starting material, F2 omitted an access-duration constraint, and F4 withheld the expected negative conclusion after independent request-inventory disagreement.** No outputs or expectations were repaired and no missing selection was forced. H2 improved but one final assessment missed 90 s; P3 assessment and P3/P4 briefs also missed targets. The owner chose to finish the current profile and disclose those misses, with 128 MB total-isolate fit left open. Local process/inspector samples are not isolate-quota proof. Typecheck, 35 TypeScript tests, one Python test and build passed; this is not release qualification. Billing monitoring remains stopped; no purchase, model/profile change, merge, deployment or public release is implied.

PR #23 integration verification (2026-10-17) combined PR head `7ab64ca` with main `495a8d5`, then incorporated main's Sources follow-up at `08d2472`, without replacing either workflow wholesale. Typecheck, 37 TypeScript tests, one Python test and the Cloudflare build passed again after that follow-up. Chromium exercised the built client with synthetic API receipts and a retained checked result: shell navigation retained findings, exact artifact/passage selection reached a checked brief, History save/reload/reopen used only a status read, and missing timing remained unavailable. At 320px in dark mode, keyboard entry, labelled disclosures, drawer Escape/focus return and no horizontal overflow passed. The final Sources build also rendered all four provenance labels, explicit retained-version identity, and requested source identity during failed retrieval without a dialog download link, using synthetic presentation fixtures. This is UI replay, not a new Worker/database/model qualification. The integrated candidate needs a new frozen qualification fixed point; fresh, latency, memory and release gates remain open.

Infrastructure deployment is now authorized and performed as described above; that authorization did not enable paid admission or change repository visibility. Keep the repository private until the source/secrets review is complete; make it public only under the approved submission plan.
