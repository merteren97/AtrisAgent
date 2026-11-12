import { readFile, writeFile } from 'node:fs/promises';

const file = 'apps/mobile/src-tauri/gen/android/app/build.gradle.kts';
const text = await readFile(file, 'utf8');
if (text.includes('signingConfigs.getByName("release")')) throw new Error('Release signing already configured; inspect generated project.');
const imports = 'import java.io.FileInputStream\nimport java.util.Properties\n';
const block = `
    signingConfigs {
        create("release") {
            val properties = Properties()
            properties.load(FileInputStream(rootProject.file("keystore.properties")))
            keyAlias = properties["keyAlias"] as String
            keyPassword = properties["password"] as String
            storeFile = file(properties["storeFile"] as String)
            storePassword = properties["storePassword"] as String
        }
    }
`;
if (!/\n\s*buildTypes\s*\{/.test(text)) throw new Error('Android buildTypes block missing');
let updated = `${imports}${text}`.replace(/(\n\s*buildTypes\s*\{)/, `${block}$1`);
if (/getByName\("release"\)\s*\{/.test(updated)) updated = updated.replace(/(getByName\("release"\)\s*\{)/, '$1\n            signingConfig = signingConfigs.getByName("release")');
else if (/\n\s*release\s*\{/.test(updated)) updated = updated.replace(/(\n\s*release\s*\{)/, '$1\n            signingConfig = signingConfigs.getByName("release")');
else throw new Error('Android release build type missing');
await writeFile(file, updated);
