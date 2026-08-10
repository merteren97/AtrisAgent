import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  UPDATER_ENDPOINT,
  createUpdaterBuildConfig,
  writeUpdaterBuildConfig,
} from './create-updater-build-config.mjs';

test('release updater config contains the bundler and plugin settings Tauri requires', () => {
  const config = createUpdaterBuildConfig('  test-public-key  ');
  assert.deepEqual(config, {
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey: 'test-public-key',
        endpoints: [UPDATER_ENDPOINT],
      },
    },
  });
  assert.equal(JSON.stringify(config).includes('PRIVATE_KEY'), false);
});

test('release updater config fails closed without the public key', () => {
  assert.throws(() => createUpdaterBuildConfig(''), /TAURI_UPDATER_PUBLIC_KEY is required/);
  assert.throws(() => createUpdaterBuildConfig('   '), /TAURI_UPDATER_PUBLIC_KEY is required/);
});

test('release updater config can be written as a valid JSON merge file', () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-updater-config-'));
  try {
    const outputPath = path.join(tempDirectory, 'tauri.release.conf.json');
    writeUpdaterBuildConfig(outputPath, 'test-public-key');
    const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(parsed.bundle.createUpdaterArtifacts, true);
    assert.equal(parsed.plugins.updater.pubkey, 'test-public-key');
    assert.deepEqual(parsed.plugins.updater.endpoints, [UPDATER_ENDPOINT]);
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});
