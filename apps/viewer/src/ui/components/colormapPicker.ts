// Reusable colormap picker: a trigger button showing the active map's gradient + label, and a
// grouped popover of gradient swatches. Framework-free (built with the h() helper); the host
// supplies the CSS gradient per colormap key (see data/colormap.ts + niivue buildColormapAssets).
import { h } from '@brainana/ui/dom.ts'
import { COLORMAP_REGISTRY, type ColormapInfo } from '../../data/colormap.ts'

export interface ColormapPickerOptions {
  gradients: Record<string, string>
  value?: string
  onChange: (key: string) => void
  /** Restrict/reorder the offered maps; defaults to the full registry. */
  infos?: ColormapInfo[]
}

export interface ColormapPicker {
  element: HTMLElement
  value: () => string
  setValue: (key: string) => void
  setGradients: (g: Record<string, string>) => void
  /** Replace the offered maps (e.g. drop the categorical "labels" entry for a continuous atlas). */
  setInfos: (infos: ColormapInfo[]) => void
}

const FALLBACK = 'linear-gradient(90deg, rgb(20,18,13), rgb(236,230,216))'

export function createColormapPicker(opts: ColormapPickerOptions): ColormapPicker {
  let infos = opts.infos ?? COLORMAP_REGISTRY
  let gradients = opts.gradients
  let current = opts.value ?? infos[0]?.key ?? 'gray'
  let open = false

  const swatch = h('span', { class: 'cmap-swatch' })
  const label = h('span', { class: 'cmap-label' }, [labelFor(current)])
  const trigger = h('button', { type: 'button', class: 'cmap-trigger' }, [swatch, label, h('span', { class: 'cmap-caret' }, ['▾'])]) as HTMLButtonElement
  const pop = h('div', { class: 'cmap-pop', hidden: true })
  const element = h('div', { class: 'cmap-picker' }, [trigger, pop])

  function labelFor(key: string): string {
    return infos.find((i) => i.key === key)?.label ?? key
  }
  function grad(key: string): string {
    return gradients[key] ?? FALLBACK
  }

  function paintTrigger(): void {
    swatch.style.background = grad(current)
    label.textContent = labelFor(current)
  }

  function buildOptions(): void {
    pop.innerHTML = ''
    let lastGroup = ''
    for (const info of infos) {
      if (info.group !== lastGroup) {
        pop.append(h('div', { class: 'cmap-group' }, [info.group]))
        lastGroup = info.group
      }
      const optSwatch = h('span', { class: 'cmap-swatch' })
      optSwatch.style.background = grad(info.key)
      const btn = h('button', { type: 'button', class: `cmap-option${info.key === current ? ' active' : ''}` }, [
        optSwatch,
        h('span', { class: 'cmap-label' }, [info.label]),
        ...(info.cyclic ? [h('span', { class: 'cmap-tag' }, ['cyclic'])] : []),
      ]) as HTMLButtonElement
      btn.addEventListener('click', () => {
        select(info.key)
        close()
      })
      pop.append(btn)
    }
  }

  function select(key: string): void {
    if (key === current) return
    current = key
    paintTrigger()
    for (const b of pop.querySelectorAll('.cmap-option')) b.classList.remove('active')
    opts.onChange(key)
  }

  const onDocPointer = (e: Event): void => {
    if (!element.contains(e.target as Node)) close()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close()
  }

  function openPop(): void {
    if (open) return
    open = true
    buildOptions()
    pop.hidden = false
    trigger.classList.add('open')
    document.addEventListener('pointerdown', onDocPointer, true)
    document.addEventListener('keydown', onKey)
  }
  function close(): void {
    if (!open) return
    open = false
    pop.hidden = true
    trigger.classList.remove('open')
    document.removeEventListener('pointerdown', onDocPointer, true)
    document.removeEventListener('keydown', onKey)
  }

  trigger.addEventListener('click', () => (open ? close() : openPop()))
  paintTrigger()

  return {
    element,
    value: () => current,
    setValue: (key) => {
      current = key
      paintTrigger()
    },
    setGradients: (g) => {
      gradients = g
      paintTrigger()
      if (open) buildOptions()
    },
    setInfos: (next) => {
      infos = next.length ? next : COLORMAP_REGISTRY
      paintTrigger() // label lookup uses infos
      if (open) buildOptions()
    },
  }
}
