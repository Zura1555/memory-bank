import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import * as z from 'zod';
import {
  EXPOSED_REQUEST_ORDER, buildExposedCampaign, deriveHGate, gradeCampaign, parseFixedCampaign,
  parseRuntimeProfile, verifyRunCapture, writeImmutableCapture,
} from '../src/server/campaign-protocol.ts';

const candidateId = 'memory-bank-issue32-round2';
const runtimeProfilePath = 'evaluation/issue32-exposed-runtime-profile.json';
const ignoredDirectories = new Set(['.git', '.cloudflare', '.wrangler', '.agents', 'node_modules', '__pycache__', 'dist', 'coverage', 'artifacts', '.local']);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const freezeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  candidate: z.strictObject({
    candidateId: z.string().min(1),
    sourceInventorySha256: hashSchema,
    sourceFileCount: z.number().int().positive(),
    corpusManifestSha256: hashSchema,
    corpusCatalogSha256: hashSchema,
    modelProfileSha256: hashSchema,
  }),
  modelProfilePath: z.literal(runtimeProfilePath),
  modelProfile: z.unknown(),
  campaign: z.unknown(),
  versionedEvidenceInventorySha256: hashSchema,
  exposedKeyProjectionSha256: hashSchema,
  exposedRequestProjectionSha256: hashSchema,
  executionMode: z.literal('offline-prepare-only'),
  sourceFactReview: z.strictObject({
    integrityCheck: z.literal('source-bytes-match-corpus-manifest'),
    independentSourceFactReview: z.literal('source-verified-agent-records-only'),
    reviewer: z.literal('CampaignProtocol (agent)'),
    humanCuratorApproval: z.literal('not-provided'),
  }),
});

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function captureBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function parseOptions(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name.startsWith('--') || !args[index + 1] || args[index + 1].startsWith('--') || options.has(name)) {
      throw new Error('INVALID_COMMAND_OPTIONS');
    }
    options.set(name, args[index + 1]);
    index += 1;
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (!value) throw new Error(`MISSING_OPTION:${name}`);
  return value;
}

function outputPath(repoRoot, requestedPath) {
  const output = resolve(repoRoot, requestedPath);
  const fromRepo = relative(repoRoot, output);
  const fromOutput = relative(output, repoRoot);
  const outputOutsideRepo = fromRepo === '..' || fromRepo.startsWith(`..${sep}`);
  const repoOutsideOutput = fromOutput === '..' || fromOutput.startsWith(`..${sep}`);
  if (!outputOutsideRepo || !repoOutsideOutput) throw new Error('OUTPUT_MUST_BE_OUTSIDE_REPO');
  return output;
}

async function loadJson(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

async function fileTree(root, directory = '', output = []) {
  if (directory === 'evaluation') {
    const candidateConfigs = new Set(['issue32-exposed-g-protocol.json', 'issue32-exposed-runtime-profile.json']);
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (candidateConfigs.has(entry.name) && entry.isFile()) output.push(`${directory}/${entry.name}`);
    }
    return output;
  }
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (ignoredDirectories.has(entry.name) || entry.name.startsWith('.env') || entry.name.startsWith('.dev.vars')) continue;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      await fileTree(root, path, output);
    } else if (entry.isFile()) {
      output.push(path);
    } else {
      throw new Error(`UNSUPPORTED_CANDIDATE_ENTRY:${path}`);
    }
  }
  return output;
}

async function candidateInventory(repoRoot) {
  const paths = (await fileTree(repoRoot)).sort();
  const files = [];
  for (const path of paths) files.push({ path, sha256: digest(await readFile(join(repoRoot, path))) });
  return { files, sha256: digest(captureBytes(files)) };
}

