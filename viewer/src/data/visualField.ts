// Pure retinotopy visual-field math (v1.2.25): polar+eccentricity → visual X/Y, true median,
// RMS local spread, covariance ellipse (~1.8σ), and offset-to-median. DOM/NiiVue-free so the
// numerics are unit-tested (the plot itself draws from these in P5).

export const ECC_MAX = 10 // eccentricity domain hard cap (degrees)
export const RINGS = [2, 4, 6, 8, 10]
const ELLIPSE_SCALE = 1.79 // ≈1.8σ

export interface VfPoint {
  x: number // visual X = ecc·cos(polar)
  y: number // visual Y = ecc·sin(polar)
  polar: number
  ecc: number
  center: boolean
}

export function visualXY(polar: number, ecc: number): [number, number] {
  return [ecc * Math.cos(polar), ecc * Math.sin(polar)]
}

// True median (average of the two middles for even counts).
export function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export interface Ellipse {
  cx: number
  cy: number
  rx: number
  ry: number
  angle: number // radians
}

export interface VfStats {
  medianX: number
  medianY: number
  spread: number // RMS distance to median (degrees)
  ellipse: Ellipse | null
  offset: number | null // center point's distance to median
  valid: number
}

// Statistics over sampled visual-field points. Non-center points drive the fit when there
// are ≥3 of them, else all points are used (matches the reference).
export function visualFieldStats(points: VfPoint[]): VfStats {
  const nonCenter = points.filter((p) => !p.center)
  const center = points.find((p) => p.center) ?? null
  const g = nonCenter.length >= 3 ? nonCenter : points
  if (g.length === 0) {
    return { medianX: 0, medianY: 0, spread: 0, ellipse: null, offset: null, valid: 0 }
  }
  const medianX = median(g.map((p) => p.x))
  const medianY = median(g.map((p) => p.y))

  let sumSq = 0
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const p of g) {
    const dx = p.x - medianX
    const dy = p.y - medianY
    sumSq += dx * dx + dy * dy
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
  }
  const spread = Math.sqrt(sumSq / g.length)

  let ellipse: Ellipse | null = null
  if (g.length >= 2) {
    const n = g.length - 1
    const Sxx = sxx / n
    const Syy = syy / n
    const Sxy = sxy / n
    const a = Sxx + Syy
    const s = Math.sqrt((Sxx - Syy) * (Sxx - Syy) + 4 * Sxy * Sxy)
    const l1 = (a + s) / 2
    const l2 = (a - s) / 2
    const angle = 0.5 * Math.atan2(2 * Sxy, Sxx - Syy)
    ellipse = { cx: medianX, cy: medianY, rx: Math.sqrt(Math.max(0, l1)) * ELLIPSE_SCALE, ry: Math.sqrt(Math.max(0, l2)) * ELLIPSE_SCALE, angle }
  }

  const offset = center ? Math.hypot(center.x - medianX, center.y - medianY) : null
  return { medianX, medianY, spread, ellipse, offset, valid: points.length }
}
