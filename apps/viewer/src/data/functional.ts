// Pure helpers for retinotopy/somatotopy display: frame selection, dynamic threshold
// bounds, and F-stat masking. No NiiVue/DOM here so the numeric behaviour is unit-tested.
//
// Reference behaviour encoded:
//  - The F-threshold slider bounds come from scanning ONLY the selected F-stat frame and
//    ignoring non-finite samples (its exact finite extrema).
//  - Somatotopy uses a reversed LUT (blue at 0 -> red at 100); retinotopy polar is circular.

export type FunctionalKind = 'retinotopy' | 'somatotopy'

// Stable, casing-independent identity of a mode. Rendering logic (legend shape, surface LUT)
// keys off this — NEVER the display `label`, which is UI text and can be re-cased/reworded.
export type FunctionalModeId = 'polar' | 'eccentricity' | 'bodyPosition'

export interface FunctionalMode {
  /** Stable identity for rendering logic (independent of `label` text/casing). */
  id: FunctionalModeId
  /** UI label. */
  label: string
  /** 4D frame index of the value map to display. */
  valueFrame: number
  /** 4D frame index of the F-stat map used for thresholding (null if none). */
  fFrame: number | null
  /** NiiVue colormap. */
  colormap: string
  /** Display range. cal_min is slightly negative so value 0 maps to the first (opaque) LUT
   *  entry, leaving the transparent index-0 for masked voxels (set below cal_min). */
  calMin: number
  calMax: number
}

// v1.2.25 display ranges (the slightly-negative cal_min reserves the transparent LUT slot).
const POLAR_MIN = -Math.PI - (2 * Math.PI) / 254
const POLAR_MAX = Math.PI

// Derive the selectable modes for a functional map from its manifest frame indices.
export function functionalModes(kind: FunctionalKind, frames: Record<string, number>): FunctionalMode[] {
  if (kind === 'retinotopy') {
    const modes: FunctionalMode[] = []
    // Default to the left/right-hemifield split map (brainana_polar_lr); the smooth cyclic wheel
    // (brainana_polar_angle) stays a selectable option (see niivue/colormaps.ts).
    if (frames.polar != null) modes.push({ id: 'polar', label: 'polar angle', valueFrame: frames.polar, fFrame: frames.polarF ?? null, colormap: 'brainana_polar_lr', calMin: POLAR_MIN, calMax: POLAR_MAX })
    if (frames.eccentricity != null) modes.push({ id: 'eccentricity', label: 'eccentricity', valueFrame: frames.eccentricity, fFrame: frames.eccentricityF ?? null, colormap: 'brainana_eccentricity', calMin: -0.0394, calMax: 10 })
    return modes
  }
  // somatotopy: reversed blue->red LUT so 0 is blue and 100 is red
  const modes: FunctionalMode[] = []
  if (frames.phase != null) modes.push({ id: 'bodyPosition', label: 'body position', valueFrame: frames.phase, fFrame: frames.fstat ?? null, colormap: 'brainana_somatotopy', calMin: -0.3937, calMax: 100 })
  return modes
}

export interface Extrema {
  min: number
  max: number
}

// Remap a functional value for DISPLAY without hiding it: the user's display window [dMin, dMax]
// is mapped onto the colormap's OPAQUE sub-range (calMin+step .. calMax), where step is one LUT
// index. Values ≤ dMin land on the first opaque color (index 1, visible) and ≥ dMax on the last —
// so narrowing the window changes contrast/color but never removes voxels. cal_min/cal_max stay
// fixed at the map's natural range (index 0 stays reserved-transparent for masked voxels).
export function mapFunctionalDisplay(val: number, dMin: number, dMax: number, calMin: number, calMax: number): number {
  const step = (calMax - calMin) / 254 // one LUT index; keeps clamped-low values on index 1 (opaque)
  const lo = calMin + step
  const span = dMax - dMin
  const t = span > 0 ? Math.max(0, Math.min(1, (val - dMin) / span)) : 0
  return lo + t * (calMax - lo)
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

// ---- Function ON the surface (categorical mesh-layer LUT + quantization) ----
// Ported verbatim from the authoritative v1.2.25 source (main.ts:2648-2726). A 256-entry
// categorical LUT is applied to per-vertex bin indices; bin 0 is transparent so masked /
// no-data vertices disappear, and the surface overlay alpha-blends over the morphology layer.

export type SurfaceFunctionMode = 'polar' | 'eccentricity' | 'somatotopy'

// 256x4 RGBA label LUT (min 0, max 255). Bin 0 reserved transparent.
export interface SurfaceLabelLut {
  lut: Uint8ClampedArray
  min: number
  max: number
  labels: string[]
}

type ColorStop = { t: number; rgb: [number, number, number] }

function interpolateRgb(stops: ColorStop[], t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t))
  for (let index = 1; index < stops.length; index += 1) {
    const right = stops[index]
    const left = stops[index - 1]
    if (x <= right.t) {
      const span = Math.max(right.t - left.t, Number.EPSILON)
      const a = (x - left.t) / span
      return [
        Math.round(left.rgb[0] + (right.rgb[0] - left.rgb[0]) * a),
        Math.round(left.rgb[1] + (right.rgb[1] - left.rgb[1]) * a),
        Math.round(left.rgb[2] + (right.rgb[2] - left.rgb[2]) * a),
      ]
    }
  }
  return stops[stops.length - 1].rgb
}

