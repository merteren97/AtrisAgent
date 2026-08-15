import fs from 'node:fs';
import path from 'node:path';

export const MEMORY_EXPORT_SUFFIX = '-atris-memory.json';

export function resolveSafeMemoryExportPath(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw)) {
    throw new Error('A valid absolute export path is required.');
  }

  const resolved = path.resolve(raw);
  const basename = path.basename(resolved);
  if (!basename.toLowerCase().endsWith(MEMORY_EXPORT_SUFFIX)) {
    throw new Error(`Memory backup filenames must end with ${MEMORY_EXPORT_SUFFIX}.`);
  }
  if (basename.length > 180) throw new Error('Memory backup filename is too long.');

  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error('The selected backup directory does not exist.');
  }
  if (fs.existsSync(resolved)) {
    throw new Error('Memory backup already exists. Choose a new filename; AtrisAgent never overwrites existing files.');
  }
  return resolved;
}

export function writeNewMemoryExport(targetPath: string, payload: string): void {
  // `wx` is the atomic no-overwrite guard. The explicit preflight above exists
  // only for a friendly error; this flag closes the TOCTOU race as well.
  fs.writeFileSync(targetPath, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}
