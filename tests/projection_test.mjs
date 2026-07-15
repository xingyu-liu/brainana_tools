// Unit tests for the pure ribbon projection (viewer/src/data/projection.ts).
import assert from 'node:assert/strict'
import { buildRibbon, projectAtlas, projectFunction, SAMPLE_COUNT, RIBBON_WEIGHTS, UNPROJECTED } from '../viewer/src/data/projection.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// Identity world→voxel map on a 4x4x4 grid.
const map = { origin: [0, 0, 0], axisX: [1, 0, 0], axisY: [0, 1, 0], axisZ: [0, 0, 1], dims: [4, 4, 4] }
const flat = (x, y, z) => x + y * 4 + z * 16

// One vertex: white at (1,1,1), pial at (1,1,1) → all 9 samples hit voxel (1,1,1).
const white = new Float32Array([1, 1, 1])
const pial = new Float32Array([1, 1, 1])
const ribbon = buildRibbon({ whitePts: white, pialPts: pial, map })
assert.equal(ribbon.length, SAMPLE_COUNT)
assert.ok([...ribbon].every((v) => v === flat(1, 1, 1)), 'all samples map to voxel (1,1,1)')
ok('buildRibbon maps interior samples to the correct flat voxel index')

// out-of-bounds → -1
const oob = buildRibbon({ whitePts: new Float32Array([9, 9, 9]), pialPts: new Float32Array([9, 9, 9]), map })
assert.ok([...oob].every((v) => v === -1), 'out-of-bounds samples are -1')
ok('buildRibbon marks out-of-bounds samples as -1')

// --- projectAtlas: modal nonzero label ---
const vol = new Float32Array(64)
vol[flat(1, 1, 1)] = 7
const atlas = projectAtlas(ribbon, vol, 1)
assert.equal(atlas[0], 7, 'modal label is 7')
// background (0) ignored: if the voxel were 0, output 0
const volZero = new Float32Array(64)
assert.equal(projectAtlas(ribbon, volZero, 1)[0], 0, 'all-background → 0')
ok('projectAtlas returns the modal nonzero label (background ignored)')

// modal vote: mix labels across samples via two vertices mapping to different voxels
// vertex A samples voxel with label 3, vertex B voxel with label 5
const white2 = new Float32Array([1, 1, 1, 2, 2, 2])
const pial2 = new Float32Array([1, 1, 1, 2, 2, 2])
const ribbon2 = buildRibbon({ whitePts: white2, pialPts: pial2, map })
const vol2 = new Float32Array(64)
vol2[flat(1, 1, 1)] = 3
vol2[flat(2, 2, 2)] = 5
const atlas2 = projectAtlas(ribbon2, vol2, 2)
assert.deepEqual([atlas2[0], atlas2[1]], [3, 5])
ok('projectAtlas votes per vertex independently')

// --- projectFunction: value mode, threshold gating ---
const values = new Float32Array(64)
const thr = new Float32Array(64)
values[flat(1, 1, 1)] = 4 // eccentricity 4°
thr[flat(1, 1, 1)] = 10 // F-stat 10
const fn = projectFunction(ribbon, values, thr, 5, 'value', 10, 1)
assert.ok(Math.abs(fn[0] - 4) < 1e-6, 'value-mode returns the eccentricity value')
// below threshold → UNPROJECTED
const fnBelow = projectFunction(ribbon, values, thr, 20, 'value', 10, 1)
assert.equal(fnBelow[0], UNPROJECTED, 'below-threshold vertex is unprojected')
ok('projectFunction (value): thresholds by F-stat, returns value, -1000 when unprojected')

// --- projectFunction: polar circular mean ---
const pv = new Float32Array(64)
const pf = new Float32Array(64)
pv[flat(1, 1, 1)] = Math.PI / 2 // angle 90°
pf[flat(1, 1, 1)] = 8
const polar = projectFunction(ribbon, pv, pf, 5, 'polar', 0, 1)
assert.ok(Math.abs(polar[0] - Math.PI / 2) < 1e-6, 'polar circular mean recovers the angle')
ok('projectFunction (polar): circular mean of the dominant bin recovers the angle')

// weights are the triangular kernel
assert.deepEqual(RIBBON_WEIGHTS, [1, 2, 3, 4, 5, 4, 3, 2, 1])
ok('ribbon weights are the triangular [1..5..1] kernel')

console.log(`projection_test: ${passed} checks passed`)
