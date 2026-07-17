// Unit tests for atlas LUT parsing + colortable building (viewer/src/data/atlas.ts).
import assert from 'node:assert/strict'
import { parseAtlasTsv, buildLabelColortable, displayLabel, labelColor, parseLabelColor } from '../apps/viewer/src/data/atlas.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

const tsv = [
  'ID\tlabel\tregion\tname\tname_full\themi',
  '0\tbackground\t\t\t\t',
  '2\tcortex_rh_ACgG\tcortex\tACgG\tanterior_cingulate_gyrus\trh',
  '16\twm_lh\tWM\tWM\twhite_matter\tlh',
].join('\n')

const rows = parseAtlasTsv(tsv)
assert.equal(rows.length, 3)
assert.deepEqual(rows[1], { id: 2, name: 'anterior_cingulate_gyrus', nameShort: 'ACgG', region: 'cortex', hemi: 'rh' }, 'prefers name_full, keeps short name + region/hemi')
assert.equal(rows[2].region, 'WM')
ok('parseAtlasTsv reads id/name/region/hemi')

assert.equal(displayLabel(rows[1]), 'anterior cingulate gyrus · RH', 'display label = name · hemi')
ok('displayLabel formats name + hemisphere')

// quoted TSV variant (ARM5-style: every cell wrapped in double quotes) must parse identically
const quoted = [
  '"ID"\t"label"\t"region"\t"name"\t"name_full"\t"hemi"',
  '0\t"background"\t\t\t\t',
  '4\t"cortex_rh_area_32"\t"cortex"\t"area_32"\t"area_32"\t"rh"',
].join('\n')
const qrows = parseAtlasTsv(quoted)
assert.equal(qrows.length, 2, 'quoted header detected → rows parsed')
assert.deepEqual(qrows[1], { id: 4, name: 'area_32', region: 'cortex', hemi: 'rh' }, 'quotes stripped from cells')
ok('parseAtlasTsv strips surrounding quotes (ARM5-style TSV)')

// WM tissue color is fixed gray regardless of golden-angle
assert.deepEqual(labelColor(rows[2], 0), [205, 205, 205], 'WM region → fixed gray')
ok('labelColor honors WM/CSF tissue special-case')

// colortable: background transparent, regions opaque, hidden set applied
const table = buildLabelColortable(rows, { seed: 0 })
assert.deepEqual(table.I, [0, 2, 16], 'intensities are the atlas IDs')
assert.equal(table.A[0], 0, 'background transparent')
assert.equal(table.A[1], 255, 'region opaque')
ok('buildLabelColortable maps IDs, background transparent')

const hidden = buildLabelColortable(rows, { seed: 0, hidden: new Set([2]) })
assert.equal(hidden.A[1], 0, 'hidden id → transparent')
assert.equal(hidden.A[2], 255, 'non-hidden stays opaque')
ok('buildLabelColortable applies the hidden set as alpha=0')

// parseLabelColor: bracketed RGB (FuncNetwork), hex (ARM4), and rejects
assert.deepEqual(parseLabelColor('[100 38 124]'), [100, 38, 124], 'bracketed space-separated RGB')
assert.deepEqual(parseLabelColor('100,38,124'), [100, 38, 124], 'comma-separated RGB')
assert.deepEqual(parseLabelColor('#803951'), [128, 57, 81], 'hex #RRGGBB')
assert.deepEqual(parseLabelColor('#abc'), [170, 187, 204], 'hex #RGB shorthand expands')
assert.deepEqual(parseLabelColor('[300 -5 124.7]'), [255, 0, 125], 'out-of-range clamped, floats rounded')
assert.equal(parseLabelColor(''), undefined, 'empty cell → undefined')
assert.equal(parseLabelColor('   '), undefined, 'whitespace-only → undefined')
assert.equal(parseLabelColor('[1 2]'), undefined, 'wrong component count → undefined')
assert.equal(parseLabelColor('#12'), undefined, 'malformed hex → undefined')
assert.equal(parseLabelColor('red'), undefined, 'non-numeric → undefined')
ok('parseLabelColor handles bracket/hex formats and rejects malformed cells')

// FuncNetwork-style TSV: authored color column is honored by parse + labelColor
const funcNet = [
  '"ID"\t"name"\t"color"',
  '1\t"VSL"\t"[100 38 124]"',
  '2\t"SM"\t"[94 128 172]"',
].join('\n')
const fnRows = parseAtlasTsv(funcNet)
assert.deepEqual(fnRows[0].color, [100, 38, 124], 'authored color parsed from TSV')
assert.deepEqual(labelColor(fnRows[0], 0), [100, 38, 124], 'labelColor returns authored color, not procedural')
ok('parseAtlasTsv + labelColor honor an authored color column')

// FuncNetwork's TSV lacks an id-0 row (ids 1..N). buildLabelColortable must inject a transparent
// background slot so NiiVue's dense LUT does not clamp background voxels (value 0) onto the first
// ROI's opaque color (the "purple wash"). ROI colors themselves must be unchanged.
const fnTable = buildLabelColortable(fnRows, { seed: 0 })
const bgIdx = fnTable.I.indexOf(0)
assert.ok(bgIdx >= 0, 'background id 0 injected when the TSV omits it')
assert.equal(fnTable.A[bgIdx], 0, 'injected background slot is transparent')
assert.equal(Math.min(...fnTable.I), 0, 'min intensity is 0 → value-0 voxels map to the transparent slot')
assert.deepEqual([fnTable.R[0], fnTable.G[0], fnTable.B[0]], [100, 38, 124], 'ROI 1 keeps its authored color')
assert.equal(fnTable.A[0], 255, 'ROI 1 stays opaque')
ok('buildLabelColortable injects a transparent background when the TSV omits id 0')

// Idempotent: a TSV that already carries an id-0 row is not given a second background slot.
const withBg = buildLabelColortable(rows, { seed: 0 })
assert.equal(withBg.I.filter((v) => v === 0).length, 1, 'no duplicate background when id 0 already present')
ok('buildLabelColortable leaves an existing id-0 row untouched')

// A color column that is empty for a row falls back to procedural / tissue colors (ARM4-style)
const mixed = [
  'ID\tregion\tcolor',
  '4\tcortex\t#803951',
  '16\tWM\t',
].join('\n')
const mixedRows = parseAtlasTsv(mixed)
assert.deepEqual(labelColor(mixedRows[0], 0), [128, 57, 81], 'cortex row uses authored hex')
assert.equal(mixedRows[1].color, undefined, 'empty color cell → no authored color')
assert.deepEqual(labelColor(mixedRows[1], 0), [205, 205, 205], 'empty WM cell falls back to tissue gray')
ok('empty color cells fall back to procedural / tissue colors')

console.log(`atlas_test: ${passed} checks passed`)
