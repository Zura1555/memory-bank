import type { PassageSearchRequest, PassageView } from "../shared/protocol.ts";
import { loadCorpus } from "./corpus.ts";
import type { Env } from "./env.ts";
import { HttpFailure } from "./errors.ts";

const EMBEDDING_DIMENSIONS = 768;
const SEARCH_LIMIT = 50;
const MODEL = "@cf/baai/bge-base-en-v1.5";

function embeddingVector(output: unknown): number[] {
  if (typeof output !== "object" || output === null || !("data" in output) || !Array.isArray(output.data) || output.data.length !== 1) {
    throw new HttpFailure(503, "SEARCH_UNAVAILABLE", true);
  }
  const [vector] = output.data;
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new HttpFailure(503, "SEARCH_UNAVAILABLE", true);
  }
  return vector;
}

export async function searchPassages(env: Env, request: PassageSearchRequest): Promise<PassageView[]> {
  if (!env.AI || !env.VECTORIZE) throw new HttpFailure(503, "SEARCH_UNAVAILABLE", true);

  const corpus = await loadCorpus(env);
  if (request.caseId && !corpus.manifest.cases.some((item) => item.caseId === request.caseId)) {
    throw new HttpFailure(404, "CASE_NOT_FOUND");
  }
  let hasEligiblePassage = false;
  for (const passage of corpus.passages.values()) {
    if (request.caseId && passage.caseId !== request.caseId) continue;
    if (request.mimeType && corpus.versions.get(passage.versionId)?.version.mimeType !== request.mimeType) continue;
    hasEligiblePassage = true;
    break;
  }
  if (!hasEligiblePassage) return [];


  let output: unknown;
  try {
    output = await env.AI.run(MODEL, { text: request.query });
  } catch {
    throw new HttpFailure(503, "SEARCH_UNAVAILABLE", true);
  }
  const vector = embeddingVector(output);
  const filter: VectorizeVectorMetadataFilter = {};
  if (request.caseId) filter.caseId = request.caseId;
  if (request.mimeType) filter.mimeType = request.mimeType;

  let response: unknown;
  try {
    response = await env.VECTORIZE.query(vector, {
      topK: SEARCH_LIMIT,
      namespace: corpus.manifestSha256,
      ...(Object.keys(filter).length ? { filter } : {}),
    });
  } catch {
    throw new HttpFailure(503, "SEARCH_UNAVAILABLE", true);
  }
  if (typeof response !== "object" || response === null || !("matches" in response) || !Array.isArray(response.matches)) {
    throw new HttpFailure(503, "SEARCH_UNAVAILABLE", true);
  }

  const results: PassageView[] = [];
  const seen = new Set<string>();
  for (const match of response.matches) {
    if (typeof match !== "object" || match === null || !("id" in match) || typeof match.id !== "string" || !match.id) {
      throw new HttpFailure(503, "SEARCH_UNAVAILABLE", true);
    }
    if (seen.has(match.id)) continue;
    const passage = corpus.passages.get(match.id);
    if (!passage || (request.caseId && passage.caseId !== request.caseId)) continue;
    if (request.mimeType && corpus.versions.get(passage.versionId)?.version.mimeType !== request.mimeType) continue;
    seen.add(match.id);
    results.push(passage);
  }
  if (results.length === 0) throw new HttpFailure(503, "SEARCH_INDEX_NOT_READY", true);
  return results;
}
