import fs from "node:fs";
import assert from "node:assert/strict";

const source = fs.readFileSync(
  new URL("../src/main.ts", import.meta.url),
  "utf8",
);
assert.match(source, /function finiteFrameRange\(image: NVImage\)/);
assert.match(source, /slider\.min = String\(range\.min\)/);
assert.match(source, /slider\.max = String\(safeMax\)/);
assert.match(source, /updateFunctionalThresholdRange\(\)/);
assert.match(source, /mode === 'somatotopy' \? 1 - t : t/);

const stops = [
  { t: 0, rgb: [255, 0, 0] },
  { t: 1, rgb: [0, 70, 255] },
];
function interpolate(stops, t) {
  const left = stops[0],
    right = stops[1];
  return left.rgb.map((v, i) => Math.round(v + (right.rgb[i] - v) * t));
}
const somatoAt0 = interpolate(stops, 1 - 0);
const somatoAt100 = interpolate(stops, 1 - 1);
assert.deepEqual(somatoAt0, [0, 70, 255]);
assert.deepEqual(somatoAt100, [255, 0, 0]);
console.log("v1.2.22 threshold range and somatotopy inversion checks passed");
