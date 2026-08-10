import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateUpdaterManifest } from './generate-updater-manifest.mjs';

function writeArtifact(directory, name, signature) {
  const artifact = path.join(directory, name);
  fs.writeFileSync(artifact, 'package-bytes');
  fs.writeFileSync(`${artifact}.sig`, signature);
}

test('stable updater manifest maps every supported desktop bundle to a signed GitHub asset', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-updater-manifest-'));
  try {
    writeArtifact(directory, 'AtrisAgent_0.3.0_x64-setup.exe', 'nsis-signature');
    writeArtifact(directory, 'AtrisAgent_0.3.0_x64_en-US.msi', 'msi-signature');
    writeArtifact(directory, 'AtrisAgent_0.3.0_amd64.AppImage', 'appimage-signature');
    writeArtifact(directory, 'AtrisAgent_0.3.0_amd64.deb', 'deb-signature');

    const manifest = generateUpdaterManifest({
      directory,
      repository: 'merteren97/AtrisAgent',
      tag: 'v0.3.0',
      publishedAt: '2026-08-10T16:00:00.000Z',
    });

    assert.equal(manifest.version, '0.3.0');
    assert.equal(manifest.pub_date, '2026-08-10T16:00:00.000Z');
    assert.equal(manifest.platforms['windows-x86_64'].signature, 'nsis-signature');
    assert.match(manifest.platforms['windows-x86_64'].url, /AtrisAgent_0\.3\.0_x64-setup\.exe$/);
    assert.equal(manifest.platforms['windows-x86_64-msi'].signature, 'msi-signature');
    assert.equal(manifest.platforms['linux-x86_64'].signature, 'appimage-signature');
    assert.equal(manifest.platforms['linux-x86_64-deb'].signature, 'deb-signature');
    for (const entry of Object.values(manifest.platforms)) {
      assert.match(entry.url, /^https:\/\/github\.com\/merteren97\/AtrisAgent\/releases\/download\/v0\.3\.0\//);
      assert.ok(entry.signature.length > 0);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('manifest generation rejects prerelease tags and unsigned artifacts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-updater-manifest-invalid-'));
  try {
    assert.throws(
      () => generateUpdaterManifest({ directory, repository: 'merteren97/AtrisAgent', tag: 'v0.3.0-1' }),
      /stable SemVer release tag/i,
    );

    fs.writeFileSync(path.join(directory, 'AtrisAgent_0.3.0_x64-setup.exe'), 'package-bytes');
    fs.writeFileSync(path.join(directory, 'AtrisAgent_0.3.0_x64_en-US.msi'), 'package-bytes');
    fs.writeFileSync(path.join(directory, 'AtrisAgent_0.3.0_amd64.AppImage'), 'package-bytes');
    fs.writeFileSync(path.join(directory, 'AtrisAgent_0.3.0_amd64.deb'), 'package-bytes');

    assert.throws(
      () => generateUpdaterManifest({ directory, repository: 'merteren97/AtrisAgent', tag: 'v0.3.0' }),
      /missing updater signature/i,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
