FICTIONAL SOURCE — Synthetic client-onboarding request. No real client or system is represented.

# Ash Goods: migration request

Date stated: 2025-03-04

Ash Goods requested moving approximately 84,000 customer identities from an old hosted CRM into a new CRM tenant. Source exports come in monthly CSV files; one contact may have several email addresses and duplicate identity rules are not documented. Client requires preserving the primary identifier, tracking rejected rows, and restarting safely after a failed transfer without duplicating records.

The request mentions a preferred weekend cutover but does not establish whether the source can remain writable, whether the target supports atomic upsert or idempotency keys, or whether a no-downtime guarantee is required. Those points were unanswered at kickoff. Target API version was not recorded in the request.

Acceptance requested a count reconciliation and a restart that does not create duplicate identities. No acceptance result or complete migration is asserted here.
