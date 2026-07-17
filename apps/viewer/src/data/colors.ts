// Procedural ROI colors — deterministic from the label ID (golden-angle HSL), matching
// v1.2.25 so the same color feeds the volume overlay, the surface projection, and the legend
// swatch. Regions WM/CSF get fixed tissue colors. A single default seed is used for every atlas
// (no per-atlas special-casing).
// Reverse-engineered constants: hue=(id·137.508+seed)%360, sat=62+id%3·8, light=49+id%4·5.

export type RGB = [number, number, number]

export const ARM_SEED = 0
const WM_COLOR: RGB = [205, 205, 205]
const CSF_COLOR: RGB = [105, 190, 245]

export function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = l - c / 2
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

// Color for an atlas label. `region` (from the TSV) special-cases white matter / CSF.
export function roiColor(id: number, region: string | undefined, seed = ARM_SEED): RGB {
  const r = (region || '').toUpperCase()
  if (r === 'WM') return WM_COLOR
  if (r === 'CSF') return CSF_COLOR
  const hue = (id * 137.508 + seed) % 360
  const sat = (62 + (id % 3) * 8) / 100
  const light = (49 + (id % 4) * 5) / 100
  return hslToRgb(hue, sat, light)
}
