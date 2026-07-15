// Viewer-domain FreeSurfer binary parsing + derived-asset generation.
// Ported verbatim in behavior from server.mjs:173-317; the only change is that
// `ensureDerivedAssets` receives an explicit `outputRoot` instead of a module global,
// so it works for any local data-source root.
import fs from 'node:fs'
import path from 'node:path'

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

// FreeSurfer curv/sulc/thickness ("morphology") binary → Float32Array of per-vertex values.
// Handles both the new (0xffffff magic) and legacy int16/100 formats.
export function parseFsMorphology(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const readUint24 = (offset) => (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2)
  const magic = readUint24(0)
  if (magic === 0xffffff) {
    const vertexCount = view.getInt32(3, false)
    const valuesPerVertex = view.getInt32(11, false)
    let offset = 15
    const values = new Float32Array(vertexCount)
    for (let i = 0; i < vertexCount; i++) {
      values[i] = view.getFloat32(offset, false)
      offset += 4 * valuesPerVertex
    }
    return values
  }
  const vertexCount = magic
  let offset = 6
  const values = new Float32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) {
    values[i] = view.getInt16(offset, false) / 100
    offset += 2
  }
  return values
}

// Serialise per-vertex scalars to a GIFTI NIFTI_INTENT_SHAPE array (base64 float32).
export function giftiShape(values) {
  const bytes = Buffer.alloc(values.length * 4)
  for (let i = 0; i < values.length; i++) bytes.writeFloatLE(values[i], i * 4)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<GIFTI Version="1.0" NumberOfDataArrays="1">\n  <MetaData/>\n  <LabelTable/>\n  <DataArray Intent="NIFTI_INTENT_SHAPE" DataType="NIFTI_TYPE_FLOAT32" ArrayIndexingOrder="RowMajorOrder" Dimensionality="1" Dim0="${values.length}" Encoding="Base64Binary" Endian="LittleEndian" ExternalFileName="" ExternalFileOffset="">\n    <MetaData/>\n    <CoordinateSystemTransformMatrix><DataSpace>NIFTI_XFORM_UNKNOWN</DataSpace><TransformedSpace>NIFTI_XFORM_UNKNOWN</TransformedSpace><MatrixData>1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</MatrixData></CoordinateSystemTransformMatrix>\n    <Data>${bytes.toString('base64')}</Data>\n  </DataArray>\n</GIFTI>\n`
}

// Parse a FreeSurfer binary surface (magic 0xfffffe): returns vertex data + the byte
// offset where vertices begin (so we can rewrite them in place, preserving faces).
export function readFsSurface(buffer) {
  let offset = 0
  const magic = (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2]
  offset += 3
  if (magic !== 0xfffffe) throw new Error('Unsupported FreeSurfer surface format')
  const nl1 = buffer.indexOf(10, offset)
  offset = nl1 + 1
  const nl2 = buffer.indexOf(10, offset)
  offset = nl2 + 1
  const vertexCount = buffer.readInt32BE(offset)
  offset += 4
  const faceCount = buffer.readInt32BE(offset)
  offset += 4
  const verticesOffset = offset
  const vertices = new Float32Array(vertexCount * 3)
  for (let i = 0; i < vertices.length; i++) {
    vertices[i] = buffer.readFloatBE(offset)
    offset += 4
  }
  return { magic, vertexCount, faceCount, verticesOffset, vertices }
}

function surfaceXBounds(points) {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i]
    if (x < min) min = x
    if (x > max) max = x
  }
  return { min, max, width: max - min }
}

function writeFsSurface(input, parsed, points, dest) {
  const output = Buffer.from(input)
  let offset = parsed.verticesOffset
  for (const value of points) {
    output.writeFloatBE(value, offset)
    offset += 4
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, output)
}

// Recenter a left/right inflated (or sphere) pair, apply an optional radial puff for
// "veryinflated", and compute adaptive per-subject hemisphere spacing so the two
// hemispheres sit side by side without overlap.
export function transformFsSurfacePair(leftSrc, rightSrc, leftDest, rightDest, kind) {
  const leftInput = fs.readFileSync(leftSrc)
  const rightInput = fs.readFileSync(rightSrc)
  const leftParsed = readFsSurface(leftInput)
  const rightParsed = readFsSurface(rightInput)
  const left = new Float32Array(leftParsed.vertices)
  const right = new Float32Array(rightParsed.vertices)
  const radial = kind === 'veryinflated' ? 1.13 : 1

  for (const points of [left, right]) {
    let cx = 0,
      cy = 0,
      cz = 0
    const count = points.length / 3
    for (let i = 0; i < points.length; i += 3) {
      cx += points[i]
      cy += points[i + 1]
      cz += points[i + 2]
    }
    cx /= count
    cy /= count
    cz /= count
    for (let i = 0; i < points.length; i += 3) {
      points[i] = cx + (points[i] - cx) * radial
      points[i + 1] = cy + (points[i + 1] - cy) * radial + 6
      points[i + 2] = cz + (points[i + 2] - cz) * radial
    }
  }

  const leftBounds = surfaceXBounds(left)
  const rightBounds = surfaceXBounds(right)
  const referenceWidth = Math.max(1, Math.min(leftBounds.width, rightBounds.width))
  const desiredGap = Math.max(4, Math.min(12, referenceWidth * 0.06))

  const leftShift = -desiredGap / 2 - leftBounds.max
  const rightShift = desiredGap / 2 - rightBounds.min
  for (let i = 0; i < left.length; i += 3) left[i] += leftShift
  for (let i = 0; i < right.length; i += 3) right[i] += rightShift

  const finalLeft = surfaceXBounds(left)
  const finalRight = surfaceXBounds(right)
  const pairCenter = (Math.min(finalLeft.min, finalRight.min) + Math.max(finalLeft.max, finalRight.max)) / 2
  for (let i = 0; i < left.length; i += 3) left[i] -= pairCenter
  for (let i = 0; i < right.length; i += 3) right[i] -= pairCenter

  writeFsSurface(leftInput, leftParsed, left, leftDest)
  writeFsSurface(rightInput, rightParsed, right, rightDest)
}

// Build (and mtime-cache) GIFTI shape arrays + display surfaces for a subject.
// `outputRoot` is the data-source root; cache lives under <outputRoot>/.brainana-viewer-cache.
export function ensureDerivedAssets(outputRoot, subjectId, fsDir) {
  if (!fsDir || !exists(fsDir)) return {}
  const surf = path.join(fsDir, 'surf')
  const cache = path.join(outputRoot, '.brainana-viewer-cache', 'surface-spacing-v2', subjectId)
  fs.mkdirSync(cache, { recursive: true })
  const result = { shapes: {}, displaySurfaces: {} }

  for (const hemi of ['lh', 'rh']) {
    for (const metric of ['curv', 'sulc', 'thickness']) {
      const src = path.join(surf, `${hemi}.${metric}`)
      if (!exists(src)) continue
      const dest = path.join(cache, `${hemi}.${metric}.shape.gii`)
      if (!exists(dest) || fs.statSync(dest).mtimeMs < fs.statSync(src).mtimeMs) {
        const values = parseFsMorphology(fs.readFileSync(src))
        fs.writeFileSync(dest, giftiShape(values))
      }
      result.shapes[`${hemi}.${metric}`] = dest
    }
  }

  const leftInflated = path.join(surf, 'lh.inflated')
  const rightInflated = path.join(surf, 'rh.inflated')
  if (exists(leftInflated) && exists(rightInflated)) {
    for (const kind of ['inflated', 'veryinflated']) {
      const leftDest = path.join(cache, kind, 'lh.inflated')
      const rightDest = path.join(cache, kind, 'rh.inflated')
      const sourceMtime = Math.max(fs.statSync(leftInflated).mtimeMs, fs.statSync(rightInflated).mtimeMs)
      if (!exists(leftDest) || !exists(rightDest) || fs.statSync(leftDest).mtimeMs < sourceMtime || fs.statSync(rightDest).mtimeMs < sourceMtime) {
        transformFsSurfacePair(leftInflated, rightInflated, leftDest, rightDest, kind)
      }
      result.displaySurfaces[`lh.${kind}`] = leftDest
      result.displaySurfaces[`rh.${kind}`] = rightDest
    }
  }

  const leftSphere = path.join(surf, 'lh.sphere')
  const rightSphere = path.join(surf, 'rh.sphere')
  if (exists(leftSphere) && exists(rightSphere)) {
    const leftDest = path.join(cache, 'sphere', 'lh.sphere')
    const rightDest = path.join(cache, 'sphere', 'rh.sphere')
    const sourceMtime = Math.max(fs.statSync(leftSphere).mtimeMs, fs.statSync(rightSphere).mtimeMs)
    if (!exists(leftDest) || !exists(rightDest) || fs.statSync(leftDest).mtimeMs < sourceMtime || fs.statSync(rightDest).mtimeMs < sourceMtime) {
      transformFsSurfacePair(leftSphere, rightSphere, leftDest, rightDest, 'sphere')
    }
    result.displaySurfaces['lh.sphere'] = leftDest
    result.displaySurfaces['rh.sphere'] = rightDest
  }
  return result
}
