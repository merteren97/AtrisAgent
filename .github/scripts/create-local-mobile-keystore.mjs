import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyKeystore } from './prepare-mobile-android-signing.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = path.join(root, '.docs/android-signing');
const keystore = path.join(directory, 'atrisagent-mobile-release.p12');
const secretsFile = path.join(directory, 'github-secrets.env');
const jsonFile = path.join(directory, 'github-secrets.json');
if (spawnSync('git', ['check-ignore', '--quiet', '.docs/android-signing/github-secrets.env'], { cwd: root }).status !== 0) throw new Error('The signing bundle directory must be ignored by Git.');
for (const file of [keystore, secretsFile, jsonFile]) {
  try { await access(file); throw new Error('Signing files already exist. Refusing to replace a signing identity.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await mkdir(directory, { recursive: true, mode: 0o700 });
const password = randomBytes(32).toString('base64url');
const environment = { ...process.env, ANDROID_KEY_ALIAS: 'atrisagent-mobile', ANDROID_KEY_PASSWORD: password, ANDROID_KEYSTORE_PASSWORD: password, ANDROID_KEYSTORE_FILE: keystore };
const keytool = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool') : 'keytool';
const generated = spawnSync(keytool, ['-genkeypair', '-storetype', 'PKCS12', '-keystore', keystore, '-alias', environment.ANDROID_KEY_ALIAS, '-storepass:env', 'ANDROID_KEYSTORE_PASSWORD', '-keypass:env', 'ANDROID_KEY_PASSWORD', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=AtrisAgent Mobile', '-noprompt'], { env: environment, encoding: 'utf8', timeout: 30_000 });
if (generated.error || generated.status !== 0) throw new Error('Could not generate the keystore. Check the JDK 17 installation. No credential values were logged.');
await chmod(keystore, 0o600);
// Save generated passwords immediately, before any later verification could fail.
const secrets = { ANDROID_KEY_BASE64: (await readFile(keystore)).toString('base64'), ANDROID_KEY_ALIAS: environment.ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD: password, ANDROID_KEYSTORE_PASSWORD: password };
await writeFile(secretsFile, Object.entries(secrets).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
await writeFile(jsonFile, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
verifyKeystore(environment);
await writeFile(path.join(directory, 'README.txt'), 'Private Android signing bundle for AtrisAgent.\nKeep this keystore and its passwords backed up; future updates must use the same key.\nDo not commit or share these files.\n\nImport the four secrets from the repository root:\ngh secret set --repo merteren97/AtrisAgent --env-file .docs/android-signing/github-secrets.env\n\nGenerated and validated with the configured JDK. No GitHub secret was changed automatically.\n', { mode: 0o600 });
console.log('Created and verified the signing bundle in .docs/android-signing (Git-ignored). No credentials were printed or uploaded.');
