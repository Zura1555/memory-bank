import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as z from 'zod';
import { MODEL_REQUEST_TIMEOUT_MS, EXPOSED_PHASE_TIMEOUT_MS } from '../src/server/model-deadlines.ts';
import {
  EXPOSED_REQUEST_ORDER, buildExposedCampaign, exposedCreditBasisSchema, exposedCreditPlan, parseFixedCampaign, parseRuntimeProfile,
  selectionsMatch, verifyRunCapture, writeImmutableCapture,
} from '../src/server/campaign-protocol.ts';

const profilePath = 'evaluation/issue32-exposed-runtime-profile.json';
const protocolPath = 'evaluation/issue32-exposed-g-protocol.json';
const candidateId = 'memory-bank-issue32-round2';
const excludedDirectories = new Set(['.git', '.cloudflare', '.wrangler', '.agents', 'node_modules', '__pycache__', 'dist', 'coverage', 'artifacts', '.local']);
const pipelineVersion = 'bounded-repair-v1';

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
  modelProfilePath: z.literal(profilePath),
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
const runnerFreezeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  pipelineVersion: z.literal(pipelineVersion),
  createdAt: z.string().datetime(),
  mode: z.literal('no-paid-prepare'),
  campaignFreezeSha256: hashSchema,
  candidate: z.strictObject({
    candidateId: z.string().min(1),
    sourceInventorySha256: hashSchema,
    corpusManifestSha256: hashSchema,
    corpusCatalogSha256: hashSchema,
    modelProfileSha256: hashSchema,
  }),
  requestOrder: z.array(z.enum(EXPOSED_REQUEST_ORDER)),
  bundleSha256: hashSchema,
  instrumentationSha256: hashSchema,
  observerSha256: hashSchema,
  runnerSha256: hashSchema,
  protocolSha256: hashSchema,
  maxCalls: z.literal(16),
  maxSpendUsd: z.literal(1),
  noAutomaticRetry: z.literal(true),
});
const authorizationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  pipelineVersion: z.literal(pipelineVersion),
  authorizationId: z.string().trim().min(1),
  authorizedBy: z.string().trim().min(1),
  authorizedAt: z.string().datetime(),
  scope: z.enum(['issue32-exposed-g2-g4-single-run', 'issue32-exposed-single-case-diagnostic']),
  runnerFreezeSha256: hashSchema,
  campaignFreezeSha256: hashSchema,
  candidateId: z.string().min(1),
  sourceInventorySha256: hashSchema,
  corpusManifestSha256: hashSchema,
  corpusCatalogSha256: hashSchema,
  modelProfileSha256: hashSchema,
  bundleSha256: hashSchema,
  instrumentationSha256: hashSchema,
  observerSha256: hashSchema,
  runnerSha256: hashSchema,
  protocolSha256: hashSchema,
  requestOrder: z.array(z.enum(EXPOSED_REQUEST_ORDER)),
  approvedMaxCalls: z.union([z.literal(16), z.literal(6), z.literal(4)]),
  approvedMaxUsd: z.union([z.literal(1), z.literal(0.25)]),
  creditBasis: exposedCreditBasisSchema,
  noAutomaticRetry: z.literal(true),
});

export function executionPlan(mode, requestId) {
  if (mode === 'paid' && requestId === undefined) {
    return { pipelineVersion, scope: 'issue32-exposed-g2-g4-single-run', requestOrder: [...EXPOSED_REQUEST_ORDER], approvedMaxCalls: 16, approvedMaxUsd: 1, qualificationEligible: true };
  }
  if (mode !== 'diagnose' || !EXPOSED_REQUEST_ORDER.includes(requestId)) throw new Error('INVALID_DIAGNOSTIC_REQUEST');
  return { pipelineVersion, scope: 'issue32-exposed-single-case-diagnostic', requestOrder: [requestId], approvedMaxCalls: requestId === 'g4' ? 4 : 6, approvedMaxUsd: 0.25, qualificationEligible: false };
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function parseOptions(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name.startsWith('--') || !args[index + 1] || args[index + 1].startsWith('--') || options.has(name)) {
      throw new Error('INVALID_RUNNER_OPTIONS');
    }
    options.set(name, args[index + 1]);
    index += 1;
  }
  return options;
}

function required(options, name) {
  const value = options.get(name);
  if (!value) throw new Error(`MISSING_OPTION:${name}`);
  return value;
}

function ensureOutside(repoRoot, requestedPath) {
  const path = resolve(repoRoot, requestedPath);
  const fromRepo = relative(repoRoot, path);
  const fromOutput = relative(path, repoRoot);
  if (!(fromRepo === '..' || fromRepo.startsWith(`..${sep}`))
    || !(fromOutput === '..' || fromOutput.startsWith(`..${sep}`))) throw new Error('OUTPUT_MUST_BE_OUTSIDE_REPO');
  return path;
}

async function readVerifiedCapture(path) {
  const bytes = await readFile(path);
  const sha256 = digest(bytes);
  if (await readFile(`${path}.sha256`, 'utf8') !== `${sha256}  ${basename(path)}\n`) {
    throw new Error(`CAPTURE_HASH_MISMATCH:${basename(path)}`);
  }
  return { value: JSON.parse(bytes.toString('utf8')), sha256 };
}

