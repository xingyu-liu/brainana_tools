// Pure helpers for retinotopy/somatotopy display: frame selection, dynamic threshold
// bounds, and F-stat masking. No NiiVue/DOM here so the numeric behaviour is unit-tested.
//
// Reference behaviour encoded:
//  - The F-threshold slider bounds come from scanning ONLY the selected F-stat frame and
//    ignoring non-finite samples (its exact finite extrema).
//  - Somatotopy uses a reversed LUT (blue at 0 -> red at 100); retinotopy polar is circular.

export type FunctionalKind = 'retinotopy' | 'somatotopy'

export interface FunctionalMode {
  /** UI label. */
  label: string
  /** 4D frame index of the value map to display. */
  valueFrame: number
  /** 4D frame index of the F-stat map used for thresholding (null if none). */
  fFrame: number | null
  /** NiiVue colormap. */
  colormap: string
}

// Derive the selectable modes for a functional map from its manifest frame indices.
export function functionalModes(kind: FunctionalKind, frames: Record<string, number>): FunctionalMode[] {
  if (kind === 'retinotopy') {
    const modes: FunctionalMode[] = []
    if (frames.polar != null) modes.push({ label: 'Polar angle', valueFrame: frames.polar, fFrame: frames.polarF ?? null, colormap: 'hsv' })
    if (frames.eccentricity != null) modes.push({ label: 'Eccentricity', valueFrame: frames.eccentricity, fFrame: frames.eccentricityF ?? null, colormap: 'plasma' })
    return modes
  }
  // somatotopy: reversed blue->red LUT so 0 is blue and 100 is red
  const modes: FunctionalMode[] = []
  if (frames.phase != null) modes.push({ label: 'Phase', valueFrame: frames.phase, fFrame: frames.fstat ?? null, colormap: 'blue2red' })
  return modes
}

export interface Extrema {
  min: number
  max: number
}

// Exact finite extrema of a frame, ignoring NaN/Infinity. Returns {0,0} when all non-finite.
export function finiteExtrema(frame: ArrayLike<number>): Extrema {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i]
    if (Number.isFinite(v)) {
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (!Number.isFinite(min)) return { min: 0, max: 0 }
  return { min, max }
}

// Build a masked copy of the value frame: keep a voxel only where its F-stat is finite and
// >= threshold; everywhere else becomes NaN (rendered transparent by the overlay shader).
export function applyThresholdMask(value: ArrayLike<number>, fstat: ArrayLike<number>, threshold: number): Float32Array {
  const out = new Float32Array(value.length)
  for (let i = 0; i < value.length; i++) {
    const f = fstat[i]
    out[i] = Number.isFinite(f) && f >= threshold ? value[i] : NaN
  }
  return out
}
