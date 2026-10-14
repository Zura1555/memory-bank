FICTIONAL SOURCE — Synthetic delivery notes. No real client or system is represented.

# Cedar Supply import work log

Date stated: 2025-02-10 to 2025-02-13

2025-02-10 — Attempt 1 used the client’s initial CSV export without filtering. Preview showed 1,200 active and 36 inactive rows. We stopped before loading because the acceptance note excludes inactive suppliers.

2025-02-11 — Decision: import only rows with status `active`; preserve `source_key` unchanged in the target reconciliation field. Normalize surrounding whitespace in legal name and email; do not lowercase or otherwise rewrite email values. Two active rows shared the same email but had different source keys. We did not deduplicate automatically. Client reviewed and accepted both as separate suppliers for this sandbox run.

2025-02-12 — Attempt 2 loaded 1,198 rows. Two rows were rejected for missing legal name. A retry of those two after client correction was not performed before the sandbox window closed.

2025-02-13 — Recorded outcome: 1,198 accepted, 2 rejected; duplicate email values were retained as separate records by source key. Client acknowledged the counts. This is evidence for this 1,200-active-row sandbox batch only, not production, other target versions, or a guarantee. No production run or post-window retry is recorded.
