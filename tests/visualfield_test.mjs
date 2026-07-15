// Unit tests for the pure visual-field math (viewer/src/data/visualField.ts).
import assert from 'node:assert/strict'
import { visualXY, median, visualFieldStats, RINGS, ECC_MAX } from '../viewer/src/data/visualField.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// visualXY
{
  const [x, y] = visualXY(0, 5)
  assert.ok(Math.abs(x - 5) < 1e-9 && Math.abs(y) < 1e-9, 'polar 0 → +X')
  const [x2, y2] = visualXY(Math.PI / 2, 4)
  assert.ok(Math.abs(x2) < 1e-9 && Math.abs(y2 - 4) < 1e-9, 'polar 90° → +Y')
  ok('visualXY = ecc·(cos, sin)')
}

// median (true median, even/odd)
assert.equal(median([3, 1, 2]), 2)
assert.equal(median([4, 1, 2, 3]), 2.5, 'even count averages the two middles')
assert.equal(median([]), 0)
ok('median handles odd/even/empty')

// domain constants
assert.equal(ECC_MAX, 10)
assert.deepEqual(RINGS, [2, 4, 6, 8, 10])
ok('eccentricity cap = 10 and rings at 2/4/6/8/10')

// stats: a tight cluster around (3,0) with a center point offset to (3.5, 0.5)
const pts = [
  { x: 3, y: 0, polar: 0, ecc: 3, center: false },
  { x: 3.2, y: 0.1, polar: 0, ecc: 3.2, center: false },
  { x: 2.8, y: -0.1, polar: 0, ecc: 2.8, center: false },
  { x: 3.5, y: 0.5, polar: 0, ecc: 3.53, center: true },
]
const stats = visualFieldStats(pts)
assert.ok(Math.abs(stats.medianX - 3) < 0.3, 'median X near 3')
assert.ok(stats.spread > 0 && stats.spread < 1, 'spread is a small positive RMS')
assert.ok(stats.ellipse && stats.ellipse.rx >= stats.ellipse.ry, 'ellipse major ≥ minor axis')
assert.ok(stats.offset != null && Math.abs(stats.offset - Math.hypot(3.5 - stats.medianX, 0.5 - stats.medianY)) < 1e-9, 'offset = center distance to median')
assert.equal(stats.valid, 4)
ok('visualFieldStats: median, RMS spread, covariance ellipse, offset-to-median')

// fewer than 3 non-center points → all points used, no throw
const few = visualFieldStats([{ x: 1, y: 1, polar: 0, ecc: 1.4, center: true }])
assert.equal(few.valid, 1)
assert.equal(few.offset, 0, 'single center point sits on its own median')
ok('visualFieldStats falls back to all points when <3 non-center')

console.log(`visualfield_test: ${passed} checks passed`)
