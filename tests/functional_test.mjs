// Unit tests for the pure functional-map math (viewer/src/data/functional.ts).
// Run via Node's native TypeScript support (Node >= 22.18 strips types on import).
import assert from 'node:assert/strict'
import { finiteExtrema, applyThresholdMask, functionalModes, createFunctionalSurfaceLut, quantizeFunctionalSurfaceValues, maskSurfaceBinsByF, maskSurfaceBinsByValue, surfaceLutFromColormap, mapFunctionalDisplay, quantizeScalarToBins } from '../apps/viewer/src/data/functional.ts'

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
  [['polar angle', 0, 1, 'brainana_polar_lr'], ['eccentricity', 2, 3, 'brainana_eccentricity']],
)
// Stable ids drive rendering logic (legend shape / surface LUT) independent of label casing.
assert.deepEqual(retino.map((m) => m.id), ['polar', 'eccentricity'], 'retinotopy mode ids')
const somato = functionalModes('somatotopy', { phase: 0, fstat: 1 })
assert.deepEqual(somato.map((m) => [m.label, m.valueFrame, m.fFrame, m.colormap]), [['body position', 0, 1, 'brainana_somatotopy']])
assert.equal(somato[0].id, 'bodyPosition', 'somatotopy mode id')
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

// --- surfaceLutFromColormap: bin 0 transparent, endpoints sample source, brightness monotonic ---
{
  // 2-entry source LUT: red -> blue (flat RGBA)
  const src = [255, 0, 0, 255, 0, 0, 255, 255]
  const { lut, min, max } = surfaceLutFromColormap(src, 1)
  assert.equal(lut.length, 256 * 4, '256-entry RGBA output')
  assert.deepEqual([min, max], [0, 255], 'label LUT domain 0..255')
  assert.deepEqual([lut[0], lut[1], lut[2], lut[3]], [0, 0, 0, 0], 'bin 0 transparent')
  assert.deepEqual([lut[4], lut[5], lut[6], lut[7]], [255, 0, 0, 255], 'bin 1 samples source start (red)')
  assert.deepEqual([lut[255 * 4], lut[255 * 4 + 1], lut[255 * 4 + 2]], [0, 0, 255], 'bin 255 samples source end (blue)')
  // brightness > 1 blends toward white: a mid bin gets lighter
  const bright = surfaceLutFromColormap(src, 1.5).lut
  assert.ok(bright[128 * 4] >= lut[128 * 4] && bright[128 * 4 + 2] >= lut[128 * 4 + 2], 'brightness>1 lightens channels')
  assert.ok(bright[128 * 4] > lut[128 * 4], 'brightness>1 strictly lightens a non-white channel')
  ok('surfaceLutFromColormap: bin0 transparent, endpoints sample source, brightness lightens')
}

// --- surfaceLutFromColormap skips a transparent source index-0 (brainana maps) so bin 1 isn't black ---
{
  // 3-entry source: index0 transparent black, index1 red, index2 blue
  const src = [0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 255]
  const { lut } = surfaceLutFromColormap(src, 1)
  assert.deepEqual([lut[4], lut[5], lut[6]], [255, 0, 0], 'bin 1 = first OPAQUE color (red), not the black slot')
  assert.deepEqual([lut[255 * 4], lut[255 * 4 + 1], lut[255 * 4 + 2]], [0, 0, 255], 'bin 255 = last color (blue)')
  ok('surfaceLutFromColormap skips a transparent source index-0 so clamped-low vertices are not black')
}

