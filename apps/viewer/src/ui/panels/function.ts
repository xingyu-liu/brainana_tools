// Docked "function" picker (top of the side panel): pick a retinotopy (Polar/Eccentricity) or
// somatotopy (Body position) map from a dropdown, and tune the F-stat threshold, opacity, and surface
// brightness. Color controls (colormap, display range, clip, legend) live in the shared "Color
// display" section at the bottom of the side panel, not here.
import { functionalModes, type FunctionalKind, type FunctionalMode } from '../../data/functional.ts'
import type { Manifest } from '../../types.ts'
import { h, selectField, type SelectOption } from '@brainana/ui/dom.ts'
import { createSlider, type Slider } from '@brainana/ui/components/slider.ts'

export interface FunctionChoice {
  kind: FunctionalKind
  mode: FunctionalMode
}

export interface FunctionPanelCallbacks {
  onSelect: (c: FunctionChoice | null) => void
  onThreshold: (v: number) => void
  onOpacity: (v: number) => void
  onBrightness: (v: number) => void
}

export interface FunctionPanel {
  element: HTMLElement
  setActive: (key: string | null) => void
  setThresholdBounds: (min: number, max: number, value: number) => void
  // Resolve the equivalent choice for THIS subject by key, so a monkey switch can restore the same
  // map (the choice objects differ per subject — they carry the subject's own frame indices).
  getChoice: (key: string) => FunctionChoice | null
}

// Restored control values carried across a monkey switch (sliders are display-only until dragged, so
// seeding them keeps the UI in sync with the restored overlay). Threshold is set separately via
// setThresholdBounds because it depends on the freshly-loaded map's F-range.
export interface FunctionPanelInitial {
  opacity?: number
  brightness?: number
}

export const choiceKey = (c: FunctionChoice): string => `${c.kind}:${c.mode.label}`

export function createFunctionPanel(manifest: Manifest, cb: FunctionPanelCallbacks, initial: FunctionPanelInitial = {}): FunctionPanel {
  const choices = new Map<string, FunctionChoice>()
  const options: SelectOption[] = [{ value: 'none', label: 'none' }]

  const kinds: FunctionalKind[] = []
  if (manifest.function?.retinotopy) kinds.push('retinotopy')
  if (manifest.function?.somatotopy) kinds.push('somatotopy')
  for (const kind of kinds) {
    const map = kind === 'retinotopy' ? manifest.function.retinotopy : manifest.function.somatotopy
    if (!map) continue
    for (const mode of functionalModes(kind, map.frames)) {
      const choice: FunctionChoice = { kind, mode }
      const key = choiceKey(choice)
      choices.set(key, choice)
      options.push({ value: key, label: mode.label })
    }
  }

  const picker = selectField('map', options, (value) => cb.onSelect(value === 'none' ? null : (choices.get(value) ?? null)))

  const thresh: Slider = createSlider({
    label: 'F-stat',
    min: 0,
    max: 1,
    step: 0.1,
    value: 0,
    disabled: true,
    onInput: (v) => cb.onThreshold(v),
  })
  const opacity = createSlider({ label: 'opacity', min: 0, max: 1, step: 0.05, value: initial.opacity ?? 1, onInput: (v) => cb.onOpacity(v) })
  // Function on the 3D surface is always shown for the active map; only the LUT brightness is
  // adjustable (blends toward white).
  const brightness = createSlider({ label: 'surface brightness', min: 0.5, max: 2, step: 0.05, value: initial.brightness ?? 1, onInput: (v) => cb.onBrightness(v) })

  const element = h('div', { class: 'side-panel', hidden: true }, [
    h('div', { class: 'side-panel-head' }, ['func map']),
    picker.element,
    thresh.element,
    opacity.element,
    brightness.element,
  ])

  return {
    element,
    setActive: (key) => picker.setValue(key ?? 'none'),
    getChoice: (key) => choices.get(key) ?? null,
    setThresholdBounds: (min, max, value) => {
      if (!(max > min)) {
        thresh.setDisabled(true)
        return
      }
      thresh.setBounds(min, max, (max - min) / 100 || 0.1)
      thresh.setValue(value)
      thresh.setDisabled(false)
    },
  }
}
