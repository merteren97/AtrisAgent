import fs from "node:fs";
import path from "node:path";

const packageRoot = process.cwd();
const repositoryRoot = path.resolve(packageRoot, "../..");
const output = path.join(packageRoot, "public");
const landingOutput = path.join(repositoryRoot, "apps", "landing", "out");
const landingPublic = path.join(repositoryRoot, "apps", "landing", "public");

if (!fs.existsSync(landingOutput)) {
  throw new Error(`Landing static export is missing: ${landingOutput}`);
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.cpSync(landingOutput, output, { recursive: true });

for (const asset of ["logo.svg", "favicon.svg"]) {
  const source = path.join(landingPublic, asset);
  if (!fs.existsSync(source)) throw new Error(`Landing branding asset is missing: ${source}`);
  fs.copyFileSync(source, path.join(output, asset));
}

console.log(`Copied landing export to ${output}`);
