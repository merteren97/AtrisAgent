import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { checkDevRuntime } from './check-dev-runtime.mjs';

const checks = [];
function command(name, args = ['--version'], required = false, executable = name) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  const output = String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0];
  const ok = !result.error && result.status === 0;
  checks.push({ name, ok, required, detail: ok ? output || 'available' : result.error?.message || `exit ${result.status}` });
}

const runtime = checkDevRuntime();
checks.push({ name: 'Node.js 22 LTS', ok: runtime.node.ok, required: true, detail: runtime.node.detail });
checks.push({ name: 'better-sqlite3 addon', ok: runtime.sqlite.ok, required: true, detail: runtime.sqlite.detail });
checks.push({ name: 'package-lock.json', ok: fs.existsSync(path.resolve('package-lock.json')), required: true, detail: 'lockfile' });
checks.push({
  name: 'dependencies installed',
  ok: fs.existsSync(path.resolve('node_modules/typescript/package.json')),
  required: true,
  detail: fs.existsSync(path.resolve('node_modules/typescript/package.json')) ? 'node_modules present' : 'run npm ci',
});

command('git', ['--version'], true);
command('cargo', ['--version'], true);
command('rustc', ['--version'], true);
command('codex', ['--version']);
command('claude', ['--version']);
command('antigravity', ['--version'], false, 'agy');
command('opencode', ['--version']);

console.log('\nAtrisAgent preflight\n');
for (const check of checks) {
  console.log(`${check.ok ? '✓' : check.required ? '✗' : '○'} ${check.name.padEnd(24)} ${check.detail}`);
}
const runtimes = checks.filter((check) => ['codex', 'claude', 'antigravity', 'opencode'].includes(check.name));
if (!runtimes.some((check) => check.ok)) console.log('\nWarning: No supported AI CLI runtime was detected. UI development can continue, but missions cannot execute.');
const failed = checks.filter((check) => check.required && !check.ok);
if (failed.length) {
  console.error(`\nPreflight failed: ${failed.map((check) => check.name).join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\nCore toolchain checks passed.');
}
