import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptsDirectory, "../..");
const workflowDirectory = path.join(repositoryRoot, ".github", "workflows");

function readWorkflow(name) {
  return fs.readFileSync(path.join(workflowDirectory, name), "utf8");
}

test("all third-party workflow actions use reviewed immutable refs", () => {
  const files = fs.readdirSync(workflowDirectory).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  assert.ok(files.length > 0, "At least one workflow must be present.");

  for (const file of files) {
    const source = readWorkflow(file);
    const lines = source.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const match = line.match(/^\s*uses:\s*([^\s#]+)(?:\s+#\s*(.*))?$/);
      if (!match) continue;
      const [, reference, comment] = match;
      assert.match(reference, /^[^@\s]+@[0-9a-f]{40}$/, `${file} contains an unpinned action: ${reference}`);
      const previousComment = lines
        .slice(0, index)
        .reverse()
        .find((previousLine) => previousLine.trim().length > 0);
      assert.ok(
        (comment && comment.trim().length > 0) || /^\s*#\s*\S/.test(previousComment || ""),
        `${file} must document the reviewed action version: ${reference}`,
      );
    }
  }
});

test("public source repository contains no active production deployment", () => {
  const forbiddenPaths = [
    path.join(workflowDirectory, "deploy.yml"),
    path.join(repositoryRoot, "infra", "nginx", "agent.atrishub.com.conf.example"),
    path.join(repositoryRoot, "infra", "pm2", "atris-agent-code-public.ecosystem.config.cjs"),
    path.join(repositoryRoot, "infra", "scripts", "deploy-agent-public.sh"),
  ];

  for (const forbiddenPath of forbiddenPaths) {
    assert.equal(fs.existsSync(forbiddenPath), false, `private production operation remains public: ${forbiddenPath}`);
  }

  const workflows = fs.readdirSync(workflowDirectory).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  for (const workflow of workflows) {
    const source = readWorkflow(workflow);
    assert.doesNotMatch(source, /appleboy\/ssh-action/, `${workflow} must not open a production SSH boundary`);
    assert.doesNotMatch(source, /SSH_PRIVATE_KEY/, `${workflow} must not request a production SSH key`);
    assert.doesNotMatch(source, /\/var\/www\//, `${workflow} must not expose a production checkout path`);
  }

  const readiness = fs.readFileSync(path.join(repositoryRoot, "docs", "PUBLIC_REPOSITORY_READINESS.md"), "utf8");
  assert.match(
    readiness,
    /separate private operations boundary/,
    "public readiness docs must preserve the private operations boundary without naming its repository",
  );
});

test("CodeQL skips private repositories until code scanning is enabled", () => {
  const codeql = readWorkflow("codeql.yml");
  assert.match(
    codeql,
    /if:\s*github\.event\.repository\.visibility\s*==\s*'public'/,
    "codeql.yml must run only after the repository is public",
  );
});

test("release publishing stays owner-controlled and requires both desktop platforms", () => {
  const release = readWorkflow("release.yml");

  assert.match(release, /workflow_dispatch:/, "release.yml must remain an explicit manual release workflow");
  assert.doesNotMatch(release, /push:\s*\n\s*tags:/, "release.yml must not publish automatically from a pushed tag");
  assert.match(release, /github\.repository == 'merteren97\/AtrisAgent'/, "release.yml must be repository-scoped");
  assert.match(release, /github\.actor == 'merteren97'/, "release.yml must be owner-triggered");
  assert.match(release, /github\.triggering_actor == 'merteren97'/, "release.yml must reject reruns by another actor");
  assert.match(release, /github\.ref == 'refs\/heads\/main'/, "release.yml must publish only from main");
  assert.match(release, /windows-latest/, "release.yml must build the Windows desktop package");
  assert.match(release, /ubuntu-22\.04/, "release.yml must build the Linux desktop package on the supported baseline");
  assert.match(release, /bundles:\s*nsis,msi/, "release.yml must publish NSIS and MSI bundles");
  assert.match(release, /bundles:\s*appimage,deb/, "release.yml must publish AppImage and Debian bundles");
  assert.match(release, /needs:\s*build/, "release publishing must wait for every platform build");
  assert.match(release, /permissions:\s*\n\s*contents:\s*write/, "release publishing requires narrowly-scoped contents write permission");
  assert.match(release, /retention-days:\s*3/, "temporary release artifacts must use short retention");
});

test("Windows runtime checks include an installed-style path with spaces", () => {
  for (const workflow of ["ci.yml", "release.yml"]) {
    const source = readWorkflow(workflow);
    assert.match(
      source,
      /Smoke Windows installed-layout runtime/,
      `${workflow} must exercise the packaged runtime outside the checkout layout`,
    );
    assert.match(
      source,
      /Atris Agent Installed Layout/,
      `${workflow} must exercise Windows process arguments with an installed-style path containing spaces`,
    );
    assert.match(
      source,
      /--runtime-dir \"\$installedRuntime\"/,
      `${workflow} must pass the copied installed runtime to the sidecar smoke test`,
    );
  }
});

test("Tauri packages the complete runtime directory into a stable resource path", () => {
  const configPath = path.join(repositoryRoot, "apps", "desktop", "src-tauri", "tauri.conf.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(
    config.bundle?.resources,
    { "target/runtime/": "runtime/" },
    "the staged runtime directory must be copied recursively to $RESOURCE/runtime",
  );
});
