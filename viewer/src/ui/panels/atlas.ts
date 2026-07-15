// Floating "Atlases" panel: pick an ARM level (1-6) or D99, adjust overlay opacity, or clear.
import type { Manifest } from '../../types.ts'
import { h } from '../dom.ts'

export interface AtlasSelection {
  atlas: 'ARM' | 'D99'
  level: number // ARM level 1..6; 0 for D99
}

export interface AtlasPanelCallbacks {
  onSelect: (sel: AtlasSelection | null) => void
  onOpacity: (opacity: number) => void
}

export interface AtlasPanel {
  element: HTMLElement
  toggle: () => void
  hide: () => void
  setActive: (sel: AtlasSelection | null) => void
}

export function createAtlasPanel(manifest: Manifest, cb: AtlasPanelCallbacks): AtlasPanel {
  const buttons = new Map<string, HTMLButtonElement>()
  const key = (sel: AtlasSelection | null) => (sel ? `${sel.atlas}${sel.level}` : 'none')

  const row = h('div', { class: 'chip-row' })
  const noneBtn = h('button', { type: 'button', class: 'chip' }, ['None']) as HTMLButtonElement
  noneBtn.addEventListener('click', () => cb.onSelect(null))
  buttons.set('none', noneBtn)
  row.append(noneBtn)

  for (let i = 1; i <= 6; i++) {
    if (!manifest.atlases?.charm?.[String(i)]) continue
    const b = h('button', { type: 'button', class: 'chip' }, [`ARM ${i}`]) as HTMLButtonElement
    b.addEventListener('click', () => cb.onSelect({ atlas: 'ARM', level: i }))
    buttons.set(`ARM${i}`, b)
    row.append(b)
  }
  if (manifest.atlases?.d99) {
    const b = h('button', { type: 'button', class: 'chip' }, ['D99']) as HTMLButtonElement
    b.addEventListener('click', () => cb.onSelect({ atlas: 'D99', level: 0 }))
    buttons.set('D990', b)
    row.append(b)
  }

  const opacity = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '0.7' }) as HTMLInputElement
  opacity.addEventListener('input', () => cb.onOpacity(Number(opacity.value)))

  const closeBtn = h('button', { type: 'button', class: 'float-panel-close', title: 'Close' }, ['×']) as HTMLButtonElement
  const element = h('div', { class: 'float-panel', hidden: true }, [
    h('div', { class: 'float-panel-head' }, ['Atlases', closeBtn]),
    row,
    h('label', { class: 'field' }, [h('span', {}, ['Overlay opacity']), opacity]),
  ])
  closeBtn.addEventListener('click', () => {
    element.hidden = true
  })

  return {
    element,
    toggle: () => {
      element.hidden = !element.hidden
    },
    hide: () => {
      element.hidden = true
    },
    setActive: (sel) => {
      const activeKey = key(sel)
      for (const [k, b] of buttons) b.classList.toggle('active', k === activeKey)
    },
  }
}