async function versionedEvidenceInventory(repoRoot, campaign) {
  const manifestPath = join(repoRoot, 'corpus/manifest.json');
  const catalogPath = join(repoRoot, 'corpus/catalog.json');
  const manifestBytes = await readFile(manifestPath);
  const catalogBytes = await readFile(catalogPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const catalog = JSON.parse(catalogBytes.toString('utf8'));
  const records = new Map();
  const ensureSource = async (caseId, artifactId, versionId) => {
    const identity = JSON.stringify([caseId, artifactId, versionId]);
    let record = records.get(identity);
    if (record) return record;
    const sourceCases = manifest.cases.filter((item) => item.caseId === caseId);
    const localCases = catalog.cases.filter((item) => item.caseId === caseId);
    if (sourceCases.length !== 1 || localCases.length !== 1) throw new Error(`SOURCE_CASE_NOT_UNIQUE:${caseId}`);
    const artifacts = sourceCases[0].artifacts.filter((item) => item.artifactId === artifactId);
    const localArtifacts = localCases[0].artifacts.filter((item) => item.artifactId === artifactId);
    if (artifacts.length !== 1 || localArtifacts.length !== 1) throw new Error(`SOURCE_ARTIFACT_NOT_UNIQUE:${caseId}/${artifactId}`);
    const versions = artifacts[0].versions.filter((item) => item.versionId === versionId);
    const localVersions = localArtifacts[0].versions.filter((item) => item.versionId === versionId);
    if (versions.length !== 1 || localVersions.length !== 1) throw new Error(`SOURCE_VERSION_NOT_UNIQUE:${versionId}`);
    const version = versions[0];
    const localVersion = localVersions[0];
    const prefix = 'corpus/originals/';
    if (version.extractionStatus !== 'complete' || !localVersion.sourcePath.startsWith(prefix)
      || localVersion.sourcePath.split('/').some((part) => part === '.' || part === '..')) {
      throw new Error(`SOURCE_VERSION_UNAVAILABLE:${versionId}`);
    }
    const relativePath = localVersion.sourcePath.slice(prefix.length);
    if (version.sourcePath !== `corpora/${manifest.corpusVersion}/originals/${relativePath}`) {
      throw new Error(`SOURCE_PATH_MISMATCH:${versionId}`);
    }
    const bytes = await readFile(join(repoRoot, localVersion.sourcePath));
    const sourceSha256 = digest(bytes);
    if (sourceSha256 !== version.sha256) throw new Error(`SOURCE_HASH_MISMATCH:${versionId}`);
    record = {
      caseId, artifactId, versionId, sourcePath: localVersion.sourcePath,
      manifestSourcePath: version.sourcePath, sha256: sourceSha256,
      evidenceRanges: [], selections: [],
      originalLines: bytes.toString('utf8').split(/\r?\n/),
      passages: version.passages,
    };
    records.set(identity, record);
    return record;
  };

  for (const item of campaign.cases) {
    for (const evidence of item.expectedEvidence) {
      const record = await ensureSource(evidence.caseId, evidence.artifactId, evidence.versionId);
      if (evidence.lineStart > evidence.lineEnd || evidence.lineEnd > record.originalLines.length) {
        throw new Error(`EVIDENCE_LINES_OUT_OF_RANGE:${item.requestId}:${evidence.versionId}`);
      }
      record.evidenceRanges.push({
        requestId: item.requestId,
        lineStart: evidence.lineStart,
        lineEnd: evidence.lineEnd,
        sourceExpectation: evidence.sourceExpectation,
        observedLines: record.originalLines.slice(evidence.lineStart - 1, evidence.lineEnd)
          .map((text, index) => ({ line: evidence.lineStart + index, text })),
      });
    }
    for (const selection of item.selections) {
      const record = await ensureSource(selection.caseId, selection.artifactId, selection.versionId);
      const selectedPassages = selection.passageIds.map((passageId) => {
        const matches = record.passages.filter((passage) => passage.passageId === passageId);
        if (matches.length !== 1) throw new Error(`SELECTION_PASSAGE_NOT_IN_VERSION:${item.requestId}:${passageId}`);
        return { passageId, ...matches[0] };
      });
      record.selections.push({ requestId: item.requestId, passages: selectedPassages });
    }
  }

  const sourceFactRecords = (cases) => cases.flatMap((item) => item.records ?? [])
    .filter((record) => record.kind === 'source_fact' && record.reviewStatus === 'source_verified');
  const reviewedRecords = sourceFactRecords(manifest.cases);
  if (!reviewedRecords.length || JSON.stringify(reviewedRecords) !== JSON.stringify(sourceFactRecords(catalog.cases))) {
    throw new Error('SOURCE_REVIEW_RECORDS_MISMATCH');
  }
  const reviewedSourceFacts = [];
  for (const record of reviewedRecords) {
    if (record.sourceVerifier !== 'CampaignProtocol (agent)'
      || record.sourceVerificationMethod !== 'independent_read_only_agent_review' || !Array.isArray(record.evidence)) {
      throw new Error(`UNATTRIBUTED_SOURCE_REVIEW:${record.recordId}`);
    }
    const evidence = [];
    for (const reference of record.evidence) {
      const source = await ensureSource(reference.caseId, reference.artifactId, reference.versionId);
      const passages = source.passages.filter((passage) => passage.passageId === reference.passageId);
      if (passages.length !== 1) throw new Error(`SOURCE_REVIEW_PASSAGE_MISMATCH:${record.recordId}`);
      evidence.push({
        ...reference,
        sourcePath: source.sourcePath,
        sourceSha256: source.sha256,
        passageExcerpt: passages[0].excerpt,
      });
    }
    reviewedSourceFacts.push({ ...record, evidence });
  }
  const sources = [...records.values()].map(({ originalLines, passages, ...record }) => ({ ...record }));
  return {
    corpusVersion: manifest.corpusVersion,
    corpusManifestSha256: digest(manifestBytes),
    corpusCatalogSha256: digest(catalogBytes),
    sources,
    sourceFactReview: {
      integrityCheck: 'source-bytes-match-corpus-manifest',
      independentSourceFactReview: 'source-verified-agent-records-only',
      reviewer: 'CampaignProtocol (agent)',
      scope: 'Only source_verified records are attributed as agent-reviewed; remaining evidence is byte-checked, not semantically reviewed here.',
      reviewedRecords: reviewedSourceFacts,
      humanCuratorApproval: 'not-provided',
    },
  };
}

async function verifiedCapture(path) {
  const bytes = await readFile(path);
  const sha256 = digest(bytes);
  const expectedSidecar = `${sha256}  ${basename(path)}\n`;
  if (await readFile(`${path}.sha256`, 'utf8') !== expectedSidecar) throw new Error(`CAPTURE_HASH_MISMATCH:${basename(path)}`);
  return { value: JSON.parse(bytes.toString('utf8')), sha256 };
}

async function runPrepare(options) {
  const repoRoot = resolve(options.get('--repo') ?? process.cwd());
  const out = outputPath(repoRoot, requiredOption(options, '--out'));
  await mkdir(out, { mode: 0o700 });
  try {
    const protocolPath = resolve(repoRoot, requiredOption(options, '--protocol'));
    const profilePath = resolve(repoRoot, requiredOption(options, '--profile'));
    if (relative(repoRoot, protocolPath) !== 'evaluation/issue32-exposed-g-protocol.json'
      || relative(repoRoot, profilePath) !== runtimeProfilePath) throw new Error('UNEXPECTED_PROTOCOL_OR_PROFILE_PATH');
    const protocol = await loadJson(protocolPath);
    const requests = await loadJson(requiredOption(options, '--requests'));
    const profileBytes = await readFile(profilePath);
    const modelProfile = parseRuntimeProfile(JSON.parse(profileBytes.toString('utf8')));
    const modelProfileSha256 = digest(profileBytes);
    const campaign = buildExposedCampaign(protocol, requests);
    const evidence = await versionedEvidenceInventory(repoRoot, campaign);
    const source = await candidateInventory(repoRoot);
    const campaignProjection = campaign.cases.map(({ requestId, request, selections, expectedEvidence, criteria }) => ({
      requestId, request, selections, expectedEvidence, criteria,
    }));
    const frozen = {
      schemaVersion: 1,
      candidate: {
        candidateId,
        sourceInventorySha256: source.sha256,
        sourceFileCount: source.files.length,
        corpusManifestSha256: evidence.corpusManifestSha256,
        corpusCatalogSha256: evidence.corpusCatalogSha256,
        modelProfileSha256,
      },
      modelProfilePath: runtimeProfilePath,
      modelProfile,
      campaign,
      versionedEvidenceInventorySha256: digest(captureBytes(evidence)),
      exposedKeyProjectionSha256: digest(captureBytes(campaignProjection)),
      exposedRequestProjectionSha256: digest(captureBytes(campaign.cases.map(({ requestId, request }) => ({ requestId, request })))),
      executionMode: 'offline-prepare-only',
      sourceFactReview: {
        integrityCheck: 'source-bytes-match-corpus-manifest',
        independentSourceFactReview: 'source-verified-agent-records-only',
        reviewer: 'CampaignProtocol (agent)',
        humanCuratorApproval: 'not-provided',
      },
    };
    await writeImmutableCapture(out, 'candidate-source-inventory.json', source.files);
    const evidenceSha256 = await writeImmutableCapture(out, 'versioned-evidence-inventory.json', evidence);
    const freezeSha256 = await writeImmutableCapture(out, 'campaign-freeze.json', frozen);
    const hGate = deriveHGate(null, null);
    await writeImmutableCapture(out, 'prepare-result.json', {
      status: 'prepared', requestOrder: campaign.requestOrder, campaignFreezeSha256: freezeSha256,
      sourceInventorySha256: source.sha256, versionedEvidenceInventorySha256: evidenceSha256,
      providerCalls: 0, hGate,
    });
    console.log(JSON.stringify({ prepared: true, requestOrder: campaign.requestOrder, campaignFreezeSha256: freezeSha256, providerCalls: 0, hGate }));
  } catch (error) {
    await writeImmutableCapture(out, 'failure.json', {
      status: 'failed', providerCalls: 0,
      failure: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      hGate: deriveHGate(null, null),
    });
    throw error;
  }
}

async function runGrade(options) {
  const repoRoot = resolve(options.get('--repo') ?? process.cwd());
  const out = outputPath(repoRoot, requiredOption(options, '--out'));
  await mkdir(out, { mode: 0o700 });
  let gradeAttemptSha256 = null;
  try {
    const freezePath = resolve(requiredOption(options, '--freeze'));
    const freeze = await verifiedCapture(freezePath);
    const parsedFreeze = freezeSchema.parse(freeze.value);
    const campaign = parseFixedCampaign(parsedFreeze.campaign);
    const requestProjection = campaign.cases.map(({ requestId, request }) => ({ requestId, request }));
    const rebuiltCampaign = buildExposedCampaign(
      await loadJson(join(repoRoot, 'evaluation/issue32-exposed-g-protocol.json')),
      requestProjection,
    );
    const campaignProjection = campaign.cases.map(({ requestId, request, selections, expectedEvidence, criteria }) => ({
      requestId, request, selections, expectedEvidence, criteria,
    }));
    const campaignMatches = JSON.stringify(rebuiltCampaign) === JSON.stringify(campaign)
      && digest(captureBytes(campaignProjection)) === parsedFreeze.exposedKeyProjectionSha256
      && digest(captureBytes(requestProjection)) === parsedFreeze.exposedRequestProjectionSha256;
    const sourceCapture = await verifiedCapture(join(dirname(freezePath), 'candidate-source-inventory.json'));
    const evidenceCapture = await verifiedCapture(join(dirname(freezePath), 'versioned-evidence-inventory.json'));
    const sourceCaptureMatches = sourceCapture.sha256 === parsedFreeze.candidate.sourceInventorySha256
      && Array.isArray(sourceCapture.value) && sourceCapture.value.length === parsedFreeze.candidate.sourceFileCount;
    const evidenceCaptureMatches = evidenceCapture.sha256 === parsedFreeze.versionedEvidenceInventorySha256;
    const manifestSha256 = digest(await readFile(join(repoRoot, 'corpus/manifest.json')));
    const catalogSha256 = digest(await readFile(join(repoRoot, 'corpus/catalog.json')));
    const profileBytes = await readFile(join(repoRoot, parsedFreeze.modelProfilePath));
    const currentProfile = parseRuntimeProfile(JSON.parse(profileBytes.toString('utf8')));
    const frozenProfile = parseRuntimeProfile(parsedFreeze.modelProfile);
    const modelProfileMatches = digest(profileBytes) === parsedFreeze.candidate.modelProfileSha256
      && JSON.stringify(currentProfile) === JSON.stringify(frozenProfile);
    const currentSource = await candidateInventory(repoRoot);
    const candidateMatches = parsedFreeze.candidate.candidateId === candidateId && campaignMatches
      && sourceCaptureMatches && evidenceCaptureMatches && modelProfileMatches
      && currentSource.sha256 === parsedFreeze.candidate.sourceInventorySha256
      && manifestSha256 === parsedFreeze.candidate.corpusManifestSha256
      && catalogSha256 === parsedFreeze.candidate.corpusCatalogSha256;
    const candidateBinding = {
      candidateId: parsedFreeze.candidate.candidateId,
      sourceInventorySha256: parsedFreeze.candidate.sourceInventorySha256,
      corpusManifestSha256: parsedFreeze.candidate.corpusManifestSha256,
      corpusCatalogSha256: parsedFreeze.candidate.corpusCatalogSha256,
      modelProfileSha256: parsedFreeze.candidate.modelProfileSha256,
      campaignFreezeSha256: freeze.sha256,
    };
    if (!candidateMatches) throw new Error('CANDIDATE_PROVENANCE_MISMATCH');
    gradeAttemptSha256 = await writeImmutableCapture(dirname(freezePath), 'grade-attempt.json', {
      campaignFreezeSha256: freeze.sha256,
      candidateBinding,
      singleAttempt: true,
    });


    const capturesPath = resolve(requiredOption(options, '--captures'));
    const captureNames = EXPOSED_REQUEST_ORDER.map((id) => `${id}-run-capture.json`);
    const expectedNames = captureNames.flatMap((name) => [name, `${name}.sha256`]).sort();
    const actualNames = (await readdir(capturesPath)).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error('RUN_CAPTURE_DIRECTORY_MUST_CONTAIN_EXACT_G2_G3_G4_SET');
    const captures = [];
    for (const name of captureNames) {
      const recordedCapture = await verifiedCapture(join(capturesPath, name));
      captures.push(verifyRunCapture(recordedCapture.value, recordedCapture.sha256, campaign, candidateBinding));
    }
    const gradeCapture = await verifiedCapture(resolve(requiredOption(options, '--grades')));
    const grade = gradeCampaign(campaign, captures, gradeCapture.value, gradeCapture.sha256);
    const result = {
      status: grade.passed ? 'passed' : 'failed',
      campaignFreezeSha256: freeze.sha256,
      gradeAttemptSha256,
      candidate: parsedFreeze.candidate,
      candidateMatches,
      modelProfile: frozenProfile,
      providerCalls: 0,
      failure: grade.passed ? null : 'INDEPENDENT_CRITERION_GRADE_FAILED',
      grade,
    };
    const resultSha256 = await writeImmutableCapture(out, 'grade-result.json', result);
    const passReceipt = {
      requestOrder: campaign.requestOrder,
      passed: grade.passed,
      captureSha256: resultSha256,
      campaignFreezeSha256: freeze.sha256,
      candidateId: parsedFreeze.candidate.candidateId,
      sourceInventorySha256: parsedFreeze.candidate.sourceInventorySha256,
      corpusManifestSha256: parsedFreeze.candidate.corpusManifestSha256,
      corpusCatalogSha256: parsedFreeze.candidate.corpusCatalogSha256,
      modelProfileSha256: parsedFreeze.candidate.modelProfileSha256,
    };
    const hGate = deriveHGate(passReceipt, null);
    await writeImmutableCapture(out, 'grade-summary.json', { passReceipt, hGate, gradeAttemptSha256, providerCalls: 0 });
    console.log(JSON.stringify({ status: result.status, passReceipt, hGate, providerCalls: 0 }));
    if (result.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    await writeImmutableCapture(out, 'failure.json', {
      status: 'failed', gradeAttemptSha256, providerCalls: 0,
      failure: error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) },
      hGate: deriveHGate(null, null),
    });
    throw error;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseOptions(args);
  if (command === 'prepare') return runPrepare(options);
  if (command === 'grade') return runGrade(options);
  throw new Error('COMMAND_MUST_BE_PREPARE_OR_GRADE');
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), providerCalls: 0 }));
  process.exitCode = 1;
});
