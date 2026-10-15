# Explainable reuse workbench — 2026-10-15

Related: issue #4. Base: `4153ad3` (pulled main before implementation). Local Worker `127.0.0.1:8793`, PostgreSQL, local R2/Queue/Workflow; no deployment.

## Result and boundaries

The workbench, bounded in-tab lineage, evidence links, and fail-closed projection were exercised through Chromium. A checked baseline displayed 64 accepted claims, four withheld, four comparison rows, and three next actions. Its Cedar product/version was explicitly unknown; sandbox and approximately 1,200-row limits were explicit. Exact source-key passage inspection and all 24 original SHA-256 checks passed.

The final full-input clarification was asserted byte-for-byte in the textarea and stored job request. It reached ready `cannot_be_established`, 41 accepted claims, 18 withheld, zero comparisons/actions/leads. The UI retained one read-only prior assessment, invalidated the selected mapping/version/passages, and explicitly reported the previous mapping Adapt recommendation as no longer established—not a supported Verify replacement. This is a valid conservative result, not evidence that every requested question received a useful answer. A deterministic regression proves supported Adapt→Reuse comparisons and missing-current-recommendation handling; no live Adapt→Verify success is claimed.

A preceding final-contract ready run displayed three comparisons and one concrete mapping-verification action, but browser typing had truncated its clarification. It is not proof of complete-policy compliance or a comparable latency sample. Browser replay used a real checked result and capability via a one-shot intercepted POST receipt; subsequent status reads and clarification admissions used real endpoints. No fake response path exists in application code, no stored result was edited to pass, and no historical failed draft was promoted.

## Frozen request and configuration

Visible baseline:

> A client needs a bounded sandbox batch import of about 1,200 active supplier rows, with compatible CSV fields, source-key reconciliation, duplicate-email visibility, and accepted/rejected counts. What prior work is relevant, and what limits must remain explicit?

Full focused clarification:

> The sandbox scope and approximately 1,200 active rows are unchanged. The new target product/version and CSV-to-target field mapping are unconfirmed. Client policy requires a compatibility verification and sign-off before the mapping can be treated as a useful starting artifact; do not assume Cedar's external_reference field exists on this target.

OpenRouter `openai/gpt-6-luna`, OpenAI-only/no fallback, strict output, reasoning none, non-streaming request, default tier, 16,384-token ceiling, 120s request and135s Workflow-step deadlines unchanged. The provider generation endpoint reports streamed=true internally; this is not the application request setting. No held-out key was opened or tuned against. All eight cases,168 passages,three reviewed records round-tripped exactly under pinned draft labels.

Initial ingestion generated import-timestamp-only manifest `d61f967277740bc4abedf4b9d6d121234e376ef56d6de12d663346cff770c8a5` for the first two runs. Then generated files were restored to pulled main and the frozen `fbc1d4ae92275efafb23b660446ac78a4b6c624e4ce603d67d2d320e142b63ca` manifest republished. Originals and passage identities did not change.

## Every task assessment and accounting

Queue/processing are DB milliseconds. For owner-reconciled failures, processing ends at reconciliation, not the first UI failure, so those values are not provider latency.

| Job | Final state | Error | Queue ms | Processing ms | Reconciled microUSD |
|---|---|---|---:|---:|---:|
| a364fe7d-1735-4280-bb18-a058f14130c2 | failed | STRUCTURAL_CHECK_FAILED | 1043.251000 | 81180.125000 | 7473 |
| bdbb597b-0abf-4402-9f3b-451bfc5b6858 | ready | — | 579.971000 | 96356.942000 | 11292 |
| 81c60156-94c5-4973-9cc4-fc3c9ec085e3 | failed | OWNER_RECONCILED | 555.417000 | 47631.898000 | 0 |
| b8b709f3-44de-4bb0-83fd-c944ce36b92c | failed | STRUCTURAL_CHECK_FAILED | 443.441000 | 91998.952000 | 8701 |
| 5ac37028-65eb-46d4-80c5-01085884964f | failed | OWNER_RECONCILED | 1538.352000 | 76902.205000 | 0 |
| e8164664-89bf-4b3b-ac25-96c6f3ea3d4d | failed | STRUCTURAL_CHECK_FAILED | 346.955000 | 111622.380000 | 7917 |
| 0a2b049d-f8f6-4e56-882a-98fda6c0a716 | ready | — | 569.486000 | 111118.174000 | 12811 |
| dd2db3f9-edbc-461d-8aeb-a7c2bab12c32 | failed | OWNER_RECONCILED | 339.216000 | 222557.162000 | 9989 |
| 85f21773-69e2-4f7a-a517-9d5b47923f04 | failed | OWNER_RECONCILED | 450.140000 | 270069.153000 | 9506 |
| 0eb9d2c8-0682-4502-bc92-a1d8ca8d6ff9 | failed | STRUCTURAL_CHECK_FAILED | 559.562000 | 58488.981000 | 6364 |
| 1eddbc86-8778-4b8b-a373-39d7058b282b | failed | INTERNAL_FAILURE | 205.908000 | 71604.128000 | 7200 |
| 490db711-33ef-4861-88af-2b27a09ea97c | ready | — | 181.776000 | 65744.535000 | 9676 |
| f46ed0f8-4646-42ce-ab3a-39b32055cd0b | failed | STRUCTURAL_CHECK_FAILED | 463.987000 | 61540.557000 | 10503 |
| 4c154e3e-e122-4d3d-8ddb-cf6c5bd90b74 | ready | — | 681.689000 | 60070.360000 | 9031 |
| c66d1759-58bf-4472-93d6-4e5395f139e6 | ready | — | -7367.065000 | 51079.074000 | 7034 |

