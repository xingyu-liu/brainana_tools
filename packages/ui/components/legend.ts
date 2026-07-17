// Reusable overlay legend that renders one of three shapes from a colormap, so the legend always
// matches the volume + surface colors:
//   - 'bar'   → horizontal colorbar (reuses colorbar.ts): morphology, linear function maps, atlas.
//   - 'wheel' → angular color wheel (polar angle) — position around the circle = the mapped value.
//   - 'rings' → concentric radial bands (eccentricity) — center = min, edge = max.
// Wheel/rings sample a flat RGBA LUT (from niivue buildColormapAssets); the bar takes a CSS gradient.
import { h } from '../dom.ts'
import { createColorbar, type Colorbar } from './colorbar.ts'

export type LegendShape = 'bar' | 'wheel' | 'rings'

export interface LegendState {
  shape: LegendShape
  /** Required for wheel/rings — a flat RGBA LUT (length = entries·4). */
  lut?: ArrayLike<number>
  /** Required for bar — a CSS gradient string. */
  gradient?: string
  min: number
  max: number
  clipLow?: number | null
  clipHigh?: number | null
  unit?: string
  /** Bar shape only: [min, mid, max] semantic tick labels (wheel/rings ignore this). */
  ticks?: [string, string, string]
}

export interface Legend {
  element: HTMLElement
  set: (state: LegendState) => void
  hide: () => void
}

const fmtDeg = (v: number): string => {
  const s = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2)
  return s.replace(/\.?0+$/, '') || '0'
}

// Sample a flat RGBA LUT at t∈[0,1] → "rgb(r,g,b)". brainana maps reserve index 0 as the transparent
// (black) masking slot, so when index 0 is transparent we sample the OPAQUE range [1, entries-1] —
// otherwise t=0 would paint a black wedge/center that reads as a gap in the wheel/rings legend.
function sampleLut(lut: ArrayLike<number>, t: number): string {
  const entries = Math.max(1, Math.floor(lut.length / 4))
  const lo = entries > 1 && lut[3] === 0 ? 1 : 0
  const idx = (lo + Math.max(0, Math.min(entries - 1 - lo, Math.round(t * (entries - 1 - lo))))) * 4
  return `rgb(${lut[idx]},${lut[idx + 1]},${lut[idx + 2]})`
}

// Overlay used to dim clipped-out regions of the wheel/rings (warm bg, semi-opaque).
const DIM = 'rgba(20,18,13,0.72)'

// The [tLo, tHi] fractions (0..1) of the display range that survive the clip window; the regions
// [0, tLo) and (tHi, 1] are clipped out and get dimmed on the wheel/rings.
function clipFractions(s: LegendState): [number, number] {
  const span = s.max - s.min
  const f = (v: number): number => (span > 0 ? Math.max(0, Math.min(1, (v - s.min) / span)) : 0)
  return [s.clipLow != null ? f(s.clipLow) : 0, s.clipHigh != null ? f(s.clipHigh) : 1]
}

