import fs from "node:fs";
import assert from "node:assert/strict";
const main = fs.readFileSync(
  new URL("../src/main.ts", import.meta.url),
  "utf8",
);
const server = fs.readFileSync(
  new URL("../server.mjs", import.meta.url),
  "utf8",
);
const worker = fs.readFileSync(
  new URL("../src/projection.worker.ts", import.meta.url),
  "utf8",
);
assert.match(server, /atlas-somatotopy/);
assert.match(server, /frames: \{ phase: 0, fstat: 1 \}/);
assert.match(main, /phase\.frame4D = somatotopy\.frames\.phase/);
assert.match(main, /fstat\.frame4D = somatotopy\.frames\.fstat/);
assert.match(main, /value >= 0 && value <= 100/);
assert.match(main, /brainana_somatotopy_0_100/);
assert.match(main, /mode: 'somatotopy'/);
assert.match(worker, /mode === 'somatotopy' \? 100 : 10/);
console.log("Somatotopy integration checks passed");
