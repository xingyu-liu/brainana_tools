import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const docs = path.join(root, "Documentation");
const required = [
  "README.md",
  "BUILD.md",
  "CHANGELOG.md",
  "ARCHITECTURE.md",
  "FEATURE_PARITY.md",
  "VALIDATION.md",
  "TECHNICAL_FINDINGS.md",
  "VERSION.json",
];
const missing = required.filter(
  (name) => !fs.existsSync(path.join(docs, name)),
);
const forbidden = [];
for (const dir of [root, docs])
  for (const name of fs.readdirSync(dir)) {
    if (
      /^(CHANGELOG|ARCHITECTURE|VALIDATION|README)-v?\d/i.test(name) ||
      /^(CHANGELOG|ARCHITECTURE|VALIDATION|README)-\d/i.test(name)
    )
      forbidden.push(path.relative(root, path.join(dir, name)));
  }
if (missing.length || forbidden.length) {
  if (missing.length)
    console.error(`Missing canonical docs: ${missing.join(", ")}`);
  if (forbidden.length)
    console.error(`Version-stamped duplicate docs: ${forbidden.join(", ")}`);
  process.exit(1);
}
console.log("documentation structure passed");
