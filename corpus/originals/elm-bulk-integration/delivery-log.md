FICTIONAL SOURCE — Synthetic delivery notes. No real client or system is represented.

# Elm Rentals connector notes

Date stated: 2025-04-08 to 2025-04-17

2025-04-08 — Capability check on StayLedger v4 confirmed export of adjustment batches as JSON and a stable adjustment reference. PaySpring Connect v3 documentation and sandbox exposed `POST /jobs` with a batch body, a job ID, and per-item status retrieval. Sandbox limit observed in docs: 500 items per job. No production test was run.

2025-04-10 — Attempt 1 submitted a 600-item test batch and received a validation rejection; no adjustments were applied. We split test data into two 300-item batches. Test included four intentionally malformed amounts; target returned item-level rejects.

2025-04-12 — Attempt 2: first 300-item sandbox batch completed; second was accepted but polling stopped after a client network disconnect. Later retrieval showed all 300 second-batch items terminal, including 2 rejected. Client confirmed 598 of 600 accepted across tests. We did not repeat either batch. No production billing result is available.

2025-04-17 — Constraint: evidence applies only to v4 / Connect v3 sandbox, batches no larger than 500, and the tested fields. Rate-limit behavior under sustained load and production authorization are unknown. Delivery acceptance for production remains pending.
