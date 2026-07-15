// Right-hand atlas ROI legend. Virtualized (windowed) so ARM level 6 (~697 rows) stays
// responsive: only the visible rows are in the DOM, toggling flips the model + re-renders
// the ~30 visible rows (not the whole list). Click toggles; Shift-click isolates.
import { displayLabel, labelColor, type AtlasLabel } from '../data/atlas.ts'
import { h } from './dom.ts'

const ROW_H = 22
const OVERSCAN = 6

interface Row {
  id: number
  label: string
  color: [number, number, number]
}

export interface RoiLegendCallbacks {
  onHiddenChange: (hidden: Set<number>) => void
}

export class RoiLegend {
  #cb: RoiLegendCallbacks
  #title = h('div', { class: 'legend-title' }, ['No visible atlas'])
  #subtitle = h('div', { class: 'legend-subtitle muted' }, ['Click to toggle · Shift-click to isolate'])
  #count = h('span', { class: 'legend-count muted' }, [''])
  #search = h('input', { type: 'text', placeholder: 'Search ROIs…', class: 'legend-search' }) as HTMLInputElement
  #scroll = h('div', { class: 'legend-scroll' })
  #spacer = h('div', { class: 'legend-spacer' })
  #rowsEl = h('div', { class: 'legend-rows' })
  #all: Row[] = []
  #filtered: Row[] = []
  #hidden = new Set<number>()
  #searchTimer = 0

  constructor(root: HTMLElement, cb: RoiLegendCallbacks) {
    this.#cb = cb
    const showAll = h('button', { type: 'button', class: 'ghost sm' }, ['Show all'])
    const hideAll = h('button', { type: 'button', class: 'ghost sm' }, ['Hide all'])
    const invert = h('button', { type: 'button', class: 'ghost sm' }, ['Invert'])
    showAll.addEventListener('click', () => this.#bulk('show'))
    hideAll.addEventListener('click', () => this.#bulk('hide'))
    invert.addEventListener('click', () => this.#bulk('invert'))
    this.#search.addEventListener('input', () => {
      clearTimeout(this.#searchTimer)
      this.#searchTimer = window.setTimeout(() => this.#applyFilter(), 120)
    })
    this.#scroll.addEventListener('scroll', () => this.#renderWindow())
    this.#scroll.append(this.#spacer, this.#rowsEl)
    this.#rowsEl.addEventListener('click', (e) => this.#onRowClick(e))

    root.innerHTML = ''
    root.append(
      this.#title,
      this.#subtitle,
      h('div', { class: 'legend-actions' }, [showAll, hideAll, invert, this.#count]),
      this.#search,
      this.#scroll,
    )
  }

  setAtlas(title: string, entries: AtlasLabel[], seed: number): void {
    this.#title.textContent = title
    this.#hidden.clear()
    this.#all = entries
      .filter((e) => e.id !== 0)
      .map((e) => ({ id: e.id, label: displayLabel(e), color: labelColor(e, seed) }))
    this.#search.value = ''
    this.#applyFilter()
    this.#cb.onHiddenChange(this.#hidden)
  }

  clear(): void {
    this.#all = []
    this.#filtered = []
    this.#title.textContent = 'No visible atlas'
    this.#rowsEl.innerHTML = ''
    this.#spacer.style.height = '0px'
    this.#count.textContent = ''
  }

  #applyFilter(): void {
    const q = this.#search.value.trim().toLowerCase()
    this.#filtered = q ? this.#all.filter((r) => r.label.toLowerCase().includes(q) || String(r.id).includes(q)) : this.#all
    this.#spacer.style.height = `${this.#filtered.length * ROW_H}px`
    this.#scroll.scrollTop = 0
    this.#renderWindow()
    this.#updateCount()
  }

  #updateCount(): void {
    const visible = this.#all.length - this.#hidden.size
    this.#count.textContent = `${visible} of ${this.#all.length} visible`
  }

  #renderWindow(): void {
    const scrollTop = this.#scroll.scrollTop
    const viewport = this.#scroll.clientHeight || 300
    const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
    const last = Math.min(this.#filtered.length, Math.ceil((scrollTop + viewport) / ROW_H) + OVERSCAN)
    this.#rowsEl.style.transform = `translateY(${first * ROW_H}px)`
    this.#rowsEl.innerHTML = ''
    for (let i = first; i < last; i++) {
      const row = this.#filtered[i]
      const hidden = this.#hidden.has(row.id)
      const el = h('button', { type: 'button', class: `legend-row${hidden ? ' hidden-roi' : ''}` }, [
        h('span', { class: 'legend-checkbox' }, [hidden ? '' : '✓']),
        h('span', { class: 'legend-swatch' }),
        h('span', { class: 'legend-id' }, [String(row.id)]),
        h('span', { class: 'legend-label' }, [row.label]),
      ])
      ;(el.querySelector('.legend-swatch') as HTMLElement).style.background = `rgb(${row.color[0]},${row.color[1]},${row.color[2]})`
      el.dataset.roiId = String(row.id)
      this.#rowsEl.append(el)
    }
  }

  #onRowClick(e: MouseEvent): void {
    const rowEl = (e.target as HTMLElement).closest('.legend-row') as HTMLElement | null
    if (!rowEl) return
    const id = Number(rowEl.dataset.roiId)
    if (e.shiftKey) {
      // isolate: hide everything except this one
      this.#hidden = new Set(this.#all.map((r) => r.id).filter((r) => r !== id))
    } else if (this.#hidden.has(id)) {
      this.#hidden.delete(id)
    } else {
      this.#hidden.add(id)
    }
    this.#renderWindow()
    this.#updateCount()
    this.#cb.onHiddenChange(this.#hidden)
  }

  #bulk(mode: 'show' | 'hide' | 'invert'): void {
    if (mode === 'show') this.#hidden.clear()
    else if (mode === 'hide') this.#hidden = new Set(this.#all.map((r) => r.id))
    else {
      const next = new Set<number>()
      for (const r of this.#all) if (!this.#hidden.has(r.id)) next.add(r.id)
      this.#hidden = next
    }
    this.#renderWindow()
    this.#updateCount()
    this.#cb.onHiddenChange(this.#hidden)
  }
}
