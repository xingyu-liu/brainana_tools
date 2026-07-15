// Draws the retinotopy visual-field plot from sampled points + stats (viewer/src/data/visualField.ts).
// Concentric rings at 2/4/6/8/10° with degree labels, bold Upper/Lower/Left/Right cardinals, a
// covariance ellipse, neighbor dots, the median (diamond), a yellow line + dashed link from the
// center voxel to the median, and the selected voxel (gold). Ported from the previous build's look.
import { RINGS, ECC_MAX, type VfPoint, type VfStats } from '../data/visualField.ts'

export function drawVisualField(canvas: HTMLCanvasElement, points: VfPoint[], stats: VfStats): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const size = Math.min(canvas.clientWidth || 300, canvas.clientHeight || 300)
  canvas.width = size * dpr
  canvas.height = size * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size, size)

  // Label-aware layout: keep the anatomical side labels fully inside the canvas; a slight leftward
  // center bias gives the longer "Right" label equal breathing room.
  ctx.font = '700 18px system-ui, sans-serif'
  const leftW = ctx.measureText('Left').width
  const rightW = ctx.measureText('Right').width
  const sideGap = 12
  const edgePad = 8
  const cx = size / 2 - Math.max(0, (rightW - leftW) / 4)
  const cy = size / 2
  const hRadius = Math.min(cx - leftW - sideGap - edgePad, size - cx - rightW - sideGap - edgePad)
  const radius = Math.max(20, Math.min(size * 0.365, hRadius))
  const pxPerDeg = radius / ECC_MAX
  const toPx = (x: number, y: number): [number, number] => [cx + x * pxPerDeg, cy - y * pxPerDeg]

  // eccentricity rings
  ctx.strokeStyle = 'rgba(180,195,214,0.36)'
  ctx.lineWidth = 2.8
  for (const r of RINGS) {
    ctx.beginPath()
    ctx.arc(cx, cy, r * pxPerDeg, 0, 2 * Math.PI)
    ctx.stroke()
  }

  // horizontal + vertical meridian axes
  ctx.strokeStyle = 'rgba(215,225,237,0.68)'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(cx - radius, cy)
  ctx.lineTo(cx + radius, cy)
  ctx.moveTo(cx, cy - radius)
  ctx.lineTo(cx, cy + radius)
  ctx.stroke()

  // cardinal labels
  ctx.fillStyle = 'rgba(230,237,246,0.98)'
  ctx.font = '700 18px system-ui, sans-serif'
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'center'
  ctx.fillText('Upper', cx, cy - radius - 12)
  ctx.fillText('Lower', cx, cy + radius + 22)
  ctx.textAlign = 'right'
  ctx.fillText('Left', cx - radius - 12, cy + 6)
  ctx.textAlign = 'left'
  ctx.fillText('Right', cx + radius + 12, cy + 6)

  // degree labels along the upper vertical meridian
  ctx.fillStyle = 'rgba(225,234,244,0.92)'
  ctx.font = '700 14px system-ui, sans-serif'
  ctx.textAlign = 'left'
  for (const r of RINGS) ctx.fillText(`${r}°`, cx + 3, cy - r * pxPerDeg + 10)

  // small center tick cross
  ctx.strokeStyle = 'rgba(235,241,247,0.9)'
  ctx.lineWidth = 2.6
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
    ctx.fillStyle = 'rgba(67,154,232,0.14)'
    ctx.strokeStyle = 'rgba(93,174,245,0.78)'
    ctx.lineWidth = 3.2
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  const center = points.find((p) => p.center)

  // yellow line center→selected voxel, dashed link voxel→median
  if (center) {
    const [px, py] = toPx(center.x, center.y)
    ctx.strokeStyle = 'rgba(255,205,72,0.92)'
    ctx.lineWidth = 2.8
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(px, py)
    ctx.stroke()
    if (points.length) {
      const [mx, my] = toPx(stats.medianX, stats.medianY)
      ctx.save()
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = 'rgba(236,241,247,0.6)'
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(mx, my)
      ctx.stroke()
      ctx.restore()
    }
  }

  // neighbor sample dots
  ctx.fillStyle = 'rgba(83,184,238,0.75)'
  for (const p of points) {
    if (p.center) continue
    const [px, py] = toPx(p.x, p.y)
    ctx.beginPath()
    ctx.arc(px, py, 4.5, 0, 2 * Math.PI)
    ctx.fill()
  }

  // median (rotated-square outline)
  if (points.length) {
    const [mx, my] = toPx(stats.medianX, stats.medianY)
    ctx.save()
    ctx.translate(mx, my)
    ctx.rotate(Math.PI / 4)
    ctx.strokeStyle = 'rgba(244,247,251,0.9)'
    ctx.lineWidth = 2.7
    ctx.strokeRect(-5.25, -5.25, 10.5, 10.5)
    ctx.restore()
  }

  // selected voxel (gold with dark outline)
  if (center) {
    const [px, py] = toPx(center.x, center.y)
    ctx.beginPath()
    ctx.arc(px, py, 7.5, 0, 2 * Math.PI)
    ctx.fillStyle = '#ffd04a'
    ctx.strokeStyle = '#15191f'
    ctx.lineWidth = 3
    ctx.fill()
    ctx.stroke()
  }
}
