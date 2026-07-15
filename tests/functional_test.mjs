// Unit tests for the pure functional-map math (viewer/src/data/functional.ts).
// Run via Node's native TypeScript support (Node >= 22.18 strips types on import).
import assert from 'node:assert/strict'
import { finiteExtrema, applyThresholdMask, functionalModes } from '../viewer/src/data/functional.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// --- finiteExtrema ignores NaN/Infinity ---
assert.deepEqual(finiteExtrema([3, 1, 4, 1, 5]), { min: 1, max: 5 })
assert.deepEqual(finiteExtrema([NaN, 2, Infinity, -1, -Infinity]), { min: -1, max: 2 }, 'non-finite samples ignored')
assert.deepEqual(finiteExtrema([NaN, Infinity]), { min: 0, max: 0 }, 'all non-finite -> {0,0}')
assert.deepEqual(finiteExtrema(new Float32Array([0.5, -0.5, 2.5])), { min: -0.5, max: 2.5 })
ok('finiteExtrema returns exact finite extrema, ignoring non-finite')

// --- applyThresholdMask keeps value only where F-stat finite and >= threshold ---
const value = new Float32Array([10, 20, 30, 40])
const fstat = new Float32Array([0.1, 5.0, NaN, 2.0])
const masked = applyThresholdMask(value, fstat, 2.0)
assert.ok(Number.isNaN(masked[0]), 'below-threshold F -> NaN')
assert.equal(masked[1], 20, 'above-threshold F -> value kept')
assert.ok(Number.isNaN(masked[2]), 'non-finite F -> NaN')
assert.equal(masked[3], 40, 'F exactly at threshold -> kept')
ok('applyThresholdMask masks by the F-stat frame (>= threshold, finite only)')

// threshold at the max keeps only the strongest voxels
const strict = applyThresholdMask(value, fstat, 5.0)
assert.equal(strict[1], 20)
assert.ok(Number.isNaN(strict[3]), 'raising threshold removes weaker voxels')
ok('raising the threshold progressively removes weaker voxels')

// --- functionalModes wiring from manifest frame indices ---
const retino = functionalModes('retinotopy', { polar: 0, polarF: 1, eccentricity: 2, eccentricityF: 3 })
assert.deepEqual(
  retino.map((m) => [m.label, m.valueFrame, m.fFrame, m.colormap]),
  [['Polar angle', 0, 1, 'hsv'], ['Eccentricity', 2, 3, 'plasma']],
)
const somato = functionalModes('somatotopy', { phase: 0, fstat: 1 })
assert.deepEqual(somato.map((m) => [m.label, m.valueFrame, m.fFrame, m.colormap]), [['Phase', 0, 1, 'blue2red']])
assert.equal(somato[0].colormap, 'blue2red', 'somatotopy uses the reversed blue->red LUT')
ok('functionalModes maps manifest frames to value/F frames and LUTs')

console.log(`functional_test: ${passed} checks passed`)
