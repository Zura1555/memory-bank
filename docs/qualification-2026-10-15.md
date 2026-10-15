# Assessment-to-brief qualification — 2026-10-15

Related: [issue #2](https://github.com/Zura1555/memory-bank/issues/2), [issue #3](https://github.com/Zura1555/memory-bank/issues/3).

## Gate result: PASS for the bounded P1 baseline; quality failures recorded

An owner-approved visible P1 run reached **ready assessment and ready brief in the actual development UI** after correcting an artifact-claim ownership mismatch. The chosen Cedar mapping brief was checked against its exact original; it preserved the sandbox, row-count, duplicate-identity, retry, and new-client compatibility limits. Every terminal phase was reconciled before further admission. Admission is disabled, held funds are zero, and no dispatch remains uncertain.

This establishes the bounded end-to-end baseline required before issue #3, not perfect model quality or release readiness. Manual review found assessment quality failures below. Full P2–P4 flows, held-out evaluation, production, and broad latency/reliability qualification remain unverified; the supplement below covers a later P3 assessment with cards, not a P3 brief. No configuration was tuned using held-out keys.

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

## Root cause and verification

Replayed the initially stored output through the executed revision's `parseAssessmentDraft` and `validateAssessmentDraft`, using the stored corpus: `CLAIM_ARTIFACT_SCOPE`. Eight assignments mixed sibling-artifact context into work roles. Example: Cedar `mapping` used `cedar-request`, whose evidence belongs to the same case's `request` artifact.

The fix distinguishes two contracts: each artifact's disposition recommendation must cite that exact artifact; contextual supporting/blocker/verification claims may cite sibling artifacts in the same case. Cross-case-only role evidence remains rejected. Exact case/artifact/version/passage checks and separate support review remain unchanged; any unsupported role still withholds the work item. The prompt now states the same ownership rule as the gate.

Replaying the same captured draft after correction passed structural validation while still identifying an invalid-reference recommendation for withholding; no references were fabricated or repaired. The permanent regression checks same-case context, unsupported-context withholding, wrong-artifact recommendation rejection, and cross-case context rejection. The fresh real UI run then exercised all four model stages.

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
