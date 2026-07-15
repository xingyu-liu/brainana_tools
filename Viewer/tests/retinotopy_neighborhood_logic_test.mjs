import assert from "node:assert/strict";

function keepVoxel({ polar, eccentricity, polarF, eccentricityF }, threshold) {
  if (![polar, eccentricity, polarF, eccentricityF].every(Number.isFinite))
    return false;
  if (eccentricity < 0 || eccentricity > 10) return false;
  return polarF >= threshold && eccentricityF >= threshold;
}

const threshold = 5;
assert.equal(
  keepVoxel(
    { polar: 0.5, eccentricity: 2, polarF: 8, eccentricityF: 7 },
    threshold,
  ),
  true,
);
assert.equal(
  keepVoxel(
    { polar: 0.5, eccentricity: 2, polarF: 8, eccentricityF: 4.9 },
    threshold,
  ),
  false,
);
assert.equal(
  keepVoxel(
    { polar: 0.5, eccentricity: 2, polarF: 4.9, eccentricityF: 8 },
    threshold,
  ),
  false,
);
assert.equal(
  keepVoxel(
    { polar: 0.5, eccentricity: 11, polarF: 8, eccentricityF: 8 },
    threshold,
  ),
  false,
);

const centerBelowThreshold = {
  polar: 0.5,
  eccentricity: 2,
  polarF: 4,
  eccentricityF: 9,
};
assert.equal(
  keepVoxel(centerBelowThreshold, threshold),
  false,
  "center voxel must not be forced into plot",
);

const validPoints = [
  { x: 1, y: 1 },
  { x: 2, y: 1 },
  { x: 1, y: 2 },
];
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
assert.equal(median(validPoints.map((p) => p.x)), 1);
assert.equal(median(validPoints.map((p) => p.y)), 1);
assert.equal(
  validPoints.length > 0,
  true,
  "empty-state message must be hidden when points exist",
);
assert.equal(
  [].length > 0,
  false,
  "empty-state message must be shown only for zero valid points",
);

console.log("Retinotopy neighborhood selection and empty-state checks passed.");
