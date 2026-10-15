# Assessment-to-brief qualification — 2026-10-15

Related: [issue #2](https://github.com/Zura1555/memory-bank/issues/2), [issue #3](https://github.com/Zura1555/memory-bank/issues/3).

## Gate result: BLOCKED by fresh baseline lead/work inconsistency

An earlier owner-approved visible P1 run reached **ready assessment and ready brief in the actual development UI** after an interim artifact-claim ownership correction. It does not qualify the subsequently integrated output contract. The latest owner-approved fresh-campaign run on revision `2f7466d` failed the structural gate: a proposed useful lead artifact was classified as verify-only work. No checked assessment or brief is claimed.

The previously interrupted dispatch now has independently verified terminal provider evidence, but its ephemeral local ledger was lost before reconciliation. The owner approved a fresh audited campaign without reconstructing historical rows. The latest run's exact charge was reconciled; admission is disabled, with no held funds or active attempt in the new ledger. See the final section for recovery, timing, cost, and failure evidence. Issue #2 and the dependent issue #3/#4 delivery gates remain incomplete; held-out evaluation, production, and broad latency/reliability qualification remain unverified.

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
