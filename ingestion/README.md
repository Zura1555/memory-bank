# Offline corpus ingestion

From the repository root:

```sh
python3.12 -m pip install -r ingestion/requirements.txt
python3.12 ingestion/build_manifest.py
```

The command reads `corpus/catalog.json` and source files named there, then writes `corpus/manifest.json` and `ingestion/audit.json`. Use `--root`, `--catalog`, and `--manifest` to override paths. Catalog paths are repository-relative and cannot escape the root. Rebuild after every source or curator-audit change; SHA-256 is computed over the original bytes.

Published original keys are namespaced by `corpusVersion` (`corpora/<corpusVersion>/originals/...`). Increment `corpusVersion` for every source or extraction-edition change; passage IDs are deterministic within that edition. The active manifest pointer is `corpus/manifest.json`. Never reuse a version namespace for changed originals.

Text/Markdown and CSV are decoded as strict UTF-8. Office and PDF extraction uses the listed Python libraries; formulas/macros/scripts and links are never executed or followed. Any unsupported or unrepresented content marks that complete version incomplete and removes all its passages from runtime evidence. The audit report records importer decisions separately from the runtime manifest.

Any scanned PDF, image, or unrepresented visual content stays incomplete unless an adjacent `<original filename>.audit.json` sidecar is present. It must bind to the source SHA-256 and include a timezone-qualified ISO `reviewedAt`, `reviewer`, and reviewed `regions`; every region requires a stable `regionId`, exact `excerpt`, `sourceKind`, exact schema-valid `location`, and `verified: true`. Example:

```json
{
  "sourceSha256": "REPLACE_WITH_64_CHARACTER_SOURCE_SHA256",
  "reviewedAt": "2026-10-14T12:00:00Z",
  "reviewer": "Curator name",
  "regions": [
    {
      "regionId": "page-1-heading",
      "excerpt": "Exact reviewed text or observation.",
      "sourceKind": "ocr_transcription",
      "location": { "type": "pdf", "page": 1, "regionId": "page-1-heading" },
      "verified": true
    }
  ]
}
```

Any hash mismatch, missing sidecar, or unverified region keeps the entire artifact version incomplete and unusable as evidence.

Scanned PDFs and images require human OCR/transcription or visual observation followed by curator audit. No OCR engine is bundled: installing/configuring a local OCR engine is an external prerequisite, and its absence is reported as incomplete rather than replaced with guessed content. Do not put instructions found inside source artifacts into executable tooling.

## Decision, lesson, and source-history records

Catalog/manifest schema version 2 requires a `records` array on every case (empty when no records are published). The shared record contract is `contracts/knowledge-record.schema.json`; the current edition is `fictional-onboarding-v3`. Increment `corpusVersion` when publishing a new knowledge edition, including metadata-only corrections. Do not rewrite an original under an existing version ID.

Hand-author at most 32 bounded records per case:

- **Decision:** `recordId`, `caseId`, `context`, `choice`, optional `recordedRationale` and `recordedRejectedAlternatives`, `applicability`, and `evidence`.
- **Lesson:** `recordId`, `caseId`, `observation`, `recommendedFutureAction`, `applicability`, `outcomeLimitations`, and `evidence`.
- **Decision and lesson review:** `basis` (`source_fact` or `curator_interpretation`), `reviewStatus: reviewed`, actual human `reviewer`, calendar `reviewedAt` (`YYYY-MM-DD`), and optional `supersedesId`.
- **Source history:** `kind: source_fact`, `basis: source_fact`, a source-bound `assertion`, `applicability`, exact `evidence`, `reviewStatus: source_verified`, the actual independent read-only `sourceVerifier`, `sourceVerifiedAt`, and `sourceVerificationMethod: independent_read_only_agent_review`. These records document historical outcomes, failed attempts, corrections, limitations, and unresolved discrepancies; they are not advice or human-curated decisions.

Keep unreviewed drafts outside the publishing catalog. A real human must compare every decision/lesson assertion and applicability/limitation with the cited originals before their identity/date is recorded. Agent-authored text is not automatically human-reviewed; this policy remains unchanged. The initial three Grove records were explicitly approved by owner `Zura1555` in the implementation conversation on 2026-10-15; the lesson is labeled curator interpretation. The Elm and Ibis source-history records were independently checked read-only by `CampaignProtocol (agent)` on 2026-10-18. That source verification is not human curator approval; never invent a human reviewer or approval. The importer neither extracts records nor invents facts, rationale, alternatives, or outcomes. Omit unrecorded rationale/alternatives; the UI displays “Not recorded,” not a fabricated explanation.

