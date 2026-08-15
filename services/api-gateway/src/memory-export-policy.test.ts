import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSafeMemoryExportPath, writeNewMemoryExport } from './memory-export-policy';

async function runTests() {
  let passed = 0;
  let failed = 0;
  const assert = (condition: boolean, message: string) => {
    if (condition) {
      passed += 1;
      console.log(`[PASS] ${message}`);
    } else {
      failed += 1;
      console.error(`[FAIL] ${message}`);
    }
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-memory-export-'));
  try {
    const safePath = path.join(root, 'project-atris-memory.json');
    assert(resolveSafeMemoryExportPath(safePath) === path.resolve(safePath), 'accepts a new absolute AtrisAgent memory backup path');

    let arbitraryNameError = '';
    try { resolveSafeMemoryExportPath(path.join(root, 'package.json')); }
    catch (error) { arbitraryNameError = error instanceof Error ? error.message : String(error); }
    assert(arbitraryNameError.includes('-atris-memory.json'), 'rejects arbitrary JSON configuration filenames');

    let relativeError = '';
    try { resolveSafeMemoryExportPath('relative-atris-memory.json'); }
    catch (error) { relativeError = error instanceof Error ? error.message : String(error); }
    assert(relativeError.includes('absolute export path'), 'rejects relative export paths');

    writeNewMemoryExport(safePath, '{"safe":true}');
    assert(fs.readFileSync(safePath, 'utf8') === '{"safe":true}', 'writes a new backup file');

    let preflightOverwriteError = '';
    try { resolveSafeMemoryExportPath(safePath); }
    catch (error) { preflightOverwriteError = error instanceof Error ? error.message : String(error); }
    assert(preflightOverwriteError.includes('never overwrites'), 'preflight rejects an existing backup file');

    let atomicOverwriteBlocked = false;
    try { writeNewMemoryExport(safePath, '{"overwritten":true}'); }
    catch (error: any) { atomicOverwriteBlocked = error?.code === 'EEXIST'; }
    assert(atomicOverwriteBlocked, 'atomic wx write rejects overwrite even if a race bypasses preflight');
    assert(fs.readFileSync(safePath, 'utf8') === '{"safe":true}', 'failed overwrite leaves the existing file unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`Memory export policy tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
