FICTIONAL SOURCE — Synthetic work product. No real client or system is represented.

# Cedar sandbox field map and reconciliation steps

Version stated: 2025-02-11

| CSV field | Sandbox field | Rule / check |
| --- | --- | --- |
| source_key | external_reference | Preserve exact value; must be present; compare this value during reconciliation. |
| legal_name | supplier_name | Trim surrounding whitespace. Reject blank after trimming. |
| contact_email | email | Trim surrounding whitespace; do not infer uniqueness or change case. |
| payment_term_code | payment_terms | Map only codes confirmed by client: NET30 → 30 days, DUE → due on receipt. Reject other values for review. |
| status | — | Include only exact `active` values; count excluded rows separately. |

Reconciliation performed for this batch: compare input active count with accepted plus rejected; retain a row-level result keyed by `source_key`; report duplicate email values without merging records. Sandbox tally: 1,200 active = 1,198 accepted + 2 rejected. The corrected rejected rows were not retried; no evidence establishes their eventual import. This mapping assumes neither more than 1,200 active records nor production behavior.
