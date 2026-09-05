import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function expectedReleaseAssets(tag) {
  if (!/^v\d+\.\d+\.\d+(?:-\d+)?$/.test(tag)) throw new Error(`Invalid canonical release tag: ${tag}`);
  const version = tag.slice(1);
  const packages = [
    `AtrisAgent_${version}_x64-setup.exe`,
    `AtrisAgent_${version}_x64_en-US.msi`,
    `AtrisAgent_${version}_amd64.AppImage`,
    `AtrisAgent_${version}_amd64.deb`,
  ];
  return { packages, signedAssets: packages.flatMap((name) => [name, `${name}.sig`]) };
}

export function validateReleaseAssets(directory, tag) {
  const { packages, signedAssets } = expectedReleaseAssets(tag);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const actual = entries.map(({ name }) => name).sort();
  const expected = [...signedAssets].sort();
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) || actual.join("\n") !== expected.join("\n")) {
    throw new Error(`Release asset allowlist mismatch. Expected: ${expected.join(", ")}; found: ${actual.join(", ")}`);
  }

  const hashes = signedAssets.sort().map((name) => {
    const bytes = fs.readFileSync(path.join(directory, name));
    if (bytes.length === 0) throw new Error(`Release asset is empty: ${name}`);
    return `${crypto.createHash("sha256").update(bytes).digest("hex")}  ${name}`;
  });
  fs.writeFileSync(path.join(directory, "SHA256SUMS"), `${hashes.join("\n")}\n`, "utf8");
  return { packages, hashes };
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    const [directory, tag] = process.argv.slice(2);
    if (!directory || !tag) throw new Error("Usage: node validate-release-assets.mjs <directory> <canonical-tag>");
    const result = validateReleaseAssets(directory, tag);
    console.log(`Validated ${result.packages.length} exact signed packages and wrote SHA256SUMS`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
