import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decodeKeystore, prepareSigning } from './prepare-mobile-android-signing.mjs';

const tool = name => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', `${name}${process.platform === 'win32' ? '.exe' : ''}`) : name;

test('JDK recovers real JKS/PKCS12 keys and reads escaped signing values exactly', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atris-keystore-validation-'));
  try {
    const reader = path.join(root, 'ReadSigningProperties.java');
    await writeFile(reader, `import java.nio.file.*; import java.util.*;
public class ReadSigningProperties {
  public static void main(String[] args) throws Exception {
    Properties p = new Properties();
    try (var stream = Files.newInputStream(Path.of(args[0]))) { p.load(stream); }
    String[][] pairs = {{"keyAlias","ANDROID_KEY_ALIAS"},{"password","ANDROID_KEY_PASSWORD"},{"storePassword","ANDROID_KEYSTORE_PASSWORD"},{"storeFile","ANDROID_KEYSTORE_FILE"}};
    for (String[] pair : pairs) if (!Objects.equals(p.getProperty(pair[0]), System.getenv(pair[1]))) throw new AssertionError("Property mismatch: " + pair[0]);
  }
}`);
    for (const format of ['JKS', 'PKCS12']) {
      const original = path.join(root, `${format}-original.keystore`);
      const storePassword = format === 'JKS' ? ' store\\pass:=! Ç漢 ' : 'store\\pass:=! $ space';
      const keyPassword = format === 'JKS' ? ' key\\pass:=! Ç漢 ' : storePassword;
      const env = { ...process.env, ANDROID_KEY_ALIAS: 'fixture-key', ANDROID_KEYSTORE_PASSWORD: storePassword, ANDROID_KEY_PASSWORD: keyPassword };
      execFileSync(tool('keytool'), ['-genkeypair', '-keystore', original, '-storetype', format, '-storepass:env', 'ANDROID_KEYSTORE_PASSWORD', '-keypass:env', 'ANDROID_KEY_PASSWORD', '-alias', env.ANDROID_KEY_ALIAS, '-dname', 'CN=CI Fixture', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '1', '-noprompt'], { env, stdio: 'pipe' });
      const originalBytes = await readFile(original);
      const decoded = path.join(root, `${format}-decoded.keystore`);
      const properties = path.join(root, `${format}.properties`);
      const credentials = { ...env, ANDROID_KEY_BASE64: originalBytes.toString('base64').match(/.{1,64}/g).join('\r\n'), ANDROID_KEYSTORE_FILE: decoded };
      await prepareSigning(credentials, properties);
      assert.deepEqual(await readFile(decoded), originalBytes);
      execFileSync(tool('java'), [reader, properties], { env: credentials, stdio: 'pipe' });
      for (const [name, value, code] of [
        ['ANDROID_KEY_ALIAS', 'wrong-alias', 'ALIAS_NOT_FOUND'],
        ['ANDROID_KEYSTORE_PASSWORD', 'wrong-store-secret', 'STORE_UNREADABLE'],
        ['ANDROID_KEY_PASSWORD', 'wrong-key-secret', 'KEY_UNREADABLE'],
      ]) {
        const invalidFile = path.join(root, `${format}-${code}.keystore`);
        const invalidProperties = path.join(root, `${format}-${code}.properties`);
        await assert.rejects(prepareSigning({ ...credentials, [name]: value, ANDROID_KEYSTORE_FILE: invalidFile }, invalidProperties), error => {
          assert.ok(error.message.includes(`ANDROID_SIGNING_${code}:`));
          assert.ok(!error.message.includes(value), 'Diagnostics must not echo credential values');
          return true;
        });
        await assert.rejects(access(invalidFile), 'Failed validation must remove its decoded temporary file');
        await assert.rejects(access(invalidProperties), 'Failed validation must not emit Gradle credentials');
      }
      await assert.rejects(prepareSigning({ ...credentials, ANDROID_KEYSTORE_FILE: original }, properties), { code: 'EEXIST' });
      assert.deepEqual(await readFile(original), originalBytes, 'The original signing identity must not be modified');
      assert.throws(() => decodeKeystore(Buffer.from(originalBytes.toString('base64')).toString('base64')), /does not decode/);
    }
    assert.throws(() => decodeKeystore(Buffer.from('-----BEGIN PRIVATE KEY-----\nnot-a-keystore').toString('base64')), /does not decode/);
    assert.throws(() => decodeKeystore('malformed-base64'), /must be Base64/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