const POLAR_SURFACE_STOPS: ColorStop[] = [
  { t: 0.0, rgb: [0, 255, 0] },
  { t: 0.25, rgb: [0, 0, 255] },
  { t: 0.5, rgb: [0, 255, 0] },
  { t: 0.75, rgb: [255, 0, 0] },
  { t: 1.0, rgb: [0, 255, 0] },
]
const ECC_SURFACE_STOPS: ColorStop[] = [
  { t: 0.0, rgb: [255, 0, 0] },
  { t: 0.2, rgb: [255, 140, 0] },
  { t: 0.4, rgb: [255, 255, 0] },
  { t: 0.6, rgb: [0, 200, 0] },
  { t: 0.8, rgb: [0, 255, 255] },
  { t: 1.0, rgb: [0, 70, 255] },
]

// Blend one channel toward white (brightness >= 1) or down (brightness < 1). Shared by the LUT
// builders so surface shading tracks the same brightness control.
function brightenChannel(channel: number, brightness: number): number {
  return brightness >= 1
    ? Math.min(255, Math.round(channel + (255 - channel) * (brightness - 1)))
    : Math.max(0, Math.round(channel * brightness))
}

// Build the categorical surface LUT from an arbitrary colormap's flat RGBA LUT (as returned by
// NiiVue's colormap(), length = entries·4). Bin 0 is reserved transparent; bins 1..255 sample the
// colormap evenly at t=(bin-1)/254 so the SURFACE uses the SAME colors as the volume overlay + the
// legend (this is what makes the colormap picker recolor the 3D surface, not just the slices).
export function surfaceLutFromColormap(cmapRgba: ArrayLike<number>, brightness = 1): SurfaceLabelLut {
  const rgba = new Uint8ClampedArray(256 * 4)
  const labels = new Array<string>(256).fill('')
  rgba.set([0, 0, 0, 0], 0) // bin 0 transparent (the surface's own masking slot)
  const entries = Math.max(1, Math.floor(cmapRgba.length / 4))
  // Skip a reserved transparent index-0 in the SOURCE colormap (brainana maps) so surface bin 1 is
  // the first OPAQUE color, not the black masking slot — otherwise clamped-low vertices render black.
  const srcLo = entries > 1 && cmapRgba[3] === 0 ? 1 : 0
  for (let bin = 1; bin < 256; bin += 1) {
    const t = (bin - 1) / 254
    const src = (srcLo + Math.round(t * (entries - 1 - srcLo))) * 4
    rgba.set(
      [brightenChannel(cmapRgba[src], brightness), brightenChannel(cmapRgba[src + 1], brightness), brightenChannel(cmapRgba[src + 2], brightness), 255],
      bin * 4,
    )
  }
  return { lut: rgba, min: 0, max: 255, labels }
}

