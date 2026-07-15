import * as nifti from 'nifti-reader-js'

export type Matrix4 = number[][]
export type Dims3 = [number, number, number]

export type RawNifti = {
  dims: Dims3
  frameCount: number
  affine: Matrix4
  pixDims: Dims3
  values: Float32Array
  datatypeCode: number
  littleEndian: boolean
  slope: number
  intercept: number
}

function product(values: number[]): number { return values.reduce((a, b) => a * b, 1) }

export function flatIndex(i: number, j: number, k: number, dims: Dims3): number {
  return i + dims[0] * (j + dims[1] * k)
}

export function determinant3(matrix: Matrix4): number {
  const a = matrix
  return a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
    - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
    + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
}

export function applyAffine(matrix: Matrix4, point: [number, number, number]): [number, number, number] {
  const [x, y, z] = point
  const w = matrix[3][0] * x + matrix[3][1] * y + matrix[3][2] * z + matrix[3][3]
  const scale = Math.abs(w) > 1e-12 ? 1 / w : 1
  return [
    (matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z + matrix[0][3]) * scale,
    (matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z + matrix[1][3]) * scale,
    (matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z + matrix[2][3]) * scale,
  ]
}

export function invertAffine(matrix: Matrix4): Matrix4 {
  const a = matrix.map((row) => row.map(Number))
  const inverse = Array.from({ length: 4 }, (_, row) => Array.from({ length: 4 }, (_, col) => row === col ? 1 : 0))
  for (let col = 0; col < 4; col += 1) {
    let pivot = col
    for (let row = col + 1; row < 4; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error('Affine transform is singular')
    ;[a[col], a[pivot]] = [a[pivot], a[col]]
    ;[inverse[col], inverse[pivot]] = [inverse[pivot], inverse[col]]
    const divisor = a[col][col]
    for (let j = 0; j < 4; j += 1) { a[col][j] /= divisor; inverse[col][j] /= divisor }
    for (let row = 0; row < 4; row += 1) {
      if (row === col) continue
      const factor = a[row][col]
      for (let j = 0; j < 4; j += 1) { a[row][j] -= factor * a[col][j]; inverse[row][j] -= factor * inverse[col][j] }
    }
  }
  return inverse
}

function readNumberArray(image: ArrayBuffer, datatypeCode: number, littleEndian: boolean, count: number): Float32Array {
  const out = new Float32Array(count)
  const view = new DataView(image)
  let bytes = 0
  let reader: (offset: number) => number
  switch (datatypeCode) {
    case 2: bytes = 1; reader = (offset) => view.getUint8(offset); break
    case 4: bytes = 2; reader = (offset) => view.getInt16(offset, littleEndian); break
    case 8: bytes = 4; reader = (offset) => view.getInt32(offset, littleEndian); break
    case 16: bytes = 4; reader = (offset) => view.getFloat32(offset, littleEndian); break
    case 64: bytes = 8; reader = (offset) => view.getFloat64(offset, littleEndian); break
    case 256: bytes = 1; reader = (offset) => view.getInt8(offset); break
    case 512: bytes = 2; reader = (offset) => view.getUint16(offset, littleEndian); break
    case 768: bytes = 4; reader = (offset) => view.getUint32(offset, littleEndian); break
    default: throw new Error(`Unsupported NIfTI datatype ${datatypeCode}`)
  }
  if (image.byteLength < count * bytes) throw new Error(`NIfTI image payload is truncated: expected ${count * bytes} bytes, found ${image.byteLength}`)
  for (let index = 0; index < count; index += 1) out[index] = reader(index * bytes)
  return out
}

export async function loadRawNifti(url: string): Promise<RawNifti> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Unable to load NIfTI (${response.status})`)
  let data = await response.arrayBuffer()
  if (nifti.isCompressed(data)) data = await nifti.decompressAsync(data)
  if (!nifti.isNIFTI(data)) throw new Error('File is not a valid NIfTI image')
  const header = nifti.readHeader(data)
  const dims: Dims3 = [Number(header.dims[1]), Number(header.dims[2]), Number(header.dims[3])]
  const higherDims = header.dims.slice(4, Math.max(4, Number(header.dims[0]) + 1)).map((v) => Math.max(1, Number(v) || 1))
  const frameCount = Math.max(1, product(higherDims))
  const count = product(dims) * frameCount
  const image = nifti.readImage(header, data)
  const raw = readNumberArray(image, Number(header.datatypeCode), Boolean(header.littleEndian), count)
  const slope = Number(header.scl_slope) || 1
  const intercept = Number(header.scl_inter) || 0
  if (slope !== 1 || intercept !== 0) for (let index = 0; index < raw.length; index += 1) raw[index] = raw[index] * slope + intercept
  const affine = header.affine.map((row) => row.map(Number))
  const pixDims: Dims3 = [Math.abs(Number(header.pixDims[1])), Math.abs(Number(header.pixDims[2])), Math.abs(Number(header.pixDims[3]))]
  return { dims, frameCount, affine, pixDims, values: raw, datatypeCode: Number(header.datatypeCode), littleEndian: Boolean(header.littleEndian), slope, intercept }
}

export function frame(image: RawNifti, frameIndex = 0): Float32Array {
  const frameSize = product(image.dims)
  const offset = frameIndex * frameSize
  if (frameIndex < 0 || offset + frameSize > image.values.length) throw new Error(`Requested NIfTI frame ${frameIndex} is unavailable`)
  return image.values.subarray(offset, offset + frameSize)
}

export function sampleNearest(values: ArrayLike<number>, dims: Dims3, xyz: [number, number, number]): number {
  const i = Math.round(xyz[0]); const j = Math.round(xyz[1]); const k = Math.round(xyz[2])
  if (i < 0 || j < 0 || k < 0 || i >= dims[0] || j >= dims[1] || k >= dims[2]) return 0
  return Number(values[flatIndex(i, j, k, dims)])
}

export function sampleLinear(values: ArrayLike<number>, dims: Dims3, xyz: [number, number, number]): number {
  const [x, y, z] = xyz
  const x0 = Math.floor(x); const y0 = Math.floor(y); const z0 = Math.floor(z)
  const x1 = x0 + 1; const y1 = y0 + 1; const z1 = z0 + 1
  if (x0 < 0 || y0 < 0 || z0 < 0 || x1 >= dims[0] || y1 >= dims[1] || z1 >= dims[2]) return 0
  const tx = x - x0; const ty = y - y0; const tz = z - z0
  const at = (i: number, j: number, k: number) => Number(values[flatIndex(i, j, k, dims)])
  const c00 = at(x0, y0, z0) * (1 - tx) + at(x1, y0, z0) * tx
  const c10 = at(x0, y1, z0) * (1 - tx) + at(x1, y1, z0) * tx
  const c01 = at(x0, y0, z1) * (1 - tx) + at(x1, y0, z1) * tx
  const c11 = at(x0, y1, z1) * (1 - tx) + at(x1, y1, z1) * tx
  const c0 = c00 * (1 - ty) + c10 * ty
  const c1 = c01 * (1 - ty) + c11 * ty
  return c0 * (1 - tz) + c1 * tz
}

export type GaussianRoi = {
  values: Float32Array
  center: [number, number, number]
  centerWorld: [number, number, number]
  extentMm: number
  fwhmMm: number
  sigmaMm: number
  positiveCount: number
}

export function createGaussianRoi(image: RawNifti, world: [number, number, number], extentMm: number): GaussianRoi {
  if (!Number.isFinite(extentMm) || extentMm < 1 || extentMm > 50) throw new Error('Gaussian ROI extent must be between 1 and 50 mm')
  const center = applyAffine(invertAffine(image.affine), world).map(Math.round) as [number, number, number]
  if (center.some((value, axis) => value < 0 || value >= image.dims[axis])) throw new Error('The cursor lies outside the T1w image')
  const centerWorld = applyAffine(image.affine, center)
  const halfExtent = extentMm / 2
  const fwhmMm = extentMm / 2
  const sigmaMm = fwhmMm / (2 * Math.sqrt(2 * Math.log(2)))
  const values = new Float32Array(product(image.dims))

  // Conservative native-voxel search radius. The exact support test below is performed in world millimetres.
  const minStep = Math.max(1e-6, Math.min(...image.pixDims.filter((value) => value > 0)))
  const radius = Math.ceil((Math.sqrt(3) * halfExtent) / minStep) + 1
  let positiveCount = 0
  for (let k = Math.max(0, center[2] - radius); k <= Math.min(image.dims[2] - 1, center[2] + radius); k += 1) {
    for (let j = Math.max(0, center[1] - radius); j <= Math.min(image.dims[1] - 1, center[1] + radius); j += 1) {
      for (let i = Math.max(0, center[0] - radius); i <= Math.min(image.dims[0] - 1, center[0] + radius); i += 1) {
        const voxelWorld = applyAffine(image.affine, [i, j, k])
        const dx = voxelWorld[0] - centerWorld[0]
        const dy = voxelWorld[1] - centerWorld[1]
        const dz = voxelWorld[2] - centerWorld[2]
        if (Math.abs(dx) > halfExtent + 1e-6 || Math.abs(dy) > halfExtent + 1e-6 || Math.abs(dz) > halfExtent + 1e-6) continue
        const distanceSquared = dx * dx + dy * dy + dz * dz
        const value = Math.exp(-distanceSquared / (2 * sigmaMm * sigmaMm))
        if (value <= 0 || !Number.isFinite(value)) continue
        values[flatIndex(i, j, k, image.dims)] = value
        positiveCount += 1
      }
    }
  }
  values[flatIndex(center[0], center[1], center[2], image.dims)] = 1
  return { values, center, centerWorld, extentMm, fwhmMm, sigmaMm, positiveCount }
}

export function normalizePositive(values: Float32Array): number {
  let maximum = 0
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error('ROI contains a non-finite value')
    if (value < -1e-7) throw new Error('ROI contains a negative value')
    if (value > maximum) maximum = value
  }
  if (!(maximum > 0)) throw new Error('Warped ROI is empty')
  if (Math.abs(maximum - 1) > 1e-7) for (let index = 0; index < values.length; index += 1) values[index] /= maximum
  return maximum
}

// FSL FLIRT matrices operate in FSL scaled-voxel millimetres, not NIfTI RAS world coordinates.
// This reproduces FSL's nifti_image_to_mat44 / handedness convention.
export function fslVoxelToMm(image: RawNifti): Matrix4 {
  const [sx, sy, sz] = image.pixDims
  if (determinant3(image.affine) > 0) {
    return [[-sx, 0, 0, (image.dims[0] - 1) * sx], [0, sy, 0, 0], [0, 0, sz, 0], [0, 0, 0, 1]]
  }
  return [[sx, 0, 0, 0], [0, sy, 0, 0], [0, 0, sz, 0], [0, 0, 0, 1]]
}

export function resampleScanner(source: RawNifti, target: RawNifti, scannerToT1wFlirt: Matrix4, sourceValues: ArrayLike<number> = frame(source, 0), interpolation: 'linear' | 'nearest' = 'linear'): Float32Array {
  if (sourceValues.length !== product(source.dims)) throw new Error('Scanner resampling source array does not match the T1w grid')
  const output = new Float32Array(product(target.dims))
  const targetVoxToFsl = fslVoxelToMm(target)
  const sourceFslToVox = invertAffine(fslVoxelToMm(source))
  for (let k = 0; k < target.dims[2]; k += 1) for (let j = 0; j < target.dims[1]; j += 1) for (let i = 0; i < target.dims[0]; i += 1) {
    const index = flatIndex(i, j, k, target.dims)
    const scannerFsl = applyAffine(targetVoxToFsl, [i, j, k])
    const t1wFsl = applyAffine(scannerToT1wFlirt, scannerFsl)
    const sourceVoxel = applyAffine(sourceFslToVox, t1wFsl)
    const value = interpolation === 'nearest' ? sampleNearest(sourceValues, source.dims, sourceVoxel) : sampleLinear(sourceValues, source.dims, sourceVoxel)
    output[index] = value
  }
  return output
}

export function validateNmtField(target: RawNifti, field: RawNifti): void {
  if (target.dims.some((value, axis) => value !== field.dims[axis])) throw new Error(`NMT reference (${target.dims.join(' × ')}) and displacement grid (${field.dims.join(' × ')}) differ`)
  if (field.frameCount < 3) throw new Error(`NMT displacement field has ${field.frameCount} frame(s), expected at least 3`)
  for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) if (Math.abs(target.affine[r][c] - field.affine[r][c]) > 1e-4) throw new Error('NMT reference and displacement affines differ')
}

export function resampleNmt(source: RawNifti, target: RawNifti, field: RawNifti, sourceValues: ArrayLike<number> = frame(source, 0), interpolation: 'linear' | 'nearest' = 'linear'): Float32Array {
  validateNmtField(target, field)
  if (sourceValues.length !== product(source.dims)) throw new Error('NMT resampling source array does not match the T1w grid')
  const output = new Float32Array(product(target.dims))
  const invSource = invertAffine(source.affine)
  const dx = frame(field, 0); const dy = frame(field, 1); const dz = frame(field, 2)
  for (let k = 0; k < target.dims[2]; k += 1) for (let j = 0; j < target.dims[1]; j += 1) for (let i = 0; i < target.dims[0]; i += 1) {
    const index = flatIndex(i, j, k, target.dims)
    const outWorld = applyAffine(target.affine, [i, j, k])
    const vx = dx[index]; const vy = dy[index]; const vz = dz[index]
    if (![vx, vy, vz].every(Number.isFinite)) continue
    // Validated against Brainana output: ITK/LPS vectors converted to RAS, then added.
    const sourceWorld: [number, number, number] = [outWorld[0] - vx, outWorld[1] - vy, outWorld[2] + vz]
    const sourceVoxel = applyAffine(invSource, sourceWorld)
    const value = interpolation === 'nearest' ? sampleNearest(sourceValues, source.dims, sourceVoxel) : sampleLinear(sourceValues, source.dims, sourceVoxel)
    output[index] = value
  }
  return output
}

export function resampleScannerToT1w(sourceScanner: RawNifti, targetT1w: RawNifti, scannerToT1wFlirt: Matrix4, sourceValues: ArrayLike<number> = frame(sourceScanner, 0), interpolation: 'linear' | 'nearest' = 'linear'): Float32Array {
  if (sourceValues.length !== product(sourceScanner.dims)) throw new Error('Scanner import source array does not match the scanner grid')
  const output = new Float32Array(product(targetT1w.dims))
  const targetVoxToFsl = fslVoxelToMm(targetT1w)
  const sourceFslToVox = invertAffine(fslVoxelToMm(sourceScanner))
  const t1wToScanner = invertAffine(scannerToT1wFlirt)
  for (let k = 0; k < targetT1w.dims[2]; k += 1) for (let j = 0; j < targetT1w.dims[1]; j += 1) for (let i = 0; i < targetT1w.dims[0]; i += 1) {
    const index = flatIndex(i, j, k, targetT1w.dims)
    const t1wFsl = applyAffine(targetVoxToFsl, [i, j, k])
    const scannerFsl = applyAffine(t1wToScanner, t1wFsl)
    const sourceVoxel = applyAffine(sourceFslToVox, scannerFsl)
    output[index] = interpolation === 'nearest' ? sampleNearest(sourceValues, sourceScanner.dims, sourceVoxel) : sampleLinear(sourceValues, sourceScanner.dims, sourceVoxel)
  }
  return output
}

export function resampleTemplateToT1w(sourceTemplate: RawNifti, targetT1w: RawNifti, reverseField: RawNifti, sourceValues: ArrayLike<number> = frame(sourceTemplate, 0), interpolation: 'linear' | 'nearest' = 'linear'): Float32Array {
  // Brainana reverse displacement fields are defined on the T1w destination grid.
  validateNmtField(targetT1w, reverseField)
  if (sourceValues.length !== product(sourceTemplate.dims)) throw new Error('Template import source array does not match the template grid')
  const output = new Float32Array(product(targetT1w.dims))
  const invSource = invertAffine(sourceTemplate.affine)
  const dx = frame(reverseField, 0); const dy = frame(reverseField, 1); const dz = frame(reverseField, 2)
  for (let k = 0; k < targetT1w.dims[2]; k += 1) for (let j = 0; j < targetT1w.dims[1]; j += 1) for (let i = 0; i < targetT1w.dims[0]; i += 1) {
    const index = flatIndex(i, j, k, targetT1w.dims)
    const outWorld = applyAffine(targetT1w.affine, [i, j, k])
    const vx = dx[index]; const vy = dy[index]; const vz = dz[index]
    if (![vx, vy, vz].every(Number.isFinite)) continue
    const sourceWorld: [number, number, number] = [outWorld[0] - vx, outWorld[1] - vy, outWorld[2] + vz]
    const sourceVoxel = applyAffine(invSource, sourceWorld)
    output[index] = interpolation === 'nearest' ? sampleNearest(sourceValues, sourceTemplate.dims, sourceVoxel) : sampleLinear(sourceValues, sourceTemplate.dims, sourceVoxel)
  }
  return output
}

export function scalarCorrelation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Number.NaN
  const positives: number[] = []
  for (let i = 0; i < b.length; i += 1) { const y = Number(b[i]); if (Number.isFinite(y) && y > 0) positives.push(y) }
  positives.sort((x, y) => x - y)
  const threshold = positives.length ? positives[Math.floor(positives.length * 0.05)] : 0
  const stride = Math.max(1, Math.floor(a.length / 300000))
  let n = 0; let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0
  for (let i = 0; i < a.length; i += stride) {
    const x = Number(a[i]); const y = Number(b[i])
    if (!Number.isFinite(x) || !Number.isFinite(y) || y <= threshold) continue
    n += 1; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y
  }
  const numerator = n * sxy - sx * sy
  const denominator = Math.sqrt(Math.max(0, n * sxx - sx * sx) * Math.max(0, n * syy - sy * sy))
  return n > 1 && denominator > 0 ? numerator / denominator : Number.NaN
}
