import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { expectedReleaseAssets, normalizeReleaseAssets, validateReleaseAssets } from "./validate-release-assets.mjs";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atris-release-assets-"));
  for (const name of expectedReleaseAssets("v1.2.3").signedAssets) fs.writeFileSync(path.join(directory, name), `bytes:${name}`);
  return directory;
}

test("accepts only exact versioned package/signature pairs and emits deterministic hashes", () => {
  const directory = fixture();
  try {
    assert.equal(validateReleaseAssets(directory, "v1.2.3").hashes.length, 8);
    const first = fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8");
    fs.rmSync(path.join(directory, "SHA256SUMS"));
    validateReleaseAssets(directory, "v1.2.3");
    assert.equal(fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8"), first);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("rejects missing, extra, wrong-version, and empty assets", () => {
  for (const mutate of [
    (dir) => fs.rmSync(path.join(dir, expectedReleaseAssets("v1.2.3").signedAssets[0])),
    (dir) => fs.writeFileSync(path.join(dir, "unexpected.txt"), "x"),
    (dir) => fs.renameSync(path.join(dir, "AtrisAgent_1.2.3_amd64.deb"), path.join(dir, "AtrisAgent_1.2.4_amd64.deb")),
    (dir) => fs.writeFileSync(path.join(dir, "AtrisAgent_1.2.3_amd64.deb.sig"), ""),
  ]) {
    const directory = fixture();
    try { mutate(directory); assert.throws(() => validateReleaseAssets(directory, "v1.2.3"), /allowlist mismatch|empty/); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
});

test("normalizeReleaseAssets flattens nested artifact directory trees and enables validation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atris-release-nested-"));
  try {
    const winDir = path.join(directory, "x86_64-pc-windows-msvc", "release", "bundle");
    const linuxDir = path.join(directory, "x86_64-unknown-linux-gnu", "release", "bundle");
    fs.mkdirSync(path.join(winDir, "nsis"), { recursive: true });
    fs.mkdirSync(path.join(winDir, "msi"), { recursive: true });
    fs.mkdirSync(path.join(linuxDir, "appimage"), { recursive: true });
    fs.mkdirSync(path.join(linuxDir, "deb"), { recursive: true });

    fs.writeFileSync(path.join(winDir, "nsis", "AtrisAgent_1.2.3_x64-setup.exe"), "setup_bytes");
    fs.writeFileSync(path.join(winDir, "nsis", "AtrisAgent_1.2.3_x64-setup.exe.sig"), "setup_sig");
    fs.writeFileSync(path.join(winDir, "msi", "AtrisAgent_1.2.3_x64_en-US.msi"), "msi_bytes");
    fs.writeFileSync(path.join(winDir, "msi", "AtrisAgent_1.2.3_x64_en-US.msi.sig"), "msi_sig");
    fs.writeFileSync(path.join(linuxDir, "appimage", "AtrisAgent_1.2.3_amd64.AppImage"), "appimage_bytes");
    fs.writeFileSync(path.join(linuxDir, "appimage", "AtrisAgent_1.2.3_amd64.AppImage.sig"), "appimage_sig");
    fs.writeFileSync(path.join(linuxDir, "deb", "AtrisAgent_1.2.3_amd64.deb"), "deb_bytes");
    fs.writeFileSync(path.join(linuxDir, "deb", "AtrisAgent_1.2.3_amd64.deb.sig"), "deb_sig");

    // Before normalization, validation throws allowlist mismatch
    assert.throws(() => validateReleaseAssets(directory, "v1.2.3"), /Release asset allowlist mismatch/);

    // After normalization, files are flat at root and validation passes
    normalizeReleaseAssets(directory);
    const result = validateReleaseAssets(directory, "v1.2.3");
    assert.equal(result.packages.length, 4);
    assert.equal(result.hashes.length, 8);
    assert.equal(fs.existsSync(path.join(directory, "SHA256SUMS")), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
