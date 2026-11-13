import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncMobileIosIcons } from './sync-mobile-ios-icons.mjs';

test('replaces generated iOS app icons and rejects missing or unsafe inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atris-ios-icons-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'catalog');
  try {
    await mkdir(source); await mkdir(destination);
    const names = ['AppIcon-60x60@2x.png', 'AppIcon-512@2x.png'];
    for (const name of names) { await writeFile(path.join(source, name), `brand-${name}`); await writeFile(path.join(destination, name), 'default'); }
    await writeFile(path.join(destination, 'Contents.json'), JSON.stringify({ images: names.map(filename => ({ filename })) }));
    await syncMobileIosIcons(source, destination);
    for (const name of names) assert.equal(await readFile(path.join(destination, name), 'utf8'), `brand-${name}`);
    await writeFile(path.join(destination, 'Contents.json'), JSON.stringify({ images: [...names, '../escape.png'].map(filename => ({ filename })) }));
    await assert.rejects(syncMobileIosIcons(source, destination));
    await writeFile(path.join(destination, 'Contents.json'), JSON.stringify({ images: [{ filename: names[0] }] }));
    await assert.rejects(syncMobileIosIcons(source, destination));
  } finally { await rm(root, { recursive: true, force: true }); }
});
