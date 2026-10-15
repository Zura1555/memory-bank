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
4. Start local PostgreSQL: `docker compose up -d postgres`. The first database initialization applies `migrations/0001_init.sql`; the local database is loopback-only on port 5433 and ephemeral. Its budget and admission state reset when the container is recreated.
5. Build the curator manifest and audit: `npm run ingest`. Publish only to Wrangler local R2: `npm run publish:corpus`.
6. Run `npm run dev`, then open `http://127.0.0.1:8787`. The Worker builds the static UI before starting.

Admission is disabled by default. Before enabling it, verify the initial remaining OpenRouter credit and route pricing in the provider dashboard or read-only provider API (`GET /api/v1/credits` and `GET /api/v1/models`); round remaining credit down to integer microUSD. `/api/operator/budget` records that campaign balance (1 USD = 1,000,000 microUSD). Metadata checks do not qualify the model route or full workflow. The $5 maximum caps admission, not provider invoices. The $0.30-per-call and $0.60-per-phase values are holds, not hard charge limits. Reconcile every terminal phase—including successful ones—against actual provider usage before further admission; the hold remains until reconciled, and an overage blocks later admissions but cannot prevent the provider charge. Do not reset the balance to the post-spend dashboard remainder because the ledger also subtracts reconciled spend. Disable admission if external activity changes the balance. This endpoint cannot query, add, or top up credit.

The app has no fake AI fallback. Without a valid key and enabled ledger, paid jobs fail closed. Local queues, Workflows, and R2 use Wrangler's local platform implementation. Remote resources, secrets, provider qualification, public release, and deployment are not configured or performed by local setup.

## Operator-only local operations

Use `Authorization: Bearer $OPERATOR_TOKEN` with `/api/operator/status` to inspect active work, provider usage, reservations, and reconciliation history. `PUT /api/operator/budget` accepts `availableCreditMicroUsd` and `admissionEnabled`; it only sets the owner's verified existing balance and does not create credit.

Verify operator authentication and concurrent database access with `node --env-file=.dev.vars --experimental-strip-types src/server/db.smoke.ts` while the local Worker is running. This read-only check submits no model jobs. Each database operation gets its own pool, and each checked-out connection is retired on release; neither sockets nor pending pool connections may cross Worker request contexts.

`POST /api/operator/reconciliations` accepts `reservationId`, `actualMicroUsd`, and a non-empty audit `note`. If a model attempt remains `dispatching`, wait at least two minutes, verify in provider records that it is no longer active, and include `confirmAbandonedDispatch: true`. Never reconcile an uncertain charge by assuming it was free. Reconciliation blocks replay and does not cancel an in-flight provider request.

## Application boundaries

- The runtime reads the published eight-case manifest and exact originals from R2; it verifies SHA-256 before using a source or serving a download.
- `ingestion/` is offline curator tooling. It supports native text/CSV and format-aware Office/PDF/image paths; scans and visual observations require a hash-bound human-audited sidecar. Missing or incomplete extraction is excluded, never guessed.
- `evaluation/keys.json` is offline-only and is not copied into `dist/`, R2, prompts, or application routes. Do not use evaluation keys for prompt tuning.
- Anonymous job capabilities protect status/results. Application request/results expire after seven days; minimal accounting/idempotency records remain for operator reconciliation. Workflow checkpoint retention is configured for seven days; provider/platform/backup retention is separate and is not promised to be zero.
- Queue/Workflow duplicates use stable IDs. Paid model calls have no automatic retries or fallback; uncertain dispatch requires operator reconciliation.
- Human-reviewed decision and lesson cards live in the versioned curator corpus, not expiring jobs. Browse `/?knowledge`, address a record with `/?knowledge=<recordId>`, or inspect it in case details. Cards link exact supporting passages/originals and mark superseded advice as history. Applying a lesson still requires the existing checked, request-specific recommendation pipeline; no new paid stage is added. See [curator authoring and review](ingestion/README.md#decision-and-lesson-records).

### Evidence inspector

The evidence inspector uses Base UI Dialog with the existing CSS tokens, including dark mode. Escape, the close button, or an outside press dismiss it; focus returns to the invoking inspection control. Each selected source reference mounts fresh passage state, aborting retrieval on close or replacement so a late response cannot overwrite another passage. Validation and exact-original downloads still use the existing evidence endpoints.

`/api/*` runs through the Worker before SPA asset handling so download navigations return the exact original rather than `index.html`. With the local Worker running and corpus published, run `node --experimental-strip-types src/server/evidence.smoke.ts` to check navigation-mode original downloads, SHA-256, and exact passage identity without model calls.

The document-first hierarchy, muted provenance, neutral dismissal, and separated header follow public Anduin [document review](https://support.anduintransact.com/en_US/investor-data-management/review-submitted-requests) and [source-linked review](https://developers.anduintransact.com/docs/handling-digital-vs-ocr-processed-subscriptions) references. These are observed product patterns, not access to Anduin's private design tokens; no second theme is introduced.

For a browser regression smoke, open checked passages from both checked examples and selected work. Verify Tab/Shift+Tab containment, visible focus, Escape/close focus return, loading, failed and mismatched-source responses, and closing/reopening another passage while retrieval is delayed. Check exact-original bytes against the retained source, then inspect 320px-wide and dark-mode layouts. Replaying an existing checked assessment avoids new paid model calls; it does not qualify the AI workflow.

## Verification and release gates

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run ingest`. Then exercise the local Worker and verify source downloads, capability ownership, budget-denied admission, queue/outbox recovery, workflow state transitions, and retention cleanup. Paid qualification requires the approved existing credit, a valid key, and measured full P1–P4 runs; freeze configuration before H1–H4. Record real model usage/cost, queue wait, phase processing time, full-context fit, extraction fidelity, memory, replay behavior, and source/version access. Do not claim these results from fictional fixtures or code inspection.

The [2026-10-15 qualification report](docs/qualification-2026-10-15.md) records an interim ready P1 assessment-to-brief run, reviewed cards, and subsequent integrated qualification failures. The final integrated gate remains blocked by an unresolved paid dispatch; admission is disabled and its reservation is preserved. Do not claim issue #2 or the dependent card delivery qualified from the interim run.

Remote deployment requires separately approved Cloudflare/Neon resources and credentials, including Hyperdrive, Queue/dead-letter queue, Workflow, R2, and the deployed static asset binding. Keep the repository private until the source/secrets review is complete; make it public only under the approved submission plan.
