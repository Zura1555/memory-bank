import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import manifestSchema from "../../contracts/corpus-manifest.schema.json" with { type: "json" };
import knowledgeSchema from "../../contracts/knowledge-record.schema.json" with { type: "json" };
import type { Env } from "./env.ts";
import type { KnowledgeCard, KnowledgeRecord, PassageView } from "../shared/protocol.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(knowledgeSchema);
const validManifest = ajv.compile<CorpusManifest>(manifestSchema);

export interface Passage {
  passageId: string;
  excerpt: string;
  sourceKind: PassageView["sourceKind"];
  location: PassageView["location"];
}

export interface SourceVersion {
  versionId: string;
  sourcePath: string;
  mimeType: string;
  sha256: string;
  statedDate: string | null;
  importedAt: string;
  extractionStatus: "complete" | "incomplete";
  exclusionReasons: string[];
  passages: Passage[];
}

export interface Artifact {
  artifactId: string;
  title: string;
  fictional: true;
  versions: SourceVersion[];
}

export interface PastCase {
  caseId: string;
  title: string;
  fictional: true;
  artifacts: Artifact[];
  records: KnowledgeRecord[];
}

export interface CorpusManifest {
  schemaVersion: 2;
  corpusVersion: string;
  cases: PastCase[];
}

export interface IndexedPassage extends PassageView {
  title: string;
}

export interface CorpusSnapshot {
  manifest: CorpusManifest;
  manifestSha256: string;
  availableVersions: Set<string>;
  caseAvailability: Map<string, "available" | "partial" | "unavailable">;
  passages: Map<string, IndexedPassage>;
  versions: Map<string, { version: SourceVersion; artifact: Artifact; pastCase: PastCase }>;
}

export class EvidenceUnavailable extends Error {
  constructor(message = "Required corpus evidence is unavailable or incomplete.") {
    super(message);
    this.name = "EvidenceUnavailable";
  }
}
async function sha256Body(body: ReadableStream<Uint8Array>): Promise<string> {
  const digest = createHash("sha256");
  const reader = body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      digest.update(chunk.value);
    }
    return digest.digest("hex");
  } finally {
    reader.releaseLock();
  }
}

function asManifest(value: unknown): CorpusManifest {
  if (!validManifest(value)) {
    throw new EvidenceUnavailable("The published corpus manifest failed schema validation.");
  }
  const manifest = value;
  const caseIds = new Set<string>();
  const artifactIds = new Set<string>();
  const versionIds = new Set<string>();
  const passageIds = new Set<string>();
  for (const pastCase of manifest.cases) {
    artifactIds.clear();
    if (caseIds.has(pastCase.caseId)) throw new EvidenceUnavailable("Duplicate case identity in corpus manifest.");
    caseIds.add(pastCase.caseId);
    if (pastCase.fictional !== true) throw new EvidenceUnavailable("A case lacks its fictional label.");
    for (const artifact of pastCase.artifacts) {
      if (artifactIds.has(artifact.artifactId)) throw new EvidenceUnavailable("Duplicate artifact identity in corpus manifest.");
      artifactIds.add(artifact.artifactId);
      if (artifact.fictional !== true) throw new EvidenceUnavailable("An artifact lacks its fictional label.");
      for (const version of artifact.versions) {
        if (versionIds.has(version.versionId)) throw new EvidenceUnavailable("Duplicate source version identity in corpus manifest.");
        versionIds.add(version.versionId);
        const versionPrefix = `corpora/${manifest.corpusVersion}/originals/`;
        if (!version.sourcePath.startsWith(versionPrefix) || version.sourcePath.includes("\\") || version.sourcePath.split("/").some((part) => part === ".." || part === ".")) {
          throw new EvidenceUnavailable("A source path is outside the canonical versioned originals namespace.");
        }
        for (const passage of version.passages) {
          if (passageIds.has(passage.passageId)) throw new EvidenceUnavailable("Duplicate passage identity in corpus manifest.");
          passageIds.add(passage.passageId);
        }
      }
    }
  }
  const records = new Map<string, KnowledgeRecord>();
  for (const pastCase of manifest.cases) {
    for (const record of pastCase.records) {
      if (record.caseId !== pastCase.caseId || records.has(record.recordId)) {
        throw new EvidenceUnavailable("Invalid or duplicate knowledge record identity.");
      }
      for (const ref of record.evidence) {
        const version = pastCase.artifacts.find((artifact) => artifact.artifactId === ref.artifactId)?.versions.find((item) => item.versionId === ref.versionId);
        if (ref.caseId !== pastCase.caseId || version?.extractionStatus !== "complete" || !version.passages.some((passage) => passage.passageId === ref.passageId)) {
          throw new EvidenceUnavailable("Knowledge evidence does not resolve to a complete exact source.");
        }
      }
      records.set(record.recordId, record);
    }
  }
  const superseded = new Set<string>();
  for (const record of records.values()) {
    if (record.supersedesId === undefined) continue;
    const target = records.get(record.supersedesId);
    if (!target || target.caseId !== record.caseId || target.kind !== record.kind || superseded.has(target.recordId)) {
      throw new EvidenceUnavailable("Invalid or ambiguous knowledge supersession link.");
    }
    superseded.add(target.recordId);
    const seen = new Set([record.recordId]);
    for (let current: KnowledgeRecord | undefined = target; current; current = current.supersedesId === undefined ? undefined : records.get(current.supersedesId)) {
      if (seen.has(current.recordId)) throw new EvidenceUnavailable("Knowledge supersession cycle.");
      seen.add(current.recordId);
    }
  }
  return manifest;
}

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

