// Surface-pane orientation widget (the R/L · A/P · S/I axis cross from v1.2.25). An SVG
// overlay recomputed live from the render instance's camera (renderAzimuth/renderElevation),
// independent of pan/zoom. The axis pointing toward the viewer is highlighted.
import type { Niivue } from '@niivue/niivue'

const SVG_NS = 'http://www.w3.org/2000/svg'
const SIZE = 96
const C = SIZE / 2
const R = 34

// The surface vertices are standard FreeSurfer surface-RAS (+x Right, +y Anterior, +z
// Superior) — confirmed from the GIFTI VolGeom header. But NiiVue's render camera
// (renderAzimuth) maps world +y toward the BACK of the view, so projecting the raw RAS +y
// as "Anterior" put the A/P labels backwards. The A/P label directions are therefore flipped
// here to match the rendered brain: anterior is drawn along −y, posterior along +y. R/L/S/I
// are unaffected.
const AXES: Array<{ label: string; v: [number, number, number] }> = [
  { label: 'R', v: [1, 0, 0] },
  { label: 'L', v: [-1, 0, 0] },
  { label: 'A', v: [0, -1, 0] },
  { label: 'P', v: [0, 1, 0] },
  { label: 'S', v: [0, 0, 1] },
  { label: 'I', v: [0, 0, -1] },
]

function project(v: [number, number, number], azDeg: number, elDeg: number): { sx: number; sy: number; depth: number } {
  const az = (azDeg * Math.PI) / 180
  const el = (elDeg * Math.PI) / 180
  // azimuth about the vertical (Superior/Inferior) axis
  const x1 = v[0] * Math.cos(az) + v[1] * Math.sin(az)
  const y1 = -v[0] * Math.sin(az) + v[1] * Math.cos(az)
  const z1 = v[2]
  // elevation tilt about the screen-horizontal axis
  const y2 = y1 * Math.cos(el) + z1 * Math.sin(el)
  const z2 = -y1 * Math.sin(el) + z1 * Math.cos(el)
  return { sx: x1, sy: -z2, depth: y2 } // sy negated: SVG y grows downward
}

export class OrientationGizmo {
  #nv: Niivue
  #svg: SVGSVGElement
  #labels = new Map<string, SVGTextElement>()
  #lines = new Map<string, SVGLineElement>()
  #raf = 0
  #last = ''

  constructor(container: HTMLElement, nv: Niivue) {
    this.#nv = nv
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`)
    svg.setAttribute('class', 'orientation-widget')
    const origin = document.createElementNS(SVG_NS, 'circle')
    origin.setAttribute('cx', String(C))
    origin.setAttribute('cy', String(C))
    origin.setAttribute('r', '2.5')
    origin.setAttribute('class', 'orientation-origin')
    svg.appendChild(origin)
    for (const axis of AXES) {
      const line = document.createElementNS(SVG_NS, 'line')
      line.setAttribute('class', 'orientation-line')
      this.#lines.set(axis.label, line)
      svg.appendChild(line)
    }
    for (const axis of AXES) {
      const text = document.createElementNS(SVG_NS, 'text')
      text.setAttribute('class', 'orientation-axis')
      text.textContent = axis.label
      this.#labels.set(axis.label, text)
      svg.appendChild(text)
    }
    container.appendChild(svg)
    this.#svg = svg
  }

  #draw(): void {
    const scene = (this.#nv as unknown as { scene?: { renderAzimuth?: number; renderElevation?: number } }).scene
    const az = scene?.renderAzimuth ?? 0
    const el = scene?.renderElevation ?? 0
    const key = `${Math.round(az)}:${Math.round(el)}`
    if (key === this.#last) return
    this.#last = key
    for (const axis of AXES) {
      const p = project(axis.v, az, el)
      const x = C + p.sx * R
      const y = C + p.sy * R
      const near = p.depth >= 0
      const text = this.#labels.get(axis.label)!
      text.setAttribute('x', String(x))
      text.setAttribute('y', String(y + 4))
      text.classList.toggle('orientation-near', near)
      const line = this.#lines.get(axis.label)!
      line.setAttribute('x1', String(C))
      line.setAttribute('y1', String(C))
      line.setAttribute('x2', String(C + p.sx * (R - 12)))
      line.setAttribute('y2', String(C + p.sy * (R - 12)))
      line.classList.toggle('orientation-near', near)
    }
  }

  start(): void {
    const loop = (): void => {
      this.#draw()
      this.#raf = requestAnimationFrame(loop)
    }
    this.#raf = requestAnimationFrame(loop)
  }

  stop(): void {
    if (this.#raf) cancelAnimationFrame(this.#raf)
    this.#raf = 0
  }

  destroy(): void {
    this.stop()
    this.#svg.remove()
  }
}
