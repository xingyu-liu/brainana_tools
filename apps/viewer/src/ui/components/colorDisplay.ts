// The unified "Color display" section docked at the bottom of the side panel. It owns the generic
// color controls that used to be nested in each panel — colormap picker, legend (bar/wheel/rings),
// display range (cal clamp), and clip (hide) — and targets whichever overlay is active. The dashboard
// drives it via setTarget() and routes the callbacks to the active overlay's apply path.
import { h } from '@brainana/ui/dom.ts'
import { createColormapPicker, type ColormapPicker } from './colormapPicker.ts'
import { createRangeControl, type RangeControl } from '@brainana/ui/components/rangeControl.ts'
import { createLegend, type Legend, type LegendShape } from '@brainana/ui/components/legend.ts'
import type { ColormapInfo } from '../../data/colormap.ts'

export interface ColorDisplayCallbacks {
  onColormap: (key: string) => void
  onDisplayRange: (min: number, max: number) => void
  onDisplaySymmetric?: (on: boolean) => void
  onDisplayAuto?: () => void
  onClipRange?: (lo: number | null, hi: number | null) => void
  onReset?: () => void
}

export interface ColorDisplayTarget {
  title: string
  colormap: string
  legendShape: LegendShape
  gradient: string
  lut?: ArrayLike<number>
  displayDomain: { min: number; max: number }
  displayRange: { min: number; max: number }
  displaySymmetric?: boolean
  /** Hide the display-range slider (e.g. categorical atlas, where the map spreads across label ids). */
  showDisplayRange?: boolean
  /** Pin the display-range lower bound so only the upper bound drags (continuous atlas). */
  lockMin?: boolean
  /** Override the colormaps offered by the picker (e.g. drop "labels" for a continuous atlas). */
  colormaps?: ColormapInfo[]
  /** Clip UI variant: a full lo/hi range, or none. */
  clip: 'range' | 'none'
  clipDomain?: { min: number; max: number }
  clipValue?: { lo: number | null; hi: number | null }
  unit?: string
  /** Bar-legend semantic tick labels [min, mid, max] (e.g. somatotopy's foot / hand / face). */
  barTicks?: [string, string, string]
  /**
   * Default collapsed state, applied only when the target *identity* (title) changes — e.g. a
   * categorical atlas starts collapsed since the ROI list above already shows the real palette,
   * yet a manual expand persists across the frequent same-target refreshes.
   */
  collapsed?: boolean
}

export interface ColorDisplay {
  element: HTMLElement
  setTarget: (t: ColorDisplayTarget | null) => void
}

const EPS = 1e-6

export function createColorDisplay(
  cb: ColorDisplayCallbacks,
  gradients: Record<string, string>,
  infos: ColormapInfo[],
): ColorDisplay {
  // Header doubles as a collapse toggle. Reset (restore the active overlay's defaults) sits inline
  // with the colormap row, not the header — it reads as "reset these colors".
  const head = h('button', { type: 'button', class: 'color-display-head' }, ['color display'])
  const resetBtn = h('button', { type: 'button', class: 'ghost sm' }, ['reset']) as HTMLButtonElement
  resetBtn.addEventListener('click', () => cb.onReset?.())

  const picker: ColormapPicker = createColormapPicker({ gradients, infos, onChange: (k) => cb.onColormap(k) })
  const legend: Legend = createLegend('legend')

  let clipDomain = { min: 0, max: 1 }
  const displayRange: RangeControl = createRangeControl({
    onChange: ({ min, max }) => cb.onDisplayRange(min, max),
    symmetric: cb.onDisplaySymmetric ? false : undefined,
    onSymmetric: cb.onDisplaySymmetric,
  })
  const clipRange: RangeControl = createRangeControl({
    onChange: ({ min, max }) => {
      const lo = min <= clipDomain.min + EPS ? null : min
      const hi = max >= clipDomain.max - EPS ? null : max
      cb.onClipRange?.(lo, hi)
    },
  })
  const displayField = h('div', { class: 'field' }, [h('span', {}, ['display']), displayRange.element])
  const clipRangeField = h('div', { class: 'field' }, [h('span', {}, ['clip']), clipRange.element])

  const body = h('div', { class: 'color-display-body' }, [
    h('div', { class: 'field' }, [
      h('div', { class: 'row' }, [h('span', { class: 'grow' }, ['colormap']), resetBtn]),
      picker.element,
    ]),
    legend.element,
    displayField,
    clipRangeField,
  ])
  const element = h('div', { class: 'color-display', hidden: true }, [
    h('div', { class: 'color-display-title' }, [head],),
    body,
  ])
  // Clicking the header collapses/expands the body (keeps a short window usable).
  head.addEventListener('click', () => element.classList.toggle('collapsed'))

  // Apply a target's default collapsed state only when the target identity changes, so a manual
  // expand/collapse survives the many same-target refreshColorDisplay() re-renders.
  let lastTitle: string | null = null

  return {
    element,
    setTarget: (t) => {
      if (!t) {
        element.hidden = true
        lastTitle = null
        return
      }
      element.hidden = false
      if (t.title !== lastTitle) {
        element.classList.toggle('collapsed', !!t.collapsed)
        lastTitle = t.title
      }
      if (t.colormaps) picker.setInfos(t.colormaps)
      picker.setValue(t.colormap)
      // Legend
      legend.set({
        shape: t.legendShape,
        gradient: t.gradient,
        lut: t.lut,
        min: t.displayRange.min,
        max: t.displayRange.max,
        clipLow: t.clipValue?.lo ?? null,
        clipHigh: t.clipValue?.hi ?? null,
        unit: t.unit,
        ticks: t.barTicks,
      })
      // Display range
      displayField.hidden = t.showDisplayRange === false
      displayRange.setDomain(t.displayDomain.min, t.displayDomain.max)
      displayRange.setValue(t.displayRange.min, t.displayRange.max)
      if (t.displaySymmetric !== undefined) displayRange.setSymmetric(t.displaySymmetric)
      displayRange.setLockMin(!!t.lockMin)
      // Clip variant
      clipRangeField.hidden = t.clip !== 'range'
      if (t.clip === 'range' && t.clipDomain) {
        clipDomain = t.clipDomain
        clipRange.setDomain(t.clipDomain.min, t.clipDomain.max)
        clipRange.setValue(t.clipValue?.lo ?? t.clipDomain.min, t.clipValue?.hi ?? t.clipDomain.max)
      }
    },
  }
}
