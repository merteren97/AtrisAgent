import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);

export function checkDevRuntime() {
  const node = {
    ok: Number(process.versions.node.split('.')[0]) === 22,
    detail: `${process.version} (ABI ${process.versions.modules}); Node.js 22 LTS required`,
  };

  let sqlite;
  try {
    // Requiring alone does not load the .node binary; opening a memory DB does.
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.close();
    sqlite = { ok: true, detail: `native addon loads with ABI ${process.versions.modules}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sqlite = {
      ok: false,
      detail: message.includes('NODE_MODULE_VERSION')
        ? `native addon was built for another Node.js ABI (current: ${process.versions.modules})`
        : message.split(/\r?\n/)[0],
    };
  }

  return { node, sqlite };
}