## Exact terminal generation charges

| Generation | Prompt tokens | Completion tokens | Provider generation ms | Exact USD |
|---|---:|---:|---:|---:|
| gen-1792050451-A4jzO0PR6Fc0oGzuntwW | 15997 | 9381 | 78770 | 0.007472569 |
| gen-1792050759-NPmtT3a2HgJaemVhMGGu | 16078 | 9059 | 77873 | 0.007320975 |
| gen-1792050838-dEh2xMrV4RJ6P4bu1PyS | 25630 | 793 | 7026 | 0.003970939 |
| gen-1792051239-PBHYoqFkvljBl219SRry | 16143 | 11360 | 89801 | 0.008700417 |
| gen-1792051612-SOzS9gYCJK65QbFBotgg | 16143 | 14446 | 108259 | 0.007916851 |
| gen-1792051978-4UQrFvO4qjtrrwGgaGQA | 16262 | 10825 | 93901 | 0.008389185 |
| gen-1792052074-I8C5eqey2GjB4QhCvIr5 | 27937 | 940 | 12830 | 0.004421637 |
| gen-1792052362-62vHFZfMAmm3WhJ78HeT | 16346 | 14878 | 130452 | 0.009988001 |
| gen-1792052727-QPLXzC23CA97o7yJxb2s | 16362 | 14140 | 116427 | 0.009505252 |
| gen-1792053277-6MTlEo76ktTbKOfeYLZg | 16523 | 7655 | 56740 | 0.006363769 |
| gen-1792053797-y98h8e4BVeEm3ZUq3q7z | 16570 | 9207 | 69844 | 0.007199205 |
| gen-1792054364-MLtL2R7WpK0ZFIMfzk64 | 15267 | 6980 | 53434 | 0.005083328 |
| gen-1792054418-vYSgsylkP12nnZccZM6r | 28656 | 1049 | 9253 | 0.004592535 |
| gen-1792055401-XnFLnln5R1hoQLPuDgVD | 15357 | 7708 | 50053 | 0.005443935 |
| gen-1792055453-yoJWLyclhCsdCx2IWfNx | 31864 | 1003 | 7925 | 0.005058949 |
| gen-1792056046-L7gzHJgZVcXxfb6avJ8j | 15334 | 6417 | 46334 | 0.004460242 |
| gen-1792056094-tklhIiwA9pgBCg2lo8Gv | 28736 | 949 | 8712 | 0.004570260 |
| gen-1792056314-l8ZbD0F86OLnRVDXN8cz | 15357 | 5498 | 40868 | 0.002623866 |
| gen-1792056356-kchPePjOTMRcOIxMitBU | 28273 | 794 | 6689 | 0.004409138 |

All terminal generation records were independently obtained before reconciliation. Two DNS failures occurred before HTTP connection (workerd getaddrinfo logs, no generation ID); provider usage exactly equaled previously verified terminal charges and both were reconciled at zero. No uncertain charge was assumed free. Broad clarification timed out with terminal130452ms generation; focused pre-compaction request also exceeded the transport envelope (116427ms generation plus4519ms latency). Delayed generation404 was not treated as zero.

Failure history preserved: mismatched generated row dependencies; wrong requirement-cell role; unsupported per-dimension uniqueness restriction (removed); missing Finch outcome-ID list entry; wrong-kind evidence lookup; invented passage hashes; reviewer rejecting quoted fragments; zero-artifact review contradiction. Fixes remove redundant role/ID generation by containment, use exact request statements, pinned short draft labels, and constrain impossible empty-inventory conclusions. Ownership/support/dependency/compatibility checks remain fail-closed.

Final campaign: admission disabled, no pending job/active attempt, zero holds,141882microUSD reconciled spend including24385microUSD predating this task. Task provider spend USD0.117491053; account usage USD0.662793465. No credit purchase, automatic paid retry, extra paid stage, model substitution, deployment, or reconstructed historical ledger.

## Quality and latency

Full-object focused draft:15178 native completion tokens,116427ms generation (failed application envelope). Compact-hash draft:8074 native completion tokens,56740ms generation (failed wrong-role gate). Short-label ready run:65.745s processing; final full-input run timing is in the table. Different contracts/output/acceptance and single samples mean no speedup/percentile claim. The unchanged historical baseline was88.334s; feature baseline111.118s exceeded90s. Broad/full-context reliability remains a risk.

Historical disposition/prose inconsistencies were observed and reviewer instructions now explicitly reject them; that is not blanket semantic qualification. Full-policy input can withdraw a prior lead without yielding a supported alternative; withheld dependencies do not leak row/action text. Reviewed-lesson applicability remains evidence- and request-dependent.

## Local and browser checks

`npm run typecheck`, `npm test` (17 TypeScript regressions plus Python validation), `npm run build`, and `npm run ingest` passed. Migration applied to the existing retained-result DB; second application updated0rows. Missing capability/operator authorization returned404; three concurrent authenticated operator reads passed. All24 exact originals matched SHA-256.

Actual Chromium verified compact comparison inspection, exact passage dialog, original link, selected mapping/passages then immediate invalidation, one previous snapshot, failed-recheck history, conservative ready state, light1440px and dark320px (page width320, no page overflow after header wrapping). Tables remain locally horizontally scrollable. No new brief phase was submitted; existing brief contracts remain covered by regression tests and prior qualification.
