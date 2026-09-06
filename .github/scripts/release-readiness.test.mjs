import assert from "node:assert/strict";
import test from "node:test";
import { validateReleaseReadiness } from "./release-readiness.mjs";

const valid = {
  workflow_sha: "a".repeat(40),
};

test("accepts the automatic workflow SHA", () => {
  assert.equal(validateReleaseReadiness(valid).workflowSha, "a".repeat(40));
});

test("fails closed when the automatic workflow SHA is missing or malformed", () => {
  assert.throws(() => validateReleaseReadiness({}), /workflow_sha/);
  assert.throws(() => validateReleaseReadiness({ workflow_sha: "not-a-sha" }), /workflow_sha/);
});
