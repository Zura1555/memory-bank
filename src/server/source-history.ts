import type { Claim, SourceRef } from "../shared/protocol.ts";
import type { CorpusSnapshot, SourceHistoryRecord } from "./corpus.ts";

const QUALIFICATION_PREFIX = "source-history-";

function sameRef(left: SourceRef, right: SourceRef): boolean {
  return left.caseId === right.caseId && left.artifactId === right.artifactId
    && left.versionId === right.versionId && left.passageId === right.passageId;
}

function sameRefs(left: SourceRef[], right: SourceRef[]): boolean {
  return left.length === right.length && left.every((ref, index) => sameRef(ref, right[index]));
}

function records(snapshot: CorpusSnapshot): SourceHistoryRecord[] {
  return snapshot.manifest.cases.flatMap((pastCase) => pastCase.records.filter((record): record is SourceHistoryRecord => record.kind === "source_fact"));
}

function qualifierId(record: SourceHistoryRecord): string {
  return `${QUALIFICATION_PREFIX}${record.recordId}`;
}

function evidenceAvailable(snapshot: CorpusSnapshot, record: SourceHistoryRecord): boolean {
  return record.evidence.every((ref) => snapshot.availableVersions.has(ref.versionId));
}

function triggers(record: SourceHistoryRecord, claim: Claim): boolean {
  return claim.sourceRefs.some((ref) => record.evidence.some((evidence) => sameRef(ref, evidence)));
}

export function sourceVerifiedRecords(snapshot: CorpusSnapshot): SourceHistoryRecord[] {
  return records(snapshot).filter((record) => evidenceAvailable(snapshot, record));
}

export function applySourceHistoryQualifications(snapshot: CorpusSnapshot, claims: Claim[]): Claim[] {
  if (claims.some((claim) => claim.claimId.startsWith(QUALIFICATION_PREFIX))) {
    throw new Error("Model claims cannot use the reserved source-history claim ID namespace.");
  }

  const history = records(snapshot);
  const additions = new Map<string, Claim>();
  const dependencies = new Map<string, Set<string>>();
  for (const record of history) {
    const matchingClaims = claims.filter((claim) => triggers(record, claim));
    if (matchingClaims.length === 0 || !evidenceAvailable(snapshot, record)) continue;
    const id = qualifierId(record);
    if (claims.some((claim) => claim.claimId === id) || additions.has(id)) {
      throw new Error(`Source-history claim ID collision: ${id}`);
    }
    additions.set(id, {
      claimId: id,
      text: record.assertion,
      kind: "source_fact",
      sourceRefs: record.evidence.map((ref) => ({ ...ref })),
      requestQuotes: [],
      dependsOnClaimIds: [],
    });
    for (const claim of matchingClaims) {
      const ids = dependencies.get(claim.claimId) ?? new Set<string>();
      ids.add(id);
      dependencies.set(claim.claimId, ids);
    }
  }

  const qualified = claims.map((claim) => {
    const required = dependencies.get(claim.claimId);
    const missing = required ? [...required].filter((id) => !claim.dependsOnClaimIds.includes(id)) : [];
    return missing.length === 0 ? claim : { ...claim, dependsOnClaimIds: [...claim.dependsOnClaimIds, ...missing] };
  });
  return [...qualified, ...additions.values()];
}

export function isSourceHistoryQualification(snapshot: CorpusSnapshot, claim: Claim): boolean {
  if (claim.kind !== "source_fact" || claim.requestQuotes.length !== 0 || claim.dependsOnClaimIds.length !== 0) return false;
  const record = records(snapshot).find((candidate) => qualifierId(candidate) === claim.claimId);
  return record !== undefined && evidenceAvailable(snapshot, record)
    && claim.text === record.assertion && sameRefs(claim.sourceRefs, record.evidence);
}

export function invalidSourceHistoryQualifications(snapshot: CorpusSnapshot, claims: Claim[]): Set<string> {
  const invalid = new Set<string>();
  const byId = new Map(claims.map((claim) => [claim.claimId, claim]));
  for (const claim of claims) {
    if (claim.claimId.startsWith(QUALIFICATION_PREFIX) && !isSourceHistoryQualification(snapshot, claim)) invalid.add(claim.claimId);
  }

  for (const record of records(snapshot)) {
    const id = qualifierId(record);
    const qualification = byId.get(id);
    const valid = qualification !== undefined && isSourceHistoryQualification(snapshot, qualification);
    const matchingClaims = claims.filter((claim) => !claim.claimId.startsWith(QUALIFICATION_PREFIX) && triggers(record, claim));
    if ((!valid || matchingClaims.length === 0) && qualification !== undefined) invalid.add(id);
    for (const claim of matchingClaims) {
      if (!valid || !claim.dependsOnClaimIds.includes(id)) invalid.add(claim.claimId);
    }
  }
  return invalid;
}