export async function loadManifest(env: Env): Promise<{ manifest: CorpusManifest; manifestSha256: string }> {
  const object = await env.ORIGINALS.get("corpus/manifest.json");
  if (!object || object.size > MAX_MANIFEST_BYTES) throw new EvidenceUnavailable("The published corpus manifest is unavailable or oversized.");
  const bytes = await object.arrayBuffer();
  const manifestSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (object.customMetadata?.sha256 && object.customMetadata.sha256 !== manifestSha256) {
    throw new EvidenceUnavailable("The published corpus manifest failed its integrity check.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new EvidenceUnavailable("The published corpus manifest is not valid JSON.");
  }
  return { manifest: asManifest(raw), manifestSha256 };
}

export async function loadCorpus(env: Env): Promise<CorpusSnapshot> {
  const { manifest, manifestSha256 } = await loadManifest(env);
  const availableVersions = new Set<string>();
  const caseAvailability = new Map<string, "available" | "partial" | "unavailable">();
  const passages = new Map<string, IndexedPassage>();
  const versions = new Map<string, { version: SourceVersion; artifact: Artifact; pastCase: PastCase }>();

  for (const pastCase of manifest.cases) {
    let totalUsable = 0;
    let totalVersions = 0;
    for (const artifact of pastCase.artifacts) {
      for (const version of artifact.versions) {
        totalVersions++;
        versions.set(version.versionId, { version, artifact, pastCase });
        if (version.extractionStatus !== "complete") continue;
        const original = await env.ORIGINALS.get(version.sourcePath);
        if (!original) continue;
        let sourceHash: string;
        try {
          sourceHash = await sha256Body(original.body);
        } catch {
          continue;
        }
        if (sourceHash !== version.sha256) continue;
        availableVersions.add(version.versionId);
        totalUsable++;
        for (const passage of version.passages) {
          passages.set(passage.passageId, {
            caseId: pastCase.caseId,
            artifactId: artifact.artifactId,
            versionId: version.versionId,
            passageId: passage.passageId,
            title: artifact.title,
            fictional: true,
            statedDate: version.statedDate,
            excerpt: passage.excerpt,
            sourceKind: passage.sourceKind,
            location: passage.location,
          });
        }
      }
    }
    caseAvailability.set(pastCase.caseId, totalUsable === 0 ? "unavailable" : totalUsable === totalVersions ? "available" : "partial");
  }
  return { manifest, manifestSha256, availableVersions, caseAvailability, passages, versions };
}
export interface ExactOriginal {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  versionId: string;
}

async function readExactOriginal(env: Env, version: SourceVersion): Promise<ExactOriginal> {
  if (version.extractionStatus !== "complete") throw new EvidenceUnavailable("This source version is marked incomplete.");
  const object = await env.ORIGINALS.get(version.sourcePath);
  if (!object || !Number.isSafeInteger(object.size) || object.size > MAX_SOURCE_BYTES) throw new EvidenceUnavailable("The exact original is unavailable or oversized.");
  const bytes = new Uint8Array(object.size);
  const digest = createHash("sha256");
  const reader = object.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.byteLength > bytes.length) throw new EvidenceUnavailable("The exact original size changed during download.");
      bytes.set(chunk.value, offset);
      digest.update(chunk.value);
      offset += chunk.value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new EvidenceUnavailable("The exact original could not be verified.");
  } finally {
    reader.releaseLock();
  }
  if (offset !== bytes.length || digest.digest("hex") !== version.sha256) throw new EvidenceUnavailable("The exact original failed its integrity check.");
  return { bytes, mimeType: version.mimeType, versionId: version.versionId };
}

