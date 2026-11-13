import { access, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function syncMobileIosIcons(source, destination) {
  const catalog = JSON.parse(await readFile(path.join(destination, 'Contents.json'), 'utf8'));
  if (!Array.isArray(catalog.images)) throw new Error('Invalid iOS app icon catalog');
  const filenames = catalog.images.map(image => image.filename).filter(Boolean);
  if (!filenames.includes('AppIcon-60x60@2x.png') || !filenames.includes('AppIcon-512@2x.png')) throw new Error('Missing required iPhone or marketing icon');
  for (const name of filenames) {
    if (typeof name !== 'string' || path.basename(name) !== name || !/^AppIcon-[a-zA-Z0-9@.\-]+\.png$/.test(name)) throw new Error('Invalid iOS app icon filename');
    await access(path.join(source, name));
  }
  for (const name of filenames) await copyFile(path.join(source, name), path.join(destination, name));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncMobileIosIcons('apps/mobile/src-tauri/icons/ios', 'apps/mobile/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset');
}
