import assert from "node:assert/strict";
import test from "node:test";
import { localJobsKey, readLocalJobs, reopenedJobMode, writeLocalJobs, type LocalJob } from "./local-jobs.ts";

test("bookmarks reopen only the original live job and lose all retained access at its expiry", () => {
  const now = Date.parse("2026-10-17T12:00:00.000Z");
  const deadline = now + 7 * 24 * 60 * 60 * 1000;
  const entry: LocalJob = {
    jobId: "00000000-0000-4000-8000-000000000001", capability: "a".repeat(43),
    label: "Checked fictional request", expiresAt: new Date(deadline).toISOString(), saved: true,
  };
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  // Even unexpected extra data is not copied into browser persistence.
  const withResults = { ...entry, request: "private full request", assessment: { claims: [] } };
  writeLocalJobs(storage, [withResults, { ...entry, saved: false }], now);
  assert.deepEqual(JSON.parse(data.get(localJobsKey)!), [entry]);
  const restored = readLocalJobs(storage, deadline - 1).entries[0];
  const job = { jobId: entry.jobId, expiresAt: entry.expiresAt, assessmentState: "ready" as const, briefState: "not_started" as const };
  assert.equal(reopenedJobMode(restored, job, deadline - 1), "assessment");
  assert.equal(reopenedJobMode(restored, { ...job, briefState: "running" }, deadline - 1), "brief");
  assert.throws(() => reopenedJobMode(restored, { ...job, jobId: "another-job" }, now));
  assert.throws(() => reopenedJobMode(restored, { ...job, expiresAt: new Date(deadline + 1).toISOString() }, now));
  assert.throws(() => reopenedJobMode(restored, job, deadline));
  assert.deepEqual(readLocalJobs(storage, deadline).entries, []);
  assert.equal(data.has(localJobsKey), false);
  storage.setItem(localJobsKey, JSON.stringify([{ ...entry, expiresAt: "invalid" }]));
  assert.match(readLocalJobs(storage, now).error!, /Malformed/);
  assert.equal(data.has(localJobsKey), false);
  const fullStorage = { ...storage, setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.throws(() => writeLocalJobs(fullStorage, [entry], now), /QuotaExceededError/);
  assert.equal(data.has(localJobsKey), false);
});
