// Unit tests for atlas LUT parsing + colortable building (viewer/src/data/atlas.ts).
import assert from 'node:assert/strict'
import { parseAtlasTsv, buildLabelColortable, displayLabel, labelColor } from '../viewer/src/data/atlas.ts'

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
assert.deepEqual(rows[1], { id: 2, name: 'anterior_cingulate_gyrus', region: 'cortex', hemi: 'rh' }, 'prefers name_full, keeps region/hemi')
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

console.log(`atlas_test: ${passed} checks passed`)
