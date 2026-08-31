import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { expectedReleaseAssets, validateReleaseAssets } from "./validate-release-assets.mjs";

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
