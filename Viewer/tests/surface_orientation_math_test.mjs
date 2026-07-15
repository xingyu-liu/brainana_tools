import assert from "node:assert/strict";

function transformDirection(matrix, [x, y, z]) {
  const tx = matrix[0] * x + matrix[4] * y + matrix[8] * z;
  const ty = matrix[1] * x + matrix[5] * y + matrix[9] * z;
  const tz = matrix[2] * x + matrix[6] * y + matrix[10] * z;
  const length = Math.hypot(tx, ty, tz) || 1;
  return [tx / length, ty / length, tz / length];
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
assert.deepEqual(transformDirection(identity, [1, 0, 0]), [1, 0, 0]);
assert.deepEqual(transformDirection(identity, [0, 1, 0]), [0, 1, 0]);
assert.deepEqual(transformDirection(identity, [0, 0, 1]), [0, 0, 1]);

// Column-major 90 degree rotation around camera Z: +X becomes +Y.
const rotateZ90 = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const rotatedRight = transformDirection(rotateZ90, [1, 0, 0]);
assert.ok(Math.abs(rotatedRight[0]) < 1e-12);
assert.ok(Math.abs(rotatedRight[1] - 1) < 1e-12);

// Translation must not alter a direction because the implementation uses w=0.
const translated = [...identity];
translated[12] = 100;
translated[13] = -50;
translated[14] = 30;
assert.deepEqual(transformDirection(translated, [0, 1, 0]), [0, 1, 0]);

// Non-uniform scale is normalized away, preserving only orientation.
const scaled = [4, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1];
assert.deepEqual(transformDirection(scaled, [1, 0, 0]), [1, 0, 0]);
assert.deepEqual(transformDirection(scaled, [0, 0, 1]), [0, 0, 1]);

console.log("surface orientation matrix checks passed");
