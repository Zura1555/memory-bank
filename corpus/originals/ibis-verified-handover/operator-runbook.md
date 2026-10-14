FICTIONAL SOURCE — Synthetic work product. No real client or system is represented.

# Ibis test import recovery runbook

Date stated: 2025-05-21

**Routine owners:** Maya Chen (primary), Luis Ortega (backup). Client operations lead: Priya Nair. Escalate to delivery support during the first five business days after handover.

1. Check the import job status and preserve the source batch identifier.
2. If the job stopped, compare the last recorded checkpoint with source and target counts before replay. Do not replay if the checkpoint is missing or the applied state is unclear; contact the operations lead.
3. Restore the prior checkpoint in the test environment, replay the identified test batch once, and compare counts.
4. Record operator, time, batch identifier, source/target counts, and any discrepancy in the exercise log.

Exercise evidence: on 2025-05-21, named operator Maya restored a supplied checkpoint and replayed one test batch; target showed one batch and count comparison matched. This procedure was exercised in test only. Production alert routing and production recovery remain unverified.
