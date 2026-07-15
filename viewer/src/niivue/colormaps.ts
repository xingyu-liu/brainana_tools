// Custom LUTs registered on both NiiVue instances (v1.2.25 fidelity):
//  - eccentricity 0-10: red → blue ramp
//  - somatotopy: the SAME ramp REVERSED (blue at 0 → red at 100) — the v1.2.22 fix
//  - polar angle: a cyclic hue wheel
//  - curvature: binary light/dark gray (sulci/gyri)
// The color stops are exported so the legends (P5) can be drawn from the same source of truth.
import type { Niivue } from '@niivue/niivue'
import { hslToRgb, type RGB } from '../data/colors.ts'

export interface NiiColormap {
  R: number[]
  G: number[]
  B: number[]
  A: number[]
  I: number[]
}

// Build a NiiVue colormap from color stops: index 0 is transparent, stops spaced 1..255.
export function buildColormap(stops: RGB[]): NiiColormap {
  const R = [0]
  const G = [0]
  const B = [0]
  const A = [0]
  const I = [0]
  const n = stops.length
  for (let k = 0; k < n; k++) {
    const idx = n === 1 ? 255 : 1 + Math.round((k * 254) / (n - 1))
    R.push(stops[k][0])
    G.push(stops[k][1])
    B.push(stops[k][2])
    A.push(255)
    I.push(idx)
  }
  return { R, G, B, A, I }
}

// Eccentricity ramp: red → orange → yellow → green → cyan → blue.
export const ECCENTRICITY_STOPS: RGB[] = [
  [204, 16, 51],
  [233, 86, 20],
  [245, 160, 20],
  [247, 220, 30],
  [150, 210, 40],
  [40, 200, 90],
  [30, 190, 200],
  [20, 90, 230],
  [0, 0, 255],
]

// Somatotopy = eccentricity reversed → blue at 0, red at 100.
export const SOMATOTOPY_STOPS: RGB[] = [...ECCENTRICITY_STOPS].reverse()

// Polar-angle wheel: cyclic hue, starting at green.
export const POLAR_STOPS: RGB[] = Array.from({ length: 17 }, (_, k) => hslToRgb((120 + k * 22.5) % 360, 0.85, 0.5))

// Binary curvature: light gray for concave (sulci), dark gray for convex (gyri).
export const CURVATURE_BINARY: NiiColormap = {
  R: [214, 214, 72, 72],
  G: [214, 214, 72, 72],
  B: [214, 214, 72, 72],
  A: [255, 255, 255, 255],
  I: [0, 127, 128, 255],
}

export const COLORMAPS: Record<string, NiiColormap> = {
  brainana_eccentricity: buildColormap(ECCENTRICITY_STOPS),
  brainana_somatotopy: buildColormap(SOMATOTOPY_STOPS),
  brainana_polar_angle: buildColormap(POLAR_STOPS),
  brainana_curvature: CURVATURE_BINARY,
}

export function registerColormaps(nv: Niivue): void {
  for (const [name, cmap] of Object.entries(COLORMAPS)) {
    try {
      nv.addColormap(name, cmap)
    } catch {
      // colormap may already be registered
    }
  }
}
