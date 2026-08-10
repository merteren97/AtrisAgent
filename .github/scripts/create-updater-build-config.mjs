import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPDATER_ENDPOINT = 'https://github.com/merteren97/AtrisAgent/releases/latest/download/latest.json';

export function createUpdaterBuildConfig(publicKey) {
  const normalizedPublicKey = typeof publicKey === 'string' ? publicKey.trim() : '';
  if (!normalizedPublicKey) {
    throw new Error('TAURI_UPDATER_PUBLIC_KEY is required to generate the release updater configuration.');
  }

  return {
    bundle: {
      createUpdaterArtifacts: true,
    },
    plugins: {
      updater: {
        pubkey: normalizedPublicKey,
        endpoints: [UPDATER_ENDPOINT],
      },
    },
  };
}

export function writeUpdaterBuildConfig(outputPath, publicKey = process.env.TAURI_UPDATER_PUBLIC_KEY) {
  if (!outputPath) throw new Error('An updater build config output path is required.');
  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(
    resolvedOutput,
    `${JSON.stringify(createUpdaterBuildConfig(publicKey), null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return resolvedOutput;
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedFile === currentFile) {
  try {
    const outputPath = process.argv[2];
    const writtenPath = writeUpdaterBuildConfig(outputPath);
    // Do not print the generated config: it contains the updater public key and
    // GitHub may intentionally mask that value in workflow output.
    console.log(`Generated release-only Tauri updater configuration at ${writtenPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
