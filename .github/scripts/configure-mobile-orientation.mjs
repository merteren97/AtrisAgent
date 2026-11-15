import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export function androidPortrait(xml) {
  const activity = /<activity\b[^>]*android:name="\.MainActivity"[^>]*>/;
  if (!activity.test(xml)) throw new Error('MainActivity not found in Android manifest');
  return xml.replace(activity, tag => tag.includes('android:screenOrientation=') ? tag.replace(/android:screenOrientation="[^"]*"/, 'android:screenOrientation="portrait"') : tag.replace('<activity', '<activity android:screenOrientation="portrait"'));
}

export function iosPortrait(xml) {
  if (!xml.includes('</dict>')) throw new Error('Invalid iOS plist');
  let result = xml;
  for (const key of ['UISupportedInterfaceOrientations', 'UISupportedInterfaceOrientations~ipad']) {
    const entry = new RegExp(`<key>${key}</key>\\s*<array>[\\s\\S]*?</array>`, 'g');
    const value = `<key>${key}</key>\n<array><string>UIInterfaceOrientationPortrait</string></array>`;
    result = entry.test(result) ? result.replace(entry, value) : result.replace('</dict>', `${value}\n</dict>`);
  }
  if (!result.includes('<key>NSCameraUsageDescription</key>')) result = result.replace('</dict>', '<key>NSCameraUsageDescription</key>\n<string>Scan the QR code to connect your desktop.</string>\n</dict>');
  return result;
}

async function main() {
  const platform = process.argv[2];
  if (platform === 'android') {
    const file = 'apps/mobile/src-tauri/gen/android/app/src/main/AndroidManifest.xml';
    await writeFile(file, androidPortrait(await readFile(file, 'utf8')));
  } else if (platform === 'ios') {
    const root = 'apps/mobile/src-tauri/gen/apple';
    const dirs = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('_iOS'));
    if (dirs.length !== 1) throw new Error('Expected one generated iOS application directory');
    const file = path.join(root, dirs[0].name, 'Info.plist');
    await writeFile(file, iosPortrait(await readFile(file, 'utf8')));
  } else throw new Error('Specify android or ios');
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('.github/scripts/configure-mobile-orientation.mjs')) await main();
