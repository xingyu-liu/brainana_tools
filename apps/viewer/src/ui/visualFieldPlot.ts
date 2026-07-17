// Draws the retinotopy visual-field plot from sampled points + stats (viewer/src/data/visualField.ts).
// Concentric rings at 2/4/6/8/10° with degree labels, bold Upper/Lower/Left/Right cardinals, a
// covariance ellipse, neighbor dots, the median (diamond), a yellow line + dashed link from the
// center voxel to the median, and the selected voxel (gold). Ported from the previous build's look.
import { RINGS, ECC_MAX, type VfPoint, type VfStats } from '../data/visualField.ts'

// The plot is drawn to a 2D canvas, which can't read CSS custom properties directly, so we read
// the theme tokens once (they're static — no runtime theme toggle) and derive concrete colors.
interface VfTheme {
  text: string
  muted: string
  accent: string
  accent2: string
  gold: string
  ink: string
  font: string
}
let cachedTheme: VfTheme | null = null
function theme(): VfTheme {
  if (cachedTheme) return cachedTheme
  const s = getComputedStyle(document.documentElement)
  const g = (name: string, fallback: string): string => s.getPropertyValue(name).trim() || fallback
  cachedTheme = {
    text: g('--text', '#ece6d8'),
    muted: g('--muted', '#a1957f'),
    accent: g('--accent', '#e6a13a'),
    accent2: g('--accent-2', '#f4c877'),
    gold: g('--gold', '#f1d272'),
    ink: g('--bg', '#14120d'),
    font: g('--font', "'Source Sans 3', system-ui, sans-serif"),
  }
  return cachedTheme
}
// #rrggbb (or #rgb) → rgba() with the given alpha; passes through non-hex strings unchanged.
function rgba(hex: string, a: number): string {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  if (h.length !== 6) return hex
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${a})`
}

export function drawVisualField(canvas: HTMLCanvasElement, points: VfPoint[], stats: VfStats): void {
  const t = theme()
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const size = Math.min(canvas.clientWidth || 300, canvas.clientHeight || 300)
  canvas.width = size * dpr
  canvas.height = size * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size, size)

  // Label-aware layout: grow the rings until a label would leave the canvas, on whichever axis
  // binds first. Horizontal is squeezed by the "Left"/"Right" text widths; vertical by the
  // "Upper"/"Lower" cardinals. A slight leftward center bias gives the wider "Right" label room.
  ctx.font = `600 13px ${t.font}`
  const leftW = ctx.measureText('Left').width
  const rightW = ctx.measureText('Right').width
  const sideGap = 3
  const edgePad = 2
  const topPad = 17 // "Upper" ascent + gap above the ring
  const botPad = 19 // "Lower" descent + gap below the ring
  const cx = size / 2 - Math.max(0, (rightW - leftW) / 4)
  const cy = size / 2
  const hRadius = Math.min(cx - leftW - sideGap - edgePad, size - cx - rightW - sideGap - edgePad)
  const vRadius = Math.min(cy - topPad, size - cy - botPad)
  const radius = Math.max(20, Math.min(hRadius, vRadius))
  const pxPerDeg = radius / ECC_MAX
  const toPx = (x: number, y: number): [number, number] => [cx + x * pxPerDeg, cy - y * pxPerDeg]

  // eccentricity rings
  ctx.strokeStyle = rgba(t.muted, 0.4)
  ctx.lineWidth = 1.5
  for (const r of RINGS) {
    ctx.beginPath()
    ctx.arc(cx, cy, r * pxPerDeg, 0, 2 * Math.PI)
    ctx.stroke()
  }

  // horizontal + vertical meridian axes
  ctx.strokeStyle = rgba(t.text, 0.55)
  ctx.lineWidth = 1.8
  ctx.beginPath()
  ctx.moveTo(cx - radius, cy)
  ctx.lineTo(cx + radius, cy)
  ctx.moveTo(cx, cy - radius)
  ctx.lineTo(cx, cy + radius)
  ctx.stroke()

  // cardinal labels
  ctx.fillStyle = rgba(t.text, 0.98)
  ctx.font = `600 13px ${t.font}`
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'center'
  ctx.fillText('Upper', cx, cy - radius - 7)
  ctx.fillText('Lower', cx, cy + radius + 16)
  ctx.textAlign = 'right'
  ctx.fillText('Left', cx - radius - 4, cy + 4)
  ctx.textAlign = 'left'
  ctx.fillText('Right', cx + radius + 4, cy + 4)

  // degree labels along the upper vertical meridian
  ctx.fillStyle = rgba(t.text, 0.85)
  ctx.font = `600 10px ${t.font}`
  ctx.textAlign = 'left'
  for (const r of RINGS) ctx.fillText(`${r}°`, cx + 4, cy - r * pxPerDeg + 3)

  // small center tick cross
  ctx.strokeStyle = rgba(t.text, 0.9)
  ctx.lineWidth = 1.8
  ctx.beginPath()
  ctx.moveTo(cx - 4, cy)
  ctx.lineTo(cx + 4, cy)
  ctx.moveTo(cx, cy - 4)
  ctx.lineTo(cx, cy + 4)
  ctx.stroke()

  // covariance ellipse (fill + outline)
  if (stats.ellipse) {
    const [ex, ey] = toPx(stats.ellipse.cx, stats.ellipse.cy)
    ctx.save()
    ctx.translate(ex, ey)
    ctx.rotate(-stats.ellipse.angle)
    ctx.beginPath()
    ctx.ellipse(0, 0, Math.max(1, stats.ellipse.rx * pxPerDeg), Math.max(1, stats.ellipse.ry * pxPerDeg), 0, 0, 2 * Math.PI)
    ctx.fillStyle = rgba(t.accent, 0.16)
    ctx.strokeStyle = rgba(t.accent2, 0.85)
    ctx.lineWidth = 2
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  const center = points.find((p) => p.center)

  // yellow line center→selected voxel, dashed link voxel→median
  if (center) {
    const [px, py] = toPx(center.x, center.y)
    ctx.strokeStyle = rgba(t.gold, 0.92)
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(px, py)
    ctx.stroke()
    if (points.length) {
      const [mx, my] = toPx(stats.medianX, stats.medianY)
      ctx.save()
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = rgba(t.text, 0.6)
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(mx, my)
      ctx.stroke()
      ctx.restore()
    }
  }

  // neighbor sample dots
  ctx.fillStyle = rgba(t.accent, 0.8)
  for (const p of points) {
    if (p.center) continue
    const [px, py] = toPx(p.x, p.y)
    ctx.beginPath()
    ctx.arc(px, py, 3.4, 0, 2 * Math.PI)
    ctx.fill()
  }

  // median (rotated-square outline)
  if (points.length) {
    const [mx, my] = toPx(stats.medianX, stats.medianY)
    ctx.save()
    ctx.translate(mx, my)
    ctx.rotate(Math.PI / 4)
    ctx.strokeStyle = rgba(t.text, 0.9)
    ctx.lineWidth = 2
    ctx.strokeRect(-4.25, -4.25, 8.5, 8.5)
    ctx.restore()
  }

  // selected voxel (gold with dark outline)
  if (center) {
    const [px, py] = toPx(center.x, center.y)
    ctx.beginPath()
    ctx.arc(px, py, 5.5, 0, 2 * Math.PI)
    ctx.fillStyle = t.gold
    ctx.strokeStyle = t.ink
    ctx.lineWidth = 2.5
    ctx.fill()
    ctx.stroke()
  }
}
