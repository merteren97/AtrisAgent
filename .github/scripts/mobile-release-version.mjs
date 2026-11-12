import { appendFile, readFile, writeFile } from 'node:fs/promises';

const version = (process.env.MOBILE_VERSION || '').replace(/^[vV]/, '');
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Mobile version must be a semantic version, e.g. 0.1.0 or v0.1.0');
for (const file of ['apps/mobile/package.json', 'apps/mobile/src-tauri/tauri.conf.json']) {
  const value = JSON.parse(await readFile(file, 'utf8'));
  value.version = version;
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
console.log(`Mobile version: ${version}`);
