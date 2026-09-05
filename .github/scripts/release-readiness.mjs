import { fileURLToPath } from "node:url";
import path from "node:path";

const REQUIRED_ACCEPTANCES = [
  "packaged_clean_install",
  "updater_round_trip",
  "production_entitlement",
  "interactive_visual_keyboard",
];

export function validateReleaseReadiness(input) {
  const expectedSha = String(input.expected_sha || "").toLowerCase();
  const workflowSha = String(input.workflow_sha || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error("expected_sha must be an exact 40-character Git commit SHA");
  if (workflowSha !== expectedSha) throw new Error(`workflow SHA ${workflowSha || "<empty>"} does not match expected SHA ${expectedSha}`);

  for (const acceptance of REQUIRED_ACCEPTANCES) {
    if (input[acceptance] !== true && input[acceptance] !== "true") {
      throw new Error(`Required acceptance is not attested: ${acceptance}`);
    }
  }

  if (input.signing_key_decision !== "approved-production-key") {
    throw new Error("signing_key_decision must be approved-production-key");
  }
  const fingerprint = String(input.signing_key_fingerprint || "").trim().toUpperCase().replaceAll(":", "");
  if (!/^[0-9A-F]{64}$/.test(fingerprint)) {
    throw new Error("signing_key_fingerprint must be a SHA-256 fingerprint (64 hexadecimal characters)");
  }
  return { expectedSha, signingKeyFingerprint: fingerprint };
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    const result = validateReleaseReadiness({
      expected_sha: process.env.EXPECTED_SHA,
      workflow_sha: process.env.GITHUB_SHA,
      packaged_clean_install: process.env.ACCEPT_PACKAGED_CLEAN_INSTALL,
      updater_round_trip: process.env.ACCEPT_UPDATER_ROUND_TRIP,
      production_entitlement: process.env.ACCEPT_PRODUCTION_ENTITLEMENT,
      interactive_visual_keyboard: process.env.ACCEPT_INTERACTIVE_VISUAL_KEYBOARD,
      signing_key_decision: process.env.SIGNING_KEY_DECISION,
      signing_key_fingerprint: process.env.SIGNING_KEY_FINGERPRINT,
    });
    console.log(`Release readiness attestations accepted for ${result.expectedSha}; signing key SHA-256 ${result.signingKeyFingerprint}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