// --- mapFunctionalDisplay: clamps into the opaque range, never below cal_min (index 0) ---
{
  const calMin = 0
  const calMax = 254 // step = 1, so opaque range is [1, 254]
  // value at dMin maps to the first opaque slot (calMin + step), not calMin itself
  assert.equal(mapFunctionalDisplay(0, 0, 100, calMin, calMax), 1, 'dMin -> first opaque (index 1)')
  assert.equal(mapFunctionalDisplay(100, 0, 100, calMin, calMax), 254, 'dMax -> calMax (index 255)')
  // below dMin clamps to first opaque (still > calMin, so visible — not transparent index 0)
  const below = mapFunctionalDisplay(-50, 0, 100, calMin, calMax)
  assert.ok(below > calMin, 'below dMin stays above cal_min (opaque, not hidden)')
  assert.equal(below, 1, 'below dMin clamps to first opaque slot')
  // above dMax clamps to calMax
  assert.equal(mapFunctionalDisplay(500, 0, 100, calMin, calMax), 254, 'above dMax clamps to calMax')
  // monotonic across the window
  const a = mapFunctionalDisplay(25, 0, 100, calMin, calMax)
  const b = mapFunctionalDisplay(75, 0, 100, calMin, calMax)
  assert.ok(b > a, 'monotonic increasing across the window')
  // degenerate window (dMin==dMax) doesn't divide by zero
  assert.ok(Number.isFinite(mapFunctionalDisplay(5, 3, 3, calMin, calMax)), 'zero-width window is finite')
  ok('mapFunctionalDisplay clamps into the opaque range (never hides), endpoints + monotonic')
}

// --- quantizeFunctionalSurfaceValues with a display range: linear clamp over [min,max] ---
{
  const bins = quantizeFunctionalSurfaceValues(new Float32Array([0, 5, 10, -3, 20]), 'eccentricity', { min: 0, max: 10 })
  assert.equal(bins[0], 1, 'value at range.min -> bin 1')
  assert.equal(bins[2], 255, 'value at range.max -> bin 255')
  assert.equal(bins[3], 1, 'below range clamps to bin 1 (still visible)')
  assert.equal(bins[4], 255, 'above range clamps to bin 255')
  assert.ok(bins[1] > 1 && bins[1] < 255, 'mid value in between')
  // sentinel / non-finite still -> bin 0 (transparent)
  assert.equal(quantizeFunctionalSurfaceValues(new Float32Array([NaN, -999]), 'polar', { min: -1, max: 1 })[0], 0, 'NaN -> bin 0')
  ok('quantizeFunctionalSurfaceValues honors a display range (linear clamp, sentinel transparent)')
}

// --- quantizeScalarToBins: continuous-atlas quantization (shared by volume + surface) ---
{
  // CortHierarchy-like: background 0, gradient 1..2. Window [1,2].
  const bins = quantizeScalarToBins(new Float32Array([0, 1, 1.5, 2, NaN, -0.5, 3]), 1, 2)
  assert.equal(bins[0], 0, 'background value 0 -> bin 0 (transparent)')
  assert.equal(bins[1], 1, 'value at range.min -> bin 1')
  assert.equal(bins[3], 255, 'value at range.max -> bin 255')
  assert.ok(bins[2] > 1 && bins[2] < 255, 'mid value in between')
  assert.equal(bins[4], 0, 'NaN -> bin 0 (transparent)')
  assert.equal(bins[5], 1, 'below range clamps to bin 1 (still visible)')
  assert.equal(bins[6], 255, 'above range clamps to bin 255')
  // Degenerate window (min == max): all non-background -> bin 1, background stays 0
  const flat = quantizeScalarToBins(new Float32Array([0, 5, 9]), 3, 3)
  assert.equal(flat[0], 0, 'background stays 0 for a degenerate window')
  assert.equal(flat[1], 1, 'degenerate window -> bin 1')
  ok('quantizeScalarToBins: 0/NaN -> bin 0, endpoints -> 1/255, clamps, degenerate window')
}

// --- maskSurfaceBinsByValue: hide vertices outside the [lo,hi] window ---
{
  const bins = new Float32Array([100, 150, 200, 50])
  const values = new Float32Array([0, 5, 10, -2])
  const out = maskSurfaceBinsByValue(bins, values, 1, 8)
  assert.equal(out[0], 0, 'value 0 < lo 1 -> hidden')
  assert.equal(out[1], 150, 'value 5 in [1,8] -> kept')
  assert.equal(out[2], 0, 'value 10 > hi 8 -> hidden')
  assert.equal(out[3], 0, 'value -2 < lo -> hidden')
  // null bounds = unbounded
  const lowOnly = maskSurfaceBinsByValue(bins, values, 1, null)
  assert.equal(lowOnly[2], 200, 'no upper bound keeps high values')
  ok('maskSurfaceBinsByValue hides surface vertices outside the value window')
}

console.log(`functional_test: ${passed} checks passed`)
