import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_RUNTIME_DIR = join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'target', 'runtime');
const DESKTOP_PACKAGE_JSON = join(REPO_ROOT, 'apps', 'desktop', 'package.json');
const RUNTIME_LICENSES_DIR = join(REPO_ROOT, 'scripts', 'runtime-licenses');
const GATEWAY_ENTRY = join(REPO_ROOT, 'services', 'api-gateway', 'src', 'entry.ts');
const BRIDGE_ENTRY = join(REPO_ROOT, 'services', 'coordination-mcp', 'src', 'control-plane-bridge.mjs');
const SQLITE_ROOT = join(REPO_ROOT, 'node_modules', 'better-sqlite3');
const BINDINGS_ROOT = join(REPO_ROOT, 'node_modules', 'bindings');
const FILE_URI_ROOT = join(REPO_ROOT, 'node_modules', 'file-uri-to-path');

function assertInside(parent, candidate, label) {
  const parentPath = resolve(parent);
  const candidatePath = resolve(candidate);
  const rel = relative(parentPath, candidatePath);
  if (!rel || rel.startsWith('..') || rel.includes(':')) {
    throw new Error(`${label} must remain inside ${parentPath}.`);
  }
  return candidatePath;
}

function assertFile(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`);
  return filePath;
}

async function copyFileChecked(source, destination, label) {
  assertFile(source, label);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { force: true });
}

async function copyPackageFiles(sourceRoot, destinationRoot, files, packageLabel) {
  for (const file of files) {
    const source = join(sourceRoot, file);
    const destination = join(destinationRoot, file);
    if (file === 'lib') {
      assertFile(join(source, 'index.js'), `${packageLabel} runtime library`);
      await cp(source, destination, { recursive: true, force: true });
    } else {
      await copyFileChecked(source, destination, `${packageLabel}/${file}`);
    }
  }
}

function packageSlug(name) {
  return name.replace(/^@/, '').replaceAll('/', '-').replace(/[^A-Za-z0-9._-]/g, '-');
}

async function packageMetadata(packageRoot, packageLabel) {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (!packageJson.name || !packageJson.version || !packageJson.license) {
    throw new Error(`${packageLabel} package.json is missing name/version/license metadata.`);
  }
  return packageJson;
}

function packageRootForInput(inputPath) {
  const starts = [resolve(process.cwd(), inputPath), resolve(REPO_ROOT, inputPath)];
  for (const start of starts) {
    let candidate = start;
    while (candidate && candidate !== dirname(candidate)) {
      const packageJson = join(candidate, 'package.json');
      if (existsSync(packageJson)) {
        try {
          const metadata = JSON.parse(readFileSync(packageJson, 'utf8'));
          if (metadata.name && candidate.includes('node_modules')) return candidate;
        } catch {
          // Keep walking when a generated nested package descriptor is incomplete.
        }
      }
      candidate = dirname(candidate);
    }
  }
  return null;
}

async function packageLicenseText(packageRoot, packageLabel) {
  const metadata = await packageMetadata(packageRoot, packageLabel);
  const candidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'LICENSE-MIT.txt', 'license', 'license.md', 'NOTICE', 'NOTICE.md', 'NOTICE.txt'];
  const source = candidates.map((file) => join(packageRoot, file)).find((file) => existsSync(file));
  if (source) return { metadata, source, text: await readFile(source, 'utf8') };

  if (metadata.name === 'cookie-signature') {
    const readme = join(packageRoot, 'Readme.md');
    if (existsSync(readme)) {
      const text = await readFile(readme, 'utf8');
      const marker = text.search(/^## License\s*$/im);
      if (marker >= 0) return { metadata, source: readme, text: text.slice(marker).trim() + '\n' };
    }
  }

  if (metadata.name === 'drizzle-orm' && metadata.version === '0.45.2') {
    const source = await trackedLicense('drizzle-orm-0.45.2-LICENSE', 'Drizzle ORM tracked license');
    return { metadata, source, text: await readFile(source, 'utf8') };
  }

  throw new Error(`${packageLabel} has no redistributable LICENSE/NOTICE text.`);
}

async function copyLicenseText(license, destinationDir) {
  const destination = join(
    destinationDir,
    `${packageSlug(license.metadata.name)}-${license.metadata.version}-LICENSE.txt`,
  );
  await writeFile(destination, license.text, 'utf8');
  return { source: license.source, destination, metadata: license.metadata };
}

async function gitBlobSha1(filePath) {
  const data = await readFile(filePath);
  return createHash('sha1')
    .update(`blob ${data.byteLength}\0`)
    .update(data)
    .digest('hex');
}

async function trackedLicense(fileName, label) {
  const source = join(RUNTIME_LICENSES_DIR, fileName);
  await assertFile(source, label);
  const sources = JSON.parse(await readFile(join(RUNTIME_LICENSES_DIR, 'SOURCES.json'), 'utf8'));
  const expected = sources[fileName]?.blob;
  const actual = await gitBlobSha1(source);
  if (!expected || expected !== actual) {
    throw new Error(`${label} hash mismatch (expected ${expected ?? '(missing)'}, got ${actual}).`);
  }
  return source;
}

function bundledPackageRoots(...metafiles) {
  const roots = new Map();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile?.inputs ?? {})) {
      if (!input.includes('node_modules')) continue;
      const root = packageRootForInput(input);
      if (!root) throw new Error(`Could not resolve a package root for bundled input: ${input}`);
      roots.set(root, root);
    }
  }
  return [...roots.values()].sort();
}

function parseArguments(argv) {
  const options = { outDir: DEFAULT_RUNTIME_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--out-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out-dir requires a path.');
      options.outDir = resolve(value);
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      console.log('Usage: node scripts/build-runtime-sidecar.mjs [--out-dir <directory>]');
      return null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

export async function buildRuntimeSidecar({ outDir = DEFAULT_RUNTIME_DIR } = {}) {
  const runtimeDir = assertInside(join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'target'), outDir, 'Runtime output');
  const nodeExecutable = assertFile(process.execPath, 'Current Node executable');
  const expectedNodeName = process.platform === 'win32' ? 'node.exe' : basename(nodeExecutable);
  if (basename(nodeExecutable).toLowerCase() !== expectedNodeName.toLowerCase()) {
    throw new Error(`Current Node executable must be ${expectedNodeName}: ${nodeExecutable}`);
  }
  assertFile(GATEWAY_ENTRY, 'API gateway entry');
  assertFile(BRIDGE_ENTRY, 'Control-plane bridge');
  const desktopPackage = JSON.parse(await readFile(DESKTOP_PACKAGE_JSON, 'utf8'));
  if (!desktopPackage.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(desktopPackage.version)) {
    throw new Error(`Desktop package version is missing or malformed: ${desktopPackage.version ?? '(missing)'}`);
  }
  const nativeAddon = join(SQLITE_ROOT, 'build', 'Release', 'better_sqlite3.node');
  assertFile(nativeAddon, 'better-sqlite3 native addon');

  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true });

  const gatewayBundle = join(runtimeDir, 'gateway.cjs');
  const bridgeBundle = join(runtimeDir, 'control-plane-bridge.mjs');
  const gatewayBuild = await esbuild({
    entryPoints: [GATEWAY_ENTRY],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: gatewayBundle,
    external: ['better-sqlite3'],
    sourcemap: false,
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
  });
  const bridgeBuild = await esbuild({
    entryPoints: [BRIDGE_ENTRY],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: bridgeBundle,
    sourcemap: false,
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
  });

  await copyFileChecked(nodeExecutable, join(runtimeDir, basename(nodeExecutable)), 'Current Node executable');
  const nodeName = process.platform === 'win32' ? 'node.exe' : basename(nodeExecutable);
  if (basename(nodeExecutable) !== nodeName) {
    await copyFileChecked(nodeExecutable, join(runtimeDir, nodeName), 'Packaged Node executable');
  }

  const sqliteDestination = join(runtimeDir, 'node_modules', 'better-sqlite3');
  await copyPackageFiles(SQLITE_ROOT, sqliteDestination, ['package.json', 'lib'], 'better-sqlite3');
  await copyFileChecked(nativeAddon, join(sqliteDestination, 'build', 'Release', 'better_sqlite3.node'), 'better-sqlite3 native addon');

  const bindingsDestination = join(runtimeDir, 'node_modules', 'bindings');
  await copyPackageFiles(BINDINGS_ROOT, bindingsDestination, ['package.json', 'bindings.js'], 'bindings');
  const fileUriDestination = join(runtimeDir, 'node_modules', 'file-uri-to-path');
  await copyPackageFiles(FILE_URI_ROOT, fileUriDestination, ['package.json', 'index.js'], 'file-uri-to-path');

  const licensesDir = join(runtimeDir, 'licenses');
  await mkdir(licensesDir, { recursive: true });
  const packageRoots = bundledPackageRoots(gatewayBuild.metafile, bridgeBuild.metafile);
  const bundledLicenses = [];
  for (const packageRoot of packageRoots) {
    bundledLicenses.push(await packageLicenseText(packageRoot, `Bundled package ${packageRoot}`));
  }
  for (const packageRoot of [SQLITE_ROOT, BINDINGS_ROOT, FILE_URI_ROOT]) {
    const license = await packageLicenseText(packageRoot, `Runtime package ${packageRoot}`);
    if (!bundledLicenses.some(({ metadata }) => metadata.name === license.metadata.name && metadata.version === license.metadata.version)) {
      bundledLicenses.push(license);
    }
  }

  const nodeVersionResult = spawnSync(nodeExecutable, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  const nodeVersion = String(nodeVersionResult.stdout ?? '').trim().replace(/^v/, '');
  if (nodeVersionResult.status !== 0 || !/^\d+\.\d+\.\d+$/.test(nodeVersion)) {
    throw new Error(`Could not determine the staged Node version from ${nodeExecutable}.`);
  }
  const nodeLicenseSource = await trackedLicense(`node-v${nodeVersion}-LICENSE`, `Node.js ${nodeVersion} tracked license`);
  const nodeLicense = {
    metadata: { name: 'Node.js', version: nodeVersion, license: 'Node.js license' },
    source: nodeLicenseSource,
    text: await readFile(nodeLicenseSource, 'utf8'),
  };
  const allLicenseRecords = [nodeLicense, ...bundledLicenses]
    .sort((left, right) => `${left.metadata.name}@${left.metadata.version}`.localeCompare(`${right.metadata.name}@${right.metadata.version}`));
  const licenseRecords = [];
  const seenPackages = new Map();
  for (const license of allLicenseRecords) {
    const packageKey = `${license.metadata.name}@${license.metadata.version}`;
    const previous = seenPackages.get(packageKey);
    if (previous) {
      if (previous.text !== license.text) {
        throw new Error(`Conflicting license text was found for ${packageKey}.`);
      }
      continue;
    }
    seenPackages.set(packageKey, license);
    licenseRecords.push(license);
  }
  const copiedLicenses = [];
  const copiedPaths = new Set();
  for (const license of licenseRecords) {
    const copied = await copyLicenseText(license, licensesDir);
    const relativePath = relative(runtimeDir, copied.destination);
    if (copiedPaths.has(relativePath)) throw new Error(`License destination collision: ${relativePath}`);
    copiedPaths.add(relativePath);
    copiedLicenses.push(copied);
  }
  const noticesPath = join(runtimeDir, 'THIRD_PARTY_NOTICES');
  const notices = [
    'AtrisAgent packaged runtime third-party notices.',
    'Each section contains the package metadata and the actual upstream LICENSE/NOTICE text used for this runtime.',
    ...licenseRecords.map(({ metadata, text }) => [
      `\n===== ${metadata.name}@${metadata.version} (${metadata.license}) =====`,
      '',
      text.trim(),
      '',
    ].join('\n')),
  ].join('\n');
  await writeFile(noticesPath, `${notices}\n`, 'utf8');
  const noticesSourcesPath = join(runtimeDir, 'THIRD_PARTY_NOTICES.sources.json');
  await copyFileChecked(join(RUNTIME_LICENSES_DIR, 'SOURCES.json'), noticesSourcesPath, 'Runtime license source metadata');

  const manifest = {
    version: desktopPackage.version,
    node: nodeName,
    gateway: 'gateway.cjs',
    bridge: 'control-plane-bridge.mjs',
    nativeAddon: 'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    runtimeDependencies: ['better-sqlite3', 'bindings', 'file-uri-to-path'],
    licenses: copiedLicenses.map(({ destination, metadata }) => ({
      package: `${metadata.name}@${metadata.version}`,
      path: relative(runtimeDir, destination),
    })),
    notices: ['THIRD_PARTY_NOTICES', 'THIRD_PARTY_NOTICES.sources.json'],
    nodeVersion,
  };
  await writeFile(join(runtimeDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const requiredFiles = [
    join(runtimeDir, nodeName),
    gatewayBundle,
    bridgeBundle,
    nativeAddon.replace(SQLITE_ROOT, sqliteDestination),
    join(bindingsDestination, 'bindings.js'),
    join(fileUriDestination, 'index.js'),
    noticesPath,
    noticesSourcesPath,
  ];
  requiredFiles.forEach((filePath) => assertFile(filePath, 'Staged runtime file'));
  return { runtimeDir, manifest };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = parseArguments(process.argv.slice(2));
  if (options) {
    const result = await buildRuntimeSidecar(options);
    console.log(`[AtrisAgent] Runtime sidecar staged at ${result.runtimeDir}`);
    console.log(`[AtrisAgent] Runtime files: ${result.manifest.node}, ${result.manifest.gateway}, ${result.manifest.bridge}`);
  }
}
