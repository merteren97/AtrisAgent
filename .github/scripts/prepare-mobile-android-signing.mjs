import { writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// java.util.Properties.load(InputStream) uses ISO-8859-1 and interprets escapes.
// Encode every significant/non-ASCII UTF-16 code unit without trimming secrets.
export function propertyValue(value) {
  return value.replace(/[\u0000-\u0020\\:=#!\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function decodeKeystore(value) {
  const encoded = value.replace(/\s/g, '');
  if (!encoded || encoded.length > 2_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new Error('ANDROID_KEY_BASE64 must be Base64 of the original binary JKS/PKCS12 file.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '') || bytes.length < 32) throw new Error('ANDROID_KEY_BASE64 is invalid or truncated.');
  if (bytes.subarray(0, 4).equals(Buffer.from([0xfe, 0xed, 0xfe, 0xed])) || bytes[0] === 0x30) return bytes;
  throw new Error('ANDROID_KEY_BASE64 does not decode to a JKS/PKCS12 keystore. Encode the keystore file itself, not a PEM key, ZIP, text signing key, or a second Base64 string.');
}

export function verifyKeystore(environment) {
  const java = environment.JAVA_HOME ? path.join(environment.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  const validation = spawnSync(java, [fileURLToPath(new URL('./VerifyAndroidKeystore.java', import.meta.url))], { env: environment, encoding: 'utf8', timeout: 30_000 });
  if (validation.error || validation.status !== 0) {
    const diagnostic = validation.stderr?.split(/\r?\n/).find(line => /^ANDROID_SIGNING_[A-Z_]+: /.test(line));
    throw new Error(diagnostic || 'Android keystore validation could not run. A JDK 17+ installation is required.');
  }
}

export async function prepareSigning(environment = process.env, propertiesFile = 'apps/mobile/src-tauri/gen/android/keystore.properties') {
  for (const name of ['ANDROID_KEY_BASE64', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEYSTORE_FILE']) {
    if (typeof environment[name] !== 'string' || !environment[name]) throw new Error(`Missing ${name}.`);
  }
  const bytes = decodeKeystore(environment.ANDROID_KEY_BASE64);
  const file = path.resolve(environment.ANDROID_KEYSTORE_FILE);
  // Refuse to overwrite an existing file, including an operator's original key.
  await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
  try {
    verifyKeystore({ ...environment, ANDROID_KEYSTORE_FILE: file });
    const properties = { keyAlias: environment.ANDROID_KEY_ALIAS, password: environment.ANDROID_KEY_PASSWORD, storePassword: environment.ANDROID_KEYSTORE_PASSWORD, storeFile: file };
    await writeFile(propertiesFile, Object.entries(properties).map(([key, value]) => `${key}=${propertyValue(value)}`).join('\n') + '\n', { mode: 0o600 });
  } catch (error) { await rm(file, { force: true }); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await prepareSigning(); console.log('Android keystore and private key verified; signing configuration prepared.'); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Android signing validation failed.'); process.exitCode = 1; }
}
