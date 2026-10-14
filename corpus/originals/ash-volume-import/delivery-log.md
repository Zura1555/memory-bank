FICTIONAL SOURCE — Synthetic delivery notes. No real client or system is represented.

# Ash Goods import attempts and status

Date stated: 2025-03-10 to 2025-03-18

2025-03-10 — Dry-run on 84,117 rows exceeded the planned weekend window. Initial script matched identities by normalized email. Preview revealed 6,402 repeated email values; several belonged to different people. We stopped before committing the batch.

2025-03-12 — Attempt 2 used source primary ID as the match key, but the target rejected 713 rows with missing IDs. The transfer process had no durable checkpoint: after a network timeout, we could not establish which of 3,000 submitted rows were committed. We did not replay that segment because duplicate creation risk was unresolved.

2025-03-14 — Corrective note: email is not a safe identity key for this dataset. Client must resolve missing IDs and provide a deterministic duplicate policy. A restartable procedure would need a target-supported idempotency key or a verified per-record reconciliation step; neither capability was confirmed.

2025-03-18 — Status: partial test only, no completed migration, no accepted reconciliation, and no verified safe restart. Final disposition of the 713 missing-ID records is unknown. The source-side writability/cutover behavior and target upsert semantics remain unknown.
