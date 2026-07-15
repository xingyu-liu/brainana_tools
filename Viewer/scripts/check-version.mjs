import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const version = JSON.parse(
  fs.readFileSync(path.join(root, "VERSION.json"), "utf8"),
);
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const files = {
  launcher: fs.readFileSync(
    path.join(root, "launcher", "brainana-launcher"),
    "utf8",
  ),
  packageScript: fs.readFileSync(
    path.join(root, "scripts", "package-macos.sh"),
    "utf8",
  ),
};
const errors = [];
if (pkg.version !== version.version)
  errors.push(`package.json ${pkg.version} != VERSION.json ${version.version}`);
if (!files.launcher.includes(`APP_VERSION="${version.version}"`))
  errors.push("launcher version mismatch");
if (!files.launcher.includes(`BUILD_ID="${version.buildId}"`))
  errors.push("launcher build ID mismatch");
if (!files.packageScript.includes(`VERSION="${version.version}"`))
  errors.push("packaging version mismatch");
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(
  `version consistency passed: ${version.version} (${version.buildId})`,
);
