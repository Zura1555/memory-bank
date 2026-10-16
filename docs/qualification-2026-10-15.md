# Assessment-to-brief qualification — 2026-10-15

Related: [issue #2](https://github.com/Zura1555/memory-bank/issues/2), [issue #3](https://github.com/Zura1555/memory-bank/issues/3).

## Current gate: implementation verified; new P1 assessment has a semantic defect

After explicit authorization for a new durable campaign, candidate `569a793` completed a real P1 assessment with 96 accepted and 25 withheld claims in 80.826 seconds processing, plus 5.770 seconds queue wait. Cedar's source-key mapping, duplicate handling, 1,198 accepted plus two rejected, and sandbox/no-retry limits were retained. However, accepted `comparison-3-assessment` incorrectly says the request does not state sandbox or production despite the explicit words "bounded sandbox batch import." The result was not repaired. The owner subsequently requested results only and no further billing tracking. No brief, P2–P4, or held-out run was completed; the candidate is not release-qualified.

Earlier successful P1 flows, quality defects, reconciled campaigns, and failures below remain historical evidence, not qualification of this candidate. The earlier interrupted dispatch has terminal provider evidence but its ephemeral ledger was lost before reconciliation; those historical rows were not reconstructed. The new unresolved reservation is separate. Neither local deterministic checks nor prior paid success establish semantic reliability, latency qualification, or deployment readiness.

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
