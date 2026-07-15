// Unit tests for the pure functional-map math (viewer/src/data/functional.ts).
// Run via Node's native TypeScript support (Node >= 22.18 strips types on import).
import assert from 'node:assert/strict'
import { finiteExtrema, applyThresholdMask, functionalModes, createFunctionalSurfaceLut, quantizeFunctionalSurfaceValues, maskSurfaceBinsByF } from '../viewer/src/data/functional.ts'

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
  [['Polar angle', 0, 1, 'brainana_polar_angle'], ['Eccentricity', 2, 3, 'brainana_eccentricity']],
)
const somato = functionalModes('somatotopy', { phase: 0, fstat: 1 })
assert.deepEqual(somato.map((m) => [m.label, m.valueFrame, m.fFrame, m.colormap]), [['Phase', 0, 1, 'brainana_somatotopy']])
assert.equal(somato[0].colormap, 'brainana_somatotopy', 'somatotopy uses the reversed blue->red LUT')
// display ranges have a slightly-negative cal_min (reserves the transparent LUT slot for masking)
assert.ok(retino[0].calMin < 0 && retino[0].calMax > 3, 'polar cal range')
assert.deepEqual([retino[1].calMin, retino[1].calMax], [-0.0394, 10], 'eccentricity capped at 10')
assert.deepEqual([somato[0].calMin, somato[0].calMax], [-0.3937, 100], 'somatotopy 0-100')
assert.ok(retino[0].calMin < 0 && somato[0].calMin < 0, 'cal_min negative so masked sentinel is transparent')
ok('functionalModes maps manifest frames to value/F frames and LUTs')

// --- createFunctionalSurfaceLut: bin 0 transparent, 256 entries, somatotopy reversed ---
const polarLut = createFunctionalSurfaceLut('polar')
assert.equal(polarLut.lut.length, 256 * 4, '256 RGBA entries')
assert.deepEqual([polarLut.min, polarLut.max], [0, 255])
assert.deepEqual(Array.from(polarLut.lut.slice(0, 4)), [0, 0, 0, 0], 'bin 0 fully transparent')
assert.equal(polarLut.lut[1 * 4 + 3], 255, 'bin 1 opaque')
// bin 1 (t=0) of polar is the green start [0,255,0]
assert.deepEqual(Array.from(polarLut.lut.slice(4, 7)), [0, 255, 0], 'polar bin 1 = green start stop')
// eccentricity: bin 1 (t=0) is red [255,0,0]; somatotopy reverses so its bin 1 (t=0 -> colorT=1) is blue end [0,70,255]
const eccLut = createFunctionalSurfaceLut('eccentricity')
const somLut = createFunctionalSurfaceLut('somatotopy')
assert.deepEqual(Array.from(eccLut.lut.slice(4, 7)), [255, 0, 0], 'eccentricity bin 1 = red')
assert.deepEqual(Array.from(somLut.lut.slice(4, 7)), [0, 70, 255], 'somatotopy bin 1 reversed = blue end')
assert.deepEqual(Array.from(somLut.lut.slice(255 * 4, 255 * 4 + 3)), [255, 0, 0], 'somatotopy bin 255 = red start')
ok('createFunctionalSurfaceLut: 256 entries, bin 0 transparent, somatotopy ramp reversed')

// brightness > 1 blends toward white; < 1 scales down
const bright = createFunctionalSurfaceLut('eccentricity', 1.5)
const dim = createFunctionalSurfaceLut('eccentricity', 0.5)
// eccentricity bin 1 = [255,0,0]; brighten pushes G,B up toward white, R stays 255
assert.ok(bright.lut[4 + 1] > eccLut.lut[4 + 1], 'brightness>1 raises green channel toward white')
assert.equal(dim.lut[4], Math.round(255 * 0.5), 'brightness<1 scales red channel down')
ok('surface LUT brightness blends toward white (>1) and scales down (<1), LUT-only')

// --- quantizeFunctionalSurfaceValues: sentinel -> 0, caps, bin range 1..255 ---
const q = quantizeFunctionalSurfaceValues(new Float32Array([-1000, NaN, -999, 0, 5, 10, 15]), 'eccentricity')
assert.equal(q[0], 0, '-1000 sentinel -> bin 0')
assert.equal(q[1], 0, 'NaN -> bin 0')
assert.equal(q[2], 0, '<= -999 -> bin 0')
assert.equal(q[3], 1, 'value 0 -> bin 1')
assert.equal(q[5], 255, 'value at max (10) -> bin 255')
assert.equal(q[6], 255, 'value above max clamps to bin 255')
assert.ok(q[4] > 1 && q[4] < 255, 'mid value maps into 1..255')
// polar wraps: -PI and +PI both wrap to the same end region
const qp = quantizeFunctionalSurfaceValues(new Float32Array([-Math.PI, 0, Math.PI]), 'polar')
assert.ok(qp.every((b) => b >= 1 && b <= 255), 'polar values map to opaque bins')
// somatotopy uses max 100
const qs = quantizeFunctionalSurfaceValues(new Float32Array([0, 50, 100]), 'somatotopy')
assert.equal(qs[0], 1)
assert.equal(qs[2], 255, 'somatotopy 100 -> bin 255')
ok('quantizeFunctionalSurfaceValues: sentinel->0, caps at max, bins 1..255')

// --- maskSurfaceBinsByF: sub-threshold / non-finite F -> bin 0 ---
const binsIn = new Float32Array([120, 200, 55, 30])
const fSurf = new Float32Array([1.0, 6.0, NaN, 5.0])
const maskedBins = maskSurfaceBinsByF(binsIn, fSurf, 5.0)
assert.equal(maskedBins[0], 0, 'F below threshold -> bin 0 (hidden)')
assert.equal(maskedBins[1], 200, 'F above threshold -> bin kept')
assert.equal(maskedBins[2], 0, 'non-finite F -> bin 0')
assert.equal(maskedBins[3], 30, 'F exactly at threshold -> kept')
ok('maskSurfaceBinsByF hides sub-threshold vertices on the surface')

console.log(`functional_test: ${passed} checks passed`)