// Build the categorical surface LUT. `brightness` >= 1 blends channels toward white; < 1 scales
// them down. Applied to the LUT ONLY — never to values, thresholds, or the volume overlay.
// Somatotopy samples the eccentricity ramp reversed (body-position 0 = blue, 100 = red).
export function createFunctionalSurfaceLut(mode: SurfaceFunctionMode, brightness = 1): SurfaceLabelLut {
  const rgba = new Uint8ClampedArray(256 * 4)
  const labels = new Array<string>(256).fill('')
  rgba.set([0, 0, 0, 0], 0) // bin 0 transparent
  const stops = mode === 'polar' ? POLAR_SURFACE_STOPS : ECC_SURFACE_STOPS
  for (let bin = 1; bin < 256; bin += 1) {
    const t = (bin - 1) / 254
    const colorT = mode === 'somatotopy' ? 1 - t : t
    const [r0, g0, b0] = interpolateRgb(stops, colorT)
    rgba.set([brightenChannel(r0, brightness), brightenChannel(g0, brightness), brightenChannel(b0, brightness), 255], bin * 4)
  }
  return { lut: rgba, min: 0, max: 255, labels }
}

// Quantize a continuous scalar field to LUT bins 1..255 over [min, max]; background (value 0 or
// non-finite) → bin 0 (transparent). Shared by the continuous-atlas VOLUME and SURFACE so both
// derive identical bins for the same 256-entry colormap LUT, keeping the slices and the 3D mesh
// pixel-consistent. (Distinct from quantizeFunctionalSurfaceValues, whose masking sentinel is <=-999
// and which supports polar/eccentricity modes; here 0 is the background sentinel, as in the volume.)
export function quantizeScalarToBins(values: ArrayLike<number>, min: number, max: number): Float32Array {
  const out = new Float32Array(values.length)
  const span = max - min
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v) || v === 0) {
      out[i] = 0
      continue
    }
    const t = span > 0 ? Math.max(0, Math.min(1, (v - min) / span)) : 0
    out[i] = 1 + Math.min(254, Math.max(0, Math.round(t * 254)))
  }
  return out
}

// Map per-vertex values to LUT bin indices 1..255; sentinel / non-finite / <= -999 → bin 0.
// With no `range`: polar wraps to [0, 2π); eccentricity/somatotopy clamp to [0, max] (somato 100,
// else 10). With a `range` (the display window): every mode quantizes LINEARLY over [min, max] and
// clamps — matching the volume's display-range remap so the surface tracks the same contrast.
export function quantizeFunctionalSurfaceValues(values: ArrayLike<number>, mode: SurfaceFunctionMode, range?: { min: number; max: number }): Float32Array {
  const bins = new Float32Array(values.length)
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!Number.isFinite(value) || value <= -999) {
      bins[index] = 0
      continue
    }
    let t: number
    if (range) {
      const span = range.max - range.min
      t = span > 0 ? Math.max(0, Math.min(1, (value - range.min) / span)) : 0
    } else if (mode === 'polar') {
      const wrapped = (((value + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      t = wrapped / (2 * Math.PI)
    } else {
      const maximum = mode === 'somatotopy' ? 100 : 10
      t = Math.max(0, Math.min(maximum, value)) / maximum
    }
    bins[index] = 1 + Math.min(254, Math.max(0, Math.round(t * 254)))
  }
  return bins
}

// Value-clip on the surface: keep a vertex's bin only when its value is inside the inclusive
// [lo, hi] window (null bound = unbounded); otherwise force bin 0 (transparent). Mirrors the
// volume value-clip so the same voxels/vertices disappear together.
export function maskSurfaceBinsByValue(bins: Float32Array, values: ArrayLike<number>, lo: number | null, hi: number | null): Float32Array {
  const out = new Float32Array(bins.length)
  for (let i = 0; i < bins.length; i++) {
    const v = values[i]
    const keep = Number.isFinite(v) && (lo === null || v >= lo) && (hi === null || v <= hi)
    out[i] = keep ? bins[i] : 0
  }
  return out
}

// Apply the F-threshold on the surface: for each vertex, keep the quantized bin only where the
// F-stat frame is finite and >= threshold; otherwise force bin 0 (transparent). Mirrors the
// volume masking but operates on already-quantized surface bins.
export function maskSurfaceBinsByF(bins: Float32Array, fstat: ArrayLike<number>, threshold: number): Float32Array {
  const out = new Float32Array(bins.length)
  for (let i = 0; i < bins.length; i++) {
    const f = fstat[i]
    out[i] = Number.isFinite(f) && f >= threshold ? bins[i] : 0
  }
  return out
}
