import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const requiredSource = [
  "src/main.ts",
  "server.mjs",
  "remote-filesystem.mjs",
  "launcher/brainana-launcher",
  "package.json",
  "package-lock.json",
  "VERSION.json",
  "Documentation/README.md",
  "Documentation/BUILD.md",
  "Documentation/CHANGELOG.md",
  "Documentation/ARCHITECTURE.md",
  "Documentation/FEATURE_PARITY.md",
  "Documentation/VALIDATION.md",
  "Documentation/TECHNICAL_FINDINGS.md",
];
const missing = requiredSource.filter(
  (p) => !fs.existsSync(path.join(root, p)),
);
const stamped = [];
for (const p of fs.readdirSync(path.join(root, "Documentation")))
  if (/-(?:v?\d+\.)+\d+\.md$/i.test(p)) stamped.push(p);
if (missing.length || stamped.length) {
  if (missing.length)
    console.error("Missing release files:", missing.join(", "));
  if (stamped.length)
    console.error("Duplicate version-stamped docs:", stamped.join(", "));
  process.exit(1);
}
console.log("release source checklist passed");