export function createLegend(label = 'Legend'): Legend {
  const head = h('div', { class: 'legend-head muted' }, [label])
  const bar: Colorbar = createColorbar('')
  const canvas = h('canvas', { class: 'legend-canvas', hidden: true }) as HTMLCanvasElement
  const caption = h('div', { class: 'legend-cap muted', hidden: true }, [''])
  const element = h('div', { class: 'overlay-legend', hidden: true }, [head, bar.element, canvas, caption])

  const drawWheel = (lut: ArrayLike<number>, s: LegendState): void => {
    const dpr = window.devicePixelRatio || 1
    const size = 120
    canvas.width = size * dpr
    canvas.height = size * dpr
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)
    const cx = size / 2
    const cy = size / 2
    const rOuter = size / 2 - 6
    const rInner = rOuter * 0.34
    // A single conic gradient paints the whole ring in one fill — no per-wedge anti-aliasing seams,
    // and it wraps continuously through 0°/360° (the color at offset 1 matches offset 0 for the
    // cyclic polar map). A conic gradient runs CLOCKWISE from 3 o'clock, but the polar-angle
    // convention is standard math orientation (value 0 at the right, angle increasing COUNTER-
    // clockwise: +π/2 up, ±π left, −π/2 down). So remap each ring offset `o` to the LUT position
    // (0.5 − o), which puts value 0 at 3 o'clock and reverses the sweep to CCW — otherwise the wheel
    // renders left↔right mirrored (invisible on the L/R map, wrong on the smooth cyclic map).
    const grad = ctx.createConicGradient(0, cx, cy)
    const STOPS = 90
    for (let s = 0; s <= STOPS; s++) {
      const t = s / STOPS
      grad.addColorStop(t, sampleLut(lut, ((0.5 - t) % 1 + 1) % 1))
    }
    // Fill the annulus: outer circle (CW) minus inner circle (CCW) leaves the center hole.
    ctx.beginPath()
    ctx.arc(cx, cy, rOuter, 0, 2 * Math.PI, false)
    ctx.arc(cx, cy, rInner, 0, 2 * Math.PI, true)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()
    // Dim the clipped-out angular sectors (value outside [clipLow, clipHigh] → hidden on the surface).
    const [tLo, tHi] = clipFractions(s)
    if (tLo > 0 || tHi < 1) {
      ctx.fillStyle = DIM
      const dimArc = (a0: number, a1: number): void => {
        if (a1 <= a0) return
        ctx.beginPath()
        ctx.arc(cx, cy, rOuter, a0 * 2 * Math.PI, a1 * 2 * Math.PI, false)
        ctx.arc(cx, cy, rInner, a1 * 2 * Math.PI, a0 * 2 * Math.PI, true)
        ctx.closePath()
        ctx.fill()
      }
      dimArc(0, tLo)
      dimArc(tHi, 1)
    }
  }

  const drawRings = (lut: ArrayLike<number>, s: LegendState): void => {
    const dpr = window.devicePixelRatio || 1
    const size = 120
    canvas.width = size * dpr
    canvas.height = size * dpr
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)
    const cx = size / 2
    const cy = size / 2
    const R = size / 2 - 6
    // Paint outer→inner filled discs; radius r ↔ t=r/R (center = min, edge = max).
    for (let r = Math.round(R); r >= 1; r--) {
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, 2 * Math.PI)
      ctx.fillStyle = sampleLut(lut, r / R)
      ctx.fill()
    }
    // Dim the clipped-out radial bands (inner disc below clipLow, outer ring above clipHigh).
    const [tLo, tHi] = clipFractions(s)
    ctx.fillStyle = DIM
    if (tLo > 0) {
      ctx.beginPath()
      ctx.arc(cx, cy, tLo * R, 0, 2 * Math.PI)
      ctx.fill()
    }
    if (tHi < 1) {
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, 2 * Math.PI, false)
      ctx.arc(cx, cy, tHi * R, 0, 2 * Math.PI, true)
      ctx.fill()
    }
  }

  return {
    element,
    hide: () => (element.hidden = true),
    set: (s) => {
      element.hidden = false
      if (s.shape === 'bar') {
        canvas.hidden = true
        caption.hidden = true
        bar.element.hidden = false
        bar.set({ gradient: s.gradient ?? 'linear-gradient(90deg,#000,#000)', min: s.min, max: s.max, clipLow: s.clipLow, clipHigh: s.clipHigh, unit: s.unit, ticks: s.ticks })
        return
      }
      // wheel / rings
      bar.element.hidden = true
      canvas.hidden = false
      caption.hidden = false
      if (s.lut) (s.shape === 'wheel' ? drawWheel : drawRings)(s.lut, s)
      const unit = s.unit ? ` ${s.unit}` : ''
      caption.textContent =
        s.shape === 'rings'
          ? `${fmtDeg(s.min)}${unit} (center) → ${fmtDeg(s.max)}${unit} (edge)`
          : `${fmtDeg(s.min)}${unit} → ${fmtDeg(s.max)}${unit}`
    },
  }
}
