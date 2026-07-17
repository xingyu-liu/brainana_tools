// Reusable min/max range control: two crafted sliders with live numeric read-outs, an optional
// "Auto" (percentile) button and an optional "Symmetric" (mirror around zero) toggle. Generalized
// from the morphology panel so morphology, functional, and future imported overlays share one
// range widget. Pure UI (h() helper); the host owns the data and computes Auto ranges.
import { h } from '../dom.ts'

export interface RangeValue {
  min: number
  max: number
}

export interface RangeControlOptions {
  label?: string
  onChange: (r: RangeValue) => void
  /** Show an "Auto" button; the host computes + pushes the range back via setValue. */
  onAuto?: () => void
  autoLabel?: string
  /** Show a "Symmetric" toggle initialised to this state; omit to hide it. */
  symmetric?: boolean
  onSymmetric?: (on: boolean) => void
  /** Format a value for the read-out (defaults to 3 significant decimals, trimmed). */
  format?: (v: number) => string
}

export interface RangeControl {
  element: HTMLElement
  setDomain: (min: number, max: number, step?: number) => void
  setValue: (min: number, max: number) => void
  value: () => RangeValue
  setSymmetric: (on: boolean) => void
  /** Pin the lower bound: disable the min handle/box so only the upper bound drags (e.g. atlas). */
  setLockMin: (on: boolean) => void
  /** Blank/disable the control (e.g. no active metric). */
  setDisabled: (disabled: boolean) => void
}

const defaultFmt = (v: number): string => {
  const s = Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)
  return s.replace(/\.?0+$/, '') || '0'
}

export function createRangeControl(opts: RangeControlOptions): RangeControl {
  const fmt = opts.format ?? defaultFmt
  let symmetric = !!opts.symmetric

  const minInput = h('input', { type: 'range' }) as HTMLInputElement
  const maxInput = h('input', { type: 'range' }) as HTMLInputElement
  // Editable numeric read-outs: the value can be typed as well as dragged (kept in sync with the slider).
  const minVal = h('input', { type: 'number', class: 'range-num' }) as HTMLInputElement
  const maxVal = h('input', { type: 'number', class: 'range-num' }) as HTMLInputElement

  let domainMin = 0
  let domainMax = 1
  let step = 0.001
  // Symmetric mode needs symmetric slider bounds, else −mag can fall outside an asymmetric domain
  // and the min handle clamps to the left edge (looking stuck). Widen the bounds to ±max(|lo|,|hi|).
  const applyBounds = (): void => {
    let lo = domainMin
    let hi = domainMax
    if (symmetric) {
      const b = Math.max(Math.abs(domainMin), Math.abs(domainMax))
      lo = -b
      hi = b
    }
    for (const inp of [minInput, maxInput]) {
      inp.min = String(lo)
      inp.max = String(hi)
      inp.step = String(step)
    }
  }

  // `source` = the handle the user moved; in symmetric mode its magnitude drives BOTH handles, so
  // either slider can shrink/grow the range (previously the larger magnitude always won → min stuck).
  const commit = (source: 'min' | 'max'): void => {
    let lo = Number(minInput.value)
    let hi = Number(maxInput.value)
    if (symmetric) {
      const mag = Math.abs(source === 'min' ? lo : hi)
      lo = -mag
      hi = mag
      minInput.value = String(lo)
      maxInput.value = String(hi)
    } else if (lo > hi) {
      if (source === 'min') hi = lo
      else lo = hi
      minInput.value = String(lo)
      maxInput.value = String(hi)
    }
    minVal.value = fmt(lo)
    maxVal.value = fmt(hi)
    opts.onChange({ min: lo, max: hi })
  }
  minInput.addEventListener('input', () => commit('min'))
  maxInput.addEventListener('input', () => commit('max'))

  // Typing into a numeric box: clamp to the slider bounds, push into the paired range input, commit.
  const editBox = (box: HTMLInputElement, slider: HTMLInputElement, source: 'min' | 'max'): void => {
    if (box.value.trim() === '' || Number.isNaN(Number(box.value))) {
      box.value = fmt(Number(slider.value))
      return
    }
    const lo = Number(slider.min)
    const hi = Number(slider.max)
    slider.value = String(Math.max(lo, Math.min(hi, Number(box.value))))
    commit(source)
  }
  minVal.addEventListener('change', () => editBox(minVal, minInput, 'min'))
  maxVal.addEventListener('change', () => editBox(maxVal, maxInput, 'max'))

  const actions: Array<Node> = []
  let symChip: HTMLButtonElement | null = null
  if (opts.onSymmetric || opts.symmetric !== undefined) {
    symChip = h('button', { type: 'button', class: `chip${symmetric ? ' active' : ''}` }, ['symmetric']) as HTMLButtonElement
    symChip.addEventListener('click', () => {
      symmetric = !symmetric
      symChip!.classList.toggle('active', symmetric)
      applyBounds() // symmetric bounds so the mirrored handles fit
      opts.onSymmetric?.(symmetric)
      if (symmetric) commit('max')
    })
    actions.push(symChip)
  }

  const element = h('div', { class: 'range-control field' }, [
    ...(opts.label ? [h('span', {}, [opts.label])] : []),
    h('div', { class: 'range-pair' }, [
      h('label', { class: 'range-side' }, [h('span', { class: 'range-cap' }, ['min ', minVal]), minInput]),
      h('label', { class: 'range-side' }, [h('span', { class: 'range-cap' }, ['max ', maxVal]), maxInput]),
    ]),
    ...(actions.length ? [h('div', { class: 'chip-row range-actions' }, actions)] : []),
  ])

  return {
    element,
    setDomain: (min, max, st) => {
      domainMin = min
      domainMax = max
      step = st ?? ((max - min) / 500 || 0.001)
      applyBounds()
    },
    setValue: (min, max) => {
      minInput.value = String(min)
      maxInput.value = String(max)
      minVal.value = fmt(min)
      maxVal.value = fmt(max)
    },
    value: () => ({ min: Number(minInput.value), max: Number(maxInput.value) }),
    setSymmetric: (on) => {
      symmetric = on
      symChip?.classList.toggle('active', on)
      applyBounds()
    },
    setLockMin: (on) => {
      minInput.disabled = on
      minVal.disabled = on
      element.classList.toggle('lock-min', on)
    },
    setDisabled: (disabled) => {
      minInput.disabled = disabled
      maxInput.disabled = disabled
      element.classList.toggle('is-disabled', disabled)
    },
  }
}
