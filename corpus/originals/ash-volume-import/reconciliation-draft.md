FICTIONAL SOURCE — Synthetic work product, incomplete draft. No real client or system is represented.

# Ash Goods import control sheet

Date stated: 2025-03-14

| Control | Proposed handling | Status in this case |
| --- | --- | --- |
| Record identity | Use immutable source primary ID; never merge by email alone. | 713 rows lack source ID; unresolved. |
| Duplicate contacts | Preserve separate identities unless client supplies an adjudicated merge rule. | 6,402 repeated-email rows flagged; identity distinctions not fully reviewed. |
| Restart | Record submitted IDs and reconcile each with target before retry; use target idempotency only after capability is confirmed. | No durable checkpoint in attempted process; target semantics unknown. |
| Completion | Reconcile source, accepted, rejected, and pending counts with client approval. | No full-run counts or acceptance evidence. |

This is a control draft, not an executable or validated migration procedure. It has not been tested for 84,117-row completion, no-duplicate restart, downtime, or target API behavior. Do not treat it as evidence that migration succeeded.
