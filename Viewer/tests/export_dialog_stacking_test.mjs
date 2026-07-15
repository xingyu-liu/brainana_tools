import fs from "node:fs";
import assert from "node:assert/strict";

const css = fs.readFileSync(
  new URL("../src/style.css", import.meta.url),
  "utf8",
);
const source = fs.readFileSync(
  new URL("../src/main.ts", import.meta.url),
  "utf8",
);

assert.match(
  css,
  /#snapshot-workstation-folder-dialog\s*\{[^}]*z-index:\s*1100/s,
);
assert.match(css, /\.snapshot-dialog\s*\{[^}]*z-index:\s*1000/s);
assert.match(
  source,
  /Select the destination folder here, then use the Export button in the main export window\./,
);
assert.match(
  source,
  /id="snapshot-workstation-folder-select"[^>]*>Use this folder<\/button>/,
);
assert.match(
  source,
  /document\.getElementById\('snapshot-save'\).*?\.focus\(\)/s,
);
assert.match(
  source,
  /document\.getElementById\('snapshot-save'\)!\.addEventListener\('click',[\s\S]*?saveSnapshot\(\)/,
);
console.log("export dialog stacking and workflow checks passed");

assert.match(source, /id="snapshot-choose-local-folder"/);
assert.match(source, /id="snapshot-choose-workstation-folder"/);
assert.match(source, /snapshotWorkstationPath = null/);
assert.match(source, /snapshotSubjectDirectory = null/);
console.log("local and workstation export destination choices passed");