async function sourceTree(root, directory = '', files = []) {
  if (directory === 'evaluation') {
    const names = new Set([protocolPath, profilePath].map((path) => path.slice('evaluation/'.length)));
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (names.has(entry.name) && entry.isFile()) files.push(`${directory}/${entry.name}`);
    }
    return files;
  }
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (excludedDirectories.has(entry.name) || entry.name.startsWith('.env') || entry.name.startsWith('.dev.vars')) continue;
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) await sourceTree(root, path, files);
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new Error(`UNSUPPORTED_CANDIDATE_ENTRY:${path}`);
    }
  }
  return files;
}

async function currentSourceInventory(repoRoot) {
  const files = [];
  for (const path of (await sourceTree(repoRoot)).sort()) {
    files.push({ path, sha256: digest(await readFile(join(repoRoot, path))) });
  }
  return { files, sha256: digest(jsonBytes(files)) };
}

function projection(campaign) {
  return campaign.cases.map(({ requestId, request, selections, expectedEvidence, criteria }) => ({
    requestId, request, selections, expectedEvidence, criteria,
  }));
}

async function loadCandidate(repoRoot, freezePath) {
  const freezeCapture = await readVerifiedCapture(freezePath);
  const freeze = freezeSchema.parse(freezeCapture.value);
  if (freeze.candidate.candidateId !== candidateId) throw new Error('UNEXPECTED_CANDIDATE_ID');
  const campaign = parseFixedCampaign(freeze.campaign);
  const requestProjection = campaign.cases.map(({ requestId, request }) => ({ requestId, request }));
  const protocolBytes = await readFile(join(repoRoot, protocolPath));
  const rebuilt = buildExposedCampaign(JSON.parse(protocolBytes.toString('utf8')), requestProjection);
  if (JSON.stringify(rebuilt) !== JSON.stringify(campaign)
    || digest(jsonBytes(projection(campaign))) !== freeze.exposedKeyProjectionSha256
    || digest(jsonBytes(requestProjection)) !== freeze.exposedRequestProjectionSha256) throw new Error('CAMPAIGN_FREEZE_MISMATCH');
  if (JSON.stringify(campaign.requestOrder) !== JSON.stringify(EXPOSED_REQUEST_ORDER)) throw new Error('CAMPAIGN_ORDER_MISMATCH');

  const directory = dirname(freezePath);
  const [sourceCapture, evidenceCapture] = await Promise.all([
    readVerifiedCapture(join(directory, 'candidate-source-inventory.json')),
    readVerifiedCapture(join(directory, 'versioned-evidence-inventory.json')),
  ]);
  const source = await currentSourceInventory(repoRoot);
  const manifestBytes = await readFile(join(repoRoot, 'corpus/manifest.json'));
  const catalogBytes = await readFile(join(repoRoot, 'corpus/catalog.json'));
  const profileBytes = await readFile(join(repoRoot, profilePath));
  const profile = parseRuntimeProfile(JSON.parse(profileBytes.toString('utf8')));
  if (profile.api !== 'chat-completions') throw new Error('UNSUPPORTED_MODEL_API');
  if (sourceCapture.sha256 !== freeze.candidate.sourceInventorySha256
    || sourceCapture.value.length !== freeze.candidate.sourceFileCount
    || JSON.stringify(sourceCapture.value) !== JSON.stringify(source.files)
    || source.sha256 !== freeze.candidate.sourceInventorySha256
    || evidenceCapture.sha256 !== freeze.versionedEvidenceInventorySha256
    || digest(manifestBytes) !== freeze.candidate.corpusManifestSha256
    || digest(catalogBytes) !== freeze.candidate.corpusCatalogSha256
    || digest(profileBytes) !== freeze.candidate.modelProfileSha256
    || JSON.stringify(profile) !== JSON.stringify(parseRuntimeProfile(freeze.modelProfile))) {
    throw new Error('CANDIDATE_PROVENANCE_MISMATCH');
  }
  return {
    freeze,
    campaign,
    campaignFreezeSha256: freezeCapture.sha256,
    protocolSha256: digest(protocolBytes),
    profile,
    binding: {
      candidateId: freeze.candidate.candidateId,
      sourceInventorySha256: freeze.candidate.sourceInventorySha256,
      corpusManifestSha256: freeze.candidate.corpusManifestSha256,
      corpusCatalogSha256: freeze.candidate.corpusCatalogSha256,
      modelProfileSha256: freeze.candidate.modelProfileSha256,
      campaignFreezeSha256: freezeCapture.sha256,
    },
  };
}

async function buildRunnerFreeze(candidate, bundleBytes, instrumentationBytes, observerBytes) {
  return {
    schemaVersion: 1,
    pipelineVersion,
    createdAt: new Date().toISOString(),
    mode: 'no-paid-prepare',
    campaignFreezeSha256: candidate.campaignFreezeSha256,
    candidate: {
      candidateId: candidate.binding.candidateId,
      sourceInventorySha256: candidate.binding.sourceInventorySha256,
      corpusManifestSha256: candidate.binding.corpusManifestSha256,
      corpusCatalogSha256: candidate.binding.corpusCatalogSha256,
      modelProfileSha256: candidate.binding.modelProfileSha256,
    },
    requestOrder: [...EXPOSED_REQUEST_ORDER],
    bundleSha256: digest(bundleBytes),
    instrumentationSha256: digest(instrumentationBytes),
    observerSha256: digest(observerBytes),
    runnerSha256: digest(await readFile(new URL(import.meta.url))),
    protocolSha256: candidate.protocolSha256,
    maxCalls: 16,
    maxSpendUsd: 1,
    noAutomaticRetry: true,
  };
}

