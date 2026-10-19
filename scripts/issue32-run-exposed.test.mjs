import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executionPlan, readAuthorization } from './issue32-run-exposed.mjs';
import { verifyRunCapture, writeImmutableCapture } from '../src/server/campaign-protocol.ts';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const binding = {
  candidateId: 'diagnostic-regression', sourceInventorySha256: hash('source'),
  corpusManifestSha256: hash('manifest'), corpusCatalogSha256: hash('catalog'),
  modelProfileSha256: hash('profile'), campaignFreezeSha256: hash('campaign'),
};
const runner = {
  createdAt: new Date(Date.now() - 1000).toISOString(),
  pipelineVersion: 'bounded-repair-v1', maxCalls: 16, maxSpendUsd: 1, noAutomaticRetry: true,
  bundleSha256: hash('bundle'), instrumentationSha256: hash('instrumentation'),
  observerSha256: hash('observer'), runnerSha256: hash('runner'), protocolSha256: hash('protocol'),
};
const runnerCapture = { sha256: hash('runner-freeze') };
function authorization(plan) {
  return {
    schemaVersion: 1, pipelineVersion: plan.pipelineVersion,
    authorizationId: 'explicit-offline-regression', authorizedBy: 'offline-test',
    authorizedAt: new Date().toISOString(), scope: plan.scope, ...binding,
    runnerFreezeSha256: runnerCapture.sha256,
    bundleSha256: runner.bundleSha256,
    instrumentationSha256: runner.instrumentationSha256,
    observerSha256: runner.observerSha256,
    runnerSha256: runner.runnerSha256,
    protocolSha256: runner.protocolSha256,
    requestOrder: plan.requestOrder, approvedMaxCalls: plan.approvedMaxCalls,
    approvedMaxUsd: plan.approvedMaxUsd, creditBasis: 'owner-accepted-hold-overlap', noAutomaticRetry: true,
  };
}

test('bounded-repair plans require exact versioned call and spend ceilings', () => {
  for (const [plan, calls, spend] of [
    [executionPlan('diagnose', 'g2'), 6, 0.25],
    [executionPlan('diagnose', 'g3'), 6, 0.25],
    [executionPlan('diagnose', 'g4'), 4, 0.25],
    [executionPlan('paid'), 16, 1],
  ]) {
    assert.equal(plan.pipelineVersion, 'bounded-repair-v1');
    assert.equal(plan.approvedMaxCalls, calls);
    assert.equal(plan.approvedMaxUsd, spend);
  }
});

test('single-case approval cannot authorize another case, a full campaign, or larger call/spend limits', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(runner.createdAt) + 1000 });
  const directory = await mkdtemp(join(tmpdir(), 'issue32-diagnostic-authorization-'));
  let index = 0;
  const check = async (value, plan) => {
    const name = `authorization-${index++}.json`;
    await writeImmutableCapture(directory, name, value);
    return readAuthorization(join(directory, name), { binding, campaignFreezeSha256: binding.campaignFreezeSha256 }, runnerCapture, runner, plan);
  };
  try {
    const g2 = executionPlan('diagnose', 'g2');
    const g3 = executionPlan('diagnose', 'g3');
    const g4 = executionPlan('diagnose', 'g4');
    const campaign = executionPlan('paid');
    await check(authorization(g2), g2);
    await check(authorization(g3), g3);
    await check(authorization(g4), g4);
    await check(authorization(campaign), campaign);
    for (const plan of [g2, g3, g4, campaign]) {
      const unversioned = authorization(plan);
      delete unversioned.pipelineVersion;
      await assert.rejects(check(unversioned, plan));
    }
    for (const [plan, legacyCalls] of [[g2, 4], [g3, 4], [g4, 2], [campaign, 12]]) {
      await assert.rejects(check({ ...authorization(plan), approvedMaxCalls: legacyCalls }, plan));
    }
    await assert.rejects(check({ ...authorization(g3), pipelineVersion: 'legacy-v1' }, g3));
    for (const [value, plan] of [
      [authorization(g3), g4], [authorization(g4), g3], [authorization(g3), campaign],
      [authorization(campaign), g3], [{ ...authorization(g3), requestOrder: ['g3', 'g4'] }, g3],
      [{ ...authorization(g4), approvedMaxCalls: 6 }, g4],
      [{ ...authorization(g3), approvedMaxUsd: 1 }, g3],
      [{ ...authorization(g3), sourceInventorySha256: hash('changed-source') }, g3],
      [{ ...authorization(g3), authorizedAt: new Date(Date.now() - 86400001).toISOString() }, g3],
      [{ ...authorization(g3), authorizedAt: new Date(Date.now() + 1).toISOString() }, g3],
      [{ ...authorization(g3), authorizedAt: new Date(Date.parse(runner.createdAt) - 1).toISOString() }, g3],
    ]) await assert.rejects(check(value, plan), /FRESH_EXPOSED_AUTHORIZATION_MISMATCH/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('diagnostic selection excludes held-out and mixed-mode requests before any dispatch', () => {
  for (const [mode, requestId] of [['diagnose', 'h1'], ['diagnose', undefined], ['diagnose', 'g3,g4'], ['paid', 'g3'], ['unexpected', 'g3']]) {
    assert.throws(() => executionPlan(mode, requestId), /INVALID_DIAGNOSTIC_REQUEST/);
  }
});

test('diagnostic envelopes are not qualifying canonical run captures', () => {
  const capture = {
    schemaVersion: 1, requestId: 'g3', ...binding,
    assessmentState: 'failed', assessmentResult: null, briefState: 'not_started', briefResult: null,
    selectionSource: 'persisted-job-record', selections: [],
  };
  const campaign = { requestOrder: ['g2', 'g3', 'g4'] };
  verifyRunCapture(capture, hash('raw-capture'), campaign, binding);
  assert.throws(() => verifyRunCapture({ diagnosticOnly: true, capture }, hash('diagnostic-capture'), campaign, binding));
});
