import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import manifest from "../corpus/manifest.json" with { type: "json" };

const origin = "https://memory-bank.zura-tran.workers.dev";
assert.ok(process.env.OPERATOR_TOKEN, "Set the production OPERATOR_TOKEN");
const operatorHeaders = {
    Authorization: `Bearer ${process.env.OPERATOR_TOKEN}`,
};
const request = (path, options = {}) =>
    fetch(`${origin}${path}`, {
        ...options,
        signal: AbortSignal.timeout(30_000),
    }).catch((cause) => {
        throw new Error(`Production request failed: ${path}`, { cause });
    });

const health = await request("/api/health");
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { status: "ok" });
const home = await request("/");
assert.equal(home.status, 200);
assert.match(await home.text(), /<title>Memory Bank — Work brief<\/title>/u);
assert.equal((await request("/api/operator/status")).status, 404);

const status = await request("/api/operator/status", {
    headers: operatorHeaders,
});
assert.equal(status.status, 200);
const before = await status.json();
assert.equal(
    before.campaign.admissionEnabled,
    false,
    "Smoke only runs with paid admission closed",
);
assert.equal(before.campaign.heldMicroUsd, 0);
assert.equal(before.activeAttemptId, null);
assert.deepEqual(before.pendingJobs, []);

let originals = 0;
for (const item of manifest.cases) {
    for (const artifact of item.artifacts) {
        for (const version of artifact.versions) {
            if (version.extractionStatus !== "complete") continue;
            const response = await request(
                `/api/evidence/originals/${version.versionId}`,
            );
            assert.equal(response.status, 200, version.sourcePath);
            const hash = createHash("sha256")
                .update(Buffer.from(await response.arrayBuffer()))
                .digest("hex");
            assert.equal(hash, version.sha256, version.sourcePath);
            originals++;
        }
    }
}

const denied = await request("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        request:
            "Check whether Cedar's batch-import mapping can support a fictional client onboarding.",
    }),
});
assert.equal(denied.status, 503);
assert.equal((await denied.json()).error.code, "ADMISSION_NOT_ENABLED");
const afterResponse = await request("/api/operator/status", {
    headers: operatorHeaders,
});
assert.equal(afterResponse.status, 200);
assert.deepEqual(
    await afterResponse.json(),
    before,
    "Denied admission must not create work or change accounting",
);
console.log(
    `Production smoke passed: health, assets, operator protection, ${originals} exact originals, closed paid admission, unchanged ledger.`,
);
