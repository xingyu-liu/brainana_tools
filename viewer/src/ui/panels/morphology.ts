// Floating "Morphology" panel: choose the surface shading metric (curvature / sulcal depth /
// thickness / none), the curvature style (binary FreeSurfer vs continuous gray), the yellow
// marker mode, and the colour range (with an "Auto 2.5–97.5%" button + symmetric-around-zero).
import { h } from '../dom.ts'
import type { MorphologyDisplayMetric, MorphologyMetric, CurvatureStyle } from '../../niivue/multiView.ts'

export type MarkerMode = 'crosshair3d' | 'nearestNode'

export interface MorphologyPanelCallbacks {
  onDisplay: (m: MorphologyDisplayMetric) => void
  onCurvatureStyle: (s: CurvatureStyle) => void
  onMarkerMode: (m: MarkerMode) => void
  onRange: (min: number, max: number) => void
  onAuto: () => void
  onSymmetric: (on: boolean) => void
}

export interface MorphologyPanel {
  element: HTMLElement
  toggle: () => void
  hide: () => void
  // Refresh the range sliders for the active metric. `hidden` blanks the range group (None or
  // binary curvature, which is forced to ±1).
  setRange: (opts: { domainMin: number; domainMax: number; min: number; max: number; metric: MorphologyMetric; hidden: boolean; symmetric: boolean }) => void
}

const chip = (label: string): HTMLButtonElement => h('button', { type: 'button', class: 'chip' }, [label]) as HTMLButtonElement

export function createMorphologyPanel(cb: MorphologyPanelCallbacks): MorphologyPanel {
  // Display metric chips.
  const displayChips: Array<[MorphologyDisplayMetric, string]> = [
    ['curvature', 'Curvature'],
    ['sulc', 'Sulcal depth'],
    ['thickness', 'Thickness'],
    ['none', 'None'],
  ]
  const displayButtons = new Map<MorphologyDisplayMetric, HTMLButtonElement>()
  const displayRow = h('div', { class: 'chip-row' })
  const setActiveMetric = (m: MorphologyDisplayMetric): void => {
    for (const [k, b] of displayButtons) b.classList.toggle('active', k === m)
    styleField.hidden = m !== 'curvature'
  }
  for (const [metric, label] of displayChips) {
    const b = chip(label)
    b.addEventListener('click', () => {
      setActiveMetric(metric)
      cb.onDisplay(metric)
    })
    displayButtons.set(metric, b)
    displayRow.append(b)
  }

  // Curvature style chips (only meaningful for curvature).
  const styleButtons = new Map<CurvatureStyle, HTMLButtonElement>()
  const styleRow = h('div', { class: 'chip-row' })
  const setActiveStyle = (s: CurvatureStyle): void => {
    for (const [k, b] of styleButtons) b.classList.toggle('active', k === s)
  }
  for (const [style, label] of [['binary', 'Binary'], ['continuous', 'Continuous']] as Array<[CurvatureStyle, string]>) {
    const b = chip(label)
    b.addEventListener('click', () => {
      setActiveStyle(style)
      cb.onCurvatureStyle(style)
    })
    styleButtons.set(style, b)
    styleRow.append(b)
  }
  const styleField = h('div', { class: 'field' }, [h('span', {}, ['Curvature style']), styleRow])

  // Yellow marker mode chips.
  const markerButtons = new Map<MarkerMode, HTMLButtonElement>()
  const markerRow = h('div', { class: 'chip-row' })
  for (const [mode, label] of [['crosshair3d', '3D crosshair'], ['nearestNode', 'Nearest node']] as Array<[MarkerMode, string]>) {
    const b = chip(label)
    b.addEventListener('click', () => {
      for (const [k, mb] of markerButtons) mb.classList.toggle('active', k === mode)
      cb.onMarkerMode(mode)
    })
    markerButtons.set(mode, b)
    markerRow.append(b)
  }

  // Colour range (min/max) + value read-outs.
  const fmt = (v: number, metric: MorphologyMetric): string => (metric === 'thickness' ? `${v.toFixed(2)} mm` : v.toFixed(3))
  const minInput = h('input', { type: 'range' }) as HTMLInputElement
  const maxInput = h('input', { type: 'range' }) as HTMLInputElement
  const minVal = h('span', { class: 'muted' }, ['—'])
  const maxVal = h('span', { class: 'muted' }, ['—'])
  let rangeMetric: MorphologyMetric = 'curvature'
  let rangeSymmetric = true
  const commitRange = (): void => {
    let lo = Number(minInput.value)
    let hi = Number(maxInput.value)
    if (rangeSymmetric) {
      // Mirror magnitude around zero (curvature/sulc); the changed handle wins.
      const mag = Math.max(Math.abs(lo), Math.abs(hi))
      lo = -mag
      hi = mag
      minInput.value = String(lo)
      maxInput.value = String(hi)
    } else if (lo > hi) {
      lo = hi
      minInput.value = String(lo)
    }
    minVal.textContent = fmt(lo, rangeMetric)
    maxVal.textContent = fmt(hi, rangeMetric)
    cb.onRange(lo, hi)
  }
  minInput.addEventListener('input', commitRange)
  maxInput.addEventListener('input', commitRange)

  const symChip = chip('Symmetric')
  symChip.classList.add('active')
  symChip.addEventListener('click', () => {
    rangeSymmetric = !rangeSymmetric
    symChip.classList.toggle('active', rangeSymmetric)
    cb.onSymmetric(rangeSymmetric)
    if (rangeSymmetric) commitRange()
  })
  const autoBtn = chip('Auto 2.5–97.5%')
  autoBtn.addEventListener('click', () => cb.onAuto())

  const rangeField = h('div', { class: 'field' }, [
    h('span', {}, ['Colour range']),
    h('div', { class: 'row' }, [h('label', { class: 'field' }, [h('span', {}, ['Min ', minVal]), minInput]), h('label', { class: 'field' }, [h('span', {}, ['Max ', maxVal]), maxInput])]),
    h('div', { class: 'chip-row' }, [autoBtn, symChip]),
  ])

  const closeBtn = h('button', { type: 'button', class: 'float-panel-close', title: 'Close' }, ['×']) as HTMLButtonElement
  const element = h('div', { class: 'float-panel', hidden: true }, [
    h('div', { class: 'float-panel-head' }, ['Morphology', closeBtn]),
    h('div', { class: 'field' }, [h('span', {}, ['Display']), displayRow]),
    styleField,
    h('div', { class: 'field' }, [h('span', {}, ['Yellow marker']), markerRow]),
    rangeField,
  ])
  closeBtn.addEventListener('click', () => (element.hidden = true))

  // Initial active states.
  setActiveMetric('curvature')
  setActiveStyle('binary')
  markerButtons.get('crosshair3d')?.classList.add('active')

  return {
    element,
    toggle: () => (element.hidden = !element.hidden),
    hide: () => (element.hidden = true),
    setRange: ({ domainMin, domainMax, min, max, metric, hidden, symmetric }) => {
      rangeMetric = metric
      rangeSymmetric = symmetric
      symChip.classList.toggle('active', symmetric)
      rangeField.hidden = hidden
      const step = (domainMax - domainMin) / 500 || 0.001
      for (const inp of [minInput, maxInput]) {
        inp.min = String(domainMin)
        inp.max = String(domainMax)
        inp.step = String(step)
      }
      minInput.value = String(min)
      maxInput.value = String(max)
      minVal.textContent = fmt(min, metric)
      maxVal.textContent = fmt(max, metric)
    },
  }
}
