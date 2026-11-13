import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./configure-mobile-android-signing.mjs', import.meta.url));
const target = 'apps/mobile/src-tauri/gen/android/app/build.gradle.kts';

test('configures release signing without duplicating existing Gradle imports', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atris-android-signing-'));
  try {
    await mkdir(path.dirname(path.join(root, target)), { recursive: true });
    for (const imports of ['', 'import java.util.Properties\n', 'import java.util.Properties\nimport java.io.FileInputStream\n']) {
      for (const release of ['getByName("release")', 'release']) {
        const fixture = `${imports}plugins { id("com.android.application") }\nandroid {\n    buildTypes {\n        ${release} {\n        }\n    }\n}\n`;
        await writeFile(path.join(root, target), fixture);
        execFileSync(process.execPath, [script], { cwd: root });
        const result = await readFile(path.join(root, target), 'utf8');
        assert.equal((result.match(/^import java\.util\.Properties$/gm) || []).length, imports.includes('java.util.Properties') ? 1 : 0);
        assert.equal((result.match(/^import java\.io\.FileInputStream$/gm) || []).length, imports.includes('java.io.FileInputStream') ? 1 : 0);
        assert.match(result, /^import java\.util\.Properties as AtrisSigningProperties$/m);
        assert.match(result, /^import java\.io\.FileInputStream as AtrisSigningFileInputStream$/m);
        assert.match(result, /val properties = AtrisSigningProperties\(\)/);
        assert.match(result, /properties\.load\(AtrisSigningFileInputStream\(rootProject\.file\("keystore\.properties"\)\)\)/);
        assert.equal((result.match(/signingConfig = signingConfigs\.getByName\("release"\)/g) || []).length, 1);
        assert.throws(() => execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' }));
      }
    }
    const invalid = 'android {\n    buildTypes {\n        debug {}\n    }\n}\n';
    await writeFile(path.join(root, target), invalid);
    assert.throws(() => execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' }));
    assert.equal(await readFile(path.join(root, target), 'utf8'), invalid, 'invalid generated projects must not be partially rewritten');
  } finally { await rm(root, { recursive: true, force: true }); }
});