async function prepare(options) {
  const repoRoot = resolve(required(options, '--repo'));
  const freezePath = ensureOutside(repoRoot, required(options, '--campaign-freeze'));
  const candidate = await loadCandidate(repoRoot, freezePath);
  const bundlePath = resolve(required(options, '--bundle'));
  if (relative(repoRoot, bundlePath) !== '.cloudflare/output/v0/workers/default/bundle/index.js') {
    throw new Error('UNEXPECTED_WORKER_BUNDLE_PATH');
  }
  const bundleBytes = await readFile(bundlePath);
  const instrumentationBytes = await readFile(resolve(required(options, '--instrumentation')));
  const observerBytes = await readFile(resolve(required(options, '--observer')));
  const runnerFreeze = await buildRunnerFreeze(candidate, bundleBytes, instrumentationBytes, observerBytes);
  const runnerFreezeSha256 = await writeImmutableCapture(dirname(freezePath), 'runner-freeze.json', runnerFreeze);
  console.log(JSON.stringify({ prepared: true, campaignFreezeSha256: candidate.campaignFreezeSha256, runnerFreezeSha256, requestOrder: candidate.campaign.requestOrder, providerCalls: 0 }));
}

async function parseEnvFile(path) {
  const raw = await readFile(path, 'utf8');
  return Object.fromEntries(raw.split('\n').flatMap((line) => {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) return [];
    let value = match[2];
    try { value = JSON.parse(value); } catch {}
    return [[match[1], value]];
  }));
}

async function saveBytes(out, filename, bytes) {
  const content = Buffer.from(bytes);
  const sha256 = digest(content);
  await writeFile(join(out, filename), content, { flag: 'wx', mode: 0o600 });
  await writeFile(join(out, `${filename}.sha256`), `${sha256}  ${filename}\n`, { flag: 'wx', mode: 0o600 });
  return sha256;
}

async function settle(api, pool, operator, jobId, phase) {
  const rows = (await pool.query("SELECT * FROM phase_reservations WHERE job_id=$1 AND phase=$2 AND state='held'", [jobId, phase])).rows;
  for (const row of rows) {
    const attempts = (await pool.query('SELECT state,usage FROM model_attempts WHERE reservation_id=$1', [row.id])).rows;
    if (attempts.length < 1 || attempts.length > 4
      || attempts.some((attempt) => !['complete', 'invalid'].includes(attempt.state)
        || !Number.isFinite(attempt.usage?.reportedCostUsd) || attempt.usage.reportedCostUsd < 0)) return false;
    const actualMicroUsd = Math.ceil(attempts.reduce((total, attempt) => total + attempt.usage.reportedCostUsd, 0) * 1_000_000);
    await api('/api/operator/reconciliations', {
      method: 'POST', headers: operator,
      body: JSON.stringify({ reservationId: row.id, actualMicroUsd, note: 'Issue #32 exposed g2-g4 run: reconcile exact known completed or invalid response usage; preserve unrelated holds.' }),
    });
  }
  return true;
}

