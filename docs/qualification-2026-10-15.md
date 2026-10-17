# Assessment-to-brief qualification — 2026-10-15

Related: [issue #2](https://github.com/Zura1555/memory-bank/issues/2), [issue #3](https://github.com/Zura1555/memory-bank/issues/3).

## Current gate: local checks complete; fresh evaluation failed; latency and isolate memory remain unqualified

The original candidate `569a793` accepted a false claim that the explicitly requested sandbox scope was unstated. The captured draft and supported review remain immutable. The replacement contract requires separate request-constraint inventories in drafting and independent review, and withholds a comparison's assessment and dependents when either inventory conflicts with its stated/absent requirement. Exact quotations, original references, eight-case coverage, independent outcome/disposition review, and the four-call assessment/brief workflow remain required.

The first frozen H1–H4 evaluation on `b37326f` failed; those captures and verdicts remain historical evidence. The owner then authorized fixing the exposed failures in the same worktree. Source-bound generation, a single case-tier decision, role-derived aggregate conclusions, self-contained exclusions, and selection-bound brief generation now produce checked H1–H4 regression results, with visible P1–P4 central checks re-exercised. This is not fresh held-out qualification: H1–H4 were exposed before these changes. H2's final assessment/brief missed the timing targets, and total isolate/RSS memory and other release gates remain unqualified. No captured verdict or generated output was repaired or relabeled.

## Configuration and provenance

- Baseline application revision: `c5d1567` (PR #1 merge). Task worktree: `feat/qualification-knowledge-cards`. The successful run used only the ownership correction described below on top of this revision; cards had not yet been added.
- Local Worker at `http://127.0.0.1:8787`, real local PostgreSQL, Wrangler-local R2/Queue/Workflow. No deployment or remote infrastructure change.
- Corpus: `fictional-onboarding-v1`, eight explicitly fictional cases, 24 originals. Published manifest SHA-256: `506aff7955e1e57cdce9c220382ebb41bd81c7e488a720d9bd36443e4cea23f5`. Both new jobs stored this exact snapshot. Older jobs used a different manifest snapshot.
- OpenRouter `/api/v1/chat/completions`, requested model `openai/gpt-6-luna`; provider `only/order: [openai]`, `allow_fallbacks: false`, `require_parameters: true`. Provider records identify `openai/gpt-6-luna-20260922`, OpenAI.
- Settings unchanged: `stream: false`, `service_tier: default`, `max_tokens: 16384`, `reasoning.effort: none`, strict stage JSON schema, no temperature/tools/plugins. Request deadline 120 seconds; Workflow step deadline 135 seconds.
- Provider/model metadata and existing remaining credit were checked read-only. Credentials were present; operator authentication and concurrent DB access worked. No credit purchase, model/provider change, or increase to the $5 admission ceiling occurred. Holds are not provider invoice limits.
- The owner authorized paid qualification after an explicit spending question, prioritizing quality over cost. After the first failure, a separate approval explicitly authorized correcting ownership and making a fresh paid attempt. Neither run automatically retried a paid call.
- Initial admission was disabled. Existing terminal phases were reconciled before new admission. A duplicate reconciliation attempt returned `409 RESERVATION_ALREADY_RECONCILED` without changing accounting.
- One pre-publication UI submission returned HTTP 503 and created no job or paid attempt. `npm run publish:corpus` then published 24 exact originals plus the manifest into this worktree's local R2 before paid admission.

## Request and observed UI flow

> A client needs a bounded sandbox batch import of about 1,200 active supplier rows, with compatible CSV fields, source-key reconciliation, duplicate-email visibility, and accepted/rejected counts. What prior work is relevant, and what limits must remain explicit?

1. Submitted P1 through the real Chromium UI, not a provider-only harness.
2. Initial job `2aaa4e67-1bdb-42fc-bcf2-bff0e63491ff`: completed draft but failed structural reference/ownership gate. UI displayed **“Evidence check failed. No past-example result is available.”** No support review or brief was dispatched.
3. After the approved fix, fresh job `2d27d701-e360-4ca5-83c3-4208fc0aff74`: ready assessment, 44 visible claims and six withheld claims. Cedar was the useful lead, with explicit questions about schema/version, row count, duplicate policy, and sandbox authorization.
4. Opened the mapping passage inspector in the UI. It displayed the exact source-key mapping at line 9, stated date, source kind, and original link. Followed that original link; the browser navigated to the original endpoint and back to the retained selection surface. Browser download-completion tracking was not available; byte-level download integrity was verified independently below.
5. Selected Cedar `mapping`, exact version `map-2025-02-11`, and passages `p-3ea71e1ac22714630e66f900bd99ce17` and `p-7f1a25ed5a9ec4bf27bc83acaee2fa55` using UI checkboxes. The stored selection matched those identities.
6. Reconciled the ready assessment before admitting the brief. Submitted **Check selected work** in the UI, then disabled further admission.
7. Ready brief displayed one **Adapt** mapping item, no Reuse/Verify items, four checked claims, zero withheld claims, exact-original links, and concrete new-client checks. All four brief claims were manually compared with the mapping original; the historical result was not presented as a new-client guarantee.

## Actual timings

All timestamps UTC. Database differences measure actual application phases; UI targets are not deadlines. Browser next-poll latency was not independently instrumented.

| Phase | Queued | Processing started | Terminal committed | Queue wait | Processing | Queued-to-terminal |
| --- | --- | --- | --- | ---: | ---: | ---: |
| Initial failed assessment | 03:17:17.449 | 03:17:17.541 | 03:18:49.104 | 0.092 s | 91.563 s | 91.655 s |
| Corrected ready assessment | 03:26:30.922 | 03:26:31.716 | 03:28:25.573 | 0.794 s | 113.857 s | 114.651 s |
| Corrected ready brief | 03:30:38.652 | 03:30:39.230 | 03:30:57.345 | 0.578 s | 18.115 s | 18.693 s |

Corrected UI-submit timestamp: `03:26:30.283`; brief-submit timestamp: `03:30:38.105`. Submit-to-server-terminal times were 115.290 s and 19.240 s respectively. First submit to ready brief was 267.062 s, including manual inspection/selection/reconciliation between phases. Assessment exceeded its 90-second target; brief was within its 30-second target. Neither proves a percentile latency target.

## Actual charges and usage

Costs are provider `GET /api/v1/generation` `total_cost`, not holds. Every generation in the local accounting database was checked. Provider completion alone did not qualify a result.

| Generation ID | Context / phase | Prompt tokens | Completion tokens | Actual USD |
| --- | --- | ---: | ---: | ---: |
| `gen-1792032769-mEn6ChGsQe43nV8gUDQw` | Prior failed assessment | 16245 | 10041 | 0.006980539 |
| `gen-1792033560-gjCO9lnGLIYBWIeeFnh5` | Prior ready assessment draft | 17250 | 15881 | 0.009995708 |
| `gen-1792033670-BQ15kt9ibcmDOtwINffb` | Prior ready assessment review | 35078 | 1621 | 0.005143223 |
| `gen-1792034239-2wvRd9TP0pnhHdkALgZN` | Initial P1 failed assessment draft | 16269 | 13153 | 0.008356703 |
| `gen-1792034793-d7UGV50Aq5VdLjOYntPc` | Corrected P1 assessment draft | 16307 | 11753 | 0.007835652 |
| `gen-1792034896-V3xjYTZ1PZsLkE7WEkHR` | Corrected P1 assessment review | 28449 | 711 | 0.003872434 |
| `gen-1792035040-7w8Mixbm3A2To9zDRVKH` | Corrected P1 brief draft | 14335 | 1662 | 0.002596572 |
| `gen-1792035055-lX9V6CzOCczVpmM18VdB` | Corrected P1 brief review | 15111 | 62 | 0.001900602 |

- Initial failed P1 actual: USD **0.008356703**. Reservation `f72b247a-9434-4121-8521-20e196cd16f9` reconciled to 8,357 microUSD.
- Corrected assessment actual: USD **0.011708086**. Reservation `ad92d55a-22ee-4364-a409-a3b271b39a9b` reconciled to 11,709 microUSD.
- Corrected brief actual: USD **0.004497174**. Reservation `a78755f6-6103-4575-a241-5ed8a510c047` reconciled to 4,498 microUSD.
- Corrected full run: USD **0.016205260**. New work including failed baseline: USD **0.024561963**. MicroUSD accounting rounds upward once per phase; it is deliberately not the displayed exact provider decimal.
- Account usage before initial paid P1: `0.467976225`; after failed P1: `0.476332928`; after corrected assessment: `0.488041014`; after brief: `0.492538188` USD. Each delta matches the corresponding generation total. Account total includes earlier activity beyond these local jobs; it is not this task's cost.
- Initial generation lookup briefly returned 404. No zero-charge assumption or new admission occurred; a later read-only lookup returned actual cost. Application usage had finer sub-nanodollar precision than generation records, e.g. `0.00835670385` versus `0.008356703`; reconciliation used provider records and the matching credit delta.
- Final campaign after qualification: 46,684 microUSD reconciled spend, zero held, no active attempt, admission disabled. Remaining provider credit: USD `4.507461812`. No dispatch was uncertain and no unresolved charge was released.

## Interim root cause and verification (later superseded by upstream PR #6)

Replayed the initially stored output through the executed revision's `parseAssessmentDraft` and `validateAssessmentDraft`, using the stored corpus: `CLAIM_ARTIFACT_SCOPE`. Eight assignments mixed sibling-artifact context into work roles. Example: Cedar `mapping` used `cedar-request`, whose evidence belongs to the same case's `request` artifact.

The interim fix distinguished two contracts: each artifact's disposition recommendation had to cite that exact artifact; contextual supporting/blocker/verification claims could cite sibling artifacts in the same case. Cross-case-only role evidence remained rejected. Exact case/artifact/version/passage checks and separate support review were unchanged; any unsupported role still withheld the work item. The interim prompt stated the same ownership rule as that gate revision.

Replaying the same captured draft after the interim correction passed structural validation while still identifying an invalid-reference recommendation for withholding; no references were fabricated or repaired. A regression at that interim revision exercised same-case context, unsupported-context withholding, wrong-artifact recommendation rejection, and cross-case context rejection. The fresh real UI run then exercised all four model stages. This interim gate change and its regression were later removed when the stricter upstream fix was integrated; see the integration record below.

## Manual quality review: observed limits, not hidden failures

All 44 accepted assessment claims and all four accepted brief claims were reviewed alongside their cited original excerpts. The central Cedar brief retained exact active status, unchanged source keys, no automatic email merging, 1,198 accepted plus two rejected, no observed retry of corrected rejects, sandbox-only scope, and new-client checks. Historical success alone did not justify unchanged reuse.

Assessment failures remain visible and are not repaired in stored evidence:

- `disposition-3-1` compresses Finch's probe as “the v2 polling route returned retired”; the original says TripPine v2 returned 410 **for the v1 polling route**. The independent reviewer accepted imprecise version wording.
- Several `outcomeClaimIds` point at descriptions of the request, not evidence of observed outcomes (Cedar, Ash, Finch, Grove, Harbor, Ibis, Kestrel). For example, Cedar's displayed Partial outcome section cites `c01`, describing the new request. True text does not establish the attached outcome. Outcome-provenance quality is not qualified by readiness.
- Several ruled-out artifacts are classified Adapt while their recommendation says not to use/adapt them for this request. They were not selected, but this disposition/prose mismatch is a recommendation-quality failure.
- `c02` labels the “closest precedent” comparison a source fact rather than interpretation. Elm's accepted count summary retains the recorded 598/600 result but omits the source's separate mention of four intentionally malformed amounts; that source tension deserves explicit treatment.
- Six claims were withheld. Their content was not shown in the user UI; no manual promotion or fake replacement occurred. Withholding does not prove every remaining claim correct.

Grove source inspection preserved rejected, never-provisioned broad-admin advice, the scoped corrective setup, incomplete audit detail, and unobserved expiry removal. This P1 run was not a P3 conflict-qualification run. Human review of three bounded Grove cards was separately obtained from the owner in this task conversation before card authoring; it is not inferred from model output.

## Access and source integrity

- `node --env-file=.dev.vars --experimental-strip-types src/server/db.smoke.ts` passed: missing operator authorization returned 404; three authenticated concurrent database reads returned 200, with no paid jobs submitted.
- Missing and syntactically valid wrong job capabilities returned `404 JOB_NOT_FOUND`; authorized UI status reads succeeded. Credentials and capability tokens were excluded from evidence.
- All 24 original downloads returned 200 and matched their manifest SHA-256. All 49 distinct initial-draft passage references resolved to exact case/artifact/version/passage identities. These endpoint checks do not substitute for semantic review.
- The selected Cedar mapping version was among those exact downloads, and the UI inspector displayed its source-key passage. Browser download completion itself was not instrumented.

## Verification scope

`npm run typecheck`, `npm test` (10 passing tests after the ownership correction), and `npm run build` passed. `npm run ingest -- --root /tmp/memory-bank-qualification-ingest-2aaa4e67` generated manifest/audit against a temporary corpus copy, preserving the paid run's frozen snapshot. `npm run publish:corpus` populated local R2 before paid dispatch.

This gate records a usable, observed P1 assessment-to-brief baseline with known assessment-quality defects. It authorizes no deployment/public release and makes no claim about held-out evaluation, all-visible-request coverage, repeatability, memory, retention cleanup, replay recovery, or production billing limits. Issue #3 must preserve these boundaries rather than add paid stages or automatically promote session output.

## Issue #3 supplement: reviewed-card runtime verification

After the P1 baseline, three owner-reviewed Grove records were published under catalog/manifest schema version 2, corpus `fictional-onboarding-v2`, manifest SHA-256 `fbc1d4ae92275efafb23b660446ac78a4b6c624e4ce603d67d2d320e142b63ca`. No original bytes or passage identities changed. This is distinct from the frozen pre-card P1 baseline above.

Actual UI verification on the task-owned Worker at `http://127.0.0.1:8788` exercised the independent knowledge index, direct record permalink, historical supersession warning, correction navigation, and the existing passage inspector. The old admin proposal remained inspectable, explicitly marked “Historical — superseded; not current advice.” The correction displayed unknown rationale and alternatives as “Not recorded.” Supporting passages resolved to their exact identities, and downloaded supporting originals matched their manifest SHA-256. The independent routes required no job capability or generated session data.

The CLI `npm run publish:corpus` timed out after 300 seconds during this second edition's uploads while the local machine was under memory/swap pressure. Publication was completed through Wrangler's documented **local Explorer R2 API**, uploading all 24 originals and publishing the manifest last. No remote writes or substitute evidence were used. The publisher now independently validates records and rejects stale catalog/manifest review metadata before uploading; throwaway rejection checks observed duplicate-ID and stale-review failures before any upload.

A real visible P3 request was then submitted through the existing assessment pipeline:

> A client needs time-limited, read-only diagnostic access for named support engineers, with MFA and audit evidence. The record contains earlier broad-admin advice and a later scoped setup. How should the conflict be represented?

Job `4d63053b-e063-4256-a20e-d645e88b94e9` reached ready assessment with zero withheld claims. Its Grove case details displayed the three cards, including the curator-interpretation lesson. Manual inspection of its seven accepted Grove claims/recommendations confirmed: rejected and never-provisioned broad-admin advice was historical; the scoped correction was explicit; MFA/read-only/named-account constraints were retained; configured expiry was not treated as observed removal; audit detail and new-client identity-provider behavior required concrete checks. The checked `grove-verification` recommendation applied the lifecycle lesson to the request's MFA/audit constraints using original passages, not historical success alone.

| Generation ID | P3 phase | Prompt tokens | Completion tokens | Actual USD |
| --- | --- | ---: | ---: | ---: |
| `gen-1792036166-v0JcaIg1tWIdK9xQohOt` | Assessment draft | 17339 | 8591 | 0.006398172 |
| `gen-1792036238-hq2Cqfr5AOUQwBJAqYMp` | Assessment review | 26296 | 650 | 0.003575805 |

Both provider records identify `openai/gpt-6-luna-20260922` / OpenAI. Actual P3 assessment cost was USD **0.009973977**, matching the provider account usage change from `0.492538188` to `0.502512165`. Reservation `acf58126-6c86-4560-ac37-5dbf87e9e3e0` was reconciled to 9,974 microUSD before further admission.

The P3 UI displayed 676 ms queue wait and 86.4 s processing. Job timestamps were queued `03:49:19.407`, processing started `03:49:20.083`, finished `03:50:46.464` UTC. The stored support-review attempt completion timestamp was `03:50:54.965`, later than the job finish timestamp. This inconsistency is retained as a timing-evidence limitation, not presented as precise end-to-end wall-clock qualification.

Two Grove work artifacts and exact passages were selected in the UI for supplementary brief verification, but the submission returned HTTP 503 after the verification driver disabled admission before asynchronous acceptance. Later driver commands were aborted/time-limited; the P3 brief remained `not_started`, with no brief reservation or generation. No P3 brief result is claimed. This does not replace the completed pre-card P1 brief or the checked P3 assessment recommendation.

Final observed operator state: admission disabled, zero held funds, no active attempt, no pending jobs; campaign reconciled spend **56,658 microUSD**. This task's actual new provider usage, including the failed baseline, corrected P1 run, and P3 assessment, totaled USD **0.034535940**. No paid attempt was automatically retried, no uncertain dispatch was released, and no generated job output was promoted into the three hand-authored cards.

Final feature checks: `npm run typecheck`, `npm test` (12 TypeScript tests plus one Python test with publishing-validation subcases), and `npm run build` passed. `npm run ingest` had successfully built the schema-v2 edition before publication and the P3 run; it was not rerun afterward to avoid silently changing the captured manifest's import timestamps. Task-owned browser/Worker processes and temporary ingestion scaffolding were released after verification; the worktree was retained.

## Historical upstream integration and ownership contract

During publication, `main` advanced to `2a3a487`, merging PR #6 (`414b5ea`). Its ownership fix uses artifact-local inline supporting/blocker/verification claims, with global facts referenced only through dependencies. The task branch incorporated that change with a normal merge, not a rebase or force-push. The interim same-case-role gate relaxation and its overlapping regression were removed. The final implementation retains upstream's stricter exact-artifact provenance gate and the reviewed-card additions; the earlier runs above remain historical observations, not proof of this changed output contract.

The first paid integrated P3 job, `14f274a5-1f99-4ffd-b3f1-0da2179224f8`, did **not** qualify: the application reached `MODEL_DISPATCH_UNCERTAIN` after its 120-second deadline. Provider generation `gen-1792037145-PFUMYNBaVqoqEiSoiRGh` subsequently proved terminal, with `finish_reason: length`, `native_finish_reason: max_output_tokens`, 18,306 prompt tokens, 16,384 completion tokens, and 133,369 ms generation time. Actual cost was USD **0.010375373**, matching account usage rising from `0.502512165` to `0.512887538`. Reservation `48f996cc-96e2-463c-9d7b-b9f54a512c66` was reconciled to 10,376 microUSD only after that terminal provider record was available; admission remained disabled. No support review or brief was dispatched.

After a separate explicit owner approval, the draft prompt was changed to avoid duplicated global/local summaries: keep facts once globally, let artifact recommendations cite their own passages and depend on global facts, leave unnecessary supporting-role arrays empty, and emit only decisive local blockers/checks. Required eight-case/all-artifact coverage, exact ownership, full evidence context, independent support review, model/provider, 16,384-token ceiling, and deadlines were preserved. No incomplete output was repaired, no case was dropped to fit, and no automatic paid retry occurred.

The separately approved compact integrated attempt, job `2f549f57-4305-498d-a9a3-15dccdfecc5e`, was interrupted by development-server reloads during subsequent verification builds/writes. The runtime log records reloads while its paid draft was active. The application accounting row remains **dispatching with no generation ID**; no support review or brief was dispatched. The UI's continually increasing processing time is not a successful result. The provider account usage rose from `0.512887538` to `0.520918838`, a delta of USD **0.008031300**, but that balance delta is not sufficient evidence to assign an exact generation charge. The read-only activity endpoint rejected the current date because it accepts completed UTC days only. No zero-charge assumption or invented generation ID was used.

The owner explicitly chose **“Preserve unresolved hold and stop paid runs.”** The 600,000-microUSD reservation remains held; admission remains disabled. No manual reconciliation or automatic retry was performed for that dispatch. Final integrated qualification therefore **has not passed**. All previously terminal attempts have provider-record reconciliation; this interrupted attempt is the explicit unresolved exception blocking further admission.

The cards, authoring validation, UI surfaces, and model context are implemented and were exercised as recorded above, but delivery against the final output contract remains blocked by issue #2. The earlier PASS heading was revised rather than silently applying historical success to a different revision. Final integrated static checks passed (`npm run typecheck`, `npm test`: 11 TypeScript tests plus one Python validation test, `npm run build`); they do not replace the failed runtime qualification. The final integration is retained locally and must not be presented as a verified published result.

## Fresh audited campaign and qualification failure — 2026-10-15

### Historical dispatch identified; old ledger unavailable

The owner supplied generation `gen-1792037443-J9YbEsAXIek0Eh8wYF9U`. A read-only `GET /api/v1/generation?id=...` independently confirmed creation at `2026-10-15T04:10:42.934Z`, OpenAI model `openai/gpt-6-luna-20260922`, `finish_reason: stop`, `native_finish_reason: completed`, `cancelled: false`, generation time 102,397 ms, and exact `total_cost` USD **0.008031300**. The timestamp matches the captured dispatch at `04:10:42.119Z`, and the charge matches the previously observed provider balance delta. This establishes terminal billing evidence, not an accepted application result.

Before a reconciliation could be submitted, the operator endpoint returned HTTP 500 because PostgreSQL was stopped. Docker inspection confirmed that both retained Memory Bank PostgreSQL containers stored `/var/lib/postgresql/data` on `tmpfs`, with no persistent database volume. No SQL dump or database backup was found in the main or qualification checkout. The historical reservation therefore was **not** reconciled through the operator endpoint; no missing historical rows were reconstructed and no old hold was claimed released.

The owner explicitly chose **“Start a fresh audited local campaign.”** `docker compose up -d --wait postgres` initialized the new local ledger. Operator status confirmed no reservations, no active attempt, admission disabled, and zero reconciled spend. This is a new campaign, not a restoration of the prior ledger. The historical provider charge above remains recorded here separately.

### Executed revision and actual UI result

- Application revision: `2f7466d` on `main`; no application, prompt, schema, gate, or model-setting changes were made for this run.
- Corpus: `fictional-onboarding-v2`, eight fictional cases; manifest SHA-256 `fbc1d4ae92275efafb23b660446ac78a4b6c624e4ce603d67d2d320e142b63ca`. The live knowledge endpoint returned all three Grove records.
- Worker: `http://127.0.0.1:8791`, local PostgreSQL and Wrangler-local R2/Queue/Workflow. Chromium was launched explicitly through `/usr/bin/chromium-browser` after the default managed browser failed.
- The model/provider contract above remained unchanged: `openai/gpt-6-luna`, OpenAI-only, no fallback, `stream: false`, default service tier, no reasoning, strict structured output, 16,384-token ceiling, 120-second request deadline. Read-only model metadata confirmed the route and current pricing before admission.
- Provider credit before admission: USD 5 total credit, USD `0.520918838` used, USD `4.479081162` remaining. The new campaign recorded 4,479,081 microUSD, rounded down. No credit purchase or budget-limit increase occurred.

The same visible P1 request quoted earlier in this report was entered through the actual UI and submitted with **Check past examples**. Job `03dc6eb7-f55a-46c4-8202-1d3a62856d11` was accepted; admission was immediately disabled to prevent another job. No build or source edits were performed in the running checkout during the paid dispatch.

The UI reached **“Evidence check failed. No past-example result is available.”** The job stored `STRUCTURAL_CHECK_FAILED`. Replaying its captured `result_json` through `parseAssessmentDraft` and `validateAssessmentDraft`, without another model call, produced:

```text
GateFailure LEAD_ARTIFACT_NOT_USABLE:
A lead includes work that was not checked as reusable or adaptable.
```

Specifically, the Cedar lead listed `delivery-log` in `usefulArtifactIds`, but its corresponding artifact work had `disposition: verify`. The existing prompt already requires lead useful artifacts to be reuse/adapt work, never verify work. The gate correctly rejected that inconsistent recommendation; neither the gate nor the captured output was weakened, repaired, or reclassified to manufacture readiness. No support-review call or brief was dispatched.

### Measured timing and reconciled charge

| Observation | Value |
| --- | --- |
| Assessment queued | `2026-10-15T06:52:04.290Z` |
| Processing started | `2026-10-15T06:52:10.920Z` |
| Failed terminal committed | `2026-10-15T06:53:55.852Z` |
| Queue wait | 6.630 s |
| Processing | 104.932 s |
| Queued-to-terminal | 111.562 s |
| Provider generation | `gen-1792047134-8AhWlswDCLFYBcIau22R` |
| Provider generation time | 100,084 ms |
| Application-reported prompt/completion tokens | 18,420 / 12,947 |
| Provider `total_cost` | USD 0.008688165 |
| Operator reconciliation | 8,689 microUSD |

The UI independently displayed 6.6 s queue wait and 104.9 s processing, exceeding the 90-second processing target. These are one failed request's observations, not a latency percentile or a successful workflow baseline.

The read-only generation endpoint confirmed terminal `stop` / `completed`. Provider total usage increased from USD `0.520918838` to `0.529607003`, exactly matching USD `0.008688165`. Reservation `2a360f73-1019-46e5-91ae-8325f4905ccf` was reconciled through `POST /api/operator/reconciliations` to 8,689 microUSD, rounded upward once. Final new-campaign status: admission disabled, zero held funds, 8,689 microUSD reconciled spend, no active attempt, and no pending job. No automatic paid retry occurred.

**Qualification remains blocked.** The current run exercised real UI submission, model dispatch, structural rejection, exact provider reconciliation, and fail-closed presentation. It did not exercise ready assessment, supporting-passage inspection, retained selection, ready brief, or their semantic quality on this revision. Issue #4 implementation remains paused under the owner's qualification-first decision; no held-out key was consulted or used to tune prompts.

## Artifact-local useful-lead contract and approved P1 baseline

### Change and verification

- Executed code: `fix/assessment-generation-consistency`, based on merged PR #15, `bc84ef6c9e9c8f33c7f3a7d65b0489802d94851f`, with the schema/parser, prompt-contract, regression, and server-documentation changes in this PR. No source writes or builds occurred while either paid phase was active.
- Before editing, replay of the stored failed job `03dc6eb7-f55a-46c4-8202-1d3a62856d11` reproduced `LEAD_ARTIFACT_NOT_USABLE`. Its output and accounting were not modified.
- Root cause: the model independently generated a lead artifact-ID list and artifact dispositions. The new contract puts an explicit `usefulForLead` boolean beside each disposition and constrains it to `false` in the verify branch. Lead metadata contains only case/state/reasons; the parser constructs the unchanged API ID list from the explicitly nominated artifacts in that case. Reuse/adapt artifacts are not automatically nominated. Contrasts retain their existing lists.
- `gates.ts` was inspected and intentionally unchanged: exact ownership, coverage, support review, separate compatibility review, and `LEAD_ARTIFACT_NOT_USABLE` remain fail-closed defenses.
- `npm run typecheck`, `npm test` (12 TypeScript tests and one Python validation test), and `npm run build` passed. The regression exercises both reuse/adapt nominations, an unselected adapt artifact, valid verify exclusion, rejection of verify-plus-useful by both emitted provider JSON Schema and runtime parsing, and the retained defensive gate.
- A throwaway `node --experimental-strip-types --input-type=module -e ...` smoke fed the captured draft's original disposition/membership choices into the new representation: both provider JSON Schema and runtime parsing rejected Cedar's verify-plus-useful choice. This was a contract smoke, not a repaired or accepted historical result.

- `npm run ingest -- --root /tmp/memory-bank-consistency-ingest-j58z_2w8` passed against a temporary copy of `corpus/` and `contracts/`; the temporary tree was removed and the paid run's frozen manifest was not rewritten.

### Approval, environment, and actual UI flow

The owner explicitly selected **“Approve one full UI flow”** after local checks and accounting preflight. Before admission, operator status showed disabled admission, zero held funds, no active attempt or pending job, and the previous 8,689-microUSD reconciliation. Read-only provider lookup reconfirmed the previous exact charge, USD 0.008688165, and credits showed USD 0.529607003 used from USD 5.

The same visible P1 request above was submitted through Chromium to the task-owned local Worker at `http://127.0.0.1:8792`. Corpus remained `fictional-onboarding-v2`, manifest SHA-256 `fbc1d4ae92275efafb23b660446ac78a4b6c624e4ce603d67d2d320e142b63ca`. Model settings remained `openai/gpt-6-luna`, OpenAI-only/no fallback/strict parameters, `stream: false`, default service tier, reasoning none, strict JSON Schema, 16,384 maximum tokens, 120-second request deadline, and 135-second Workflow step deadline. Provider records identify `openai/gpt-6-luna-20260922` / OpenAI. No model, deadline, ceiling, corpus, or held-out key was changed.

1. UI **Check past examples** created job `232833ce-9a30-4302-8d69-ef86a99d1748`. Admission was disabled after acceptance. The UI reached **Precedent found**, with 52 accepted claims and zero withheld claims.
2. Cedar was the only lead. Its explicit useful artifacts were `delivery-log` and `mapping`; both were Adapt. No verify artifact appeared in the checked lead.
3. UI **Choose work from these examples** opened artifact selection. The mapping's **Inspect checked passage** dialog displayed the exact source-key rule, source kind `native`, stated date `2025-02-11`, and text line 9. Visual inspection confirmed the dialog and source text.
4. Selected Cedar `mapping`, sole retained version `map-2025-02-11`, and checked passages `p-3ea71e1ac22714630e66f900bd99ce17` and `p-7f1a25ed5a9ec4bf27bc83acaee2fa55` using UI checkboxes. Stored `brief_selections` matched all identities.
5. Assessment provider records were obtained and its reservation reconciled before further admission. With no active work or hold, admission was enabled only for UI **Check selected work**, then disabled.
6. The UI reached ready **Checked brief**: one Verify mapping item, no Reuse/Adapt items, six supported claims, zero withheld. The brief conservatively asks compatibility checks rather than promising unchanged reuse; this is a separate brief disposition, not verify membership in an assessment lead.
7. The brief's **Download exact selected original** link resolved to `/api/evidence/originals/map-2025-02-11`; a read-only byte fetch matched manifest SHA-256 `7dd4e8ae29cdd878b579364f03207430cfd0e904b7e75eeb01e4f9bfaf09644a`. Browser download completion is not claimed.

The initial managed browser attachment failed twice; an explicitly launched `/usr/bin/chromium-browser --headless=new --no-sandbox --disable-dev-shm-usage --remote-debugging-port=9337` was attached through CDP and exercised the real application. Two text waits used wording absent from the UI and timed out, but the accepted phases continued normally; neither caused a new submission or model retry. Screenshots confirmed the evidence dialog and terminal brief.

8. Read-only `GET /api/jobs/232833ce-9a30-4302-8d69-ef86a99d1748` checks with missing and syntactically valid wrong Bearer capabilities both returned `404 JOB_NOT_FOUND`. Three concurrent authenticated operator reads succeeded and observed zero holds. No capability or credential is included in this report.

### Exact phase latency

Database timestamps and differences, UTC:

| Phase | Queued | Processing started | Terminal committed | Queue wait | Processing | Queued-to-terminal |
| --- | --- | --- | --- | ---: | ---: | ---: |
| Assessment | 07:12:21.304813 | 07:12:21.771214 | 07:13:50.105230 | 0.466401 s | 88.334016 s | 88.800417 s |
| Brief | 07:15:25.408829 | 07:15:26.083172 | 07:15:44.387213 | 0.674343 s | 18.304041 s | 18.978384 s |

First queued request to ready brief: 203.082400 s, including manual evidence inspection, selection, and reconciliation between phases. The UI displayed 467 ms / 88.3 s assessment and 675 ms / 18.3 s brief. Both processing observations met their targets in this single run; neither establishes a percentile. Host-captured assessment submit time (`07:12:29.282320`) was later than the DB's queue timestamp; cross-clock submit latency is therefore not trustworthy and is not reported as a precise measurement.

### Exact provider charges and every-attempt reconciliation

All four generation records were terminal `stop` / `completed`. Token columns below are generation-endpoint fields, not application response usage.

| Generation ID | Phase | Provider prompt tokens | Provider completion tokens | Provider generation time | Exact USD |
| --- | --- | ---: | ---: | ---: | ---: |
| `gen-1792048346-thZ0ExgMped48eyhZ97e` | Assessment draft | 15,617 | 9,189 | 71,848 ms | 0.007373198 |
| `gen-1792048420-srkpq8SgwhtZBfbX8IBN` | Assessment review | 25,140 | 693 | 6,594 ms | 0.003896689 |
| `gen-1792048528-8qsmDD8C73rrD1wVJWEi` | Brief draft | 13,064 | 1,093 | 12,650 ms | 0.002463417 |
| `gen-1792048541-fZY4MdIHuieiotnx7yHa` | Brief review | 13,920 | 63 | 1,893 ms | 0.001962105 |

- Assessment: exact USD **0.011269887**; reservation `598247e9-c268-41d7-944f-738cb4747d85` reconciled to **11,270 microUSD**.
- Brief: exact USD **0.004425522**; reservation `7424042c-c4a7-4087-900a-c91c38ec00ce` reconciled to **4,426 microUSD**.
- New full flow: exact USD **0.015695409**. Provider credit usage increased from `0.529607003` to `0.540876890` after assessment and `0.545302412` after brief, exactly matching both phase totals. Remaining provider credit: USD **4.454697588**.
- Response usage differs from generation-endpoint token counts: assessment draft 18,510/10,268; assessment review 28,277/803; brief draft 14,719/1,297; brief review 15,536/80 prompt/completion tokens. Response cost also contains finer precision; exact charges above use provider generation `total_cost`, as in prior reconciliation.
- Final fresh-campaign reconciled spend: **24,385 microUSD**, including the earlier failed draft's 8,689. Zero held, no active attempt or pending job, admission disabled. Every one of the five fresh-campaign calls is accounted for. No automatic paid retry or uncertain dispatch occurred.
- PostgreSQL's tmpfs container was never restarted; the existing ledger was preserved. Task-owned Worker/browser processes were stopped only after terminal accounting.

### Manual quality findings and gate scope

All 52 accepted assessment claims and all six brief claims were compared with their cited original excerpts; the selected mapping original was also fetched and checked byte-for-byte. Cedar preserves active-only scope, exact source keys, separate duplicate-email records, 1,198 accepted plus two rejected, no corrected-row retry, sandbox-only outcome, and concrete new-target checks. The brief's six claims retain those limits and do not promise new-client results.

Remaining assessment defects are not hidden by readiness:

- `artifact-3-1-blocker-0` says “the v2 polling route was retired.” The cited probe says TripPine v2 returned 410 for the **v1 polling route**. Independent support review accepted this imprecision.
- Non-lead artifacts remain labeled Adapt while their recommendation explicitly says not to use them as an implementation starting point, e.g. Elm `batch-adapter-notes`, Grove `access-checklist`, and Harbor `scope-inventory`. Useful-lead membership is now structurally consistent, but disposition/prose quality is not solved by this fix.
- `artifact-0-2-blocker-0` is a source_fact phrased as an instruction (“Do not assume…”), rather than cleanly distinguishing recorded limits from recommendation. Elm's accepted 598/600 summary still omits the separate malformed-input count tension recorded earlier.
- Harbor is labeled Failed while its claims preserve unknown client-dependent provisioning outcome. Stopped work and unknown outcome should not be conflated.

**Bounded P1 flow gate passed with recorded quality defects.** No held-out evaluation, all-request qualification, broad reliability/latency claim, production deployment, or public release is authorized by this result. The historical ledger-loss limitation remains explicit; this run reconciles the fresh campaign, not missing historical rows.

## Independently checked case-outcome classifications

The recorded Harbor defect above is preserved as historical evidence. Outcome normalization now creates a distinct `outcome-N` interpretation for each non-unknown label with nominated evidence. Its dependencies are the outcome facts, and its text states the exact label. The existing independent reviewer receives that classification as its own required verdict target, with explicit instructions to distinguish stopped work and unknown provisioning from an observed failed result. The gate requires both the classification and its evidence; unsupported, uncertain, missing, or evidence-free labels become Unknown rather than another classification. Stored results lacking the new classification claim also become Unknown on revalidation; accepted factual context remains visible.

Verification:

- Before the fix, `node --experimental-strip-types --test --test-name-pattern='case outcome labels need their own review' src/server/gates.test.ts` failed: the Harbor-style case, uncertain classification, and missing classification all retained `failed` when their facts passed.
- The regression now covers withholding those labels, retaining supported failure/partial/success, missing evidence, rejected/uncertain dependencies, invalid references, older stored outcomes, and subsequent evidence loss.
- `node --experimental-strip-types /tmp/memory-bank-outcome-smoke.mts` loaded the real local originals through the corpus hash checks and exercised normalization, review-target construction, review validation, the gate, and stored-result revalidation. Using manual verdicts against Harbor's 2025-06-16 delivery-log excerpt, the generated `failed` became `unknown`, the original unknown-provisioning fact remained visible, and the classification appeared in the review inventory. The temporary script was removed after the run.
- `npm run typecheck`, `npm test` (18 TypeScript tests and one Python test), `npm run build`, and `npm run ingest` passed. Ingestion's timestamp-only manifest changes were discarded.

This is a deterministic gate/regression check, not a paid model qualification. No live reviewer or P1–P4 rerun, held-out evaluation, failure-recovery/retention campaign, latency/cost qualification, deployment, or change to repository visibility was performed. The separate disposition-versus-recommendation defect remains open. A reviewer can still make a semantic error; requiring an explicit classification verdict closes the unreviewed-label path, not broad reliability.

## Independently checked artifact-disposition classifications

### Implementation and local proof

Based on pulled `main` `50303f3`, branch `fix/independent-artifact-dispositions`. Normalization creates a distinct `classification-disposition-N-M` interpretation for **every available artifact**, including non-lead/contrast artifacts. It states the exact attached disposition and depends on the artifact's recommendation and all local supporting/blocker/verification claims. The existing support-review inventory requires its own verdict; no paid stage, model setting, API field, citation repair, or replacement label is added.

The reviewer must establish unchanged use without a decisive blocker/unresolved check for Reuse; usable starting material plus concrete changes/checks for Adapt; and a concrete decision-critical check for Verify. Factually supported “do not use as starting material” prose cannot support an Adapt classification. Rejected, uncertain, missing, mismatched, or dependency-withheld classifications withhold the work. The gate removes its useful-lead membership and work claim inventories, preventing passage selection and next actions. Independently supported Adapt work remains available. Read-time revalidation also withholds legacy dispositions lacking the classification rather than treating old results as newly reviewed.

- Before: `node --experimental-strip-types --test --test-name-pattern='attached dispositions' src/server/gates.test.ts` failed with `'adapt' !== null` when the attached classification was rejected.
- After: `npm run typecheck`, `npm test` (**25 TypeScript tests and one Python test**), and `npm run build` passed. The regression covers lead and non-lead rejection/uncertainty/missing verdicts, supported Adapt, selections, next actions, legacy reads, mismatched labels, and rejected role dependencies.
- `npm run ingest -- --root <temporary corpus/contracts copy>` passed without rewriting the pinned manifest. `npm run publish:corpus` published all 24 exact originals and the unchanged manifest to this task's local R2.
- A throwaway Bun/Eval runtime smoke used the actual parser, reference/dependency gate, checked-result builder, live Worker/PostgreSQL/R2, and real Chromium UI. **Synthetic manual verdicts, not model qualification:** 23 contradictory artifacts were visibly withheld and disabled; Cedar mapping remained Adapt/selectable, was the only useful lead artifact, and supplied the only next action. Direct brief admission for withheld request work returned **422 `INVALID_SELECTION_PASSAGE`**, without a model reservation. Legacy-result replay removed the lead and mapping disposition.
- The browser replay intercepted only the create-job receipt for the synthetic checked job; status, revalidation, and evidence used the live Worker. No synthetic result was submitted to the provider. Synthetic application content was subsequently expired and cleared by the real scheduled handler.

### Paid visible qualification: failed first dispatch, unresolved billing

The requested P1–P4 campaign used existing approved credit; no purchase, upgrade, fallback, retry, or model/profile change occurred. Preflight provider credit was USD 5 total and USD **0.674417648** used; the new empty local ledger recorded **4,325,582 microUSD** available, rounded down. Before admission it had zero holds, no active reservation, and no jobs. Its ephemeral PostgreSQL state was backed up locally before and after this campaign; this was not reconstruction of an older lost ledger.

P1 was submitted once through Chromium at `http://127.0.0.1:8794`. Admission was immediately disabled after acceptance.

| Item | Observed value |
| --- | --- |
| Job | `2a5f2f67-627a-4ec6-a83b-e11888a820a0` |
| Reservation | `791dbc69-ce9d-4a93-8a23-31df1b5c43af` |
| Model attempt | `de6faa33-2327-402e-b541-93a41439c8ae`, call index 1 |
| Provider generation header | `gen-1792078484-aIZPi2qwmCiY90vXXm6Q` |
| Queued, UTC | `2026-10-15T15:34:43.679Z` |
| Processing started, UTC | `2026-10-15T15:34:43.802Z` |
| Terminal application state, UTC | `2026-10-15T15:36:32.934Z`, `reconciliation_required` |
| Queue wait | **0.123537 s** |
| Processing | **109.131730 s** |
| Queued-to-terminal | **109.255267 s** |

The UI displayed **“Evidence reconciliation is required. Results are withheld until the checked evidence can be reconciled.”** The stored error is `MODEL_DISPATCH_UNCERTAIN`. No draft result, review call, assessment, or brief was accepted. Processing exceeded the 90-second target; this failed dispatch does not qualify successful-assessment latency, brief latency, token/context fit, or percentiles.

At the 2026-10-15 checkpoint, repeated read-only `GET /api/v1/generation?id=...` calls returned **404**, including that checkpoint's final check. Provider total usage remained USD **0.674417648**, but unchanged balance and a missing generation record did **not** prove terminality or zero charge. No exact cost, token count, returned model, or provider completion state was available then. No reconciliation was posted; the **600,000-microUSD hold**, disabled admission, and active-reservation lock were still present. P2–P4 were **not admitted**, rather than violating the unresolved-charge gate. There was no paid retry. Two browser waits missed the actual reconciliation wording; neither caused another submission. The 2026-10-16 follow-up below supersedes this checkpoint's provider-availability and ledger-preservation status, not its failed application result.

### Exercised failure-recovery, ownership, and retention checks

| Check | Actual result and boundary |
| --- | --- |
| Admission disabled | Live `POST /api/jobs` returned **503 `ADMISSION_NOT_ENABLED`** before paid qualification. |
| Job ownership | Missing and wrong Bearer capabilities returned **404**; three concurrent authenticated operator reads returned **200**. |
| Exact originals | Task-owned original endpoint returned **200** with the manifest SHA-256. The existing `evidence.smoke.ts` also passed, but hardcodes port 8787; only the separate direct 8794 fetch proves this task-owned endpoint. |
| Missing/corrupt essential correction | In task-local R2, corrupted Grove `notes-2025-01-22` returned **503**; a synthetic recommendation depending on that correction lost its lead and disposition, with `cannot_be_established`, not no useful precedent. |
| Exact restoration | Re-uploaded original returned **200**, SHA-256 `b1c784ecf2e3dad6185f4c372b6e1e3ecaf11fc886a9efb62a24741ac7a769e8`; the original checked lead returned without a model call. |
| Incomplete extraction | Actual corpus loader with a synthetic incomplete-extraction manifest excluded the mapping and all its passages, reporting Cedar **partial**. The published manifest was not changed. |
| Database failure/recovery | Actual Hono operator handler with an unreachable PostgreSQL address returned **500 `INTERNAL_ERROR`**; the real local database address returned **200**. The shared PostgreSQL service was not stopped; this is connection-failure proof, not an infrastructure-restart test. |
| Outbox/duplicate delivery | Cleared only this task's outbox publication marker, then invoked `/cdn-cgi/handler/scheduled`. Publication recovered; duplicate queue delivery retained exactly the same single uncertain model attempt/generation. |
| Workflow replay | `wrangler workflows instances restart memory-bank-workflow 2a5f2f67-627a-4ec6-a83b-e11888a820a0-assessment-1 --local --port 8794 --json` followed by `describe ... --local --port 8794 --json` completed with **zero steps**. The job's reconciliation-required guard prevented a new paid call; the attempt and hold were unchanged. |
| Seven-day application expiry | Synthetic expired job returned **410 `JOB_EXPIRED`** with a valid 43-character capability before cleanup. Real scheduled cleanup nulled capability, request, assessment, brief, selections, and model result JSON. Reservation/attempt identities and minimal usage accounting survived. Both smoke jobs' content was cleared afterward. |

These are bounded local checks, not Cloudflare/Neon deployment, upstream deletion, peak-isolate-memory qualification, or successful four-call model execution. The task-owned Worker/browser were stopped after evidence capture. At that checkpoint, PostgreSQL accounting and the unresolved hold were intact, with local SQL backups and private runtime evidence outside Git. Their later availability is recorded in the 2026-10-16 follow-up below.

### Frozen candidate; evaluation and deployment gates remain closed

The executed candidate was snapshotted before the paid run and verified unchanged afterward. Node `24.19.0`, pinned Wrangler `4.151.0`, corpus `fictional-onboarding-v2`; `openai/gpt-6-luna`, OpenAI-only/no fallback/strict parameters, `stream: false`, default tier, reasoning none, strict JSON Schema, 16,384-token ceiling, 120-second request and 135-second Workflow-step deadlines. No prompt/schema/runtime writes or builds occurred during the paid dispatch.

SHA-256 freeze inventory:

| Path | SHA-256 |
| --- | --- |
| `src/server/schemas.ts` | `28908cb29aec609bdf6e2d36fc409a3db8e1bd9db6078beddc61f5691fdf3139` |
| `src/server/gates.ts` | `b7de6beb5f01b477e9c98873681373fb0f84e2617d76dbe9f86769c5df8340e7` |
| `src/server/prompts.ts` | `74a17e8d07a0c359110ea4d985cbb803e12bb26fbd6181dd6a4528597a53a494` |
| `src/server/openrouter.ts` | `211c57f750e2bae86426bf63da508ba921b33d845b4c7c7652c990835471a372` |
| `src/server/workflow.ts` | `b5bde6562f93bf9667fd85fdff8f1505c54c5fede4c7ed008b626b8ba1193bdf` |
| `wrangler.jsonc` | `c5d63c30e22f2237e33a230c263694616580f8cfc43a3b66bc68889a39bb6cf9` |
| `corpus/manifest.json` | `fbc1d4ae92275efafb23b660446ac78a4b6c624e4ce603d67d2d320e142b63ca` |
| `corpus/catalog.json` | `62a076d1b8781fcae00c54be1e97c5cfcd678ae18cc5dd7a895a849e6727a2a7` |
| `web/main.tsx` | `294f3b803962258d787029650963b0500edd070a1f060b918d564c10d1726fe7` |
| `package-lock.json` | `2d1acd60173a7bf4286b125dd7d26c1927ef295f0c1fa6ecd9e984e21d9cf052` |

This freezes the **candidate**, not a qualification-ready release. H1–H4 have not been evaluated or used to tune this change. Terminal provider evidence/reconciliation and successful visible P1–P4 qualification are prerequisites to held-out evaluation. Any subsequent configuration change creates a new candidate requiring its own visible qualification before held-out evaluation. Independent classification review closes the unreviewed-label path but can still make semantic errors. Deployment/public release remain separately gated. Initial publication was paused after the qualification failure; the owner subsequently explicitly requested a PR with these blockers preserved. PR publication does not qualify the failed campaign, release the hold, reopen paid admission, or authorize merge/deployment.

## Terminal provider billing follow-up — 2026-10-16

After merged PR #20, `main` was fast-forwarded from `50303f3` to `1f55420`. Authenticated, read-only `GET /api/v1/generation?id=gen-1792078484-aIZPi2qwmCiY90vXXm6Q` returned **200** at `2026-10-16T02:55:25Z`. The generation ID is exact and its creation timestamp matches the original dispatch; no replacement identity or new model call was used.

| Provider evidence | Observed value |
| --- | --- |
| Generation created, UTC | `2026-10-15T15:34:44.195Z` |
| Returned model/provider | `openai/gpt-6-luna-20260922`, OpenAI, provider response status 200 |
| Terminal state | `finish_reason: stop`, `native_finish_reason: completed`, `cancelled: false` |
| Exact `total_cost` and `usage`, USD | **0.006004152** |
| Reconciliation amount, microUSD | **6,005**, rounded up; not the 600,000-microUSD reservation |
| Reported tokens | 15,258 prompt / 8,962 completion; native 16,087 prompt / 8,108 completion |
| Provider timing | 159,392 ms generation time; 6,573 ms latency |

The read-only credits endpoint returned USD **5** total credits and USD **0.6804218** total usage, leaving USD **4.3195782**. The usage delta from the previous checkpoint is exactly USD **0.006004152**, corroborating the terminal generation record; the balance is not the sole billing evidence.

Provider completion does **not** mean the app received or accepted the output. The app failed after 109.131730 s, before the reported provider generation duration. The provider reports `streamed: true` while the application configuration sends `stream: false`; that metadata discrepancy is not a diagnosed cause. The existing provider-call path preserves `x-generation-id` when response-body reading fails. No captured transport cause establishes why this historical body read failed, and these observations do not prove the 120-second application deadline fired. No response recovery, support review, brief, or new qualification result is claimed.

### Reconciliation blocked by unavailable original ledger

Calling the actual `operatorStatus` implementation against the configured local database returned **`ECONNREFUSED`**. Docker reported the original PostgreSQL container stopped at `2026-10-16T01:23:17.17514166Z`, exit 255, not OOM-killed. Both its inspected configuration and `compose.yaml` place PostgreSQL data on tmpfs; it was not started or recreated.

The recorded temporary SQL backups and private runtime/preflight files are absent. No SQL, compressed-SQL, or dump backup was found at the checked task-worktree or feature-planning directory roots. An external backup may still exist; this check does not establish permanent loss. The original reservation `791dbc69-ce9d-4a93-8a23-31df1b5c43af`, its 600,000-microUSD hold, active lock, and persisted admission state cannot currently be inspected. None was reconstructed or described as successfully released.

Authenticated provider responses and the computed amount were saved privately outside Git with permissions 0600. This report publishes only the sanitized findings, not credentials, capability receipts, raw private responses, SQL dumps, or local planning files.

**Original-ledger reconciliation:** reconciling the original reservation through the operator endpoint still requires an authentic ledger backup. The owner-approved exception below documents the historical charge instead; it does not reconstruct rows, post that reconciliation, or release a fictitious hold.

### Owner-approved lost-ledger exception

On 2026-10-16, the owner explicitly selected **“Approve lost-ledger exception”** after being told that this records the confirmed charge without falsely marking the missing reservation reconciled. The approved scope was to record the approval and exact charge, mark the original reservation unrecoverable from available records, and update PR #21, with **no database reconstruction, paid calls, or admission enablement**.

- The historical charge is documented by this exception using the terminal provider evidence above, not an assumed zero charge or the phase reservation amount. The private decision receipt links the same generation, reservation, exact charge, rounded amount, and approval scope to the saved provider evidence.
- The original reservation remains **unreconciled**. Its historical hold and active lock cannot be verified and are not claimed released. If an authentic backup later appears, inspect it and this exception together to avoid accounting for the same charge twice.
- The previous requirement for an owner accounting decision is satisfied for this historical dispatch. This is a documented accounting exception, not a successful operator transaction or a claim that the unavailable runtime now works.
- Before another paid admission, establish valid accounting and budget state without inventing old rows and obtain authorization for the next run. No replacement campaign was initialized or authorized by this exception.
- Visible qualification, held-out prerequisites, the unresolved historical transport cause, and separate deployment/public-release gates are unchanged. PR publication does not authorize merge.

## Dispatch diagnostics and visitor disclosure — 2026-10-16

Implemented on `fix/dispatch-diagnostics-disclosure` from `main` `1d22474`, without a new paid campaign. `migrations/0003_model_failure_diagnostics.sql` adds nullable, allowlisted HTTP status, failure phase, and transport cause fields. The existing paid-attempt failure update persists them and authenticated operator status selects them. Historical rows are not backfilled. Safe bounded `gen-` identities survive provider rejection and envelope/output-validation failures. No provider payload, arbitrary error message, credential, request text, or stack is added to diagnostic storage.

An observed abort of the call's own 120-second deadline is distinct from an upstream `TimeoutError`, an `AbortError`, and other transport failures. Model/profile, strict checks, output ceiling, deadlines, holds, uncertainty rules, and zero paid-step retries are unchanged. These diagnostics cannot establish the historical dispatch's cause.

### Local executable evidence

| Check | Observed result and boundary |
| --- | --- |
| Before/after interrupted body | `node --experimental-strip-types --test src/server/openrouter.test.ts` initially failed because `failurePhase` was absent; afterward all five provider tests passed, including observed deadline versus generic transport, safe IDs, rejection billing uncertainty, and no retry. |
| Required checks | `npm run typecheck`, `npm test` (28 TypeScript tests and one Python test), `npm run build`, and `npm run ingest` passed. Generated import timestamps were not included in the source change. Primary diagnostics reported no findings in the checked server files; the frontend language-server check timed out, so complete LSP clearance is not claimed. |
| Real database failure/recovery path | `node --experimental-transform-types src/server/ledger.smoke.ts` passed against its random isolated Compose project. Actual `runPaidStage` consumed one intercepted synthetic interrupted response and persisted `uncertain`, HTTP 200, `response_body`, `transport_error`, and `gen-synthetic-interrupted`; operator status returned those values without the synthetic private error detail. All seven ledger tables survived restart, container recreation, and private dump/restore unchanged. Uncertain and reconciled replay attempts added zero provider requests. Admission stayed disabled, the synthetic hold/lock stayed intact, and real provider network requests were zero. The smoke removed only its own resources. |
| Actual Chromium UI | Browser-only receipts/status fixtures using the real safe `jobView` messages exercised provider rejection, missing evidence, and uncertain dispatch in both assessment and brief panels. Each showed its differentiated explanation with no unchecked output. Exact API expiry remained visible during running assessment, selection, running brief, and ready brief/export; export did not repeat the timestamp. Intake linked OpenRouter, OpenAI, Cloudflare, and Neon policies and distinguished application content expiry, retained billing/replay records, backup/upstream retention, and downloaded packs. At 320 px in dark mode, intake and ready brief had no horizontal overflow. This proves UI rendering/transitions, not model semantics or paid Workflow qualification. |
| Actual local Worker | On task-local port 8791, health returned 200 and unauthenticated operator status returned 404. Local R2 publication's per-object CLI exceeded its time limit after 11 originals; Wrangler's local-only `getPlatformProxy` completed the remaining 13, then the exact tracked manifest was restored. On task-local port 8787, `node --experimental-strip-types src/server/evidence.smoke.ts` passed exact-original SHA-256, navigation handling, and passage identity. Task Workers/browser were stopped. |

### Qualification prerequisites remain open

Authenticated read-only provider metadata returned HTTP 200 for credits, model listing, and `openai/gpt-6-luna` endpoints. Total credits remained USD 5 and total usage USD 0.6804218: remaining credit USD **4.3195782**, rounded down to **4,319,578 microUSD** for any future approved admission calculation. The public model listing reports USD 0.10/M input and USD 0.50/M output, with USD 0.20/M and USD 0.75/M at the 272,000-token prompt tier; OpenAI endpoint metadata lists multiple rate bands. Context is 1,050,000 tokens and advertised maximum output 128,000; the application's 16,384-token ceiling was not changed. Metadata is not proof of the effective paid route, full-context fit, latency, memory, support quality, or final billing.

The original `memory-bank-postgres-1` still reports stopped, exit 255, with the same finish time `2026-10-16T01:23:17.17514166Z`; it was not started, migrated, reconstructed, or reconciled. No replacement campaign was initialized, no real budget/admission state was changed, and no paid dispatch was made. A valid durable accounting/budget state and explicit authorization for the next campaign are still required before P1–P4; freeze before H1–H4. Local planning issue 14 remains incomplete. Infrastructure provisioning, signed-out judge-URL acceptance, public-source/secrets review, deployment/public release, and PR merge remain separately gated.

## Authorized durable campaign: P1 assessment result — 2026-10-16

The owner selected **Authorize new qualification campaign** after PR #23 opened. A separate named PostgreSQL volume was initialized with `fsync`, `synchronous_commit`, and `full_page_writes` on; the original lost-ledger container was untouched. Initialization exceeded the health-check grace while `initdb` was observed waiting in `submit_bio_wait`; the database subsequently became available without weakening durability. A private pre-admission dump and candidate/runtime snapshot were saved outside Git. Source/model/prompt/configuration remained frozen at `569a793` throughout both model stages.

- Real Chromium submitted P1 once, creating job `e0f3666c-6c37-4610-87a5-f43699e63d25`. Admission was disabled immediately afterward. All eight cases were assessed; the API returned `precedent_found`, 96 accepted claims and 25 withheld. Processing was **80.826 s** against the 90 s target; queue wait was **5.770 s**, reported separately. This is one observation, not a percentile.
- All 24 live original downloads matched their manifest SHA-256; a passage from each resolved exactly. All 72 distinct references in accepted P1 claims matched case/artifact/version/passage identities, and every dependency resolved to an accepted claim. Missing/wrong job capabilities returned 404; three authenticated concurrent operator reads returned 200.
- Source review confirmed the central Cedar counts, duplicate-email preservation, source-key reconciliation, unretried rejects, and sandbox-only/no-guarantee limits. Mapping and delivery-log remained Adapt; both were selected with eight exact passages. The real inspector displayed the source-key mapping at line 9. The brief was **not submitted**.
- **Observed semantic failure:** accepted `comparison-3-assessment` and its visible environment comparison incorrectly say sandbox/production scope is unstated. P1 explicitly states sandbox. Independent support review did not catch this contradiction. No output, label, prompt, model setting, deadline, or gate was changed to obtain a pass. Held-out content stayed unopened.
- The phase monitor captured no assessment heap samples because its Node WebSocket connection failed. Separate Bun inspector probes measured JS heap successfully, but these are not assessment peak or total-isolate-memory proof. Full memory qualification remains incomplete.

Both model attempts completed. Their independent terminal provider records eventually became available and were saved privately; the owner then requested results only and no further billing tracking. No reconciliation or hold release is claimed. Further admission was disabled, and the task Worker/browser were stopped. The durable campaign volume, private source/result evidence, and backup remain preserved. P1 brief, P2–P4, H1–H4, full quality/memory qualification, deployment, and public release remain incomplete.

## Dual-pass request-constraint correction — 2026-10-16

- **Before:** the private original-capture replay failed with `FALSE_UNKNOWN_REQUIREMENT_ACCEPTED`: all 24 local original hashes verified, eight cases, 96 accepted and 25 withheld claims, and the false environment absence survived parser, authentic supported verdicts, gates, and owned-job revalidation.
- **Rejected intermediate design:** a real, ledger-protected review-only challenge of the unchanged original draft returned an empty environment inventory and again marked its false absence supported. This was one review call, not a fresh assessment workflow. Its result was preserved privately and not published as an assessment; no captured output or verdict was repaired. A reviewer-only inventory was insufficient.
- **Implemented contract:** both existing model passes now extract exact current-request constraint quotations independently of historical facts. Any comparison requirement-presence conflict with either inventory rejects its assessment before dependency closure. Its implication and other dependent actions are withheld; supported historical evidence and unrelated work remain. The result retains the independent review inventory for read/brief/export validation. Prior results lacking the strict review are unavailable rather than silently upgraded.
- **After:** fresh job `a772e781-f7e0-45e3-86b6-e7ae3d115f95` completed both actual model stages through local Worker/Queue/Workflow/PostgreSQL/R2. Both inventories extracted the sandbox constraint. The visible requirement remained “bounded sandbox batch import,” relation Match, without production or new-client guarantees. All eight cases were assessed; mapping and delivery-log stayed Adapt. Processing was 71.425 s and queue wait 6.391 s. Accepted/withheld counts were 79/53, not a standalone quality score. Actual browser DOM assertions and visual inspection confirmed the environment comparison.
- `npm run typecheck`, `npm test` (29 TypeScript tests and one Python test), and `npm run build` passed. `npm run ingest` passed; only generated manifest timestamps were restored to preserve pinned SHA-256 `fbc1d4ae92275efafb23b660446ac78a4b6c624e4ce603d67d2d320e142b63ca`. The regression covers supported false-absence claims with disagreement from either pass, transitive withholding, genuine absence, stated-but-unconfirmed constraints, invented quotations, missing legacy review, and conservative no-precedent classification. LSP navigation reported no server for this worktree; independent TypeScript checking passed.

All raw captures, capabilities, screenshots and connection details remain private outside Git. The broader qualification campaign is authorized but incomplete at this checkpoint. No held-out content has been opened, no production source/deployment was changed, no purchase or billing monitor was started, and no old reservation was reconstructed or reconciled.

## Structurally owned comparisons and final visible qualification — 2026-10-16

The first dual-pass candidate (`008dcc4`) completed P1–P3 assessment-to-brief, but its first P4 draft failed closed at `INVALID_COMPARISON_SCOPE`: four comparison rows belonged to three cases outside its nominated leads/contrasts. The original draft was preserved privately, not repaired. The wire contract now nests comparisons in their owning lead/contrast, forbids per-row case IDs, derives canonical case ownership by containment, and enforces a 24-row combined bound. The existing ownership gate, exact source/reference checks, and independent review remain unchanged. Regression coverage rejects foreign-case citations and the obsolete unscoped shape.

Because the generation contract changed, all four visible requests were exercised again without inspecting held-out content or modifying generated results. Every successful assessment considered all eight cases. These are single observations, not percentiles:

| Request | Assessment processing (s) | Assessment queue (s) | Brief processing (s) | Brief queue (s) | Observed quality |
| --- | ---: | ---: | ---: | ---: | --- |
| P1 | 80.115 | 4.019 | 9.002 | 11.434 | Central proof passed: sandbox Match; Cedar delivery-log/mapping Adapt; counts, source-key reconciliation, duplicate preservation, unretried rejects and production/no-guarantee limits retained. |
| P2 | 59.612 | 3.303 | 12.356 | 11.389 | Failed: review withheld both relevant Elm implementation artifacts and returned no lead. Only the supported Finch warning was selected; its brief retained two source facts but no checked work items. This is not a useful completed reuse brief. |
| P3 | 62.325 | 3.390 | 24.121 | 3.427 | Central proof passed: corrected scoped setup, named accounts/MFA/read-only scope, rejected unprovisioned admin draft, missing audit detail and unobserved expiry removal retained. |
| P4 | 46.335 | 2.273 | — | — | Failed: leads empty, independent conclusion `cannot_be_established`; four context-only request artifacts retained as Adapt. No brief was forced from those misleading selections. |

P4's accepted `disposition-2-0` says, “This is a bulk asynchronous billing integration request, not a migration precedent for the requested online cross-region move,” yet its artifact is Adapt. The other retained requests likewise describe context or missing requirements rather than usable migration starting material. Independent factual support/classification review did not reliably enforce the requested disposition semantics. The bounded-corpus no-useful-precedent expectation was not established. P2's final over-withholding also fails its expected useful-precedent gate despite a successful earlier run. Neither failure is averaged away or repaired by displaying another label.

**Held-out gate:** H1–H4 remain unopened and unrun. Visible quality prerequisites failed; this is not a frozen visible-qualified candidate. A further semantic/contract correction needs fresh visible qualification before held-out evaluation. The local planning tracker records the new disposition/no-precedent decision gate separately; no new disposition category or weakened safety check was silently introduced.

### Runtime evidence and limits

- The final visible workload completed 14 actual provider calls: two for P4 assessment and four each for P1–P3. Requested/returned model was `openai/gpt-6-luna`, provider OpenAI; existing route, reasoning/output settings, strict schemas and no-retry/fallback policy were retained. Prompt sizes ranged **13,886–45,819 tokens**, completions **63–7,799 tokens** under the 16,384-token output bound. There was no observed context/output overflow or corpus truncation. This is observed workload fit, not a maximum context qualification.
- All **24 live original downloads** matched manifest SHA-256; an actual passage from each matched its exact case/artifact/version identity and excerpt. Every accepted claim reference and dependency in all final visible assessments and generated briefs resolved against the canonical manifest. Final corpus SHA-256 remained `fbc1d4ae92275efafb23b660446ac78a4b6c624e4ce603d67d2d320e142b63ca`. P1 Markdown/JSON packs on the dual-pass contract exported successfully with source-key and sandbox limits; missing capability returned 404.
- Actual workerd inspector sampling at one-second intervals yielded **1,153 samples** across candidate/visible phases, including final-contract P1–P3 and P4 assessment. Sampled maximum JS heap used was **32.587 MiB**, allocated JS heap **35.063 MiB**, backing storage **3.725 MiB**. Two context errors occurred during hot reload. `process.memoryUsage()` returned zeros and was excluded. These are sampled JS/inspector components, **not absolute peak, total isolate memory, process RSS, or a production memory-limit guarantee**. Total-isolate memory qualification remains open.
- `node --experimental-transform-types src/server/ledger.smoke.ts` passed on an isolated durable PostgreSQL project: safe failure diagnostics/operator projection, all seven tables across database restart/container recreation/private dump-restore, and zero added provider requests on replay. Its only provider response was synthetic, not a new paid call. The actual final P3 brief's two completed model stages were also replayed through `runPaidStage`: original attempt IDs returned, zero new model attempts, zero provider fetches.
- Local admission was disabled after terminal work; a real subsequent POST returned `ADMISSION_NOT_ENABLED` with unchanged job/attempt/reservation counts. No active Workflow remained. Completed new qualification phase holds were settled only from actual stored provider response usage; no estimate, old lost-ledger reconstruction, abandoned-dispatch release, purchase, or billing monitor was used. The older unreconciled reservations remain distinct.
- The local Wrangler proxy emitted canceled-background-request messages and one operator settlement request lost its network connection. Ledger inspection showed that settlement had not committed; its later idempotent terminal settlement succeeded. Assessment/brief results above reached their recorded terminal states; these proxy events are not claimed as proof of production behavior or a diagnosed runtime fix.

`npm run typecheck`, all 29 TypeScript tests plus one Python test, and `npm run build` passed after the ownership cutover. Earlier `npm run ingest` passed with timestamp-only manifest changes restored. Private evidence contains immutable drafts/reviews, checked outputs, receipts, phase timings, exact references, heap samples, and verdicts. Source changes remain on the existing task worktree/PR; no main-branch push, merge, production deployment, public-source release, or held-out tuning occurred.

## Artifact-role correction and visible requalification — 2026-10-16

### Root cause and contract

An offline replay of the immutable P2/P4 captures reproduced both failures through the original parser, authentic review, and checked-result path. P2 had no invalid references: all Elm claims and Adapt classifications were supported, but the separate nominated-only lead review returned uncertain and removed the starting material. P4 forced every artifact into Reuse/Adapt/Verify, allowing a supported description of irrelevant request context to remain Adapt. Unrelated claim uncertainty also vetoed the corpus-wide negative conclusion.

The shared correction replaces nominated-only lead verdicts with an independent role inventory for every assessed artifact: `starting_point`, `context_only`, `not_relevant`, or `unresolved`. Reuse/Adapt require source-established starting material as well as the existing claim/classification/reference/dependency gates. Conditional Adapt retains explicit new-client checks; unknown compatibility is not approval for unchanged Reuse. Drafts can explicitly exclude work with null disposition, empty role arrays, and a cited explanation, treated as an interpretation rather than a recommendation. The UI adds no work disposition and keeps exclusions unselectable.

A no-useful-precedent conclusion now requires the complete canonical artifact inventory, complete source availability, settled context-only/not-relevant roles, valid references, and consistent request inventories. Unrelated historical outcome uncertainty does not manufacture uncertainty about implementation relevance. Missing/duplicate role reviews, contradictory role conclusions, unresolved relevance, or missing source evidence fail closed. Roles are persisted and rechecked on owned reads, brief admission, export, and browser parsing; legacy results without them are unavailable rather than upgraded.

### Actual visible workflow evidence

The same updated drafting/review contract, provider/model configuration, 16,384-token output bound, no-retry/fallback policy, and pinned eight-case corpus were used throughout. All results were read/exported through the final gate, including its defensive complete-inventory check. No captured draft, verdict, or generated result was repaired or relabeled. These are single observed runs, not percentiles or broad model-reliability claims.

| Request / job | Assessment processing (s) | Assessment queue (s) | Brief processing (s) | Brief queue (s) | Observed central check |
| --- | ---: | ---: | ---: | ---: | --- |
| P1 / `90710ce9-2933-47d4-8161-c6410110dd45` | 52.078 | 4.213 | 10.602 | 2.120 | Cedar mapping remained conditional Adapt; sandbox Match, 1,198 accepted/2 rejected, source-key reconciliation, retained duplicate emails, no recorded retry, and production/scale limits remained explicit. |
| P2 / `a4424e3f-f4a9-4d46-b858-9aaa7d12440b` | 64.298 | 3.516 | 18.869 | 3.739 | Elm batch-adapter-notes survived as conditional Adapt lead and checked brief. The brief retained submit/status/per-item handling, version/500-record/two-300-item limits, new-tenant checks, and no production/general-retry guarantee. Finch was not offered for unchanged reuse. |
| P3 / `e9d445e3-13c7-4286-97d3-17ffe11d7942` | 66.680 | 3.155 | 17.142 | 3.228 | Corrected scoped delivery log/checklist reached an Adapt brief. Named accounts, read-only diagnostics, MFA, rejected never-provisioned administrator draft, missing viewed-record audit detail, and unobserved expiry removal remained explicit. |
| P4 / `645424c1-32b6-4892-8ba3-7bab5fda45a7` | 30.828 | 11.577 | — | — | API and actual Chromium showed no useful precedent; all 24 artifacts had settled negative roles and null work dispositions. Historical outcomes stayed Unknown. No migration plan or brief was invented. |

- All 14 real provider attempts completed: four each for P1–P3, two for P4 assessment. Requested/returned model was `openai/gpt-6-luna`, provider OpenAI. Observed prompts ranged 13,866–39,549 tokens and completions 58–5,881; no observed context/output overflow or corpus omission.
- Every assessment covered all eight cases; accepted references, exact request quotations, and dependencies resolved against the canonical manifest. All 24 live original downloads matched SHA-256. Stored corpus version/hash remained `fictional-onboarding-v2` / `fbc1d4ae92275efafb23b660446ac78a4b6c624e4ce603d67d2d320e142b63ca`.
- Actual Chromium selected the supported work and submitted each P1–P3 brief once. P4's completed receipt was additionally replayed with admission disabled against real owned status/evidence routes: selection showed 19 Context only and 5 Not applicable artifacts, zero enabled work checkboxes. A direct context-artifact brief submission returned 422 `INVALID_SELECTION_PASSAGE` before paid admission.
- All six actual JSON/Markdown pack downloads for P1–P3 returned 200 through final revalidation and contained no visitor capability. P4 had no supported selections and no admitted brief; the explicit invalid-selection probe above was rejected before a paid phase.
- `npm run typecheck`, `npm test` (32 TypeScript tests plus one Python test), and `npm run build` passed. New behavior regressions preserve conditional starting material with all claims supported, reject context-only Adapt, block unchanged Reuse with checks, establish a complete negative review despite unrelated outcome uncertainty, reject incomplete/legacy roles and missing source evidence, and exercise explicit exclusion through the parser. LSP navigation had no server for this worktree; independent TypeScript checking is the compiler evidence.
- `npm run ingest -- --root /tmp/memory-bank-role-ingest-gFnlKa` passed against an isolated corpus/contracts copy; the candidate's pinned manifest and originals were not rewritten.

Local admission was disabled after terminal phases; a real POST returned 503 `ADMISSION_NOT_ENABLED` without changing job/reservation/attempt counts. There was no active Workflow. New completed-phase holds were settled only from actual stored terminal provider-response usage. No billing monitor, credit purchase, abandoned-dispatch release, old-ledger reconstruction, production admission change, merge, or deployment occurred. The durable campaign and immutable private captures/backups remain outside Git.

**Remaining gates:** H1–H4 are still unopened/unrun; total-isolate/RSS memory and the separately recorded release gates remain unqualified. These visible central checks resolve P2/P4, not production reliability, held-out qualification, deployment approval, or public release. Prior recovery/replay/heap measurements above retain their stated historical boundaries; they were not reclassified as fresh measurements of this candidate.

## First frozen held-out evaluation — 2026-10-16

### Freeze and protocol

The owner explicitly requested H1–H4 after visible P1–P4 central checks passed. Before opening the keys, the clean existing task worktree was frozen at `b37326fe8aaef248cd651f003e7a836b4ce72f73`, tree `dcb22e2bd164ef994fdf00a82fe7c30f5749cf51`. Evaluation-key SHA-256 was `59875e3e5d4cfd33a6cd2958bef4b1ac7e993224971e0ec50bedac127cb73305`; corpus SHA-256 remained `fbc1d4ae92275efafb23b660446ac78a4b6c624e4ce603d67d2d320e142b63ca`. After all four runs, HEAD, the clean working tree, and both file hashes were unchanged. This report update occurred afterward and changes no application behavior.

Only each held-out request text was submitted to the actual Chromium intake. Expected evidence, decisive constraints, acceptable uncertainty, and prohibited recommendations stayed offline and were not added to model context. The existing local Worker/Queue/Workflow/PostgreSQL/R2, production-authorized model credential, OpenRouter/OpenAI `openai/gpt-6-luna`, output bound, deadlines, and no-retry/fallback policy were retained. No production admission or deployment changed. Each request was admitted once; there was no paid rerun or tuning between requests.

### Observed results

| Request / job | Assessment processing (s) | Queue wait (s) | Actual provider calls | Result and reproduced rejection |
| --- | ---: | ---: | ---: | --- |
| H1 / `70a2ff53-d818-4444-92a2-af875d5dfb8f` | 58.844 | 11.864 | 2 | Failed: `INVALID_REQUEST_CONSTRAINT_REVIEW` in checked-result construction. Draft and review constraint inventories quoted historical Ibis text rather than the current request, including “in the test environment.” No checked handover distinction or brief was delivered. |
| H2 / `2baa26ce-210e-48cc-a288-3f4438d7c0e4` | 103.085 | 10.760 | 2 | Failed: `CONFLICTING_ARTIFACT_REVIEW`. The reviewer concluded `no_useful_precedent` while assigning `starting_point` to Cedar mapping, Ash reconciliation draft, Ibis runbook, and Kestrel operations draft; no lead was nominated. Processing also exceeded the 90 s target. |
| H3 / `9545e208-4b64-4e3a-ac09-bc996709e842` | 61.586 | 11.187 | 1 | Failed: `CLAIM_CASE_SCOPE` during draft reference/ownership validation: a case claim lacked evidence from its own case. Independent review was never dispatched. No checked correction/compatibility result or brief was delivered. |
| H4 / `91ed0c29-e6e7-4f1a-ac4d-6d3589cc008e` | 83.059 | 10.462 | 2 | Failed: `INVALID_REQUEST_CONSTRAINT_REVIEW`. Inventories included source-only constraints absent from the current request, such as “two operators” and the historical network-route restriction. No checked bounded no-precedent result was delivered. |

Every owned API result was `assessmentState: failed` with safe `STRUCTURAL_CHECK_FAILED` disclosure. Actual Chromium displayed the differentiated failure panel and no unchecked generated result. Briefs were not admitted because no assessment became ready. Safe withholding is observed; it is **not** a useful-result pass, proof that the rejected prose was semantically correct, or a substitute for any expected source-backed behavior.

Each failure was reproduced offline with `node --experimental-transform-types` and a private unchanged-capture replay using the actual frozen parser/gates, authentic model outputs, and all 24 SHA-verified originals. All four exited 1 at the stages/codes above. No verdict, quotation, citation, role, conclusion, or generated output was repaired. Raw captures, capabilities, replay inputs, and database backups remain private outside Git.

### Usage, accounting, and shutdown

All seven dispatched provider attempts completed and reported usage: requested/returned model `openai/gpt-6-luna`, provider OpenAI. Every raw draft included all eight cases. Prompt sizes were 17,165–40,639 tokens; completions were 2,009–5,556, within the unchanged 16,384-token bound. This proves observed workload fit, not acceptance or broad context capacity. There were no ready assessments, briefs, selections, or export packs to qualify.

Stored terminal provider-response usage totaled USD **0.03374686755**. Per-phase upward rounding produced **33,749 microUSD** reconciled across the four new reservations (H1 9,268; H2 10,509; H3 3,993; H4 9,979). This is application accounting from actual response metadata, not independent invoice/credit monitoring. The two-call settlement helper initially skipped H3's one-call terminal phase, leaving its hold intact during H4. After all runs ended, the failed H3 job, its sole completed draft, and absence of a dispatched review were verified before settling only that actual usage. No uncertain/abandoned charge or older reservation was released or reconstructed.

Local admission ended disabled with no active Workflow. A real subsequent POST returned 503 `ADMISSION_NOT_ENABLED` without changing job/reservation/attempt counts. All four new phase reservations were verified reconciled. A final private durable-database dump and immutable captures were saved; task Worker/browser were stopped and task-created secret configuration removed. No purchase, billing monitor, main push, merge, deployment, or public release occurred. No new application tests/build were required for this evaluation-only, documentation-only change; the earlier visible-candidate static checks are historical, not new held-out evidence.

**Gate verdict: failed.** Do not average these cases away or describe a safely withheld result as qualified. H1–H4 are now exposed evaluation material. A subsequent fix may use them as regression cases, but a new held-out claim requires fresh, untouched requests fixed before that change. Total-isolate/RSS memory, production behavior, and the other release gates remain separately unqualified.

## Source-bound generation and exposed H1–H4 correction — 2026-10-16

### Shared contract fixes

The owner requested fixes after the failed frozen evaluation. The same dedicated worktree and provider/model configuration were retained; H1–H4 are now explicitly **exposed regression cases**, not held out.

- Current client text is separated from full historical context. Both existing assessment passes select inventory quotations from request-bound sentence/chunk choices; historical request text is not a possible choice. Existing exact-substring, dimension-presence, and dependency-withholding gates remain. Global claim schemas pair each case with its available source IDs, preventing H3's foreign-case attribution.
- Each generated case has exactly one lead/contrast/context tier, containing its reasons/comparisons. The parser derives the existing API lists; it does not choose or repair a tier. This also closes an intermediate duplicate-tier failure. Independent per-claim outcome/disposition review, comparison containment, and the 24-row bound remain.
- Artifact roles are the independent relevance decisions. The server derives the aggregate conclusion from full reviewed coverage and accepted nominated work; no second model-written aggregate can contradict the roles. An omitted or unsupported starting point cannot become a lead or a negative proof. Missing evidence/unresolved roles remain conservative. Reads never upgrade an already stored uncertain conclusion.
- Null exclusions must be self-contained, with their own cited explanation and no authored claim dependencies; the parser still creates the independently reviewed classification/dependency relationship. This prevents dangling references to omitted outcome aliases without dropping or repairing any generated edge.
- Brief item identities and claim ownership are bound to exact selected artifacts/versions, preventing full-case background from adding unselected work. Drafting keeps checks atomic and source-backed rather than adding unsupported operating requirements. Independent brief review remains unchanged; uncertain checks and their dependents are still withheld.

The new provider-boundary regressions failed before the respective schema changes: historical text was accepted as a request-inventory choice, and an unselected background artifact was accepted as a generated brief item. Final tests also reject foreign-case claim pairings, duplicate tier-list output, dangling exclusion dependencies, and arbitrary aggregate labels; accepted negative/uncertain inventories, omitted starting points, real selection eligibility, and conservative stored-result revalidation remain covered. No benchmark-specific answer, source substring special case, extra paid stage, automatic retry/fallback, or relaxed reference/graph gate was added.

### Observed end-to-end results

All eight final assessments completed with all eight cases. Six applicable selected-work paths produced checked briefs. Single observations, queue wait separate:

| Request / job | Assessment processing (s) | Assessment queue (s) | Brief processing (s) | Brief queue (s) | Observed central behavior |
| --- | ---: | ---: | ---: | ---: | --- |
| H1 / `dc66458e-ec2b-4699-889b-a2b31de4799f` | 76.322 | 17.020 | 19.513 | 26.776 | Ibis named owners and corrected test recovery distinguished from Kestrel's contradicted ownership/no exercise. Selected runbook stayed Adapt; production readiness/recovery was not inferred. |
| H2 / `ca5d89f0-2171-47c4-a306-d2c1ce6bc34d` | 117.361 | 16.226 | 46.228 | 14.072 | Cedar's small sandbox boundary, Ash duplicate-email/missing-ID risks, 3,000 uncertain commits, and unverified restart preserved. Ash controls reached a Verify-only brief, explicitly not an executable or validated procedure. Both timing targets failed. |
| H3 / `e5ab8041-d06b-4048-ba9a-4b5cbf082beb` | 75.463 | 0.851 | — | — | Dated withdrawal, retired v1 route/410, 38/40 older samples with two unexplained pending, absent v2 capabilities, and no bulk attempt/alternative retained. No obsolete polling implementation or selectable replacement was offered; no brief forced. |
| H4 / `a2a226ad-6fac-47a3-a2a0-abd74aa28d18` | 70.854 | 16.651 | 19.793 | 8.162 | Bounded no-useful-precedent; networked Grove setup not offered as an offline solution. Selected inventory produced only prerequisite Verify checks for missing middleware/trust/lifecycle materials, not a provisioning plan. |
| P1 / `12eb189b-57e7-419d-8cfa-0d9b04c01d89` | 83.441 | 8.050 | 5.965 | 16.245 | Cedar sandbox Match, 1,198 accepted/2 rejected, source-key/duplicate/count/retry limits retained. Only the selected mapping appeared in the Adapt brief. |
| P2 / `df00b3bc-ec14-4613-a23c-143f8be62110` | 49.068 | 10.323 | 21.091 | 0.000 | Elm adapter remained a useful conditional Adapt starting point through the brief; version/limits/duplicate/retry checks retained. Finch artifacts excluded from unchanged reuse. |
| P3 / `7480ba81-af33-49c2-96e3-4a0fdc0a642a` | 38.644 | 5.414 | 19.449 | 10.167 | Corrected scoped access, rejected never-provisioned admin proposal, audit-detail gap, and unobserved expiry removal preserved. Selected checklist reached Adapt with an explicit removal check. |
| P4 / `f7328aab-63c7-4b3c-a21c-7d374341f57b` | 69.090 | 8.228 | — | — | Bounded no-useful-migration-precedent, no leads or selectable work, no invented migration plan or forced brief. |

The final generation contract was tightened during verification, not disguised as an unchanged frozen campaign. Intermediate results remain private and are not averaged into the table: a P2 draft had dangling exclusion dependencies; a P2 brief lost its recommendation through an uncertain compound check; H1 independently nominated a case in both tiers; and P1 brief generation added an unselected background artifact. The fixes above address these shared causes. The last brief-selection restriction did not change the assessment contract. Original accepted H1/H2/H4 brief drafts from that assessment contract were replayed unchanged against the final stricter selected-source schema; all passed. Final P1–P4 were submitted under that selected-source restriction. The later stored-uncertainty guard changes only conservative read behavior; every final result was replayed and read/exported through it.

### Final verification and limits

- `npm run typecheck`, `npm test` (**34 TypeScript tests plus one Python test**), and `npm run build` passed. `npm run ingest -- --root /tmp/memory-bank-boundary-ingest-cITHy2` passed on an isolated corpus/contracts copy without changing the pinned corpus. LSP reported no server for the worktree; TypeScript checking is the compiler evidence.
- A private `node --experimental-transform-types .../verify-final-contract.mjs <worktree> <evidence>` replay used the actual current parser, authentic stored reviews, exact selections, gates and read revalidation: **8 assessments, 6 briefs, 1,266 canonical references, 24 SHA-verified originals**, with stored results equal to replayed results and no output edits. All six raw accepted brief drafts passed the final selected-source schema. Twelve live Markdown/JSON pack downloads returned 200; no capability appeared in the packs. All 24 fresh live original downloads matched SHA-256. Corpus hash remains `fbc1d4ae92275efafb23b660446ac78a4b6c624e4ce603d67d2d320e142b63ca`.
- The final result set used 28 completed real provider calls, OpenRouter/OpenAI `openai/gpt-6-luna`; prompts 13,423–48,912 tokens and completions 41–7,334 stayed within the existing bound. Across all intermediate and final work in this correction, 18 jobs produced 57 completed calls and 30 reconciled new phases. Actual stored response usage totaled USD 0.2435522562; per-phase upward rounding reconciled 243,568 microUSD. These are application response-usage/accounting records, not provider credit or invoice monitoring. Single-draft terminal structural failures were settled only after verifying review was never dispatched; no uncertain/older hold was released.
- Actual Chromium exercised the new ready results, supported work selection, checked briefs and negative-precedent surfaces. Final live reads/export passed after the conservative revalidation guard. Local admission ended disabled, no active Workflow remained, and a real denied POST returned 503 `ADMISSION_NOT_ENABLED` with unchanged job/reservation/attempt counts. Task Worker/browser and secret configuration were removed; a final private durable backup and immutable evidence remain outside Git.

**Result:** the exposed H1–H4 behavioral/structural failures are corrected, and P1–P4 central behavior remains intact. **Not release-qualified:** the original held-out failure is not erased; fresh untouched held-out requests are required, H2 still misses both timing targets, and total-isolate/RSS memory and separate release/production gates remain unqualified. No purchase, billing monitor, main push, merge, deployment, or public release was performed.

## Remaining-gate investigation and correction — 2026-10-17

The owner authorized fixing H2 and the remaining qualification opens in the existing task worktree. No merge, deployment, production-admission change, new provider/model, purchase, top-up, automatic retry/fallback, or uncertain/older reservation release is authorized by this work.

### Measurement and shared corrections

- The established H2 baseline remains **117.361 s assessment / 46.228 s brief**, queue separate. Its immutable attempt timestamps attribute 93.107 s and 15.515 s respectively to paid-stage/ledger spans, leaving 24.254 s and 30.713 s outside those spans. Captured-input profiling performed actual prompt/schema construction, parsing, reference validation, checked-result construction and revalidation five times: individual operations took milliseconds, not those tens of seconds.
- A separate real H2 diagnostic completed its assessment in 64.794 database seconds, with 64.420 s inside its two paid-stage/ledger spans. Database queries and durable-step boundaries were small in valid spans. That diagnostic did not produce the specifically requested Ash-control selection, so no brief was forced and it is not a full-workflow qualification pass.
- The local clock then produced backward jumps and negative Worker/database spans. Worker `performance.now()` is not an independent monotonic clock in this workerd build. Negative/zero-clamped database timings are excluded from performance qualification. The external observer uses host `process.hrtime.bigint()`, records queued/running/terminal observations, and computes a conservative processing upper bound from the last observed queued-read request start (or admission start) through the terminal response, including observation overhead. Database queue/processing fields remain separately preserved; neither a clock-invalid field nor one fast run establishes a speedup or percentile.
- Repeated valid canonical reference tuples in review/brief input documents now use a document-local `sourceReferenceIndex`. Twenty historical input documents round-tripped exactly, including every claim, dependency, classification and full source context; intentionally wrong case/version tuples stayed verbatim rather than being repaired by passage ID. H2 payloads changed from 161,033 to 127,358 bytes for assessment review, 85,300 to 62,614 for brief drafting, and 88,851 to 65,251 for brief review. These are measured input-byte reductions, not an inferred causal latency improvement. Canonical outputs, storage, selections and all evidence gates remain unchanged.
- Real verification exposed incomplete available-artifact inventories and repeated selected brief items. Provider inputs now require exact case/artifact keys and one selected case/artifact/version decision, normalized into the existing API arrays/sections. The server does not fill omissions, repair prose, relabel a disposition, or weaken a gate. Shared JSON Schema references avoid expanding repeated schemas. The existing strict request-size bound remains. Shared dimension definitions separate volume, deployment location, continuity, and product/API capabilities; confirmed version match/mismatch additionally needs established product/API lineage and an explicit version relationship. Independent role decisions precede claim/disposition judgments so the draft's proposed Adapt labels do not define implementation relevance.

### Additional observed regressions

Actual Chromium found that semantically identical selections persisted as PostgreSQL JSONB could miss the existing-brief path because object property order differed from JavaScript insertion order. The real identical-selection POST returned `409 WORKFLOW_BUSY` while another phase was active, with no new calls. Explicit field-order normalization now returns `202` with `briefState: ready`, without any additional provider attempt or phase reservation. A regression in the existing isolated durable-ledger smoke passed this ready-brief replay both before and after database restart. The broader smoke timed out during container recreation; its randomly named synthetic resources were removed. Recreation/restore is not claimed reverified by that timed-out run.

Backward phase timestamps previously displayed a fabricated `0 ms` brief. The new consumer-visible regression failed before the fix. Chronologically inconsistent phases now return null observed timings; actual Chromium displays “Observed timing unavailable: timestamps are missing or inconsistent.” Checked results remain accessible. This disclosure detects observed chronology reversals; it does not reconstruct the true elapsed time or prove that a forward wall-clock adjustment did not occur.

### Failed intermediate candidates are retained

The first compressed-reference campaign produced eight ready assessments and six ready briefs, with 28 completed calls, 1,231 canonical-reference checks, twelve real pack exports and all 24 live original hashes. Independent semantic audit nevertheless failed P4's bounded negative conclusion and found accepted H3 prose inventing a version relationship across distinct API/product lineages. Those results are not counted as final qualification. Subsequent exposed P4 runs failed on an omitted artifact, conflicting request dimensions, or unrelated procedural components being reviewed as starting points for a requested proven operation. An H2 brief repeated its selected artifact and failed `DUPLICATE_BRIEF_ITEM` before independent brief review. Authentic model outputs/verdicts remain unchanged; failed attempts are accounted for and are never silently replaced by later successes.

### Fresh evaluation and memory boundaries

Before any tuning, an independent author fixed four fresh composed client requests (`f1`–`f4`), exact expected source identities, decisive constraints, acceptable uncertainty, prohibited recommendations and brief-selection expectations. The private keys were frozen with SHA-256 `bc19c9e475b458b24c1a296cebcdb1ea44cb40284f06b1c0fcf5ff42ce7e788b`. Expected content remains offline and is never model context. The original H1–H4 failure and later exposed regressions retain their history; no exposed request becomes held out again.

Overhead-inclusive Linux `/proc/<pid>/smaps_rollup` RSS/PSS/private-memory samples and `/proc/<pid>/status` RSS high-water marks now cover the actual task workerd processes, distinguished from Wrangler's front proxy. Intermediate complete-campaign application-process RSS reached **312,143,872 bytes**; that process contains native/shared runtime allocations and local platform-service isolates, and hot reload produced new processes. This is not the application isolate's memory usage, and subtracting an idle baseline would not establish it. Earlier JS-heap measurements remain component measurements only.

Local workerd has no equivalent enforceable per-isolate total-memory accounting in the installed configuration. [Cloudflare's memory metric](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/#memory-usage) reports invocation-time isolate-memory percentiles using reservoir sampling, not an absolute peak; Workflow coverage must also be established before using it for this workload. Neither local process RSS nor that documented metric proves the approved **128 MB isolate-fit** gate. A production/platform measurement or explicitly approved interpretation remains a release prerequisite; no deployment is performed to bypass that boundary.

### Frozen corrected candidate and exposed checks

Functional candidate **`3dfc51c9655e80086dbe4078f74a315c52b9ccd2`** keeps the same OpenAI/OpenRouter `openai/gpt-6-luna` default-tier profile, reasoning effort `none`, 16,384-token ceiling, all eight cases, 24 originals and four calls per complete workflow. Provider inventories use exact required keys; review verdicts use a required claim-ID-keyed object normalized to the unchanged canonical arrays. Inline artifact claims, comparison cells and lead/contrast reasons are structurally bound to their own source scope. Brief passage labels are bound to exact selected versions and supplied using the same pinned index. Repeated claim keys are encoded as lossless `claimFields`/`claimRows`, not summarized text. Twenty historical input documents round-tripped with every claim, dependency, classification and original excerpt preserved; malformed source tuples remained malformed.

The final exposed workload completed **12 assessments, 11 selected briefs and 46 provider calls**. Unchanged-output replay through parsing, independent review, reference/dependency gates and read revalidation passed **2,675 canonical references**, **22 live Markdown/JSON exports** and **24 live SHA-256 original checks**. Independent semantic grading passed P1–P4 and exposed H1–H4, including all five H2 repeats. P4/H4 selected briefs contained only bounded Verify prerequisites, not migration/offline implementation plans. The prior candidate's false successful-outcome labels for explicitly partial deliveries were corrected through shared recorded-scope/acceptance guidance in both passes, not case-specific relabeling or capture repair. Some source-recorded outcomes remained Unknown without an independently accepted classification; source history stayed inspectable. These are conservative completeness limits, not fabricated replacement outcomes.

Local source checks passed: typecheck, **35 TypeScript tests plus one Python test**, build, isolated ingestion without rewriting the pinned corpus, and actual UI checks for ready checked work, same-selection brief replay, unavailable timing and bounded no-precedent selection. Same-selection replay added no reservation/model attempt. The extended isolated ledger smoke passed its new JSONB ready-replay check initially and after database restart, but the overall smoke timed out during container recreation under host IO pressure; this continuation does **not** claim a new full recreation/restore pass. Earlier recovery evidence retains its historical scope.

### Timing: improvements observed, final targets not fully met

Backward local-clock jumps invalidate wall-duration comparisons even when a particular stored duration is positive. External host `process.hrtime` observations read durable queued/running/terminal states every 250 ms, bounding processing separately from queue wait; the bound includes transition-observation/query overhead, not HTTP proxy polling delays. Stored database queue/processing fields and the wider HTTP-observation bounds remain retained separately. No clamping, percentile claim, causal speedup claim, dropped run or selective successful-run qualification is used.

A preceding candidate met both H2 targets in five full workflows, but later semantic corrections changed that candidate. Its timing pass is not transferred to the final commit. Final H2 processing upper bounds, in fixed run order:

| H2 run | Assessment upper bound, s | Brief upper bound, s |
|---|---:|---:|
| 1 | 90.716 | 26.906 |
| 2 | 70.598 | 16.434 |
| 3 | 83.536 | 26.578 |
| 4 | 73.892 | 16.442 |
| 5 | 84.363 | 21.288 |

H2 run 1's assessment lower bound was **90.203 s**, so its miss is not merely the upper-bound sampling width. P1's final brief met its target at an upper bound of **26.678 s**, but P3 assessment (**126.195 s**), P4 brief (**37.902 s**) and P3 brief (**30.633 s**) missed their respective targets. Queue observations remain separate in the private phase traces; database wall durations are not qualification evidence.

Two additional, unchanged-source boundary diagnostics completed both full workflows. Host-monotonic dispatch-to-complete windows attributed approximately **44.31–45.34 s** of P3's **57.04–57.56 s** assessment to paid-stage work, and **57.16–58.19 s** of H2's **66.06–66.57 s** assessment to paid-stage work. Brief paid-stage spans were approximately **8.37–9.39 s** of **17.77–18.28 s** for P3 and **7.65–8.69 s** of **19.39–19.91 s** for H2. The remaining time lies outside those spans, including database/Workflow boundaries. These windows include response parsing/ledger work and are not provider-only generation times or a diagnosis of the long earlier P3 run.

The owner explicitly chose **“Finish current profile; disclose timing misses”** rather than priority-tier requalification. No further latency tuning, route/model/profile change or implied target waiver was performed. **Latency remains unqualified.**

### Fresh untouched evaluation: failed, no post-result tuning

The four requests frozen before tuning were each submitted **once**, after candidate commit/configuration freeze and hash verification. Assessment received only unchanged request text; selected briefs received only the frozen human case/artifact/version identities, not expected dispositions, evidence answers or grading criteria. The source stayed unchanged across all four cases. All four assessments completed; two briefs completed; no missing selected work was substituted or forced. The **12 completed calls** passed unchanged-output integrity/revalidation, **856 canonical references**, **four live pack exports**, and all **24 original hashes**.

| Request / job | Assessment upper, s | Brief upper, s | Offline verdict |
|---|---:|---:|---|
| F1 / `6acb01f5-204c-4c47-9dfb-1f9edfcd89c8` | 65.907 | — | **Fail:** Cedar mapping was classified context-only/excluded despite the frozen expected conditional starting material. Ibis runbook remained Adapt, but could not replace the missing Cedar selection; required combined brief was not produced. |
| F2 / `08c4b4bb-87f7-4c8e-88e4-6e956ff61c6e` | 75.011 | 27.682 | **Fail:** correct Elm/Grove selections and conditional brief, but the requested five-business-day access period was omitted from the final brief. Generic configured expiry did not preserve that constraint. |
| F3 / `a2964f61-d2e6-4f0b-a224-abe5be2b644d` | 76.173 | 15.173 | **Pass:** conditional Elm billing adapter remained available; Finch-specific polling withdrawal/version limits remained distinct. Only the frozen selected adapter was briefed; no reservation replacement was invented. |
| F4 / `d227b1dd-14ec-492f-913b-be2c079803e6` | 55.480 | — | **Fail:** independent review omitted operational/deletion acceptance constraints from its recovery/operations inventory, conflicting with the draft and preventing the expected bounded no-useful-precedent conclusion. All 24 artifact roles were settled negative; no missing source justified the omission. |

F1's relevant mapping facts survived, but `disposition-0-0` and `classification-disposition-0-0` excluded the actual work. F2's safe useful content did not excuse the omitted duration. F4's fail-closed Cannot-be-established result did not satisfy the frozen negative-result criterion. Independent offline graders checked original source passages; no expectation, capture, verdict, selection or conclusion was repaired. **Overall fresh gate: failed.** F1–F4 are now exposed material; later tuning requires another untouched set before any new held-out claim.

### Operational acceptance follow-up — issue #35, 2026-10-17

PR #42 supplied the shared operational-acceptance definition and independent-review reminder while this task was running. Those changes are preserved. The reviewer now explicitly distinguishes client operating deadlines, completion proof and rejected operational substitutes from the assistant's response deadline/format or evidence-inspection instructions. Exact request quotations and uncertainty qualifiers remain required; no schema, provider/profile, corpus, paid-stage count or historical capture/verdict was changed.

An additional gate regression reproduced an unsupported negative result: draft and review disagreed on operational-constraint presence, but with no comparison rows `requirementConflict` stayed false. The focused command `node --experimental-strip-types --test --test-name-pattern='operational acceptance conflicts' src/server/gates.test.ts` failed with actual `no_useful_precedent` versus expected `cannot_be_established`. Presence agreement is now checked across all five dimensions before considering rows. Existing row/dependency withholding remains; no missing constraint is filled from the other pass. The same command passed after the fix.

Before this follow-up's behavior edits, a stateless independent author received only the unchanged manifest and all 24 originals and froze four new composed private keys at **2026-10-17T06:23:10.967569+00:00**, SHA-256 **`328fb08868c3fe8fc153cd254e7e3e1df37f8a10b4edd17ba16bf0777ea16f4d`**. A separate read-only stateless review accepted source/version identities and criterion grounding without rewriting the keys. The implementation owner did not inspect expected answers. An earlier linked-work freeze had failed its grounding review and was not substituted or repaired. No claim is made that the new freeze predates PR #42's already-existing prompt change.

Observed offline verification:

- `npm run typecheck`, `npm test` (**40 TypeScript tests and one Python test**), and `npm run build` passed. No language server was available; compiler checking supplies the type evidence.
- Immutable exposed P1–P4/H1–H4/F1–F4 capture replay, including the four additional H2 repeats, passed **16 assessments, 13 briefs and 3,531 canonical references** through actual parsing, independent stored reviews, evidence/dependency gates, selection validation and read revalidation. All **24 exact originals** passed SHA-256 verification. No capture, expected conclusion or verdict was edited.
- A throwaway no-provider-network smoke used a fresh isolated PostgreSQL container, synthetic job capabilities, filesystem-backed original storage and actual authenticated Hono status/export routes. An explicitly hand-authored negative gate fixture retained all 24 reviewed roles and exact acceptance quotations on GET, offered no work, and was downgraded when an original was corrupted. Both negative fixture and authentic historical F4 returned **409 `CHECKED_BRIEF_REQUIRED`** for both pack formats; an unchanged accepted historical F2 brief exported JSON and Markdown with **200** and no capability leakage. Admission stayed disabled, model-attempt rows stayed zero, and only the smoke's own container was removed. This is route/gate proof, not new model output or Worker/platform qualification.

The separately frozen final offline candidate source/configuration/corpus inventory has SHA-256 **`b2f9bbb9be35bea3e360c2a2c37bf70978404c8a46f6c600a8b622398112cadf`**; only server documentation changed after the runtime smoke's earlier source inventory. The authentic F4 capture still has three draft operational quotations, zero review quotations and 24 settled negative roles, and correctly replays as `cannot_be_established`; reads do not repair or upgrade it. **A newly generated F4 bounded-negative result and untouched-set application evaluation are not verified.** Paid calls/admission are unauthorized, and #32's candidate/integration, timing, memory and separate execution approvals remain prerequisites. The frozen keys, receipts and raw evidence remain private outside Git. No merge, deployment or release is authorized by these offline checks.

### Memory and spending boundaries

The clean final exposed workload yielded **11,144 process samples**: application workerd RSS/high-water **391,221,248 bytes**, front-proxy RSS **332,226,560 bytes**. **3,400 inspector samples** peaked at **44,050,676 bytes** for the simultaneously observed allocated-heap/embedder/backing-storage component sum. Fresh workload samples observed application RSS **390,295,552 bytes** (process-lifetime high-water **392,744,960**) and an inspector component sum of **31,332,051 bytes**. Neither measurement is an absolute application-isolate peak or the platform quota accounting. No idle-baseline subtraction or inference from small JS heap to total-isolate fit was used.

The owner explicitly chose **“Finish locally; leave memory gate open.”** The **128 MB isolate-fit gate remains unqualified**; no staging/production deployment was authorized or performed.

Across this entire follow-on, including failed/superseded candidates, diagnostics and fresh requests, **60 task-owned jobs produced 202 completed calls and 103 reconciled phases**. Actual stored response usage totaled **USD 0.8137823265**; phase-level upward rounding reconciled **813,829 microUSD**. Every new phase matched its actual completed response usage; zero new holds remained. Older/uncertain reservations were not released, and no provider credit/invoice monitoring, purchase, top-up, fallback or automatic retry occurred.

Final shutdown checked no active attempt or pending job and admission disabled. A real subsequent POST returned **503 `ADMISSION_NOT_ENABLED`**, with unchanged job/attempt/reservation counts. A private custom-format durable-database backup was retained; task Worker/samplers/browser were stopped and task-created secret configuration and ingestion scratch were removed. Durable campaign data and immutable private captures remain outside Git.

**Delivery boundary:** local code and checks are complete, not release qualification. The fresh gate failed; timing and total-isolate memory remain explicitly open. No merge, deployment, production-admission change or public release follows from this report.

## Initial offline checkpoint for issue #33 — 2026-10-17

**Historical offline checkpoint, not the later paid-verification result.** Candidate worktree `fix/33-conditional-adapt` began from main `eb431c6a432f17c21606f5e3c1b03f0b0fb28402`. At this checkpoint no model/provider/profile, admission, paid-stage count, gate, original source, selection substitution, deployment or release change had been made.

### Corrected diagnosis from unchanged captures

The earlier F1 summary above and the original offline grade are retained as historical records, but their root-cause description is inaccurate. The authentic draft offered Cedar mapping as Adapt and useful starting material. Independent review assigned `starting_point` and supported its recommendation, verification claim and `classification-disposition-0-2`; the mapping was not independently classified context-only. The only rejected claim was `c1`: it presented a current-request constraint as a historical `source_fact`. Its dependencies removed the supported mapping recommendation/check/classification and its lead reason. The accepted historical mapping facts in `c2` survived. Empty checked work inventories then correctly blocked the exact mapping selection. Ibis alone was not substituted for the frozen two-artifact selection.

The shared contract now separates historical source facts from current-request interpretations. Provider and runtime global-claim schemas prohibit request quotations on historical `source_fact` claims. Draft instructions require exact, explicitly attributed request interpretations; independent review checks those statements against the request, not as proof of historical or provisioned capability. No verdict, dependency, role or classification is repaired; an old misclassified draft is rejected rather than normalized into a different claim. Existing checked stored results keep their original fail-closed revalidation.

The mapping still establishes only its bounded key-preservation, shared-email, active-filtering and reconciliation procedure. The separately selected runbook supplies bounded handover/recovery evidence. Neither establishes large-scale success, production recovery, new-client compatibility or tested combined acceptance. The conditional Adapt and context-only/unsupported-control boundaries are unchanged.

### Freeze prerequisite and owner decision

An independent private four-case key set was frozen before the first behavior edit, at `2026-10-17T05:31:34.913220+00:00`, SHA-256 `c8d5db238dbb483f4693255388c5f17485c8d2c077a5a4081d25a40ea9593914`. A separate review found an incorrect corpus-coverage criterion, so this is **not a valid completed #32 prerequisite**. The keys remain immutable and unused; no expected content was read by the implementation owner. The initial independent agent failed before producing keys; a stateless independent design and review produced the frozen record and identified its defect. No new held-out pass is claimed.

After initially approving one bounded F1 workflow, the owner chose **Stop paid verification** when informed of the failed freeze prerequisite. At that checkpoint no F1 rerun, paid application call, admission change, task commit, push or PR publication had occurred. The owner subsequently explicitly authorized paid exposed-regression verification and PR publication, then separately authorized one rejection diagnostic, a corrected workflow, the remaining full-F1 corrections, and ordinary current-main-to-task-branch integration. These approvals did not authorize new held-out execution, a model/provider/profile change, deployment or merge into main.

### Offline checks

- Before the fix, the focused `artifact recommendations and role claims` regression failed with `true !== false`: the runtime schema accepted a current-request quotation as a historical global source fact.
- The regression now checks provider/runtime rejection, correctly typed request interpretations retaining Adapt selection, and unsupported/uncertain requirement dependencies still withholding work and selection. Existing negative relevance, uncertain roles, classification, original-integrity and dependency checks remain.
- A private no-paid runtime smoke loaded and integrity-checked all **24 originals across eight cases**, rejected the authentic unchanged F1 misclassification under the new contract, and exercised new synthetic input through assessment parsing/review gates, exact two-artifact selection, brief validation, read-time revalidation and JSON/Markdown pack construction. Both conditional Adapt components and explicit no-combined/production-guarantee text survived. This proves contract plumbing, **not model semantics, actual UI interaction, HTTP export delivery or live F1 success**. Synthetic review verdicts were not presented as independent model results.
- Corpus manifest remains `fictional-onboarding-v2`, SHA-256 `fbc1d4ae92275efafb23b660446ac78a4b6c624e4ce603d67d2d320e142b63ca`. Private requests, raw captures, capabilities and keys remain outside GitHub; existing captures/verdicts were not rewritten.
- At this initial checkpoint, `npm run typecheck`, `npm test` (**38 TypeScript tests plus one Python test**) and `npm run build` passed. No language server was available; `tsc` supplied type diagnostics. Exact candidate/configuration/capture hashes and the no-paid smoke result remain privately recorded in `issue33-offline-verification.json`. Later candidates and paid outcomes are separate evidence, not replacements for that record.

## Selected-brief constraint preservation (issue #34) — 2026-10-17

**Local implementation verified; F2 and fresh qualification remain open.** No paid application call, admission/budget change, model/provider/profile change, deployment, merge or public release was authorized or performed.

Before implementation tuning, a separate author created four new composed private evaluation keys with requests, source expectations, decisive values/uncertainty, prohibited recommendations and human-selection expectations. The authoring agent ended before sealing; the parent sealed its existing bytes without viewing request or expected-answer content. Receipt: **2026-10-17T05:30:20.355741Z**, SHA-256 **`ba8f9b6d5df2cddcc32f98999b21baa535abce41530c5b48d33bb64f5e72b0b3`**. Keys/receipt remain outside Git with directory/file modes 0700/0600. They have not been executed or qualified; #32 still requires final candidate/configuration/corpus freeze, prerequisite disposition and separate spending approval. P1–P4/H1–H4/F1–F4 remain exposed.

### Cause and cutover

The original brief review returned verdicts only for emitted claims. A supported generic expiry check could therefore omit a decisive requested duration without any independently reviewed coverage record. Assessment recognition and hidden `requestQuotes` metadata did not make the value visible in the selected brief.

The existing brief-review call now independently extracts complete constraint quotations per exact selected artifact/version, then judges each brief claim. The gate requires every independently inventoried constraint and every draft recommendation quotation in supported recommendation text for that item. Missing values, units or uncertainty qualifiers withhold recommendations and transitive dependants; the server never inserts request text or repairs claims. Recommendations must distinguish requested constraints/proposed checks from historical facts, provisioned capabilities and integrated acceptance. Source/dependency gates and independent assessment claim/outcome/disposition/artifact-role review remain unchanged.

The checked brief retains the independent inventory for owned reads and both export formats. Missing/malformed/incomplete legacy review fails closed rather than supplying an empty inventory. Drain active workflows before the strict schema cutover; obtain explicit authority for a fresh checked workflow when needed. Retained historical captures, exports and verdicts were not rewritten.

### Observed local evidence

- `node --experimental-transform-types /home/tuantran01/.omp/replay-34-f2.mjs <base-checkout> <task-checkout>` replayed the authentic original F2 brief and independent verdicts without edits: **6 accepted claims**, correct original selection, and the requested duration missing from brief text. The original JSON pack's brief claims matched; original exports were inspected, and Markdown was regenerated through the old export path. All **24 original hashes** verified. Current revalidation rejected the legacy missing independent coverage. This preserves F2's failure; it does not create a corrected F2 result.
  The retained original Markdown had the period in request-quote metadata, but not in checked recommendation prose; that does not satisfy the brief criterion.
- `node --experimental-transform-types /home/tuantran01/.omp/smoke-34.mjs <task-checkout>` exercised real parser/gates/read revalidation/pack builders with a separately synthesized Elm/Grove selection. Two Adapt items retained **seven business days** and explicit unverified audit/removal wording; generic configured-expiry replacement withheld both recommendations. Generated JSON/Markdown were inspected. Synthetic verdicts prove mechanics, not independent model quality or F2 acceptance. Throwaway scripts were removed after verification; no historical capture was edited.
- `npm run typecheck`, `npm test` (**39 TypeScript tests and one Python test**), and `npm run build` passed. Permanent consumer-visible coverage in `src/server/packs.test.ts` checks exact period, business-day units, numeric scale and uncertainty in checked claims and both formats; generic wording, lost qualifiers, fact-only/metadata-only coverage, uncertain dependencies, invented request quotes, wrong selection keys and missing legacy review fail closed.
  `npm run ingest -- --root /tmp/memory-bank-34-ingest-20261017` passed against an isolated corpus/contracts copy without changing the pinned corpus. The generated provider JSON Schema accepted keyed coverage and rejected omitted inventories.
- Actual Chromium exercised the built client with synthetic API receipts and outputs from the smoke: explicit two-artifact/passage selection reached the checked brief; exact period and unverified checks rendered. Both export buttons produced blobs whose Markdown/JSON bytes were inspected. Desktop light and 320px dark were visually inspected; narrow document width/scroll width were both **320 px**. This is presentation replay, not new Worker/database/model qualification. The browser and task-only static server were stopped.
- Initial LSP reference lookup reported no server. Later diagnostics identified a frontend narrowing error, which was fixed; final diagnostics on six changed source files reported only three existing deprecated `FormEvent` hints, with no errors. Compiler checks above passed.

### Remaining acceptance gates

F2 must be rerun only under separately approved execution on a frozen candidate and independently graded against original sources, including the real selected combined brief and both exports. In particular, its requested five-business-day period must appear as a requested check while record-level audit and actual removal stay separately unverified. No tenant-admin/shared-account advice, production-write authorization or fabricated integrated acceptance is authorized. This local synthetic proof is not that run.

Integrate #33/#35 and rerun affected exposed regressions before #32's fresh fixed-point evaluation. Timing, total-isolate-memory and other prerequisite gates remain independently open unless explicitly scoped by the owner. No final-candidate freeze, fresh pass or release-readiness claim follows from this change.

## Issue #33 paid verification and current-main integration — 2026-10-17

The owner explicitly authorized paid exposed-F1 verification and PR publication, then separately approved one instrumented provider diagnostic, a fresh corrected workflow, completion of the remaining F1 criteria, and an ordinary current-main-to-task-branch merge. These are bounded exposed-regression runs, not new held-out qualification or deployment authority.

### Preserved failed and superseded attempts

- The first application draft dispatch returned HTTP 400 `MODEL_PROVIDER_REJECTED`. One separately approved operator diagnostic captured the provider's private response: OpenAI rejected `allOf` in the generated response schema. Refining the reused request-quotation array had emitted that unsupported composition. A fresh empty array using the same element type preserves the constraint without `allOf`; the focused provider-contract regression failed before that correction and passed after it. The diagnostic ran outside the application workflow and is retained as a separate private operator attempt. Neither rejection supplied attributable usage; its cost was not assumed zero, and the failed application phase's hold was not released.
- The corrected candidate completed four application calls and produced both expected Adapt artifacts, the exact combined brief, 261 canonical checked references, two real pack exports and 24 matching live original hashes. Actual completed response usage was **USD 0.018458748**. The independent full F1 grade nevertheless **failed**: the rationale omitted a material earlier recovery failure/correction, and current ownership/escalation/acceptance and target replay prerequisites were insufficiently explicit. The grade, request, selections, all outputs and exports remain unchanged.
- The historical verification harness initially required identical next-action order across assessment construction and read revalidation. Revalidation orders actions by already-ranked leads. A separate private harness checks identical action membership plus every other result field, references and dependencies, without rewriting stored outputs or fixing this unrelated ordering behavior.

### Shared correction and integration

Shared instructions now preserve material failed-attempt → correction → bounded-success history in assessment rationale. Artifact recommendations cite relevant documented prerequisites, roles/authority, escalation and acceptance. New-client roles and target mechanics must be agreed or verified, not inherited from old signatures, names, support windows or matching counts. Selected briefs retain those conditions as explicit adaptations/checks without attributing another artifact's history to the selected original. Existing independent support, role, classification, ownership and dependency gates remain unchanged.

With explicit approval, task checkpoint `4952965` was merged with current main **`be5881635bf3a68373e2bea56ecb7e1016ca1249`**, producing functional candidate **`8d3933c`**. The sole content conflict was the additive qualification history; both records were retained. The source merge preserved #34's independently reviewed brief-constraint coverage and #35's operational inventory/conflict withholding. No merge into main, rebase, force-push or deployment occurred. Typecheck, **41 TypeScript tests plus one Python test**, and the development build passed before the integrated run.

### Integrated candidate failure and structural quote correction

The first integrated candidate completed four application calls at **USD 0.01953475425**, but its checked brief had **zero items and six withheld claims**. Independent review rejected one recovery disposition; the imported #34 gate also withheld both items because independently inventoried request quotations were missing verbatim from recommendation prose. Both exact artifact/version selections were retained, not replaced. Historical recovery failure/correction and current ownership/target checks were improved, but this was **not a full F1 pass**.

The same candidate's mapping remained Adapt/selectable but disappeared from checked leads because a second lead reason contained a fabricated question quotation. The gate correctly rejected that reference. Its role inventory also treated an execution summary as procedural starting material. The independent grade recorded these additional failures. All original captures and grades remain unchanged.

The next candidate closes quotation identity at generation: every assessment quote field uses existing request-bound sentence/chunk choices; quoted brief recommendations/interpretations contain one exact chosen quotation visibly, enforced by an escaped literal substring pattern. Independent brief review chooses relevance separately from those same request choices. Historical facts remain unquoted; execution summaries remain corroborating context unless they actually supply usable operative instructions. Existing support/coverage/dependency gates are not weakened, no request text is inserted, and no verdict or omission is repaired. The visible-quotation regression failed before the structural correction and passed afterward, including literal regex-metacharacter input; the existing brief/export boundary regression retains units, uncertainty and dependency-withholding checks. Typecheck, **41 TypeScript tests plus one Python test**, and the development build passed before a separately approved four-call verification.

### Final task boundary: draft review only, F1 remains failed

The next request-bound candidate still lost mapping: independent review assigned `starting_point` but rejected its recommendation/classification after the draft mixed recovery controls into the mapping. No replacement brief was forced. A component-separation candidate then retained the bounded recommendation but added a cross-operation recovery verification claim to the map; that claim and dependent classification were rejected. Both two-call assessment-only failures and their independent failed grades remain private and unchanged.

The owner approved a completion campaign capped at **12 further application calls and USD 0.20 actual response usage**, stopping on uncertainty. Scoped-procedure guidance confines local claims/checks to the source-established operation and assigns recovery/ownership prerequisites to the source that documents them. The final admitted assessment retained both exact expected artifacts as Adapt. Its exact two-artifact brief dispatch then returned HTTP 200 but failed output validation as `MODEL_OUTPUT_INCOMPLETE_OR_REFUSED`; the app correctly entered **`reconciliation_required`**, retained the active attempt and hold, and did not dispatch brief review. A read-only provider-generation lookup returned 404, so terminal provider usage could not be established. No replay, free-charge assumption, repair or replacement result was made. The completion campaign stopped after **five** calls and **USD 0.0292534605** attributable completed usage; unused call authority was not exercised.

Across this task's explicitly approved application runs: **16 dispatches = 14 complete + one rejected + one uncertain**, plus **one separately approved operator diagnostic** outside the application workflow. The seven completed phases reported **USD 0.08167977675**, reconciled to **81,683 microUSD** by phase-level upward rounding. The rejected application phase's **600,000-microUSD hold** and uncertain brief's **600,000-microUSD hold** remain; older holds are untouched. Rejected/uncertain costs are not claimed zero. Local admission is disabled; one task job remains reconciliation-required, not silently called terminal or drained.

An independent code review identified a provider/runtime mismatch for lead reasons: a quoted `source_fact` reason could pass the provider schema and then fail global-claim normalization. A focused regression reproduced that mismatch; reason schemas now use the same historical-vs-request distinction as normalized global claims. This final source correction received local checks, not another paid workflow.

Final `npm run typecheck`, `npm test` (**41 TypeScript tests plus one Python test**), `npm run build`, and the development build passed. A read-only smoke on the final built source served the last authentic assessment with both expected Adapt artifacts; both pack formats correctly returned **409 `CHECKED_BRIEF_REQUIRED`** for the incomplete brief. Earlier completed candidates produced two real HTTP-200 JSON/Markdown downloads each with original hashes/canonical references checked, but neither passed full F1 grading. Actual Chromium exercised the request form, exact artifact/version/passage selection, evidence dialog, combined-brief presentation and both export-button dispatches on those earlier candidates. Browser attachment-body capture returned empty data; full downloaded bytes were verified separately through authenticated HTTP. No final-successful-brief or final visual pass is claimed.

The owner explicitly approved an **incomplete-verification draft PR**, with `Refs #33`, no closing keyword, no further paid calls and no ready-to-merge claim. Full F1 acceptance, fresh untouched qualification #32, affected exposed requalification, rejected/uncertain billing resolution, timing and memory gates remain open. The invalid private key set remains immutable/unused; no new held-out evaluation occurred. Source/configuration/corpus hashes, unchanged captures, independent grades, all approvals and accounting are retained outside Git. No credentials, capabilities, private request text or raw results are included in the PR; no deployment, merge into main, force-push or public release was performed.

### Follow-up: preserve failed-output evidence; F1 completion still blocked

Read-only provider metadata and stored-content lookups again returned **404** for the uncertain brief; the same credential retrieved the preceding completed review with HTTP 200. The old response envelope was not retained, so neither its exact failure condition nor its charge is established. The owner offered to supply terminal provider evidence and separately authorized up to **20 application calls and USD 0.25 attributable response usage**, only after safe reconciliation of the existing uncertain dispatch, with the same profile and a stop on any uncertainty. **No new paid call or admission enablement occurred in this follow-up.** The active lock and all historical holds remain intact.

A local regression reproduced the diagnostic defect: absent output, non-stop completion and refusal collapsed to one error, and output-validation failures discarded already parsed usage. New dispatches distinguish missing choice/text, token limit, refusal, filtering and other non-stop completion using fixed safe error codes. Failed attempts persist reported usage/model/provider in existing operator-only columns, including invalid JSON/schema output; missing cost stays unknown. No partial response, refusal prose or arbitrary finish-reason text is stored, and no failure is converted into an accepted result or automatic billing settlement. Historical captures and their original error codes remain unchanged. No schema, prompt, provider/profile, token limit, deadline, corpus or source/dependency gate changed in this follow-up.

`npm run typecheck`, `npm test` (**42 TypeScript tests plus one Python test**), `npm run build` and the development build passed. The new provider regression failed before the fix and passed afterward, covering safe failure distinctions, retained usage, absent usage, privacy and single dispatch. `node --experimental-transform-types src/server/ledger.smoke.ts` exercised actual paid-stage persistence and operator reads against isolated PostgreSQL, with two intercepted synthetic responses and **no provider network access**. Both holds and disabled admission survived; replay added no requests. All seven ledger tables matched after restart, container recreation and private dump/restore. The synthetic resources were removed without touching the real campaign. This verifies diagnostic recovery, **not** successful F1 brief generation; PR #46 remains draft with `Refs #33`.

### Follow-up: brief `length` response isolated to the brief provider grammar; candidate fix pending paid verification

One separately approved diagnostic brief dispatch against the retained assessed selections returned HTTP 200 in about **2.7 seconds** with `finish_reason: length` / native `max_output_tokens`, **null content, null reasoning and no usage object**; provider generation/content lookups returned 404. Genuine exhaustion of the submitted 16,384-token allowance is not established: earlier generations of roughly 8–16k completion tokens took about 100+ seconds and left terminal provider records. The assessment stages, using identical model/provider/token controls and a far larger grammar, completed on the same profile.

Local audit of the captured request (retained privately; sizes only here) found a 94,584-byte body, a 7,435-byte brief schema and exactly **seven unanchored literal request-sentence `pattern`s** (65–125 characters each) constraining claim prose — the only material brief-only provider-grammar construct. Every schema branch is locally satisfiable, a compact valid brief output exists, and runtime parsing plus the checked-brief coverage gate independently require each quotation verbatim in accepted recommendation prose. No invalid or unsatisfiable schema, prompt-size, or token-budget defect was found in the application request.

Candidate correction, **not yet proven by a paid call**: the `brief_draft` provider grammar now omits unanchored sentence patterns while anchored identity patterns remain. The provider grammar is a generation guide, not the trust boundary: the runtime Zod schema parsed before any output is stored still enforces the exact quotation-in-prose pattern, and existing coverage/support gates are unchanged. No model, provider/profile, token ceiling, prompt, corpus, retry/fallback or gate changed. A new intercepted-fetch regression captures the brief request, asserts the sentence pattern is absent and the anchored identity pattern remains, and proves hidden quotation metadata still fails runtime parsing while a visible-quotation brief is accepted. `npm run typecheck`, `npm test` (**43 TypeScript tests plus one Python test**) and `npm run build` passed. PR #46 remains draft; successful F1 brief generation requires one further separately approved paid verification on this candidate, stopping on any uncertainty as before.

### Paid verification of the candidate correction

The owner separately approved one verification dispatch. A single `brief_draft` call on candidate `c14bc5b`, using the same accepted assessment, exact two-artifact selections and unchanged profile outside the application workflow, returned `finish_reason: stop` with reported usage: **21,188 prompt / 1,026 completion tokens, USD 0.00312981075**. The dispatched provider grammar contained only the anchored identity pattern. Runtime parsing accepted the output: both required artifacts (Cedar mapping, Ibis operator runbook) as **Adapt**, six recommendation claims, every request quotation verbatim in its claim prose, and zero invalid references. Exactly one dispatch occurred; no brief review, application workflow, admission enablement or hold/lock change was made, and captures remain private outside Git. This verifies brief **draft generation** on the corrected grammar; it is not an independently reviewed checked brief or a full F1 acceptance pass, and PR #46 remains draft.

### Follow-up: quotation coverage withheld both Adapt items; per-item atomic-claim correction

The separately approved independent brief review of the generated draft supported all six claims, but the checked brief retained **zero items and withheld all six claims**. The independent per-item constraint inventories each required four quotations. The draft loaded several request sentences into each disposition claim's prose while its `requestQuotes` could name only one of them (the runtime contract allows exactly one quotation per quoted claim), left one decisive quotation in prose without matching metadata on each item, and omitted one shared decisive quotation from one item entirely. The coverage gate at `gates.ts` therefore correctly withheld every recommendation; that safeguard is unchanged and no captured output, verdict or inventory was repaired.

Generic correction, **not yet proven by a paid call**: brief generation instructions now run a per-item quotation-coverage procedure — list each selected item's decisive quotations independently (a shared quotation belongs to every affected item), emit exactly one dedicated atomic recommendation per quotation assigned only to that item with the quotation verbatim in prose, a one-element `requestQuotes`, and references from that exact artifact/version, keep at most one quotation on the disposition claim, and audit that no claim prose carries a verbatim request sentence other than its sole metadata entry. The runtime brief schema now also rejects such stray-quotation prose at parse time, before the independent review is spent; it rejects drafts only and never inserts or rewrites text. No gate, reviewer, model/provider/profile, token limit, corpus or retry behavior changed. Local regressions pin both directions: per-item atomic claims (including a shared quotation repeated per item) survive `buildCheckedBrief` for both items, the captured prose-without-metadata shape withholds only the offending item, and stray-quotation wire output fails runtime parsing while a dedicated atomic claim parses. `npm run typecheck`, `npm test` (**44 TypeScript tests plus one Python test**) and `npm run build` passed. PR #46 remains draft; a checked F1 brief still requires one further separately approved paid verification on this candidate, stopping on any uncertainty as before.

### Paid verification of the quotation-coverage correction

The owner authorized the verification run (`run it`). On candidate `09937cc`, outside the application workflow and with the unchanged profile, exactly **two dispatches** occurred: one `brief_draft` (21,494 prompt / 1,201 completion tokens, **USD 0.00325430325**) and one independent `brief_review` (23,079 prompt / 292 completion tokens, **USD 0.003000492**), total reported **USD 0.00625479525**; no retry, admission enablement, or hold/lock change was made, and captures remain private outside Git. The draft returned both expected artifacts as Adapt with **10 claims** and zero invalid references: each disposition claim carries no quotation, and every decisive quotation sits in its own dedicated atomic recommendation per affected item, verbatim in both prose and its one-element `requestQuotes` with references from that item's exact artifact/version, including the shared combined-recovery quotation repeated for both items. The independent review supported **10 of 10 claims** and inventoried four quotations per item; `buildCheckedBrief` retained **both Adapt items, all 10 claims, and withheld 0**. This verifies the checked two-artifact brief path for the exposed F1 regression on this candidate; it is not an application-workflow run, a full F1 acceptance grade against all frozen criteria (exports, browser and timing remain as previously recorded), fresh held-out qualification, or a merge/release claim. PR #46 remains draft.
