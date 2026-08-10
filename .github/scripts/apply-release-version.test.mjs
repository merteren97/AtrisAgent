import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyReleaseVersion, parseReleaseVersion } from "./apply-release-version.mjs";

const workspaceDirs = [
  "apps/desktop",
  "apps/landing",
  "packages/database",
  "packages/domain",
  "packages/event-bus",
  "packages/event-schema",
  "services/api-gateway",
  "services/coordination-mcp",
  "services/merge-coordinator",
  "services/orchestration-core",
  "services/policy-engine",
  "services/public-server",
  "services/runtime-host",
  "services/workspace-manager",
];

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atris-agent-release-version-"));
  const packageData = { name: "fixture", version: "0.2.0" };
  writeJson(path.join(root, "package.json"), { ...packageData, workspaces: ["apps/*", "packages/*", "services/*"] });
  for (const workspaceDir of workspaceDirs) {
    writeJson(path.join(root, workspaceDir, "package.json"), packageData);
  }
  writeJson(path.join(root, "apps/desktop/src-tauri/tauri.conf.json"), packageData);
  const workspaceLockEntries = Object.fromEntries(workspaceDirs.map((workspaceDir) => [workspaceDir, { version: "0.2.0" }]));
  writeJson(path.join(root, "package-lock.json"), {
    name: "fixture",
    version: "0.2.0",
    packages: {
      "": { version: "0.2.0" },
      ...workspaceLockEntries,
    },
  });
  fs.mkdirSync(path.join(root, "apps/desktop/src-tauri"), { recursive: true });
  fs.writeFileSync(path.join(root, "apps/desktop/src-tauri/Cargo.toml"), '[package]\nname = "atris-agent-code"\nversion = "0.2.0"\n');
  fs.writeFileSync(path.join(root, "apps/desktop/src-tauri/Cargo.lock"), '[[package]]\nname = "atris-agent-code"\nversion = "0.2.0"\n');
  return root;
}

test("parses tagged and untagged semantic versions", () => {
  assert.equal(parseReleaseVersion("v1.2.3"), "1.2.3");
  assert.equal(parseReleaseVersion("1.2.3-rc.1+build.4"), "1.2.3-rc.1+build.4");
  assert.throws(() => parseReleaseVersion("release-1"), /Invalid semantic version/);
  assert.throws(() => parseReleaseVersion("01.2.3"), /Invalid semantic version/);
});

test("updates all current release version surfaces", () => {
  const root = createFixture();
  try {
    applyReleaseVersion(root, "v1.4.0");
    for (const file of ["package.json", ...workspaceDirs.map((workspaceDir) => `${workspaceDir}/package.json`), "apps/desktop/src-tauri/tauri.conf.json", "package-lock.json"]) {
      const data = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
      assert.equal(data.version, "1.4.0", file);
    }
    const lockData = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    for (const workspaceDir of workspaceDirs) assert.equal(lockData.packages[workspaceDir].version, "1.4.0", workspaceDir);
    assert.match(fs.readFileSync(path.join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf8"), /version = "1\.4\.0"/);
    assert.match(fs.readFileSync(path.join(root, "apps/desktop/src-tauri/Cargo.lock"), "utf8"), /version = "1\.4\.0"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run leaves the fixture unchanged", () => {
  const root = createFixture();
  try {
    const before = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const result = applyReleaseVersion(root, "1.5.0", { dryRun: true });
    assert.equal(result.version, "1.5.0");
    assert.equal(fs.readFileSync(path.join(root, "package.json"), "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("same-version apply and dry-run are idempotent", () => {
  const root = createFixture();
  try {
    const dryRun = applyReleaseVersion(root, "v0.2.0", { dryRun: true });
    assert.equal(dryRun.version, "0.2.0");
    applyReleaseVersion(root, "0.2.0");
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, "0.2.0");
    assert.match(fs.readFileSync(path.join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf8"), /version = "0\.2\.0"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing Cargo version patterns fail explicitly", () => {
  const root = createFixture();
  try {
    fs.writeFileSync(path.join(root, "apps/desktop/src-tauri/Cargo.toml"), '[package]\nname = "atris-agent-code"\n');
    assert.throws(
      () => applyReleaseVersion(root, "1.5.0", { dryRun: true }),
      /Cargo package version was not found/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const lockRoot = createFixture();
  try {
    fs.writeFileSync(path.join(lockRoot, "apps/desktop/src-tauri/Cargo.lock"), '[[package]]\nname = "other"\nversion = "0.2.0"\n');
    assert.throws(
      () => applyReleaseVersion(lockRoot, "1.5.0", { dryRun: true }),
      /Cargo\.lock package version was not found/,
    );
  } finally {
    fs.rmSync(lockRoot, { recursive: true, force: true });
  }
});

test("missing workspace lock surfaces fail explicitly", () => {
  const root = createFixture();
  try {
    const lockPath = path.join(root, "package-lock.json");
    const lockData = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    delete lockData.packages["services/runtime-host"];
    writeJson(lockPath, lockData);
    assert.throws(
      () => applyReleaseVersion(root, "1.5.0", { dryRun: true }),
      /Workspace lock entry is missing: services\/runtime-host/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace lock names must match package manifests", () => {
  const root = createFixture();
  try {
    const lockPath = path.join(root, "package-lock.json");
    const lockData = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    lockData.packages["services/runtime-host"].name = "wrong-package";
    writeJson(lockPath, lockData);
    assert.throws(
      () => applyReleaseVersion(root, "1.5.0", { dryRun: true }),
      /Workspace lock entry name mismatch: services\/runtime-host/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
