import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['node_modules', '.git', 'src-tauri']);
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist') fs.rmSync(target, { recursive: true, force: true });
      else walk(target);
      continue;
    }
    if (entry.name.endsWith('.tsbuildinfo') || entry.name.endsWith('.d.ts.map') || entry.name.endsWith('.js.map') || (entry.name.endsWith('.js') && fs.existsSync(target.slice(0, -3) + '.ts'))) {
      fs.rmSync(target, { force: true });
    }
  }
}
walk(root);
