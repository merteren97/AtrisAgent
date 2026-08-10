import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseReleaseVersion(rawVersion) {
  if (typeof rawVersion !== "string" || rawVersion.length === 0) {
    throw new Error("Release version is required.");
  }

  const version = rawVersion.replace(/^v/i, "");
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid semantic version: ${rawVersion}`);
  }

  return version;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function updateJson(filePath, updater, dryRun, changedFiles) {
  const data = readJson(filePath);
  updater(data);
  if (!dryRun) writeJson(filePath, data);
  changedFiles.push(path.relative(process.cwd(), filePath));
}

function updateCargoVersion(filePath, version, dryRun, changedFiles) {
  const source = fs.readFileSync(filePath, "utf8");
  const versionPattern = /^(version\s*=\s*")[^"]+("\s*$)/m;
  if (!versionPattern.test(source)) throw new Error(`Cargo package version was not found: ${filePath}`);
  const updated = source.replace(versionPattern, `$1${version}$2`);
  if (!dryRun) fs.writeFileSync(filePath, updated);
  changedFiles.push(path.relative(process.cwd(), filePath));
}

function updateCargoLockVersion(filePath, packageName, version, dryRun, changedFiles) {
  if (!fs.existsSync(filePath)) return;

  const source = fs.readFileSync(filePath, "utf8");
  const packagePattern = new RegExp(`(name\\s*=\\s*"${packageName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}"\\s*\\nversion\\s*=\\s*")[^"]+("\\s*$)`, "m");
  if (!packagePattern.test(source)) throw new Error(`Cargo.lock package version was not found: ${packageName}`);
  const updated = source.replace(packagePattern, `$1${version}$2`);
  if (!dryRun) fs.writeFileSync(filePath, updated);
  changedFiles.push(path.relative(process.cwd(), filePath));
}

function workspacePatterns(rootPackage) {
  if (Array.isArray(rootPackage.workspaces)) return rootPackage.workspaces;
  if (Array.isArray(rootPackage.workspaces?.packages)) return rootPackage.workspaces.packages;
  return [];
}

function workspacePackageFiles(repoRoot, rootPackage) {
  const directories = new Set();
  for (const rawPattern of workspacePatterns(rootPackage)) {
    const segments = String(rawPattern).replaceAll("\\", "/").split("/").filter(Boolean);
    let candidates = [repoRoot];
    for (const segment of segments) {
      if (segment === "*") {
        candidates = candidates.flatMap((directory) => {
          if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
            throw new Error(`Workspace pattern directory is missing: ${directory}`);
          }
          return fs.readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(directory, entry.name));
        });
      } else {
        candidates = candidates.map((directory) => path.join(directory, segment));
      }
    }
    for (const directory of candidates) {
      const manifest = path.join(directory, "package.json");
      if (!fs.existsSync(manifest)) {
        throw new Error(`Workspace package manifest is missing: ${manifest}`);
      }
      directories.add(directory);
    }
  }

  return [...directories]
    .map((directory) => {
      const data = readJson(path.join(directory, "package.json"));
      if (typeof data.name !== "string" || data.name.length === 0) {
        throw new Error(`Workspace package name is missing: ${directory}`);
      }
      if (typeof data.version !== "string" || !VERSION_PATTERN.test(data.version)) {
        throw new Error(`Workspace package version is missing or malformed: ${directory}`);
      }
      const key = path.relative(repoRoot, directory).split(path.sep).join("/");
      if (!key || key.startsWith("../")) throw new Error(`Workspace package is outside the repository: ${directory}`);
      return { data, filePath: path.join(directory, "package.json"), key };
    })
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

function updateLockWorkspace(lockData, key, version, expectedName) {
  const entry = lockData.packages?.[key];
  if (!entry) throw new Error(`Workspace lock entry is missing: ${key}`);
  if (expectedName && entry.name && entry.name !== expectedName) {
    throw new Error(`Workspace lock entry name mismatch: ${key}`);
  }
  entry.version = version;
}

export function applyReleaseVersion(repoRoot, rawVersion, { dryRun = false } = {}) {
  const version = parseReleaseVersion(rawVersion);
  const changedFiles = [];
  const rootPackage = path.join(repoRoot, "package.json");
  const tauriConfig = path.join(repoRoot, "apps/desktop/src-tauri/tauri.conf.json");
  const lockfile = path.join(repoRoot, "package-lock.json");
  const cargoToml = path.join(repoRoot, "apps/desktop/src-tauri/Cargo.toml");
  const cargoLock = path.join(repoRoot, "apps/desktop/src-tauri/Cargo.lock");
  const rootPackageData = readJson(rootPackage);
  const workspacePackages = workspacePackageFiles(repoRoot, rootPackageData);

  for (const filePath of [rootPackage, tauriConfig, lockfile, cargoToml]) {
    if (!fs.existsSync(filePath)) throw new Error(`Release version file is missing: ${filePath}`);
  }

  for (const filePath of [rootPackage, ...workspacePackages.map(({ filePath }) => filePath), tauriConfig]) {
    updateJson(filePath, (data) => { data.version = version; }, dryRun, changedFiles);
  }

  updateJson(lockfile, (data) => {
    data.version = version;
    updateLockWorkspace(data, "", version);
    for (const { data: packageData, key } of workspacePackages) {
      updateLockWorkspace(data, key, version, packageData.name);
    }
  }, dryRun, changedFiles);

  updateCargoVersion(cargoToml, version, dryRun, changedFiles);
  updateCargoLockVersion(cargoLock, "atris-agent-code", version, dryRun, changedFiles);

  return { version, changedFiles, dryRun };
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === currentFile) {
  const rawVersion = process.argv.slice(2).find((argument) => argument !== "--dry-run");
  const dryRun = process.argv.includes("--dry-run");
  const repoRoot = path.resolve(path.dirname(currentFile), "../..");
  const result = applyReleaseVersion(repoRoot, rawVersion, { dryRun });
  console.log(`${dryRun ? "Would update" : "Updated"} release version to ${result.version}:`);
  for (const file of result.changedFiles) console.log(`- ${file}`);
}
