import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./mobile-release-version.mjs', import.meta.url));

test('normalizes optional version prefixes consistently for config and workflow output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atris-mobile-version-'));
  try {
    await mkdir(path.join(root, 'apps/mobile/src-tauri'), { recursive: true });
    const files = ['apps/mobile/package.json', 'apps/mobile/src-tauri/tauri.conf.json'];
    for (const file of files) await writeFile(path.join(root, file), '{"version":"0.0.0"}');
    for (const input of ['0.1.0', 'v0.1.0', 'V0.1.0']) {
      const output = path.join(root, 'output');
      await writeFile(output, '');
      execFileSync(process.execPath, [script], { cwd: root, env: { ...process.env, MOBILE_VERSION: input, GITHUB_OUTPUT: output } });
      for (const file of files) assert.equal(JSON.parse(await readFile(path.join(root, file), 'utf8')).version, '0.1.0');
      assert.equal(await readFile(output, 'utf8'), 'version=0.1.0\n');
    }
    for (const invalid of ['', 'vv0.1.0', 'v01.1.0', '0.1.0-rc1', 'v0.1.0\nother=value']) {
      assert.throws(() => execFileSync(process.execPath, [script], { cwd: root, env: { ...process.env, MOBILE_VERSION: invalid, GITHUB_OUTPUT: '' }, stdio: 'pipe' }));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