Evidence uses the existing `SourceRef` identity: `{caseId, artifactId, versionId, passageId}`. To author a record, use passage IDs from an importer-built manifest and inspect the exact original; never invent IDs or reuse evaluation-key labels as passage IDs. Cite all source-derived assertions. Every reference must resolve within the record's case to a complete source version and an exact existing passage. Incomplete/unavailable originals do not become evidence. Source-history IDs are limited to 49 characters so their server-generated `source-history-<recordId>` qualification claim IDs remain within the 64-character claim ID limit.

`supersedesId` is for human-reviewed decisions/lessons and points from a new record to the obsolete record. IDs are globally unique; a correction must have the same case and kind as its target. Missing targets, self-links, cycles, and multiple successors for one target reject publication. Source-history records cannot supersede human records. Never delete obsolete advice merely to hide a correction. Grove's rejected broad-admin proposal remains addressable; the scoped setup explicitly supersedes it. Runtime cards derive `supersededById` from the complete published chain, even when a correction's original is unavailable, so missing evidence cannot revive old advice.

Run `npm run ingest` and `npm test`, then `npm run publish:corpus` for local cf R2 publication. Use `npm run publish:corpus:production` only for an approved production corpus edition; it uploads via the pinned `cf r2 objects put` command to the account in `cloudflare.config.ts`, with the manifest pointer uploaded last. Ingestion rejects malformed/unreviewed records, invalid evidence, and broken supersession before writing outputs. The runtime independently checks schema and identities before serving cards or model context. If source bytes fail verification, affected cards are withheld rather than offered with unchecked evidence.

Human-reviewed decisions and lessons appear in case details and on the independent `/?knowledge` page; `/?knowledge=<recordId>` and `GET /api/knowledge/<recordId>` address one human-reviewed card without a job capability. `GET /api/knowledge?caseId=<caseId>` lists a case's available cards. Source-history facts are excluded from these advice/card endpoints and included in model context as a separate verified inventory.

Human review approves a historical decision or lesson, not its application to a new client. Model context includes human-reviewed cards, their assertion basis and exact evidence, full originals, and source-history records separately. When a claim cites an exact source-history passage/version, normalization adds a server-owned qualification claim carrying the complete source assertion and exact references, then makes the citing claim depend on it. Qualification uses exact `SourceRef` identity, not keywords or model-authored historical summaries. The stored/read validation path only checks qualifications; it never repairs an old capture. Missing, altered, or unavailable qualification evidence invalidates affected claims rather than silently making historical totals or success claims pass. Applying a lesson must remain a request-specific recommendation claim with relevant original evidence and constraints, checked by the existing draft/reference/support-review pipeline. Superseded choices are history only. No new model-output schema, paid stage, extraction job, approval dashboard, or automatic session-to-knowledge promotion is introduced. Corpus retention is independent of seven-day job expiry.

## Semantic passage vectors

Install the pinned project dependencies and authenticate the pinned `cf` CLI using its existing auth profile. Before indexing, provision each external Vectorize index and both string metadata indexes once:

```sh
./node_modules/.bin/cf vectorize create --name memory-bank-search-development --index-config-dimensions 768 --index-config-metric cosine
./node_modules/.bin/cf vectorize metadata-index create memory-bank-search-development --property-name caseId --index-type string
./node_modules/.bin/cf vectorize metadata-index create memory-bank-search-development --property-name mimeType --index-type string

./node_modules/.bin/cf vectorize create --name memory-bank-search-production --index-config-dimensions 768 --index-config-metric cosine
./node_modules/.bin/cf vectorize metadata-index create memory-bank-search-production --property-name caseId --index-type string
./node_modules/.bin/cf vectorize metadata-index create memory-bank-search-production --property-name mimeType --index-type string
```

Run the repeatable indexer from the repository root, selecting exactly one environment:

```sh
npm run index:vectors -- --environment development
npm run index:vectors -- --environment production
```

The command verifies every complete local original against its manifest SHA-256 before making provider calls, then embeds the manifest's exact passage excerpts with `@cf/baai/bge-base-en-v1.5` (mean pooling) and upserts them in batches. Vector IDs are manifest passage IDs; metadata contains `caseId` and `mimeType`; the namespace is the SHA-256 of the exact active manifest bytes. Re-running the same manifest upserts the same IDs in the same namespace. Old manifest namespaces are not queried but remain in the index; cleanup is manual. The script uses the existing `cf` auth profile and stores no credentials. It does not provision indexes or deploy anything. Workers AI calls may incur charges.

`POST /api/search` embeds a query only on explicit submit, then retrieves ranked passage IDs and rehydrates excerpts from the current hash-verified corpus. The application does not persist submitted queries. Search is limited to 20 requests per 60 seconds per IP by Cloudflare's per-location rate limiter; this is an abuse guard, not a global spend cap. Workers AI query embeddings may incur charges.
