import { fileURLToPath } from "node:url";
import path from "node:path";

export function validateReleaseReadiness(input) {
  const workflowSha = String(input.workflow_sha || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(workflowSha)) throw new Error("workflow_sha must be an exact 40-character Git commit SHA");
  return { workflowSha };
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    const result = validateReleaseReadiness({
      workflow_sha: process.env.WORKFLOW_SHA || process.env.GITHUB_SHA,
    });
    console.log(`Release workflow revision validated: ${result.workflowSha}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
