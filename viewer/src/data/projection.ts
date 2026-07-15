// Pure volume→surface ribbon projection (v1.2.25 projection.worker fidelity).
// The ribbon cache (per-vertex voxel indices) is built ONCE per surface+target-affine and
// reused for every atlas level / function frame / threshold. Kept DOM/NiiVue-free for tests.
//
// Constants (reverse-engineered): 9 ribbon samples between white↔pial at interior fractions
// t=(s+1)/(sampleCount+1); triangular weights [1,2,3,4,5,4,3,2,1]; atlas = modal nonzero
// label; function polar = 256-bin circular mean of the dominant bin; ecc/somato = weighted
// mean of the dominant value-bin (caps 10°/100). Unprojected vertices default to -1000.

export const SAMPLE_COUNT = 9
export const RIBBON_WEIGHTS = [1, 2, 3, 4, 5, 4, 3, 2, 1]
export const UNPROJECTED = -1000
export const POLAR_BINS = 256

// World→voxel mapping columns: voxel = origin + wx·axisX + wy·axisY + wz·axisZ (each a 3-vec).
export interface WorldToVox {
  origin: [number, number, number]
  axisX: [number, number, number]
  axisY: [number, number, number]
  axisZ: [number, number, number]
  dims: [number, number, number]
}

export interface RibbonInput {
  whitePts: Float32Array // [x,y,z]*N (world space)
  pialPts: Float32Array // [x,y,z]*N (world space)
  map: WorldToVox
  sampleCount?: number
}

// Per-vertex flat voxel indices (Int32Array length = vertexCount*sampleCount), -1 = out of bounds.
export function buildRibbon(input: RibbonInput): Int32Array {
  const n = input.sampleCount ?? SAMPLE_COUNT
  const { whitePts, pialPts, map } = input
  const [nx, ny, nz] = map.dims
  const vertexCount = whitePts.length / 3
  const out = new Int32Array(vertexCount * n)
  const { origin, axisX, axisY, axisZ } = map
  for (let v = 0; v < vertexCount; v++) {
    const wi = v * 3
    for (let s = 0; s < n; s++) {
      const t = (s + 1) / (n + 1)
      const wx = whitePts[wi] + (pialPts[wi] - whitePts[wi]) * t
      const wy = whitePts[wi + 1] + (pialPts[wi + 1] - whitePts[wi + 1]) * t
      const wz = whitePts[wi + 2] + (pialPts[wi + 2] - whitePts[wi + 2]) * t
      const vx = Math.round(origin[0] + wx * axisX[0] + wy * axisY[0] + wz * axisZ[0])
      const vy = Math.round(origin[1] + wx * axisX[1] + wy * axisY[1] + wz * axisZ[1])
      const vz = Math.round(origin[2] + wx * axisX[2] + wy * axisY[2] + wz * axisZ[2])
      out[v * n + s] = vx >= 0 && vx < nx && vy >= 0 && vy < ny && vz >= 0 && vz < nz ? vx + vy * nx + vz * nx * ny : -1
    }
  }
  return out
}

// Atlas → modal nonzero label per vertex (weighted vote over ribbon samples).
export function projectAtlas(ribbon: Int32Array, volume: ArrayLike<number>, vertexCount: number, sampleCount = SAMPLE_COUNT, weights = RIBBON_WEIGHTS): Float32Array {
  const out = new Float32Array(vertexCount)
  const counts = new Map<number, number>()
  for (let v = 0; v < vertexCount; v++) {
    counts.clear()
    for (let s = 0; s < sampleCount; s++) {
      const vox = ribbon[v * sampleCount + s]
      if (vox < 0) continue
      const label = Math.round(volume[vox])
      if (label === 0) continue
      counts.set(label, (counts.get(label) ?? 0) + weights[s])
    }
    let bestLabel = 0
    let bestW = 0
    for (const [label, w] of counts) {
      if (w > bestW) {
        bestW = w
        bestLabel = label
      }
    }
    out[v] = bestLabel
  }
  return out
}

export type FunctionMode = 'polar' | 'value'

// Function map → per-vertex value, thresholded by a separate F-stat frame (>= cutoff).
// polar: circular mean of the dominant 256-bin angle; value (ecc/somato): weighted mean of
// the dominant value-bin with a hard cap. Unprojected/failing vertices → UNPROJECTED.
export function projectFunction(
  ribbon: Int32Array,
  values: ArrayLike<number>,
  thresholds: ArrayLike<number>,
  cutoff: number,
  mode: FunctionMode,
  cap: number,
  vertexCount: number,
  sampleCount = SAMPLE_COUNT,
  weights = RIBBON_WEIGHTS,
): Float32Array {
  const out = new Float32Array(vertexCount)
  const binW = new Float64Array(POLAR_BINS)
  const binA = new Float64Array(POLAR_BINS) // sin accumulator (polar) or value accumulator (value)
  const binB = new Float64Array(POLAR_BINS) // cos accumulator (polar)
  for (let v = 0; v < vertexCount; v++) {
    binW.fill(0)
    binA.fill(0)
    binB.fill(0)
    let any = false
    for (let s = 0; s < sampleCount; s++) {
      const vox = ribbon[v * sampleCount + s]
      if (vox < 0) continue
      if (thresholds[vox] < cutoff || !Number.isFinite(thresholds[vox])) continue
      const value = values[vox]
      if (!Number.isFinite(value)) continue
      const w = weights[s]
      if (mode === 'polar') {
        let bin = Math.floor(((value + Math.PI) / (2 * Math.PI)) * POLAR_BINS)
        bin = Math.max(0, Math.min(POLAR_BINS - 1, bin))
        binW[bin] += w
        binA[bin] += Math.sin(value) * w
        binB[bin] += Math.cos(value) * w
      } else {
        if (value < 0 || value > cap) continue
        let bin = Math.floor((value / cap) * POLAR_BINS)
        bin = Math.max(0, Math.min(POLAR_BINS - 1, bin))
        binW[bin] += w
        binA[bin] += value * w
      }
      any = true
    }
    if (!any) {
      out[v] = UNPROJECTED
      continue
    }
    let modal = 0
    let modalW = -1
    for (let b = 0; b < POLAR_BINS; b++) {
      if (binW[b] > modalW) {
        modalW = binW[b]
        modal = b
      }
    }
    out[v] = mode === 'polar' ? Math.atan2(binA[modal], binB[modal]) : binA[modal] / binW[modal]
  }
  return out
}
