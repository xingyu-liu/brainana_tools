// Unit tests for the GIFTI reader (viewer/src/data/gifti.ts), incl. gzip + raw base64.
import assert from 'node:assert/strict'
import { zlibSync } from 'fflate'
import { parseGiftiFloat32 } from '../viewer/src/data/gifti.ts'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

function giftiArray(values, gzip) {
  const bytes = new Uint8Array(new Float32Array(values).buffer)
  const payload = gzip ? zlibSync(bytes) : bytes
  const b64 = Buffer.from(payload).toString('base64')
  const enc = gzip ? 'GZipBase64Binary' : 'Base64Binary'
  return `<DataArray Intent="NIFTI_INTENT_SHAPE" DataType="NIFTI_TYPE_FLOAT32" Dim0="${values.length}" Encoding="${enc}"><Data>${b64}</Data></DataArray>`
}

// raw base64
{
  const xml = `<GIFTI>${giftiArray([1.5, -2.25, 3], false)}</GIFTI>`
  const arrays = parseGiftiFloat32(xml)
  assert.equal(arrays.length, 1)
  assert.deepEqual([...arrays[0]], [1.5, -2.25, 3])
  ok('parses Base64Binary FLOAT32 DataArray')
}

// gzip (zlib) encoded, multiple frames
{
  const xml = `<GIFTI>${giftiArray([0, 1, 2, 3], true)}${giftiArray([10, 20, 30, 40], true)}</GIFTI>`
  const arrays = parseGiftiFloat32(xml)
  assert.equal(arrays.length, 2, 'two frames')
  assert.deepEqual([...arrays[0]], [0, 1, 2, 3])
  assert.deepEqual([...arrays[1]], [10, 20, 30, 40])
  ok('parses GZipBase64Binary (zlib) multi-frame GIFTI')
}

// empty / no arrays
assert.deepEqual(parseGiftiFloat32('<GIFTI></GIFTI>'), [])
ok('returns [] for a GIFTI with no DataArrays')

console.log(`gifti_test: ${passed} checks passed`)
