// Unit tests for the ported ROI/warp math (viewer/src/data/roiWarp.ts, from Align).
import assert from 'node:assert/strict'
import { flatIndex, determinant3, applyAffine, invertAffine, sampleNearest, sampleLinear, createGaussianRoi, normalizePositive, fslVoxelToMm, scalarCorrelation } from '../viewer/src/data/roiWarp.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const IDENT = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
]
const raw = (dims, affine, values) => ({ dims, frameCount: 1, affine, pixDims: [1, 1, 1], values, datatypeCode: 16, littleEndian: true, slope: 1, intercept: 0 })

// flatIndex + affine primitives
assert.equal(flatIndex(1, 2, 3, [4, 4, 4]), 1 + 4 * (2 + 4 * 3))
assert.equal(determinant3(IDENT), 1)
assert.deepEqual(applyAffine(IDENT, [1, 2, 3]), [1, 2, 3])
ok('flatIndex, determinant3, applyAffine on identity')

// invertAffine: identity and a scale+translate
assert.deepEqual(invertAffine(IDENT), IDENT)
const M = [
  [2, 0, 0, 5],
  [0, 2, 0, -3],
  [0, 0, 2, 1],
  [0, 0, 0, 1],
]
const roundtrip = applyAffine(invertAffine(M), applyAffine(M, [3, 4, 5]))
for (let i = 0; i < 3; i++) assert.ok(Math.abs(roundtrip[i] - [3, 4, 5][i]) < 1e-9)
assert.throws(() => invertAffine([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]]), /singular/i)
ok('invertAffine inverts (identity, scale+translate) and rejects singular')

// interpolation
const vals = new Float32Array(8) // 2x2x2
vals[flatIndex(0, 0, 0, [2, 2, 2])] = 10
vals[flatIndex(1, 0, 0, [2, 2, 2])] = 20
assert.equal(sampleNearest(vals, [2, 2, 2], [0, 0, 0]), 10)
assert.equal(sampleNearest(vals, [2, 2, 2], [1, 0, 0]), 20)
assert.ok(Math.abs(sampleLinear(vals, [2, 2, 2], [0.5, 0, 0]) - 15) < 1e-6, 'trilinear midpoint = 15')
assert.equal(sampleNearest(vals, [2, 2, 2], [-1, 0, 0]), 0, 'out of bounds → 0')
ok('sampleNearest + trilinear sampleLinear (out-of-bounds → 0)')

// Gaussian ROI: center voxel forced to 1, cube-clipped, positive falloff
const roi = createGaussianRoi(raw([8, 8, 8], IDENT, new Float32Array(512)), [4, 4, 4], 4)
assert.equal(roi.values[flatIndex(4, 4, 4, [8, 8, 8])], 1, 'center voxel = 1')
assert.ok(roi.positiveCount > 1, 'ROI has a positive neighbourhood')
assert.ok(Math.abs(roi.fwhmMm - 2) < 1e-9 && roi.sigmaMm > 0, 'FWHM = extent/2')
// cube clip: no positive voxel beyond halfExtent (2mm) on any axis
assert.equal(roi.values[flatIndex(7, 4, 4, [8, 8, 8])], 0, 'beyond halfExtent → 0 (cube clip)')
assert.throws(() => createGaussianRoi(raw([8, 8, 8], IDENT, new Float32Array(512)), [4, 4, 4], 0.5), /extent/i)
ok('createGaussianRoi: center=1, FWHM=extent/2, cube-clipped, extent bounds enforced')

// normalizePositive
const nv = Float32Array.from([0, 0.5, 2, 1])
assert.equal(normalizePositive(nv), 2)
assert.ok(Math.abs(nv[2] - 1) < 1e-9 && Math.abs(nv[1] - 0.25) < 1e-9, 'rescaled so max = 1')
assert.throws(() => normalizePositive(Float32Array.from([0, 0, 0])), /empty/i)
assert.throws(() => normalizePositive(Float32Array.from([0, -1])), /negative/i)
ok('normalizePositive rescales to max=1 and rejects empty/negative')

// FSL handedness: det>0 flips X (reproduces nifti_image_to_mat44)
const fsl = fslVoxelToMm(raw([4, 4, 4], IDENT, new Float32Array(64)))
assert.ok(fsl[0][0] < 0, 'positive-determinant affine → X axis flipped in FSL scaled-voxel mm')
ok('fslVoxelToMm applies the FSL handedness flip for det>0')

// scalarCorrelation
const a = Float32Array.from([1, 2, 3, 4, 5])
assert.ok(Math.abs(scalarCorrelation(a, a) - 1) < 1e-6, 'self-correlation = 1')
assert.ok(scalarCorrelation(a, Float32Array.from([5, 4, 3, 2, 1])) < -0.99, 'reversed → -1')
ok('scalarCorrelation: 1 for identical, -1 for reversed')

console.log(`roiwarp_test: ${passed} checks passed`)
