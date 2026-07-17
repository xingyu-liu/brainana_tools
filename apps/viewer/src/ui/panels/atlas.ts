// Docked "atlas" picker (top of the side panel): pick any discovered atlas from a dropdown,
// adjust overlay opacity, or clear. Atlases are treated uniformly (identified by name).
import type { Manifest } from '../../types.ts'
import { h, selectField, type SelectOption } from '@brainana/ui/dom.ts'
import { createSlider } from '@brainana/ui/components/slider.ts'

export interface AtlasSelection {
  name: string // atlas name, e.g. 'ARM1', 'D99', 'CortHierarchy'
}

export interface AtlasPanelCallbacks {
  onSelect: (sel: AtlasSelection | null) => void
  onOpacity: (opacity: number) => void
}

export interface AtlasPanel {
  element: HTMLElement
  setActive: (sel: AtlasSelection | null) => void
}

// Restored opacity carried across a monkey switch (the slider is display-only until dragged).
export interface AtlasPanelInitial {
  opacity?: number
}

// The dropdown value IS the atlas name; the sentinel 'none' (no leading atlas- prefix) clears it.
const NONE = 'none'
const key = (sel: AtlasSelection | null): string => (sel ? sel.name : NONE)

// Parse an option value back into a selection ('none' → null, otherwise an atlas name).
function parseKey(value: string): AtlasSelection | null {
  return value === NONE ? null : { name: value }
}

export function createAtlasPanel(manifest: Manifest, cb: AtlasPanelCallbacks, initial: AtlasPanelInitial = {}): AtlasPanel {
  const options: SelectOption[] = [{ value: NONE, label: 'none' }]
  for (const atlas of manifest.atlases ?? []) options.push({ value: atlas.name, label: atlas.label })

  const picker = selectField('atlas', options, (value) => cb.onSelect(parseKey(value)))
  const opacity = createSlider({ label: 'overlay opacity', min: 0, max: 1, step: 0.05, value: initial.opacity ?? 0.7, onInput: (v) => cb.onOpacity(v) })

  const element = h('div', { class: 'side-panel', hidden: true }, [
    h('div', { class: 'side-panel-head' }, ['atlas']),
    picker.element,
    opacity.element,
  ])

  return {
    element,
    setActive: (sel) => picker.setValue(key(sel)),
  }
}