export async function readAuthorization(path, candidate, runnerFreezeCapture, runnerFreeze, plan) {
  const capture = await readVerifiedCapture(path);
  const authorization = authorizationSchema.parse(capture.value);
  const candidateAuth = authorization.candidateId === candidate.binding.candidateId
    && authorization.sourceInventorySha256 === candidate.binding.sourceInventorySha256
    && authorization.corpusManifestSha256 === candidate.binding.corpusManifestSha256
    && authorization.corpusCatalogSha256 === candidate.binding.corpusCatalogSha256
    && authorization.modelProfileSha256 === candidate.binding.modelProfileSha256;
  const freezeAuth = authorization.runnerFreezeSha256 === runnerFreezeCapture.sha256
    && authorization.campaignFreezeSha256 === candidate.campaignFreezeSha256
    && authorization.bundleSha256 === runnerFreeze.bundleSha256
    && authorization.instrumentationSha256 === runnerFreeze.instrumentationSha256
    && authorization.observerSha256 === runnerFreeze.observerSha256
    && authorization.runnerSha256 === runnerFreeze.runnerSha256
    && authorization.protocolSha256 === runnerFreeze.protocolSha256
    && runnerFreeze.pipelineVersion === plan.pipelineVersion
    && runnerFreeze.maxCalls === 16;
  const authorizedAt = Date.parse(authorization.authorizedAt);
  const fresh = authorizedAt >= Date.parse(runnerFreeze.createdAt) && authorizedAt <= Date.now()
    && Date.now() - authorizedAt <= 24 * 60 * 60 * 1000;
  if (!candidateAuth || !freezeAuth || !fresh
    || authorization.pipelineVersion !== plan.pipelineVersion
    || authorization.scope !== plan.scope
    || authorization.approvedMaxCalls !== plan.approvedMaxCalls
    || authorization.approvedMaxUsd !== plan.approvedMaxUsd
    || JSON.stringify(authorization.requestOrder) !== JSON.stringify(plan.requestOrder)) {
    throw new Error('FRESH_EXPOSED_AUTHORIZATION_MISMATCH');
  }
  return { authorization, sha256: capture.sha256 };
}
async function runPaid(options) {
  const repoRoot = resolve(required(options, '--repo'));
  const plan = executionPlan(required(options, '--mode'), options.get('--request-id'));
  const out = ensureOutside(repoRoot, required(options, '--out'));
  await mkdir(out, { mode: 0o700 });
  let mf;
  let pool;
  let observer;
  let before;
  let operatorToken;
  let paidAdmission = false;
  let cappedCredit = 0;
  let paidCalls = 0;
  let reportedSpend = 0;
  let stopUpstream = false;
  let campaignAborted = false;
  const events = [];
  const providerRecords = [];
  const summaries = [];
  const runCaptureDirectory = join(out, plan.qualificationEligible ? 'run-captures' : 'diagnostic-captures');
  await mkdir(runCaptureDirectory, { mode: 0o700 });
  try {
    const freezePath = ensureOutside(repoRoot, required(options, '--campaign-freeze'));
    const candidate = await loadCandidate(repoRoot, freezePath);
    const runnerFreezePath = resolve(required(options, '--runner-freeze'));
    if (runnerFreezePath !== join(dirname(freezePath), 'runner-freeze.json')) throw new Error('RUNNER_FREEZE_PATH_MISMATCH');
    const runnerFreezeCapture = await readVerifiedCapture(runnerFreezePath);
    const runnerFreeze = runnerFreezeSchema.parse(runnerFreezeCapture.value);
    const bundlePath = resolve(required(options, '--bundle'));
    const instrumentationPath = resolve(required(options, '--instrumentation'));
    const observerPath = resolve(required(options, '--observer'));
    if (relative(repoRoot, bundlePath) !== '.cloudflare/output/v0/workers/default/bundle/index.js') throw new Error('UNEXPECTED_WORKER_BUNDLE_PATH');
    const bundleBytes = await readFile(bundlePath);
    const instrumentationBytes = await readFile(instrumentationPath);
    const observerBytes = await readFile(observerPath);
    const expectedRunnerFreeze = await buildRunnerFreeze(candidate, bundleBytes, instrumentationBytes, observerBytes);
    const runnerFreezeMatches = runnerFreeze.mode === 'no-paid-prepare'
      && runnerFreeze.pipelineVersion === pipelineVersion
      && runnerFreeze.campaignFreezeSha256 === candidate.campaignFreezeSha256
      && JSON.stringify(runnerFreeze.candidate) === JSON.stringify(expectedRunnerFreeze.candidate)
      && JSON.stringify(runnerFreeze.requestOrder) === JSON.stringify(EXPOSED_REQUEST_ORDER)
      && runnerFreeze.bundleSha256 === expectedRunnerFreeze.bundleSha256
      && runnerFreeze.instrumentationSha256 === expectedRunnerFreeze.instrumentationSha256
      && runnerFreeze.observerSha256 === expectedRunnerFreeze.observerSha256
      && runnerFreeze.runnerSha256 === expectedRunnerFreeze.runnerSha256
      && runnerFreeze.protocolSha256 === candidate.protocolSha256
      && runnerFreeze.maxCalls === 16 && runnerFreeze.maxSpendUsd === 1 && runnerFreeze.noAutomaticRetry;
    if (!runnerFreezeMatches) throw new Error('RUNNER_FREEZE_MISMATCH');
    const authorization = await readAuthorization(required(options, '--authorization'), candidate, runnerFreezeCapture, runnerFreeze, plan);

    const paidAttemptSha256 = await writeImmutableCapture(dirname(freezePath), 'paid-attempt.json', {
      campaignFreezeSha256: candidate.campaignFreezeSha256,
      runnerFreezeSha256: runnerFreezeCapture.sha256,
      authorizationSha256: authorization.sha256,
      authorizationId: authorization.authorization.authorizationId,
      requestOrder: plan.requestOrder,
      qualificationEligible: plan.qualificationEligible,
      singleAttempt: true,
    });
    await writeImmutableCapture(out, 'paid-started.json', {
      campaignFreezeSha256: candidate.campaignFreezeSha256,
      runnerFreezeSha256: runnerFreezeCapture.sha256,
      paidAttemptSha256,
      authorizationId: authorization.authorization.authorizationId,
      approvedMaxCalls: plan.approvedMaxCalls,
      approvedMaxUsd: plan.approvedMaxUsd,
      creditBasis: authorization.authorization.creditBasis,
      requestOrder: plan.requestOrder,
      qualificationEligible: plan.qualificationEligible,
      startedAt: new Date().toISOString(),
      providerCalls: 0,
    });

    const env = await parseEnvFile(resolve(required(options, '--env-file')));
    assert.ok(env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY missing from explicitly selected secret file');
    const databaseUrl = new URL(required(options, '--database-url'));
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname) || databaseUrl.protocol !== 'postgresql:') {
      throw new Error('DATABASE_MUST_BE_LOOPBACK_POSTGRES');
    }
    const postgresContainer = required(options, '--postgres-container');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(postgresContainer)) throw new Error('INVALID_POSTGRES_CONTAINER_NAME');
    const { Miniflare, convertV4MiniflareOptions, Response: MFResponse } = await import(pathToFileURL(join(repoRoot, 'node_modules/miniflare/dist/src/index.js')));
    const pg = (await import(pathToFileURL(join(repoRoot, 'node_modules/pg/lib/index.js')))).default;
    const mono = () => Number(process.hrtime.bigint()) / 1e6;
    operatorToken = randomBytes(32).toString('hex');
    const operator = { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json' };
    pool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 1 });
    const marks = async (request) => {
      if (new URL(request.url).pathname === '/delay') {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        return new MFResponse(null, { status: 204 });
      }
      events.push({ hostMonotonicMs: mono(), ...await request.json() });
      return new MFResponse(null, { status: 204 });
    };
    const outbound = async (request) => {
      const relayEntered = mono();
      if (!paidAdmission || stopUpstream || campaignAborted || paidCalls >= plan.approvedMaxCalls) {
        throw new Error('UNAPPROVED_PROVIDER_DISPATCH');
      }
      const profile = candidate.profile;
      const endpoint = `${profile.origin}/api/v1/chat/completions`;
      assert.equal(request.url, endpoint);
      const requestBody = await request.text();
      const body = JSON.parse(requestBody);
      assert.equal(body.model, profile.model);
      assert.equal(body.service_tier, profile.serviceTier);
      assert.equal(body.stream, profile.stream);
      assert.equal(body.max_tokens, profile.maxTokens);
      assert.deepEqual(body.provider, {
        only: profile.routing.only, order: profile.routing.order,
        allow_fallbacks: profile.routing.allowFallbacks, require_parameters: profile.routing.requireParameters,
      });
      assert.deepEqual(body.reasoning, profile.reasoning);
      const stage = body.response_format.json_schema.name;
      assert.match(stage, /^[a-zA-Z0-9_-]+$/, 'Invalid provider schema stage name');
      const index = ++paidCalls;
      await saveBytes(out, `call-${index}-${stage}-request.json`, requestBody);
      const record = {
        index, stage, relayEntered, requestBytes: Buffer.byteLength(requestBody),
        schemaBytes: Buffer.byteLength(JSON.stringify(body.response_format)), requestStart: mono(),
      };
      providerRecords.push(record);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { Authorization: request.headers.get('Authorization'), 'Content-Type': 'application/json' },
          body: requestBody,
          redirect: 'error',
          signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
        });
        record.headersReceived = mono();
        record.httpStatus = response.status;
        const bytes = new Uint8Array(await response.arrayBuffer());
        record.bodyReceived = mono();
        record.responseBytes = bytes.byteLength;
        await saveBytes(out, `call-${index}-${stage}-response.json`, bytes);
        let envelope;
        try { envelope = JSON.parse(new TextDecoder().decode(bytes)); } catch {}
        record.finishReason = envelope?.choices?.[0]?.finish_reason ?? null;
        record.usage = envelope?.usage ?? null;
        record.generationId = envelope?.id ?? response.headers.get('x-generation-id');
        const cost = envelope?.usage?.cost;
        const costKnown = Number.isFinite(cost) && cost >= 0;
        if (!response.ok || record.finishReason !== 'stop' || !costKnown) stopUpstream = true;
        if (costKnown) {
          reportedSpend += cost;
          assert.ok(reportedSpend <= authorization.authorization.approvedMaxUsd, 'Authorized spend ceiling exceeded');
        }
        if (reportedSpend >= authorization.authorization.approvedMaxUsd) stopUpstream = true;
        const headers = new Headers(response.headers);
        headers.delete('content-encoding');
        headers.delete('content-length');
        record.responseDelivered = mono();
        return new MFResponse(bytes, { status: response.status, headers });
      } catch (error) {
        record.failure = error instanceof Error ? error.name : String(error);
        stopUpstream = true;
        throw error;
      }
    };
    const api = async (path, options = {}) => {
      const response = await mf.dispatchFetch(`http://localhost${path}`, options);
      const data = await response.json();
      if (!response.ok) throw new Error(`HTTP_${response.status}_${data.error?.code ?? data.error ?? 'UNKNOWN'}`);
      return data;
    };
    const budget = async (enabled, credit) => api('/api/operator/budget', {
      method: 'PUT', headers: operator,
      body: JSON.stringify({ availableCreditMicroUsd: credit, admissionEnabled: enabled }),
    });

    const { observePhases } = await import(pathToFileURL(observerPath));
    const wrapper = `import worker,{MemoryBankWorkflow,probeControl,probeContext} from './app.mjs';export {MemoryBankWorkflow};export default {...worker,fetch(request,env,ctx){return probeContext.run({scope:'http'},()=>new URL(request.url).pathname==='/__diagnostic/control'?probeControl().then(result=>Response.json(result)):worker.fetch(request,env,ctx));}};`;
    const built = bundleBytes.toString('utf8');
    const instrumentation = instrumentationBytes.toString('utf8');
    mf = new Miniflare(convertV4MiniflareOptions({
      name: 'memory-bank-issue32-round2-exposed-g2-g4',
      modules: [
        { type: 'ESModule', path: join(out, 'entry.mjs'), contents: wrapper },
        { type: 'ESModule', path: join(out, 'app.mjs'), contents: `${built}\n${instrumentation}` },
      ],
      modulesRoot: out,
      compatibilityDate: '2025-06-01',
      compatibilityFlags: ['nodejs_compat'],
      bindings: {
        APP_ENV: 'development', LOCAL_DATABASE_URL: databaseUrl.toString(),
        MODEL_PROVIDER: candidate.profile.provider, MODEL_NAME: candidate.profile.model,
        MODEL_BASE_URL: `${candidate.profile.origin}/api/v1`, OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
        OPERATOR_TOKEN: operatorToken,
      },
      r2Buckets: ['ORIGINALS'],
      queueProducers: { JOB_QUEUE: 'memory-bank-issue32-round2-exposed-jobs' },
      queueConsumers: { 'memory-bank-issue32-round2-exposed-jobs': { maxBatchSize: 1, maxConcurrency: 1, maxRetries: 3 } },
      workflows: { WORKFLOW: { name: 'memory-bank-issue32-round2-exposed-workflow', className: 'MemoryBankWorkflow' } },
      serviceBindings: { DIAGNOSTIC_MARKS: marks },
      outboundService: outbound,
    }));

    const bucket = await mf.getR2Bucket('ORIGINALS');
    const manifestBytes = await readFile(join(repoRoot, 'corpus/manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const catalog = JSON.parse(await readFile(join(repoRoot, 'corpus/catalog.json'), 'utf8'));
    await bucket.put('corpus/manifest.json', manifestBytes);
    const originals = new Map(catalog.cases.flatMap((item) => item.artifacts.flatMap((artifact) => artifact.versions.map((version) => [version.versionId, version.sourcePath]))));
    for (const item of manifest.cases) for (const artifact of item.artifacts) for (const version of artifact.versions) {
      const bytes = await readFile(join(repoRoot, originals.get(version.versionId)));
      assert.equal(digest(bytes), version.sha256, `Original drift: ${version.versionId}`);
      await bucket.put(version.sourcePath, bytes);
    }
    assert.equal((await api('/api/health')).status, 'ok');
    assert.deepEqual(await api('/api/model-info'), { provider: candidate.profile.provider, model: candidate.profile.model, endpoint: candidate.profile.origin });
    const control = await api('/__diagnostic/control');
    assert.equal(control.cases, 8);
    assert.equal(control.originals, 24);
    const controlDuration = (name) => {
      const begin = events.find((event) => event.name === name && event.event === 'begin');
      const end = events.find((event) => event.spanId === begin.spanId && event.event === 'end');
      return end.hostMonotonicMs - begin.hostMonotonicMs;
    };
    assert.ok(controlDuration('delayed-control') >= 90, 'Instrumentation did not observe the delayed control');
    assert.ok(controlDuration('empty-control') < controlDuration('delayed-control'));
    await writeImmutableCapture(out, 'control-proof.json', {
      ...control, emptyControlMs: controlDuration('empty-control'), delayedControlMs: controlDuration('delayed-control'), providerCalls: paidCalls,
    });
    before = await api('/api/operator/status', { headers: operator });
    assert.equal(before.activeAttemptId, null);
    assert.equal(before.pendingJobs.length, 0);
    assert.equal(before.campaign.admissionEnabled, false);
    await writeImmutableCapture(out, 'initial-status.json', before);

    const backup = execFileSync('docker', [
      'exec', postgresContainer, 'pg_dump', '-U', 'memory_bank', '-d', 'memory_bank', '-Fc',
    ], { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
    await saveBytes(out, 'before-paid-campaign.dump', backup);
    const creditResponse = await fetch(`${candidate.profile.origin}/api/v1/credits`, {
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(15_000),
    });
    assert.equal(creditResponse.status, 200);
    const credit = (await creditResponse.json()).data;
    const remainingMicroUsd = Math.floor((credit.total_credits - credit.total_usage) * 1_000_000);
    const creditPlan = exposedCreditPlan(remainingMicroUsd, before.campaign, authorization.authorization.creditBasis);
    cappedCredit = creditPlan.cappedCreditMicroUsd;
    await writeImmutableCapture(out, 'credit-preflight.json', {
      remainingMicroUsd, oldHeldMicroUsd: before.campaign.heldMicroUsd,
      ...creditPlan, purchase: false, holdsReleased: false,
    });

    const getJob = async (receipt) => api(`/api/jobs/${receipt.jobId}`, { headers: { Authorization: `Bearer ${receipt.capability}` } });
    const wait = async (receipt, phase, stageResponses) => {
      const start = mono();
      while (mono() - start < EXPOSED_PHASE_TIMEOUT_MS) {
        const result = await getJob(receipt);
        stageResponses[phase] = result;
        if (['ready', 'failed', 'reconciliation_required'].includes(result[`${phase}State`])) return result;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
      }
      throw new Error(`${phase.toUpperCase()}_WORKFLOW_TIMEOUT`);
    };
    const persistRunCapture = async (caseInput, receipt, stageResponses, error) => {
      let stored = null;
      if (receipt?.jobId) {
        stored = (await pool.query(
          'SELECT assessment_state,brief_state,assessment_result,brief_result,brief_selections FROM jobs WHERE id=$1',
          [receipt.jobId],
        )).rows[0] ?? null;
      }
      if (error) await writeImmutableCapture(out, `${caseInput.requestId}-run-error.json`, { error, providerCalls: paidCalls });
      if (!stored) throw new Error(`PERSISTED_JOB_RECORD_MISSING:${caseInput.requestId}`);
      const actualSelections = Array.isArray(stored.brief_selections) ? stored.brief_selections : [];
      const assessmentResponse = stageResponses.assessment ?? null;
      const briefResponse = stageResponses.brief ?? null;
      if ((assessmentResponse?.assessmentState === 'ready') !== (stored.assessment_state === 'ready')) {
        throw new Error(`SERVED_ASSESSMENT_STATE_MISMATCH:${caseInput.requestId}`);
      }
      if (briefResponse && briefResponse.briefState !== stored.brief_state) {
        throw new Error(`SERVED_BRIEF_STATE_MISMATCH:${caseInput.requestId}`);
      }
      const assessmentState = assessmentResponse?.assessmentState === 'ready' ? 'ready' : 'failed';
      const assessmentResult = assessmentState === 'ready' ? assessmentResponse : null;
      let briefState = 'not_started';
      let briefResult = null;
      if (caseInput.requestId !== 'g4') {
        const actualBriefState = briefResponse?.briefState ?? stored.brief_state ?? 'not_started';
        briefState = actualBriefState === 'not_started' ? 'not_started'
          : actualBriefState === 'ready' && briefResponse !== null ? 'ready' : 'failed';
        briefResult = briefState === 'ready' ? briefResponse : null;
      }
      const selections = caseInput.requestId === 'g4' ? [] : actualSelections;
      const capture = {
        schemaVersion: 1,
        requestId: caseInput.requestId,
        campaignFreezeSha256: candidate.campaignFreezeSha256,
        candidateId: candidate.binding.candidateId,
        sourceInventorySha256: candidate.binding.sourceInventorySha256,
        corpusManifestSha256: candidate.binding.corpusManifestSha256,
        corpusCatalogSha256: candidate.binding.corpusCatalogSha256,
        modelProfileSha256: candidate.binding.modelProfileSha256,
        assessmentState,
        assessmentResult,
        briefState,
        briefResult,
        selectionSource: caseInput.requestId === 'g4' ? 'no-brief-submitted' : 'persisted-job-record',
        selections,
      };
      if (caseInput.requestId === 'g4' && stored.brief_selections) throw new Error('G4_UNEXPECTED_PERSISTED_SELECTIONS');
      const capturedValue = plan.qualificationEligible ? capture : { diagnosticOnly: true, capture };
      const captureName = `${caseInput.requestId}-${plan.qualificationEligible ? 'run' : 'diagnostic'}-capture.json`;
      const runCaptureSha256 = await writeImmutableCapture(runCaptureDirectory, captureName, capturedValue);
      const verified = verifyRunCapture(capture, runCaptureSha256, candidate.campaign, candidate.binding);
      return { capture, verified, selectionCheck: selectionsMatch(caseInput.selections, selections) };
    };

    for (const caseInput of candidate.campaign.cases.filter((item) => plan.requestOrder.includes(item.requestId))) {
      const summary = { requestId: caseInput.requestId, error: null, providerCallsBefore: paidCalls };
      const stageResponses = {};
      let receipt = null;
      let caseError = null;
      if (campaignAborted || stopUpstream) {
        caseError = 'CAMPAIGN_STOPPED_AFTER_PRIOR_FAILURE_OR_UNCERTAIN_DISPATCH';
        campaignAborted = true;
      } else {
        try {
          observer = await observePhases(pool, caseInput.request);
          await budget(true, cappedCredit);
          paidAdmission = true;
          receipt = await api('/api/jobs', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ request: caseInput.request }),
          });
          await writeImmutableCapture(out, `${caseInput.requestId}-receipt.json`, receipt);
          await budget(false, cappedCredit);
          const assessment = await wait(receipt, 'assessment', stageResponses);
          await writeImmutableCapture(out, `${caseInput.requestId}-assessment.json`, assessment);
          if (assessment.assessmentState === 'reconciliation_required') {
            throw new Error('ASSESSMENT_RECONCILIATION_REQUIRED');
          }
          if (!await settle(api, pool, operator, receipt.jobId, 'assessment')) throw new Error('ASSESSMENT_USAGE_UNKNOWN');
          paidAdmission = false;
          if (assessment.assessmentState !== 'ready') throw new Error(`ASSESSMENT_${assessment.assessmentState.toUpperCase()}`);

          if (caseInput.requestId !== 'g4') {
            if (caseInput.selections.length === 0) throw new Error(`FIXED_SELECTIONS_MISSING:${caseInput.requestId}`);
            const selections = caseInput.selections;
            await writeImmutableCapture(out, `${caseInput.requestId}-frozen-selections.json`, selections);
            await budget(true, cappedCredit);
            paidAdmission = true;
            await api(`/api/jobs/${receipt.jobId}/brief`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${receipt.capability}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ selections }),
            });
            await budget(false, cappedCredit);
            const brief = await wait(receipt, 'brief', stageResponses);
            await writeImmutableCapture(out, `${caseInput.requestId}-brief-result.json`, brief);
            if (brief.briefState === 'reconciliation_required') throw new Error('BRIEF_RECONCILIATION_REQUIRED');
            if (!await settle(api, pool, operator, receipt.jobId, 'brief')) throw new Error('BRIEF_USAGE_UNKNOWN');
            paidAdmission = false;
            const auth = { Authorization: `Bearer ${receipt.capability}` };
            for (const format of ['json', 'markdown']) {
              const response = await mf.dispatchFetch(`http://localhost/api/jobs/${receipt.jobId}/pack/${format}`, { headers: auth });
              assert.equal(response.status, 200);
              const bytes = Buffer.from(await response.arrayBuffer());
              assert.ok(!bytes.toString('utf8').includes(receipt.capability));
              await saveBytes(out, `${caseInput.requestId}-pack.${format === 'json' ? 'json' : 'md'}`, bytes);
            }
          } else {
            if (caseInput.selections.length !== 0) throw new Error('G4_FIXED_SELECTIONS_MUST_BE_EMPTY');
          }
        } catch (error) {
          caseError = error instanceof Error ? error.message : String(error);
          campaignAborted = true;
          stopUpstream = stopUpstream || /UNCERTAIN|RECONCILIATION|TIMEOUT|DISPATCH|NETWORK|HTTP_5/.test(caseError);
        }
      }

      try {
        if (observer) {
          const observations = await observer.stop();
          observer = null;
          await writeImmutableCapture(out, `${caseInput.requestId}-direct-db-observations.json`, observations);
          summary.bounds = observations.bounds;
          summary.observerError = observations.error;
        }
        if (receipt?.jobId) {
          const attempts = (await pool.query('SELECT * FROM model_attempts WHERE job_id=$1 ORDER BY phase,call_index', [receipt.jobId])).rows;
          await writeImmutableCapture(out, `${caseInput.requestId}-attempts.json`, attempts);
          summary.providerCalls = attempts.length;
          summary.reportedUsageUsd = attempts.length > 0
            && attempts.every((attempt) => Number.isFinite(attempt.usage?.reportedCostUsd) && attempt.usage.reportedCostUsd >= 0)
            ? attempts.reduce((total, attempt) => total + attempt.usage.reportedCostUsd, 0)
            : null;
          const stored = (await pool.query('SELECT * FROM jobs WHERE id=$1', [receipt.jobId])).rows[0];
          await writeImmutableCapture(out, `${caseInput.requestId}-stored-job.json`, stored);
        }
        const captured = await persistRunCapture(caseInput, receipt, stageResponses, caseError);
        summary.runCaptureSha256 = captured.verified.captureSha256;
        summary.assessmentState = captured.verified.assessmentState;
        summary.briefState = captured.verified.briefState;
        summary.selectionCheck = captured.selectionCheck;
        if (!captured.selectionCheck) {
          caseError = caseError ?? `PERSISTED_SELECTION_IDENTITY_MISMATCH:${caseInput.requestId}`;
          campaignAborted = true;
        }
      } catch (captureError) {
        campaignAborted = true;
        caseError = `${caseError ? `${caseError};` : ''}${captureError instanceof Error ? captureError.message : String(captureError)}`;
        await writeImmutableCapture(out, `${caseInput.requestId}-capture-error.json`, { error: caseError, providerCalls: paidCalls });
      }
      summary.error = caseError;
      summary.providerCallsAfter = paidCalls;
      summaries.push(summary);
      console.log(JSON.stringify(summary));
    }

    let originalCount = 0;
    for (const item of manifest.cases) for (const artifact of item.artifacts) for (const version of artifact.versions) {
      const response = await mf.dispatchFetch(`http://localhost/api/evidence/originals/${encodeURIComponent(version.versionId)}`);
      assert.equal(response.status, 200);
      assert.equal(digest(new Uint8Array(await response.arrayBuffer())), version.sha256);
      originalCount += 1;
    }
    assert.equal(originalCount, 24);
    const afterBackup = execFileSync('docker', [
      'exec', postgresContainer, 'pg_dump', '-U', 'memory_bank', '-d', 'memory_bank', '-Fc',
    ], { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
    await saveBytes(out, 'after-campaign.dump', afterBackup);
    await writeImmutableCapture(out, 'integrity-proof.json', {
      exactOriginals: originalCount, campaignCalls: paidCalls, reportedUsageUsd: reportedSpend,
      campaignFreezeSha256: candidate.campaignFreezeSha256,
      sourceInventorySha256: candidate.binding.sourceInventorySha256,
      requestOrder: plan.requestOrder, qualificationEligible: plan.qualificationEligible, summaries,
    });
    if (campaignAborted) process.exitCode = 1;
  } catch (error) {
    campaignAborted = true;
    await writeImmutableCapture(out, 'campaign-stop.json', {
      error: error instanceof Error ? error.message : String(error), campaignCalls: paidCalls,
      reportedUsageUsd: reportedSpend, automaticRetry: false, providerCalls: paidCalls,
    });
    console.error(JSON.stringify({ stopped: true, error: error instanceof Error ? error.message : String(error), campaignCalls: paidCalls, reportedUsageUsd: reportedSpend }));
    process.exitCode = 1;
  } finally {
    if (observer) {
      try { await writeImmutableCapture(out, 'stopped-phase-observations.json', await observer.stop()); } catch { process.exitCode = 1; }
    }
    if (mf && before) {
      try {
        const response = await mf.dispatchFetch('http://localhost/api/operator/budget', {
          method: 'PUT',
          headers: { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ availableCreditMicroUsd: before.campaign.availableCreditMicroUsd, admissionEnabled: false }),
        });
        if (!response.ok) throw new Error('ADMISSION_SHUTDOWN_FAILED');
        const statusResponse = await mf.dispatchFetch('http://localhost/api/operator/status', { headers: { Authorization: `Bearer ${operatorToken}` } });
        await writeImmutableCapture(out, 'final-status.json', await statusResponse.json());
      } catch (error) {
        console.error(`Admission shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    }
    try { await writeImmutableCapture(out, 'campaign-summary.json', summaries); } catch { process.exitCode = 1; }
    try { await writeImmutableCapture(out, 'events.json', events); } catch { process.exitCode = 1; }
    try { await writeImmutableCapture(out, 'provider-boundaries.json', providerRecords); } catch { process.exitCode = 1; }
    if (mf) { try { await mf.dispose(); } catch { process.exitCode = 1; } }
    if (pool) { try { await pool.end(); } catch { process.exitCode = 1; } }
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const mode = required(options, '--mode');
  const supported = new Set(mode === 'prepare'
    ? ['--mode', '--repo', '--campaign-freeze', '--bundle', '--instrumentation', '--observer']
    : ['--mode', '--repo', '--out', '--campaign-freeze', '--runner-freeze', '--authorization', '--bundle', '--instrumentation', '--observer', '--env-file', '--database-url', '--postgres-container', ...(mode === 'diagnose' ? ['--request-id'] : [])]);
  if ([...options.keys()].some((name) => !supported.has(name))) throw new Error('UNSUPPORTED_RUNNER_OPTION');
  if (mode === 'prepare') return prepare(options);
  if (mode === 'paid' || mode === 'diagnose') return runPaid(options);
  throw new Error('MODE_MUST_BE_PREPARE_PAID_OR_DIAGNOSE');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), providerCalls: 0 }));
    process.exitCode = 1;
  });
}
