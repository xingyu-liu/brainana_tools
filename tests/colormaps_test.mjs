// Unit tests for custom LUTs (viewer/src/niivue/colormaps.ts).
// Key invariant: somatotopy is the eccentricity ramp REVERSED (blue at 0 → red at 100).
import assert from 'node:assert/strict'
import { buildColormap, ECCENTRICITY_STOPS, SOMATOTOPY_STOPS, POLAR_STOPS, COLORMAPS, CURVATURE_BINARY } from '../viewer/src/niivue/colormaps.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// buildColormap structure
const cm = buildColormap([
  [255, 0, 0],
  [0, 0, 255],
])
assert.equal(cm.I[0], 0, 'index 0 present')
assert.equal(cm.A[0], 0, 'index 0 transparent')
assert.deepEqual([cm.R[1], cm.G[1], cm.B[1]], [255, 0, 0], 'first stop')
assert.deepEqual([cm.R[2], cm.G[2], cm.B[2]], [0, 0, 255], 'last stop')
assert.ok(cm.I.every((v, i, arr) => i === 0 || v > arr[i - 1]), 'intensities strictly ascending')
assert.equal(cm.I[cm.I.length - 1], 255, 'last intensity is 255')
ok('buildColormap: transparent index 0, ascending intensities, stop colors preserved')

// somatotopy = eccentricity reversed
assert.deepEqual(SOMATOTOPY_STOPS, [...ECCENTRICITY_STOPS].reverse())
assert.deepEqual(SOMATOTOPY_STOPS[0], ECCENTRICITY_STOPS[ECCENTRICITY_STOPS.length - 1], 'somato starts where ecc ends')
assert.deepEqual(SOMATOTOPY_STOPS[0], [0, 0, 255], 'somatotopy 0 = blue')
assert.deepEqual(SOMATOTOPY_STOPS[SOMATOTOPY_STOPS.length - 1], [204, 16, 51], 'somatotopy 100 = red')
ok('somatotopy LUT is the eccentricity ramp reversed (blue 0 → red 100)')

// registered maps present
for (const name of ['brainana_eccentricity', 'brainana_somatotopy', 'brainana_polar_angle', 'brainana_curvature']) {
  assert.ok(COLORMAPS[name], `${name} registered`)
}
assert.equal(COLORMAPS.brainana_curvature, CURVATURE_BINARY)
assert.deepEqual(CURVATURE_BINARY.I, [0, 127, 128, 255], 'curvature is a binary step LUT')
ok('all custom colormaps are present incl. binary curvature')

// polar wheel is cyclic-ish (17 distinct stops)
assert.equal(POLAR_STOPS.length, 17)
for (const c of POLAR_STOPS) for (const ch of c) assert.ok(Number.isInteger(ch) && ch >= 0 && ch <= 255)
ok('polar-angle wheel has 17 valid stops')

console.log(`colormaps_test: ${passed} checks passed`)
