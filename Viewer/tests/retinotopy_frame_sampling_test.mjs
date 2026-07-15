import fs from "node:fs";
const source = fs.readFileSync(
  new URL("../src/main.ts", import.meta.url),
  "utf8",
);
const matches = [
  ...source.matchAll(/image\.getValue\(x, y, z, image\.frame4D\)/g),
];
if (matches.length < 2)
  throw new Error(
    `Expected both retinotopy samplers to pass image.frame4D, found ${matches.length}`,
  );

class MockImage {
  constructor(frame4D) {
    this.frame4D = frame4D;
  }
  getValue(_x, _y, _z, frame4D = 0) {
    return [0.25, 7.5, 3.25, 12.0][frame4D];
  }
}
const values = [0, 1, 2, 3].map((frame) => {
  const image = new MockImage(frame);
  return image.getValue(1, 2, 3, image.frame4D);
});
const expected = [0.25, 7.5, 3.25, 12.0];
if (JSON.stringify(values) !== JSON.stringify(expected))
  throw new Error(`Frame sampling mismatch: ${values}`);
console.log("retinotopy frame sampling test passed", values);
