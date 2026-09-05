import assert from "node:assert/strict";
import test from "node:test";
import { validateReleaseReadiness } from "./release-readiness.mjs";

const valid = {
  expected_sha: "a".repeat(40), workflow_sha: "a".repeat(40),
  packaged_clean_install: true, updater_round_trip: true, production_entitlement: true,
  interactive_visual_keyboard: true, signing_key_decision: "approved-production-key",
  signing_key_fingerprint: "AB:".repeat(31) + "AB",
};

test("accepts a complete exact-SHA release attestation", () => {
  assert.equal(validateReleaseReadiness(valid).signingKeyFingerprint, "AB".repeat(32));
});

test("fails closed for a SHA mismatch and every omitted acceptance", () => {
  assert.throws(() => validateReleaseReadiness({ ...valid, workflow_sha: "b".repeat(40) }), /does not match/);
  for (const key of ["packaged_clean_install", "updater_round_trip", "production_entitlement", "interactive_visual_keyboard"]) {
    assert.throws(() => validateReleaseReadiness({ ...valid, [key]: false }), new RegExp(key));
  }
  assert.throws(() => validateReleaseReadiness({ ...valid, signing_key_decision: "rotate-before-release" }), /approved-production-key/);
  assert.throws(() => validateReleaseReadiness({ ...valid, signing_key_fingerprint: "unknown" }), /SHA-256 fingerprint/);
});