export async function exactOriginal(env: Env, versionId: string): Promise<ExactOriginal> {
  const { manifest } = await loadManifest(env);
  const version = manifest.cases.flatMap((item) => item.artifacts.flatMap((artifact) => artifact.versions))
    .find((item) => item.versionId === versionId);
  if (!version) throw new EvidenceUnavailable("The requested source version is unknown.");
  return readExactOriginal(env, version);
}

export async function exactPassage(env: Env, passageId: string): Promise<IndexedPassage> {
  const { manifest } = await loadManifest(env);
  for (const pastCase of manifest.cases) {
    for (const artifact of pastCase.artifacts) {
      for (const version of artifact.versions) {
        const passage = version.passages.find((item) => item.passageId === passageId);
        if (!passage) continue;
        if (version.extractionStatus !== "complete") throw new EvidenceUnavailable("The referenced source version is incomplete.");
        const original = await env.ORIGINALS.get(version.sourcePath);
        if (!original || await sha256Body(original.body) !== version.sha256) throw new EvidenceUnavailable("The exact original failed its integrity check.");
        return {
          caseId: pastCase.caseId,
          artifactId: artifact.artifactId,
          versionId: version.versionId,
          passageId: passage.passageId,
          title: artifact.title,
          fictional: true,
          statedDate: version.statedDate,
          excerpt: passage.excerpt,
          sourceKind: passage.sourceKind,
          location: passage.location,
        };
      }
    }
  }
  throw new EvidenceUnavailable("The requested passage is unknown.");
}

export function knowledgeCards(snapshot: CorpusSnapshot, caseId?: string): KnowledgeCard[] {
  return snapshot.manifest.cases.flatMap((pastCase) => {
    if (caseId !== undefined && pastCase.caseId !== caseId) return [];
    return pastCase.records.filter((record) => record.evidence.every((ref) => snapshot.availableVersions.has(ref.versionId))).map((record) => {
      const successor = pastCase.records.find((candidate) => candidate.supersedesId === record.recordId);
      return { ...record, ...(successor ? { supersededById: successor.recordId } : {}) };
    });
  });
}

export interface ModelCaseContext {
  caseId: string;
  title: string;
  availability: "available" | "partial" | "unavailable" | undefined;
  records: KnowledgeCard[];
  artifacts: {
    artifactId: string;
    title: string;
    versions: {
      versionId: string;
      statedDate: string | null;
      extractionStatus: "available" | "unavailable";
      exclusionReasons: string[];
      passages: Passage[];
    }[];
  }[];
}

export function modelCorpus(snapshot: CorpusSnapshot): ModelCaseContext[] {
  return snapshot.manifest.cases.map((pastCase) => ({
    caseId: pastCase.caseId,
    title: pastCase.title,
    availability: snapshot.caseAvailability.get(pastCase.caseId),
    records: knowledgeCards(snapshot, pastCase.caseId),
    artifacts: pastCase.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      title: artifact.title,
      versions: artifact.versions.map((version) => ({
        versionId: version.versionId,
        statedDate: version.statedDate,
        extractionStatus: snapshot.availableVersions.has(version.versionId) ? "available" : "unavailable",
        exclusionReasons: version.exclusionReasons,
        passages: snapshot.availableVersions.has(version.versionId) ? version.passages : [],
      })),
    })),
  }));
}

export function sourceVersion(snapshot: CorpusSnapshot, versionId: string) {
  const found = snapshot.versions.get(versionId);
  if (!found || !snapshot.availableVersions.has(versionId)) throw new EvidenceUnavailable("The exact original version is unavailable.");
  return found;
}
