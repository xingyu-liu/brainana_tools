// Unit tests for procedural ROI colors (viewer/src/data/colors.ts).
import assert from 'node:assert/strict'
import { roiColor, hslToRgb, ARM_SEED } from '../apps/viewer/src/data/colors.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// tissue special-cases
assert.deepEqual(roiColor(42, 'WM', ARM_SEED), [205, 205, 205])
assert.deepEqual(roiColor(42, 'wm', ARM_SEED), [205, 205, 205], 'case-insensitive region')
assert.deepEqual(roiColor(42, 'CSF', ARM_SEED), [105, 190, 245])
ok('roiColor gives fixed WM/CSF tissue colors')

// golden-angle: deterministic, valid, distinct
const a = roiColor(10, 'cortex', ARM_SEED)
const b = roiColor(11, 'cortex', ARM_SEED)
assert.deepEqual(roiColor(10, 'cortex', ARM_SEED), a, 'deterministic')
assert.notDeepEqual(a, b, 'consecutive ids differ')
for (const c of [...a, ...b]) assert.ok(Number.isInteger(c) && c >= 0 && c <= 255)
ok('roiColor is deterministic, distinct, 0-255')

// seed parameter shifts the hue
assert.notDeepEqual(roiColor(10, 'cortex', ARM_SEED), roiColor(10, 'cortex', ARM_SEED + 211), 'seed changes hue')
ok('different seeds produce different colors')

// hslToRgb sanity
assert.deepEqual(hslToRgb(0, 1, 0.5), [255, 0, 0], 'hue 0 = red')
assert.deepEqual(hslToRgb(120, 1, 0.5), [0, 255, 0], 'hue 120 = green')
assert.deepEqual(hslToRgb(240, 1, 0.5), [0, 0, 255], 'hue 240 = blue')
assert.deepEqual(hslToRgb(-360 + 0, 1, 0.5), [255, 0, 0], 'negative hue wraps')
ok('hslToRgb maps primary hues correctly and wraps')

console.log(`colors_test: ${passed} checks passed`)
