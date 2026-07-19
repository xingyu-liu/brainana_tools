// Dashboard shell (P1): the v1.2.25 single-screen layout — top bar, slice pane + surface
// pane, right atlas-legend column, bottom info grid. P1 wires the top bar (Monkey across all
// sources, vol/surf selectors, montage layout), the 2-instance MultiView, and base
// volume + surface loading. The right column, info grid, and panel buttons are placeholders
// filled by later phases.
import type { RuntimeClient } from '@brainana/core-client/runtimeClient.ts'
import type { SourceManager } from '@brainana/core-client/sourceManager.ts'
import type { FilesystemClient, MonkeySummary } from '@brainana/core-client/filesystemClient.ts'
import type { Manifest, SurfacePair } from '../types.ts'
import { MultiView, MORPH_DEFAULT_COLORMAP, type SurfaceNode, type SurfacePairUrls, type MorphologyDisplay, type MorphologyDisplayMetric, type MorphologyMetric, type MorphologyShapePairs, type CurvatureStyle } from '../niivue/multiView.ts'
import { Marker } from '@brainana/niivue-kit/marker.ts'
import { OrientationGizmo } from '@brainana/niivue-kit/orientation.ts'
import { createViewerStore, type Layout } from '../state/store.ts'
import { parseAtlasTsv, buildLabelColortable, type AtlasLabel } from '../data/atlas.ts'
import { ARM_SEED } from '../data/colors.ts'
import { finiteExtrema, createFunctionalSurfaceLut, quantizeFunctionalSurfaceValues, maskSurfaceBinsByF, maskSurfaceBinsByValue, type SurfaceFunctionMode } from '../data/functional.ts'
import { visualXY, visualFieldStats, ECC_MAX, type VfPoint } from '../data/visualField.ts'
import { parseGiftiFloat32 } from '../data/gifti.ts'
import { RoiLegend } from './roiLegend.ts'
import { createAtlasPanel, type AtlasPanel, type AtlasSelection } from './panels/atlas.ts'
import { createFunctionPanel, choiceKey, type FunctionPanel, type FunctionChoice } from './panels/function.ts'
import { createMorphologyPanel, type MorphologyPanel, type MarkerMode } from './panels/morphology.ts'
import { drawVisualField } from './visualFieldPlot.ts'
import { h, errorText, selectField } from '@brainana/ui/dom.ts'
import { createSlider } from '@brainana/ui/components/slider.ts'
import { mountSourcesDialog } from './dialogs/sources.ts'
import { buildColormapAssets, availableColormaps } from '../niivue/colormaps.ts'
import { buildColormapRegistry, type ColormapInfo } from '../data/colormap.ts'
import { surfaceLutFromColormap } from '../data/functional.ts'
import { createColorDisplay, type ColorDisplay } from './components/colorDisplay.ts'

const FALLBACK_GRADIENT = 'linear-gradient(90deg, rgb(20,18,13), rgb(236,230,216))'

interface Deps {
  client: RuntimeClient
  sources: SourceManager
  files: FilesystemClient
}

// 'veryinflated' is deliberately omitted: it has no real FreeSurfer source file (the server
// synthesizes it by puffing 'inflated'), so it isn't offered as a surface.
const SURFACE_ORDER = ['pial', 'white', 'smoothwm', 'inflated', 'sphere'] as const
const SURFACE_LABELS: Record<string, string> = {
  pial: 'pial',
  white: 'white',
  smoothwm: 'smoothwm',
  inflated: 'inflated',
  sphere: 'sphere',
}

const BRAINANA_ASCII_LOGO = `
                                                +++++++
                                       +++++++++++++++++++++++++
                                  +++++++++++++++++++++++++++++++++++
                              +++++++++++++++++++++++++++++++++++++++++++
                            +++++++++++++++++++++++++++++++++++++++++++++++
                         +++++++++++++++++++++++++++++++++++++++++++++++++++++
                       +++++++++++++++++++++++++       +++++++++++++++++++++++++
                     ++++++++++++++++++++                     ++++++++++++++++++++                    +++++++++++++++++++++++              +++++++++++++++++++++++                   +++++++++++++++++++                   ++++++++               +++                         ++++               ++++++++++++++++++              +++                         ++++               ++++++++++++++++++
                    +++++++++++++++++                             +++++++++++++++++                   +++++++++++++++++++++++++            +++++++++++++++++++++++++                +++++++++++++++++++++                  ++++++++               ++++                        ++++             +++++++++++++++++++++             +++++                       ++++             ++++++++++++++++++++++
                  ++++++++++++++++                                   ++++++++++++++++                 ++++++++++++++++++++++++++           ++++++++++++++++++++++++++              +++++++++++++++++++++++                 ++++++++               ++++++                      ++++            ++++++++++++++++++++++++           ++++++                      ++++            ++++++++++++++++++++++++
                 ++++++++++++++                                         ++++++++++++++                +++++++++       +++++++++++          +++++++++        ++++++++++            ++++++++++     ++++++++++                ++++++++               +++++++                     ++++           ++++++++++     ++++++++++           ++++++++                    ++++           ++++++++++      ++++++++++
                +++++++++++++              +++++++++++++++++             ++++++++++++++               +++++++++         +++++++++          +++++++++         ++++++++++          ++++++++++       ++++++++++               ++++++++               +++++++++                   ++++          ++++++++++        +++++++++          +++++++++                   ++++           +++++++++        +++++++++
               +++++++++++++            +++++++++++++++++++++++            +++++++++++++              +++++++++          ++++++++          +++++++++          +++++++++          +++++++++         +++++++++               ++++++++               ++++++++++                  ++++          +++++++++         +++++++++          ++++++++++                  ++++          +++++++++          +++++++++
              +++++++++++++           +++++++++++++++++++++++++++           +++++++++++++             +++++++++          +++++++++         +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++++++++++                ++++          +++++++++          +++++++++         ++++++++++++                ++++          +++++++++          +++++++++
             ++++++++++++           +++++++++++++++++++++++++++++++           ++++++++++++            +++++++++          +++++++++         +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               +++++++++++++               ++++          +++++++++          +++++++++         +++++++++++++               ++++          +++++++++          +++++++++
             +++++++++++           +++++++++++++++++++++++++++++++++           ++++++++++++           +++++++++          +++++++++         +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++++++++++++              ++++          +++++++++          +++++++++         +++++++++++++++             ++++          +++++++++          +++++++++
            +++++++++++           +++++++++  +++++++++++++  +++++++++          ++++++++++++           +++++++++          ++++++++          +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++++++++++++++            ++++          +++++++++          +++++++++         ++++++++++++++++            ++++          +++++++++          +++++++++
           ++++++++++++          +++++++         +++++         +++++++          ++++++++++++          +++++++++          ++++++++          +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               +++++++++++++++++           ++++          +++++++++          +++++++++         ++++++++++++++++++          ++++          +++++++++          +++++++++
           +++++++++++           ++++++            +            ++++++           +++++++++++          +++++++++          ++++++++          +++++++++          ++++++++           +++++++++          ++++++++               ++++++++               +++++++++++++++++++         ++++          +++++++++          +++++++++         +++++++++++++++++++         ++++          +++++++++          +++++++++
           +++++++++++     +++++++++++                           +++++++++++     ++++    +++          +++++++++         ++++++++           +++++++++         ++++++++            +++++++++          ++++++++               ++++++++               ++++++++++++++++++++        ++++          +++++++++          +++++++++         +++++++++++++++++++++       ++++          +++++++++          +++++++++
           ++++++++++     ++ +++++++++                           +++++++++ ++    ++++++++++++         +++++++++        ++++++++            +++++++++        +++++++++            +++++++++          ++++++++               ++++++++               ++++++++++++++++++++++      ++++          +++++++++          +++++++++         ++++++++++++++++++++++      ++++          +++++++++          +++++++++
          +++++++++++     ++    ++++++     +++        +++        ++++++    ++     +++    ++++         +++++++++++++++++++++++              ++++++++++++++++++++++++              +++++++++++++++++++++++++++               ++++++++               ++++  +++++++++++++++++     ++++          ++++++++++++++++++++++++++++         ++++  +++++++++++++++++     ++++          ++++++++++++++++++++++++++++
          +++++++++++      +++++++++++     +++  +     ++++ +     +++++++++++      +++++++++++         ++++++++++++++++++++                 +++++++++++++++++++++                 +++++++++++++++++++++++++++               ++++++++               ++++   ++++++++++++++++++   ++++          ++++++++++++++++++++++++++++         ++++   ++++++++++++++++++   ++++          ++++++++++++++++++++++++++++
          +++++++++++            ++++++     +++         +++     ++++++            +++    ++++         +++++++++++++++++++++++              ++++++++++++++++++++++++++            +++++++++++++++++++++++++++               ++++++++               ++++     +++++++++++++++++  ++++          ++++++++++++++++++++++++++++         ++++     +++++++++++++++++  ++++          ++++++++++++++++++++++++++++
          +++++++++++            +++++                           +++++           ++++++++++++         +++++++++       +++++++++            +++++++++       ++++++++++++          +++++++++         +++++++++               ++++++++               ++++      ++++++++++++++++++++++          +++++++++          +++++++++         ++++      ++++++++++++++++++++++          +++++++++          +++++++++
           +++++++++++          +++                                 +++          +++++++++++          +++++++++         ++++++++           +++++++++         ++++++++++          +++++++++          ++++++++               ++++++++               ++++       +++++++++++++++++++++          +++++++++          +++++++++         ++++        ++++++++++++++++++++          +++++++++          +++++++++
           +++++++++++         +++                 +                 +++         +++++++++++          +++++++++          ++++++++          +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++         +++++++++++++++++++          +++++++++          +++++++++         ++++         +++++++++++++++++++          +++++++++          +++++++++
           ++++++++++++        +++                 +  +              +++        ++++++++++++          +++++++++          ++++++++          +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++          ++++++++++++++++++          +++++++++          +++++++++         ++++          ++++++++++++++++++          +++++++++          +++++++++
            +++++++++++         ++              +++++++              +++        +++++++++++           +++++++++          ++++++++          +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++            ++++++++++++++++          +++++++++          +++++++++         ++++            ++++++++++++++++          +++++++++          +++++++++
            ++++++++++++        +++                                 +++        ++++++++++++           +++++++++          +++++++++         +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++             +++++++++++++++          +++++++++          +++++++++         ++++             +++++++++++++++          +++++++++          +++++++++
             ++++++++++++        ++++                             ++++        ++++++++++++            +++++++++          +++++++++         +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++               +++++++++++++          +++++++++          +++++++++         ++++               +++++++++++++          +++++++++          +++++++++
              ++++++++++++         ++++                         ++++         ++++++++++++             +++++++++          +++++++++         +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++                ++++++++++++          +++++++++          +++++++++         ++++                ++++++++++++          +++++++++          +++++++++
               ++++++++++++          ++++++                 ++++++          +++++++++++++             +++++++++          +++++++++         +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++                 +++++++++++          +++++++++          +++++++++         ++++                  ++++++++++          +++++++++          +++++++++
               ++++++++++++++            ++++++++++++++++++++++           +++++++++++++               +++++++++         +++++++++          +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++                   +++++++++          +++++++++          +++++++++         ++++                   +++++++++          +++++++++          +++++++++
                 ++++++++++++++              +++++++++++++              ++++++++++++++                +++++++++        ++++++++++          +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++                    ++++++++          +++++++++          +++++++++         ++++                    ++++++++          +++++++++          +++++++++
                  +++++++++++++++                                     +++++++++++++++                 ++++++++++++++++++++++++++           +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++                      ++++++          +++++++++          +++++++++         ++++                      ++++++          +++++++++          +++++++++
                   ++++++++++++++                                     ++++++++++++++                  +++++++++++++++++++++++++            +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++                       +++++          +++++++++          +++++++++         ++++                       +++++          +++++++++          +++++++++
                     +++++++++++     ++                         ++     +++++++++++                    ++++++++++++++++++++++++             +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++                         +++          +++++++++          +++++++++         ++++                         +++          +++++++++          +++++++++
                       ++++++++     ++++++++               ++++++++     ++++++++                      +++++++++++++++++++++                +++++++++          +++++++++          ++++++++           ++++++++               ++++++++               ++++                          ++          +++++++++          +++++++++         ++++                          ++          +++++++++          +++++++++
                        ++++++     +++++++++++++++++++++++++++++++++     ++++++
                           ++     +++++++++++++++++++++++++++++++++++     ++
                                 +++++++++++++++++++++++++++++++++++++
`.slice(1).trimEnd()

// Build a <dl> of <dt>/<dd> label:value rows for the info panel.
function dlRows(pairs: Array<[string, string | Node]>): HTMLDListElement {
  const dl = h('dl')
  for (const [label, value] of pairs) dl.append(h('dt', {}, [label]), h('dd', {}, [value]))
  return dl
}
function layoutIcon(k: Layout): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 18')
  svg.setAttribute('aria-hidden', 'true')
  const r = (x: number, y: number, w: number, h: number): SVGRectElement => {
    const rect = document.createElementNS(ns, 'rect')
    rect.setAttribute('x', String(x))
    rect.setAttribute('y', String(y))
    rect.setAttribute('width', String(w))
    rect.setAttribute('height', String(h))
    rect.setAttribute('rx', '0.5')
    return rect
  }
  if (k === 'grid') {
    svg.append(r(1, 1, 10, 7), r(13, 1, 10, 7), r(1, 10, 10, 7), r(13, 10, 10, 7))
  } else if (k === 'row') {
    svg.append(r(1, 1, 22, 8), r(1, 11, 6, 6), r(9, 11, 6, 6), r(17, 11, 6, 6))
  } else {
    svg.append(r(1, 1, 8, 4.5), r(1, 6.75, 8, 4.5), r(1, 12.5, 8, 4.5), r(11, 1, 12, 16))
  }
  return svg
}
const LAYOUTS: Array<{ k: Layout; icon: SVGSVGElement; title: string }> = [
  { k: 'grid', icon: layoutIcon('grid'), title: '2×2 grid (3 planes + surface)' },
  { k: 'row', icon: layoutIcon('row'), title: 'Surface on top, planes in a row' },
  { k: 'column', icon: layoutIcon('column'), title: 'Surface on top, planes in a column' },
]
// Only the wired category tabs are shown. Imported/Import/Export are deferred Phase-3 work and
// were previously rendered permanently-disabled (reading as broken) — hidden until implemented.
const PANEL_BUTTONS = ['atlas', 'morphology', 'func map']
// Camera view presets shown in the surf row (Req 4). Lateral/Medial are hemisphere-aware.
const VIEW_PRESETS: Array<{ k: 'lateral' | 'medial' | 'ventral' | 'dorsal' | 'anterior' | 'posterior'; label: string }> = [
  { k: 'lateral', label: 'lat' },
  { k: 'medial', label: 'med' },
  { k: 'ventral', label: 'vent' },
  { k: 'dorsal', label: 'dor' },
  { k: 'anterior', label: 'ant' },
  { k: 'posterior', label: 'pos' },
]

// Prefer a FreeSurfer volume (norm.mgz) as the default base — same space as the surfaces.
function defaultVolumeIndex(volumes: Manifest['volumes']): number {
  const norm = volumes.findIndex((v) => v.key === 'mri/norm.mgz' || v.label.toLowerCase() === 'norm')
  if (norm >= 0) return norm
  const mri = volumes.findIndex((v) => v.key.startsWith('mri/'))
  return mri >= 0 ? mri : 0
}

// Prefer the derived .shape.gii pairs for surface shading; both hemispheres must be present.
function shapePair(pair: SurfacePair | undefined): SurfacePairUrls | undefined {
  return pair?.left && pair?.right ? { left: pair.left, right: pair.right } : undefined
}

function morphologyShapePairs(manifest: Manifest): MorphologyShapePairs {
  const shape = manifest.morphology?.shape
  return { curvature: shapePair(shape?.curvature), sulc: shapePair(shape?.sulc), thickness: shapePair(shape?.thickness) }
}

// Full value domain + default colour range per metric (v1.2.25). Binary curvature is forced ±1.
const MORPH_DOMAIN: Record<MorphologyMetric, { min: number; max: number }> = {
  curvature: { min: -1, max: 1 },
  sulc: { min: -6, max: 6 },
  thickness: { min: 0, max: 4 },
}
const MORPH_DEFAULT_RANGE: Record<MorphologyMetric, { min: number; max: number }> = {
  curvature: { min: -0.2, max: 0.2 },
  sulc: { min: -3, max: 3 },
  thickness: { min: 1, max: 3 },
}

export function mountDashboard(root: HTMLElement, deps: Deps): void {
  const { client, files, sources } = deps
  const { store } = createViewerStore()
  root.innerHTML = ''

  // --- top bar: two rows (vol row + surf row), surf field aligned under the vol field ---
  const monkeySelect = h('select', { id: 'monkey-select' }, [h('option', { value: '' }, ['select monkey…'])])
  const datasetBtn = h('button', { type: 'button', class: 'primary' }, ['dataset'])
  const volCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  volCheck.checked = true
  const volSelect = h('select', { title: 'Base volume (FreeSurfer mri/)', class: 'narrow' })
  const surfCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  surfCheck.checked = true
  const surfSelect = h('select', { title: 'Cortical surface' })
  const lhCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  lhCheck.checked = true
  const rhCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  rhCheck.checked = true
  const neighborhoodSelect = h(
    'select',
    { class: 'sm' },
    ['0', '1', '2', '3'].map((n) => h('option', { value: n }, [n])),
  ) as HTMLSelectElement
  neighborhoodSelect.value = '1'

  const layoutBtns = LAYOUTS.map((l) => {
    const b = h('button', { type: 'button', class: 'layout-btn', title: l.title }, [l.icon])
    b.dataset.layout = l.k
    return b
  })
  const panelBtns = PANEL_BUTTONS.map((name) => h('button', { type: 'button', class: 'panel-btn' }, [name]))
  const viewBtns = VIEW_PRESETS.map((v) => {
    const b = h('button', { type: 'button', class: 'view-btn', title: `${v.label} view` }, [v.label])
    b.dataset.view = v.k
    return b
  })

  // --- Marker / Crosshair toolbar controls: show/hide toggles, size, and placement mode ---
  const markerCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  markerCheck.checked = true
  const crosshairCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  crosshairCheck.checked = true
  const orientCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  orientCheck.checked = true
  markerCheck.addEventListener('change', () => {
    marker?.setVisible(markerCheck.checked)
    if (markerCheck.checked) placeMarker()
  })
  crosshairCheck.addEventListener('change', () => view?.setCrosshairVisible(crosshairCheck.checked))
  orientCheck.addEventListener('change', () => view?.setSliceOrientationVisible(orientCheck.checked))
  const markerSize = createSlider({
    label: 'size',
    min: 0.3,
    max: 3,
    step: 0.1,
    value: 1,
    hideBox: true, // tight toolbar slot; the number box overflowed onto the mode select
    onInput: (v) => {
      marker?.setSize(v)
      placeMarker()
    },
  })
  const markerModeSel = selectField(
    'mode',
    [
      { value: 'crosshair3d', label: '3D crosshair' },
      { value: 'nearestNode', label: 'nearest vertex' },
    ],
    (value) => {
      markerMode = value as MarkerMode
      placeMarker()
    },
  )
  markerModeSel.setValue('nearestNode')
  // Apply the current toolbar states to the freshly-created view/marker (called on subject load).
  const syncMarkerControls = (): void => {
    marker?.setSize(markerSize.value())
    marker?.setVisible(markerCheck.checked)
    view?.setCrosshairVisible(crosshairCheck.checked)
    view?.setSliceOrientationVisible(orientCheck.checked)
    markerMode = markerModeSel.value() as MarkerMode
  }

  // Two-row × four-column grid (fills column-by-column via grid-auto-flow: column). Full-height
  // hairline dividers (`tb-divide`, each spanning both rows) separate the logical clusters.
  const tbDivide = (): HTMLElement => h('div', { class: 'tb-divide' })
  const toolbar = h('header', { class: 'toolbar' }, [
    // col 1: title (row 1) · version (row 2)
    h('div', { class: 'tb-cell brand' }, ['Brainana Viewer']),
    h('div', { class: 'tb-cell' }, [h('span', { class: 'badge' }, [`v${__APP_VERSION__}`])]),
    tbDivide(),
    // col 2: Dataset (row 1) · Monkey (row 2)
    h('div', { class: 'tb-cell' }, [datasetBtn]),
    h('div', { class: 'tb-cell' }, [monkeySelect]),
    tbDivide(),
    // col 3: vol (row 1) · surf (row 2). LH/RH moved to col 4 row 1 (freed by the underlay rail).
    h('div', { class: 'tb-cell' }, [h('label', { class: 'tb-field inline' }, [volCheck, h('span', {}, ['vol']), volSelect])]),
    h('div', { class: 'tb-cell' }, [
      h('label', { class: 'tb-field inline' }, [surfCheck, h('span', {}, ['surf']), surfSelect]),
    ]),
    tbDivide(),
    // col 3b: view section — slice montage layouts (row 1) · surface view presets (row 2)
    h('div', { class: 'tb-cell' }, [h('div', { class: 'montage' }, layoutBtns)]),
    h('div', { class: 'tb-cell' }, [h('div', { class: 'views' }, viewBtns)]),
    tbDivide(),
    // col 4: LH/RH hemisphere toggles in the vol row (row 1) — occupying the slot vacated by the
    // crosshair + AP/SI/LR toggles, which now live in the right-hand underlay rail; surface marker +
    // size + placement mode in the surf row (row 2).
    h('div', { class: 'tb-cell' }, [
      h('label', { class: 'tb-field inline' }, [lhCheck, h('span', {}, ['LH'])]),
      h('label', { class: 'tb-field inline' }, [rhCheck, h('span', {}, ['RH'])]),
    ]),
    h('div', { class: 'tb-cell marker-controls' }, [
      h('label', { class: 'tb-field inline' }, [markerCheck, h('span', {}, ['marker'])]),
      markerSize.element,
      markerModeSel.element,
    ]),
    tbDivide(),
    // col 5: category tabs (row 1); row 2 reserved for future Import/Export controls.
    h('div', { class: 'tb-cell panels' }, panelBtns),
    h('div', { class: 'tb-cell' }, []),
  ])

  // --- main grid ---
  const slicesCanvas = h('canvas', { id: 'slices', class: 'nv-canvas' }) as HTMLCanvasElement
  const surfaceCanvas = h('canvas', { id: 'surface', class: 'nv-canvas' }) as HTMLCanvasElement
  const slicePane = h('div', { class: 'slice-pane' }, [slicesCanvas])
  const surfacePane = h('div', { class: 'surface-pane' }, [surfaceCanvas])
  const viewerArea = h('div', { class: 'viewer-area' }, [slicePane, surfacePane])
  // Splitter for the surf-pane / side-panel boundary. It's a direct child of `main` (not the
  // aside) anchored to the column seam via CSS, so it's reliably on top and grabbable (Req 4).
  const panelResizer = h('div', { class: 'panel-resizer', title: 'Drag to resize the panel' })
  const infoResizer = h('div', { class: 'info-resizer', title: 'Drag to resize the info panel' })
  // Splitter on the underlay rail's right edge — drags --rail-w, sizing the rail column only. The
  // Coordinates info column shares the same 168px start but is independent (its own --info-c1 seam).
  const railResizer = h('div', { class: 'rail-resizer', title: 'Drag to resize the underlay rail' })
  // The side panel docks the active category's picker at the top (`sidePicker`) with
  // category-specific content below (`sideContent`): the atlas ROI legend, or a light caption for
  // function / morphology. Exactly one content slot is visible at a time (driven by `updateTabUI`).
  const sidePicker = h('div', { class: 'side-picker' })
  const legendSlot = h('div', { class: 'side-slot', hidden: true })
  // Function/morphology side-content slots carry no caption — the active selection is already shown
  // by the highlighted chip in the docked panel above, so a descriptive caption is redundant.
  const funcSlot = h('div', { class: 'side-slot', hidden: true })
  const morphSlot = h('div', { class: 'side-slot', hidden: true })
  const sidePlaceholder = h('div', { class: 'legend-title muted' }, ['Select atlas, morphology, or function above.'])
  const sideContent = h('div', { class: 'side-content' }, [legendSlot, funcSlot, morphSlot, sidePlaceholder])
  // Docked at the bottom of the side panel: the shared "Color display" section (colormap + legend +
  // display range + clip), mounted once the view/colormaps exist. Applies to the active overlay.
  const colorDock = h('div', { class: 'color-dock' })
  const atlasLegend = h('aside', { class: 'atlas-legend' }, [sidePicker, sideContent, colorDock])
  // Each column is a flex box: a fixed (non-scrolling) header + an `.info-scroll` region that owns
  // the overflow, so the title stays put while only its content scrolls.
  const infoPanel = h('section', { class: 'info-panel' }, [
    h('div', { class: 'info-col' }, [h('h3', {}, ['Coordinates']), h('div', { class: 'info-scroll' }, [h('div', { id: 'report-coordinates', class: 'muted' }, ['—'])])]),
    h('div', { class: 'info-col' }, [h('h3', {}, ['Atlas']), h('div', { class: 'info-scroll' }, [h('div', { id: 'report-anatomy', class: 'muted' }, ['—'])])]),
    h('div', { class: 'info-col' }, [h('h3', {}, ['Surface']), h('div', { class: 'info-scroll' }, [h('div', { id: 'report-surface', class: 'muted' }, ['—'])])]),
    h('div', { class: 'info-col' }, [h('h3', {}, ['Func Map']), h('div', { class: 'info-scroll' }, [h('div', { id: 'report-function', class: 'muted' }, ['—'])])]),
    h('div', { class: 'info-col' }, [
      h('div', { class: 'vf-header' }, [
        h('h3', {}, ['Visual field']),
        h('label', { class: 'neighborhood-control' }, [h('span', {}, ['neighborhood']), neighborhoodSelect]),
      ]),
      h('div', { class: 'info-scroll' }, [
        h('canvas', { id: 'visual-field-canvas', class: 'vf-canvas' }),
        h('div', { id: 'report-visual-note', class: 'muted' }, ['Add retinotopy in FUNC MAP first']),
      ]),
    ]),
  ])
  const placeholderText = h('p', { class: 'placeholder-text' }, ['Select a dataset, then choose a monkey to begin'])
  const asciiEl = h('pre', { class: 'monkey-ascii' }, [BRAINANA_ASCII_LOGO])
  const placeholderContent = h('div', { class: 'placeholder-content' }, [asciiEl, placeholderText])
  const placeholder = h('div', { class: 'monkey-placeholder' }, [placeholderContent])
  {
    const fitAsciiLogo = (): void => {
      asciiEl.style.fontSize = '1px'
      const width = placeholder.clientWidth
      if (width <= 0 || asciiEl.scrollWidth <= 0) return
      const ratio = width / asciiEl.scrollWidth
      asciiEl.style.fontSize = `${Math.min(ratio * 0.88, 4)}px`
    }
    const ro = new ResizeObserver(fitAsciiLogo)
    ro.observe(placeholder)
    requestAnimationFrame(fitAsciiLogo)
  }
  const loadingText = h('div', { class: 'loading-text' }, ['Loading…'])
  const loadingOverlay = h('div', { class: 'loading-overlay', hidden: true }, [h('div', { class: 'spinner' }), loadingText])
  const main = h('main', { class: 'dashboard' }, [viewerArea, atlasLegend, panelResizer, infoResizer, railResizer, infoPanel, placeholder, loadingOverlay])

  // --- right underlay rail: base-volume intensity window (brightness/contrast ↔ display min/max),
  // value clip, montage zoom, plus the crosshair + AP/SI/LR toggles moved out of the top bar. All
  // four intensity controls drive the same cal_min/cal_max window (NiiVue has no separate brightness);
  // brightness=center, contrast=width, display boxes=ends — edits on either side mirror to the other.
  let volGlobalMin = 0
  let volGlobalMax = 1
  let volRobustMin = 0
  let volRobustMax = 1
  let volCalLo = 0
  let volCalHi = 1
  let volClipLo: number | null = null
  let volClipHi: number | null = null
  let volSyncing = false // suppress the slider→box→slider feedback loop while mirroring

  const fmtVol = (v: number): string => v.toFixed(4)
  const numBox = (): HTMLInputElement => h('input', { type: 'number', class: 'range-num' }) as HTMLInputElement
  const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))
  const volSpan = (): number => volGlobalMax - volGlobalMin || 1

  const f2 = (v: number): string => v.toFixed(2)
  const briSlider = createSlider({ label: 'brightness', min: 0, max: 1, step: 0.01, value: 0.5, format: f2, onInput: () => onBriConInput() })
  const conSlider = createSlider({ label: 'contrast', min: 0, max: 1, step: 0.01, value: 0.5, format: f2, onInput: () => onBriConInput() })
  const zoomSlider = createSlider({ label: 'zoom', min: 0.5, max: 4, step: 0.1, value: 1, format: f2, onInput: (v) => view?.setVolumeZoom(v) })
  const dispMinBox = numBox()
  const dispMaxBox = numBox()
  const clipMinBox = numBox()
  const clipMaxBox = numBox()

  const applyVolumeWindow = (): void => view?.setVolumeWindow(volCalLo, volCalHi, volClipLo, volClipHi)
  const setDisplayBoxes = (): void => {
    dispMinBox.value = fmtVol(volCalLo)
    dispMaxBox.value = fmtVol(volCalHi)
  }
  // Window ends → brightness/contrast sliders. brighter = lower window center; more contrast = narrower.
  const windowToSliders = (): void => {
    const s = volSpan()
    const width = volCalHi - volCalLo
    const center = (volCalLo + volCalHi) / 2
    volSyncing = true
    conSlider.setValue(clamp01(1 - width / s))
    briSlider.setValue(clamp01(1 - (center - volGlobalMin) / s))
    volSyncing = false
  }
  // Brightness/contrast sliders → window ends, then reflect into the display boxes.
  const slidersToWindow = (): void => {
    const s = volSpan()
    let width = s * (1 - conSlider.value())
    const minWidth = s * 0.005 // guard: never a zero/negative window
    if (width < minWidth) width = minWidth
    const center = volGlobalMin + (1 - briSlider.value()) * s
    volCalLo = Math.max(volGlobalMin, center - width / 2)
    volCalHi = Math.min(volGlobalMax, center + width / 2)
    setDisplayBoxes()
    applyVolumeWindow()
  }
  const onBriConInput = (): void => {
    if (volSyncing) return
    slidersToWindow()
  }
  const onDisplayBoxEdit = (): void => {
    let lo = Number(dispMinBox.value)
    let hi = Number(dispMaxBox.value)
    if (!Number.isFinite(lo)) lo = volCalLo
    if (!Number.isFinite(hi)) hi = volCalHi
    if (lo > hi) [lo, hi] = [hi, lo] // swap an inverted entry so the window stays valid
    // Clamp to the volume's real extents so the derived brightness/contrast sliders (windowToSliders
    // maps the window into [0,1]) can represent the window — an out-of-range entry would otherwise
    // pin a slider to its rail and the next drag would snap the window back, discarding the typed value.
    volCalLo = Math.max(volGlobalMin, Math.min(volGlobalMax, lo))
    volCalHi = Math.max(volGlobalMin, Math.min(volGlobalMax, hi))
    setDisplayBoxes()
    windowToSliders()
    applyVolumeWindow()
  }
  const onClipBoxEdit = (): void => {
    const lo = clipMinBox.value.trim() === '' ? NaN : Number(clipMinBox.value)
    const hi = clipMaxBox.value.trim() === '' ? NaN : Number(clipMaxBox.value)
    let clipLo = Number.isFinite(lo) ? lo : null // empty / non-numeric = open on that side
    let clipHi = Number.isFinite(hi) ? hi : null
    // Swap an inverted [lo, hi] (matching onDisplayBoxEdit) so it never collapses to an empty window
    // that masks the whole underlay to black with no feedback. Only meaningful when both ends are set.
    if (clipLo !== null && clipHi !== null && clipLo > clipHi) {
      ;[clipLo, clipHi] = [clipHi, clipLo]
      clipMinBox.value = fmtVol(clipLo)
      clipMaxBox.value = fmtVol(clipHi)
    }
    volClipLo = clipLo
    volClipHi = clipHi
    applyVolumeWindow()
  }
  dispMinBox.addEventListener('change', onDisplayBoxEdit)
  dispMaxBox.addEventListener('change', onDisplayBoxEdit)
  clipMinBox.addEventListener('change', onClipBoxEdit)
  clipMaxBox.addEventListener('change', onClipBoxEdit)

  const setVolRailEnabled = (on: boolean): void => {
    briSlider.setDisabled(!on)
    conSlider.setDisabled(!on)
    zoomSlider.setDisabled(!on)
    for (const b of [dispMinBox, dispMaxBox, clipMinBox, clipMaxBox]) b.disabled = !on
  }
  // Seed (on load) or restore (Reset) the rail to the volume's defaults: display window = robust
  // range, clip cleared, zoom = 1. No-op with the controls disabled when no base volume is present.
  const syncVolumeControls = (): void => {
    const r = view?.baseVolumeRange()
    if (!r) {
      setVolRailEnabled(false)
      volRail.hidden = true // no base volume (e.g. welcome screen) — keep the rail out of the layout
      return
    }
    volRail.hidden = false
    setVolRailEnabled(true)
    volGlobalMin = r.globalMin
    volGlobalMax = r.globalMax
    volRobustMin = r.robustMin
    volRobustMax = r.robustMax
    volCalLo = volRobustMin
    volCalHi = volRobustMax
    volClipLo = null
    volClipHi = null
    clipMinBox.value = ''
    clipMaxBox.value = ''
    setDisplayBoxes()
    windowToSliders()
    zoomSlider.setValue(1)
    view?.resetVolumeZoom() // neutral centred pan+zoom (not a crosshair-anchored zoom-to-1)
    applyVolumeWindow()
  }

  const volResetBtn = h('button', { type: 'button', class: 'ghost sm' }, ['reset']) as HTMLButtonElement
  volResetBtn.addEventListener('click', () => syncVolumeControls())
  // Shared 3-column grid: [label (52px)] [min/max span (auto)] [number input (1fr)]
  // All four rows (display-min, display-max, clip-min, clip-max) share the same column edges.
  const volDisplayClipGrid = h('div', { class: 'vol-dc-grid' }, [
    h('span', { class: 'vol-dc-label' }, ['display']),
    h('label', { class: 'vol-dc-row' }, [h('span', { class: 'vol-dc-mm' }, ['min']), dispMinBox]),
    h('span', { class: 'vol-dc-label' }),
    h('label', { class: 'vol-dc-row' }, [h('span', { class: 'vol-dc-mm' }, ['max']), dispMaxBox]),
    h('span', { class: 'vol-dc-label' }, ['clip']),
    h('label', { class: 'vol-dc-row' }, [h('span', { class: 'vol-dc-mm' }, ['min']), clipMinBox]),
    h('span', { class: 'vol-dc-label' }),
    h('label', { class: 'vol-dc-row' }, [h('span', { class: 'vol-dc-mm' }, ['max']), clipMaxBox]),
  ])
  const volRail = h('aside', { class: 'vol-rail' }, [
    h('div', { class: 'vol-rail-head' }, [h('span', { class: 'vol-rail-title' }, ['underlay']), volResetBtn]),
    briSlider.element,
    conSlider.element,
    volDisplayClipGrid,
    h('div', { class: 'vol-rail-toggles' }, [
      zoomSlider.element,
      h('label', { class: 'tb-field inline' }, [crosshairCheck, h('span', {}, ['crosshair'])]),
      h('label', { class: 'tb-field inline' }, [orientCheck, h('span', {}, ['AP/SI/LR'])]),
    ]),
  ])
  setVolRailEnabled(false) // disabled until a base volume loads
  volRail.hidden = true // hidden on the welcome screen; revealed by syncVolumeControls once a volume loads
  // Rail is col 1 / row 1 of the dashboard grid, so it stops at the info panel (row 2) and the
  // info panel — spanning grid-column 1/-1 — reaches under it to the far-left edge.
  main.insertBefore(volRail, main.firstChild)

  root.append(toolbar, h('div', { class: 'content-row' }, [main]))

  // The viewport height settles only after the fullscreen transition finishes — the initial
  // layout can be a few px short, leaving a first-paint artifact at the bottom edge that only
  // cleared when the user resized. Nudge one relayout after the browser has painted so it
  // self-corrects. (100dvh on #app handles the sizing; this repaints away any stale edge.)
  requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))))

  // #4 Draggable seams between the 5 bottom info subpanels. Each seam adjusts the px width of the
  // column to its left (cols 1..4, stored in --info-cN); the last column flexes to fill. The handles
  // float over the seams and are repositioned whenever the panel or a column resizes.
  {
    const cols = Array.from(infoPanel.querySelectorAll('.info-col')) as HTMLElement[]
    const MIN_COL = 90
    const handles: HTMLElement[] = []
    const reposition = (): void => {
      const base = infoPanel.getBoundingClientRect().left
      handles.forEach((handle, k) => {
        handle.style.left = `${cols[k].getBoundingClientRect().right - base}px`
      })
    }
    for (let k = 0; k < cols.length - 1; k++) {
      const handle = h('div', { class: 'info-vresizer', title: 'Drag to resize the subpanels' })
      let dragging = false
      handle.addEventListener('pointerdown', (e) => {
        dragging = true
        handle.setPointerCapture(e.pointerId)
        e.preventDefault()
      })
      handle.addEventListener('pointermove', (e) => {
        if (!dragging) return
        const left = cols[k].getBoundingClientRect().left
        const w = Math.max(MIN_COL, e.clientX - left)
        infoPanel.style.setProperty(`--info-c${k + 1}`, `${Math.round(w)}px`)
        reposition()
      })
      const end = (e: PointerEvent): void => {
        if (!dragging) return
        dragging = false
        try {
          handle.releasePointerCapture(e.pointerId)
        } catch {
          /* pointer already released */
        }
      }
      handle.addEventListener('pointerup', end)
      handle.addEventListener('pointercancel', end)
      handles.push(handle)
      infoPanel.append(handle)
    }
    reposition()
    new ResizeObserver(reposition).observe(infoPanel)
  }

  // Drag the boundary between the viewer area and the right atlas panel: update the
  // --legend-width grid track live (the dashboard grid is `minmax(0,1fr) var(--legend-width)`).
  {
    let dragging = false
    const setWidth = (clientX: number): void => {
      const rect = main.getBoundingClientRect()
      const w = Math.max(160, Math.min(rect.width - 320, rect.right - clientX))
      document.documentElement.style.setProperty('--legend-width', `${Math.round(w)}px`)
      view?.resize()
    }
    panelResizer.addEventListener('pointerdown', (e) => {
      dragging = true
      panelResizer.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    panelResizer.addEventListener('pointermove', (e) => {
      if (dragging) setWidth(e.clientX)
    })
    const end = (e: PointerEvent): void => {
      if (!dragging) return
      dragging = false
      try {
        panelResizer.releasePointerCapture(e.pointerId)
      } catch {
        /* pointer already released */
      }
    }
    panelResizer.addEventListener('pointerup', end)
    panelResizer.addEventListener('pointercancel', end)
  }

  // Drag the underlay rail's right edge: update --rail-w (the shared base width of the rail column
  // and the Coordinates info column). Clamped so the rail never starves the viewer or collapses.
  {
    let dragging = false
    const setWidth = (clientX: number): void => {
      const rect = main.getBoundingClientRect()
      const w = Math.max(120, Math.min(rect.width - 360, clientX - rect.left))
      main.style.setProperty('--rail-w', `${Math.round(w)}px`)
      view?.resize()
    }
    railResizer.addEventListener('pointerdown', (e) => {
      dragging = true
      railResizer.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    railResizer.addEventListener('pointermove', (e) => {
      if (dragging) setWidth(e.clientX)
    })
    const end = (e: PointerEvent): void => {
      if (!dragging) return
      dragging = false
      try {
        railResizer.releasePointerCapture(e.pointerId)
      } catch {
        /* pointer already released */
      }
    }
    railResizer.addEventListener('pointerup', end)
    railResizer.addEventListener('pointercancel', end)
  }

  // No more persistent "Ready · …" status (Req 5). Loading/errors surface in a centered overlay
  // over the viewer while a subject renders (Req 17); other transient progress is dropped.
  const showLoading = (text: string): void => {
    loadingText.textContent = text
    loadingText.classList.remove('error')
    loadingOverlay.classList.remove('is-error')
    loadingOverlay.hidden = false
  }
  const hideLoading = (): void => {
    loadingOverlay.hidden = true
  }
  const showError = (text: string): void => {
    loadingText.textContent = text
    loadingText.classList.add('error')
    loadingOverlay.classList.add('is-error')
    loadingOverlay.hidden = false
  }
  // --- state wiring ---
  let view: MultiView | null = null
  let marker: Marker | null = null
  let gizmo: OrientationGizmo | null = null
  let manifest: Manifest | null = null
  let currentNode: SurfaceNode | null = null

  // Editable crosshair coordinates: X/Y/Z (world mm) and I/J/K (base-volume voxel). Typing a value
  // moves the crosshair; the fields refresh from the crosshair on each move (except the one being
  // edited, so typing isn't clobbered). Built once; `update()` writes values, never rebuilds the DOM.
  const coordEditor = (() => {
    const num = (step: string): HTMLInputElement => h('input', { type: 'number', step, class: 'coord-num' }) as HTMLInputElement
    const xIn = num('0.1')
    const yIn = num('0.1')
    const zIn = num('0.1')
    const iIn = num('1')
    const jIn = num('1')
    const kIn = num('1')
    const hemiEl = h('dd', {}, ['—'])
    // Read-only probe of the active overlay's value at the crosshair. The <dt> label is the overlay
    // name/metric (set dynamically), the <dd> its formatted value; both driven by updateOverlayValue().
    const overlayDt = h('dt', {}, ['overlay'])
    const overlayEl = h('dd', {}, ['—'])
    const commitMm = (): void => {
      const mm: [number, number, number] = [Number(xIn.value), Number(yIn.value), Number(zIn.value)]
      if (mm.some((v) => Number.isNaN(v))) return
      view?.moveCrosshairToWorld(mm)
    }
    const commitVox = (): void => {
      const ijk: [number, number, number] = [Number(iIn.value), Number(jIn.value), Number(kIn.value)]
      if (ijk.some((v) => Number.isNaN(v))) return
      const mm = view?.voxToWorld(ijk)
      if (mm) view?.moveCrosshairToWorld(mm)
    }
    for (const inp of [xIn, yIn, zIn]) inp.addEventListener('change', commitMm)
    for (const inp of [iIn, jIn, kIn]) inp.addEventListener('change', commitVox)
    const row = (label: string, input: HTMLElement): Node[] => [h('dt', {}, [label]), h('dd', {}, [input])]
    const el = h('dl', { class: 'coord-dl' }, [
      ...row('X (mm)', xIn),
      ...row('Y (mm)', yIn),
      ...row('Z (mm)', zIn),
      ...row('I', iIn),
      ...row('J', jIn),
      ...row('K', kIn),
      h('dt', {}, ['hemi']),
      hemiEl,
      overlayDt,
      overlayEl,
    ])
    const put = (inp: HTMLInputElement, v: string): void => {
      if (document.activeElement !== inp) inp.value = v
    }
    const update = (mm: [number, number, number], ijk: [number, number, number] | null, hemi: string): void => {
      put(xIn, mm[0].toFixed(2))
      put(yIn, mm[1].toFixed(2))
      put(zIn, mm[2].toFixed(2))
      put(iIn, ijk ? String(ijk[0]) : '')
      put(jIn, ijk ? String(ijk[1]) : '')
      put(kIn, ijk ? String(ijk[2]) : '')
      hemiEl.textContent = hemi
    }
    // Set the overlay probe row's value ('—' when nothing is overlaid). The <dt> stays 'overlay'.
    const setOverlay = (value: string | null): void => {
      overlayEl.textContent = value ?? '—'
    }
    return { el, update, setOverlay }
  })()
  // Mount the editable editor into the Coordinates subpanel (built into the info panel above).
  {
    const coordHost = document.getElementById('report-coordinates')
    if (coordHost) {
      coordHost.classList.remove('muted')
      coordHost.replaceChildren(coordEditor.el)
    }
  }

  // Effective pane visibility (Req: hide vol/surf pane when unchecked). Never hide both: if both
  // boxes are off, keep the pane whose box was unchecked most recently (user's choice).
  let lastUnchecked: 'vol' | 'surf' = 'vol'
  const paneState = (): { vol: boolean; surf: boolean } => {
    let vol = volCheck.checked
    let surf = surfCheck.checked
    if (!vol && !surf) lastUnchecked === 'vol' ? (vol = true) : (surf = true)
    return { vol, surf }
  }
  // Hide the unchecked pane's grid track and resize the remaining panel(s) to fill.
  const applyPaneVisibility = (): void => {
    const { vol, surf } = paneState()
    main.dataset.vol = vol ? 'on' : 'off'
    main.dataset.surf = surf ? 'on' : 'off'
    view?.resize()
  }
  // Hemisphere shown = surf pane visible AND that hemisphere's LH/RH checkbox.
  const applyHemiVisibility = (): void => {
    if (!view) return
    const surf = paneState().surf
    view.setHemisphereVisible(0, surf && lhCheck.checked)
    view.setHemisphereVisible(1, surf && rhCheck.checked)
  }
  // Which hemisphere Lat/Med orient to: left when LH is on, else right.
  const preferHemi = (): 0 | 1 => (lhCheck.checked ? 0 : 1)

  // --- morphology shading + yellow-marker state ---
  let morphPanel: MorphologyPanel | null = null
  let morphMetric: MorphologyDisplayMetric = 'curvature'
  let morphStyle: CurvatureStyle = 'binary'
  const morphRanges: Record<MorphologyMetric, { min: number; max: number }> = {
    curvature: { ...MORPH_DEFAULT_RANGE.curvature },
    sulc: { ...MORPH_DEFAULT_RANGE.sulc },
    thickness: { ...MORPH_DEFAULT_RANGE.thickness },
  }
  // Per-metric colormap override for the continuous morphology layers (binary curvature is fixed).
  const morphColormaps: Partial<Record<MorphologyMetric, string>> = { ...MORPH_DEFAULT_COLORMAP }
  // Per-metric two-sided clip (as in function): vertices outside [lo, hi] render transparent. Default
  // open (full domain).
  const morphClip: Record<MorphologyMetric, { lo: number | null; hi: number | null }> = {
    curvature: { lo: null, hi: null },
    sulc: { lo: null, hi: null },
    thickness: { lo: null, hi: null },
  }
  let markerMode: MarkerMode = 'nearestNode'
  let lastCrosshairMm: [number, number, number] | null = null
  const morphDisplay = (): MorphologyDisplay => ({ metric: morphMetric, curvatureStyle: morphStyle, ranges: morphRanges, colormaps: morphColormaps, clip: morphClip[morphActiveMetric()] })

  const placeMarker = (): void => {
    if (!view) return
    if (!paneState().surf) {
      marker?.setWorld(null) // no marker while the surface is hidden (Req 6)
      return
    }
    // crosshair3d pins the raw crosshair world coord; nearestNode snaps to the reference vertex.
    if (markerMode === 'crosshair3d' && lastCrosshairMm) {
      marker?.setWorld(lastCrosshairMm, null)
      return
    }
    if (!currentNode) return
    marker?.setWorld(view.nodeWorld(currentNode), view.nodeWorldNormal(currentNode))
  }

  // --- atlas state ---
  const legend = new RoiLegend(legendSlot, { onHiddenChange: (hidden) => applyHidden(hidden) })
  let atlasPanel: AtlasPanel | null = null
  let atlasEntries: AtlasLabel[] = []
  let atlasSeed = ARM_SEED
  let atlasOpacity = 0.7
  let atlasSurfacePair: { left: string; right: string } | null = null
  let atlasHidden = new Set<number>()

  // Which category's picker is docked at the top of the side panel (drives the button highlight and
  // the visible content slot). Atlas and Function are mutually-exclusive overlays; Morphology is an
  // always-on base underlay, so its tab leaves the active overlay untouched. `lastAtlasSel` /
  // `lastFuncChoice` remember each overlay's selection so re-entering its tab restores it.
  let dockedTab: 'atlas' | 'morphology' | 'function' | null = null
  let lastAtlasSel: AtlasSelection | null = null
  let lastFuncChoice: FunctionChoice | null = null

  function applyHidden(hidden: Set<number>): void {
    if (!view || atlasEntries.length === 0) return
    atlasHidden = hidden
    applyAtlasColormap()
  }

  // Apply the current atlas colormap to BOTH the volume slices and the 3D surface (Req: a colormap
  // change must recolor both). Categorical (`atlasColormap === null`, "none"): the per-ROI label
  // table; visibility is driven solely by the ROI list (atlasHidden) — labels mode has no display
  // range or clip. Continuous (a colormap key — default for float atlases, or forced onto a
  // parcellation): quantize values over the display window into a shared ramp LUT (identical on
  // volume + surface) and mask voxels/vertices outside the clip window.
  function applyAtlasColormap(): void {
    if (!view) return
    if (atlasColormap) {
      const cmapLut = colormapLuts[atlasColormap] ?? view.colormapLut(atlasColormap)
      if (!cmapLut) return
      const range = { min: atlasDisplayMin, max: atlasDisplayMax }
      const clip = { lo: atlasClipLo, hi: atlasClipHi }
      view.setAtlasContinuous(cmapLut, range, clip) // volume slices
      if (atlasSurfacePair) void view.setAtlasSurfaceContinuous(atlasSurfacePair, cmapLut, range, atlasOpacity, clip) // surface
    } else {
      if (atlasEntries.length) view.setAtlasColortable(buildLabelColortable(atlasEntries, { seed: atlasSeed, hidden: atlasHidden })) // slices (keeps negatives)
      void view.updateSurfaceOverlayTable(buildLabelColortable(atlasEntries, { seed: atlasSeed, hidden: atlasHidden, clipNegative: true })) // surface
    }
  }

  // Current atlas surface overlay descriptor (per-hemi .func.gii + colortable), or null.
  const buildSurfaceOverlay = () =>
    atlasSurfacePair && atlasEntries.length
      ? { left: atlasSurfacePair.left, right: atlasSurfacePair.right, table: buildLabelColortable(atlasEntries, { seed: atlasSeed, hidden: atlasHidden, clipNegative: true }) }
      : null
  // Swap ONLY the surface overlay layer in place — no base-mesh reload, so the surface doesn't
  // blank when the atlas/map changes (Req 7). Used for atlas selection; surface-type changes
  // still go through applySurface (which reloads geometry).
  const applyOverlay = async (): Promise<void> => {
    if (!view) return
    await view.setSurfaceOverlay(buildSurfaceOverlay())
  }

  let atlasToken = 0
  const selectAtlas = async (sel: AtlasSelection | null): Promise<void> => {
    if (!view || !manifest) return
    const token = ++atlasToken // latest-wins guard against rapid atlas switches
    atlasColormap = null // a new atlas selection starts categorical
    atlasPanel?.setActive(sel)
    if (!sel) {
      view.removeAtlas()
      legend.clear()
      atlasEntries = []
      atlasSurfacePair = null
      atlasHidden = new Set()
      atlasContinuous = false
      await applyOverlay() // drop the atlas surface layer in place (no reload)
      refreshColorDisplay()
      return
    }
    const entry = manifest.atlases.find((a) => a.name === sel.name)
    if (!entry) return
    atlasSeed = ARM_SEED
    const title = entry.label
    try {
      let parsed: AtlasLabel[] = []
      if (entry.labels) {
        const tsv = await (await client.apiFetch(entry.labels)).text()
        parsed = parseAtlasTsv(tsv)
      }
      await view.loadAtlasOverlay(entry.volume, atlasOpacity)
      if (token !== atlasToken) return // a newer selection superseded this one
      atlasHidden = new Set()
      atlasSurfacePair = entry.surface ?? null
      atlasContinuous = view.atlasIsContinuous()
      atlasDomain = view.atlasValueRange()
      atlasDisplayMin = atlasDomain.min
      atlasDisplayMax = atlasDomain.max
      atlasClipLo = null
      atlasClipHi = null
      if (atlasContinuous) {
        // Continuous (float scalar) gradient: no discrete ROIs. Render with the default colormap on
        // BOTH volume + surface; the ROI list is meaningless, so clear it (COLOR DISPLAY shows the bar).
        atlasEntries = []
        atlasColormap = CONTINUOUS_DEFAULT
        legend.clear()
        applyAtlasColormap()
      } else {
        // Categorical parcellation. No .tsv sidecar: derive the label set from the volume itself so
        // it still renders categorically (procedural colors keyed by ID) with a legend + toolbar.
        atlasColormap = null
        atlasEntries = parsed.length ? parsed : view.atlasLabelIds().map((id) => ({ id, name: String(id), region: '', hemi: '' }))
        if (atlasEntries.length) {
          view.setAtlasColortable(buildLabelColortable(atlasEntries, { seed: atlasSeed }))
          legend.setAtlas(title, atlasEntries, atlasSeed)
        } else {
          legend.clear()
        }
        await applyOverlay() // load + color the surface .func.gii categorically (no base-surface reload)
      }
      refreshColorDisplay()
    } catch {
      // atlas load failure is non-fatal — leave the previous overlay in place
    }
  }

  const setActiveLayout = (layout: Layout): void => {
    store.set('layout', layout)
    for (const b of layoutBtns) b.classList.toggle('active', b.dataset.layout === layout)
    main.dataset.layout = layout
    view?.setLayout(layout)
    view?.resize()
  }
  for (const b of layoutBtns) b.addEventListener('click', () => setActiveLayout(b.dataset.layout as Layout))

  const applySurface = async (kind: string): Promise<void> => {
    if (!view || !manifest) return
    const pair = manifest.surfaces[kind as keyof Manifest['surfaces']]
    await view.setSurface(pair, morphologyShapePairs(manifest), buildSurfaceOverlay(), morphDisplay())
    // Note: no auto-fit here — the initial fit runs in the load flow (after the layout sizes the
    // pane); switching surface type keeps the current zoom/orientation (Req 11).
    applyHemiVisibility()
    placeMarker() // re-place the pin at the same node on the new surface geometry
  }

  // The vol checkbox toggles the base volume on/off and hides/shows the slice pane (Req 3).
  volCheck.addEventListener('change', () => {
    if (!volCheck.checked) lastUnchecked = 'vol'
    view?.setVolumeOpacity(paneState().vol ? 1 : 0)
    applyPaneVisibility()
  })
  volSelect.addEventListener('change', async () => {
    if (!view || !manifest) return
    const vol = manifest.volumes[Number(volSelect.value)]
    if (!vol) return
    try {
      await view.setBaseVolume(vol.url, paneState().vol ? 1 : 0)
      syncVolumeControls() // re-seed the underlay rail for the switched volume's intensity range
      store.set('volumeKey', vol.key)
    } catch {
      // volume switch failure is non-fatal — the previous base volume stays loaded
    }
  })
  surfSelect.addEventListener('change', () => {
    store.set('surfaceKind', surfSelect.value)
    void (async () => {
      await applySurface(surfSelect.value)
      // The mesh reload drops the function-on-surface layer; re-apply it so the overlay persists.
      await applyFunctionSurface()
    })()
  })
  surfCheck.addEventListener('change', () => {
    if (!surfCheck.checked) lastUnchecked = 'surf'
    applyHemiVisibility()
    applyPaneVisibility() // hide/show the surface pane and resize the rest (Req 3)
    placeMarker() // hide/show the pin with the surface (Req 6)
  })
  lhCheck.addEventListener('change', () => {
    applyHemiVisibility()
    placeMarker()
  })
  rhCheck.addEventListener('change', () => {
    applyHemiVisibility()
    placeMarker()
  })

  // Surf-row view presets replace the old single "Reset views" (Req 4). No rescale, no crosshair
  // reset — just re-orient the surface camera (Req 11).
  for (const b of viewBtns) {
    b.addEventListener('click', () => {
      view?.setView(b.dataset.view as 'lateral' | 'medial' | 'ventral' | 'dorsal' | 'anterior' | 'posterior', preferHemi())
    })
  }

  // --- function state (retinotopy / somatotopy) ---
  let functionPanel: FunctionPanel | null = null
  let funcChoice: FunctionChoice | null = null
  let funcThreshold = 0
  let funcOpacity = 1
  let funcBrightness = 1
  let funcToken = 0
  // Colormap override (null = the active map's default), display range (cal clamp; defaults to the
  // map's mode range), and value-clip window (null = unbounded).
  let funcColormap: string | null = null
  let funcCalMin = 0
  let funcCalMax = 1
  let funcClipLo: number | null = null
  let funcClipHi: number | null = null
  // Colormap assets (gradient previews + raw LUTs) + registry, built once the view exists.
  let colormapGradients: Record<string, string> = {}
  let colormapLuts: Record<string, Uint8ClampedArray> = {}
  let colormapInfos: ColormapInfo[] = []
  // The unified bottom "Color display" section + which overlay it currently targets.
  let colorDisplay: ColorDisplay | null = null
  type ColorTarget = 'morphology' | 'function' | 'atlas' | null
  // Atlas overlay colormap: null = the categorical label table; a key = a continuous colormap (the
  // default for float scalar atlases like CortHierarchy, or forced onto a parcellation via the
  // picker). The synthetic 'labels' picker entry restores the categorical table.
  let atlasColormap: string | null = null
  const LABELS_KEY = 'labels'
  const CONTINUOUS_DEFAULT = 'magma' // default colormap for continuous (float scalar) atlases
  // Atlas display state: whether the loaded atlas is a gradient, its fixed data-value (or label-id)
  // domain, and the current (draggable) display window + value clip. For a continuous atlas the window
  // remaps the ramp and the clip hides voxels outside [lo, hi]; for a categorical atlas the clip hides
  // ROIs whose id falls outside [lo, hi] (the display window is inert — colors come from the table).
  let atlasContinuous = false
  let atlasDomain = { min: 0, max: 1 }
  let atlasDisplayMin = 0
  let atlasDisplayMax = 1
  let atlasClipLo: number | null = null
  let atlasClipHi: number | null = null
  // Per-hemisphere parsed frames of the currently loaded function surface .func.gii, cached so a
  // threshold/brightness drag re-quantizes in place without re-fetching (keyed by choice.kind).
  let funcSurfaceFrames: { kind: string; left: Float32Array[]; right: Float32Array[] } | null = null

  // Map a function choice to the categorical surface-LUT mode.
  const surfaceModeFor = (choice: FunctionChoice): SurfaceFunctionMode =>
    choice.kind === 'somatotopy' ? 'somatotopy' : choice.mode.id === 'eccentricity' ? 'eccentricity' : 'polar'

  // Fetch + parse the function surface .func.gii pair (all frames) for the active choice. Cached.
  const ensureFunctionSurfaceFrames = async (choice: FunctionChoice): Promise<boolean> => {
    if (funcSurfaceFrames?.kind === choice.kind) return true
    const map = choice.kind === 'retinotopy' ? manifest?.function.retinotopy : manifest?.function.somatotopy
    const pair = map?.surface
    if (!pair?.left || !pair?.right) {
      funcSurfaceFrames = null
      return false
    }
    const [left, right] = await Promise.all([
      client.apiFetch(pair.left).then((x) => x.text()).then((t) => parseGiftiFloat32(t)),
      client.apiFetch(pair.right).then((x) => x.text()).then((t) => parseGiftiFloat32(t)),
    ])
    funcSurfaceFrames = { kind: choice.kind, left, right }
    return true
  }

  // (Re)build the function-on-surface categorical layer from the cached frames using the current
  // threshold + brightness. Removes the layer when surface display is off or no choice is active.
  // The function overlay is shown on the surface whenever a map is selected (no toggle). Removed
  // when the selection is cleared or the map has no precomputed surface pair.
  const applyFunctionSurface = async (): Promise<void> => {
    if (!view) return
    if (!funcChoice) {
      view.clearSurfaceFunctionLayers()
      return
    }
    const token = funcToken
    const ok = await ensureFunctionSurfaceFrames(funcChoice)
    if (token !== funcToken || !funcChoice || !funcSurfaceFrames) return
    const map = funcChoice.kind === 'retinotopy' ? manifest?.function.retinotopy : manifest?.function.somatotopy
    const pair = map?.surface
    if (!ok || !pair?.left || !pair?.right) {
      view.clearSurfaceFunctionLayers()
      return
    }
    const mode = surfaceModeFor(funcChoice)
    const { valueFrame, fFrame } = funcChoice.mode
    // Build the surface LUT from the ACTIVE colormap so the picker recolors the surface too. Prefer
    // the prebuilt asset, fall back to a live LUT lookup, and only then to the built-in retinotopy ramp.
    const cmapLut = colormapLuts[funcColormapKey()] ?? view.colormapLut(funcColormapKey())
    const lut = cmapLut ? surfaceLutFromColormap(cmapLut, funcBrightness).lut : createFunctionalSurfaceLut(mode, funcBrightness).lut
    // Quantize over the user display window for maps that expose one (somatotopy) so the surface
    // tracks the same contrast as the volume's display-range remap; retinotopy (polar/eccentricity)
    // has no display range, so it keeps its fixed cyclic/natural domain (range = undefined). Then
    // mask by both the F-threshold and the value clip (so clip hides the same vertices as voxels).
    const range = funcChoice.kind === 'retinotopy' ? undefined : { min: funcCalMin, max: funcCalMax }
    const binsFor = (frames: Float32Array[]): Float32Array => {
      const value = frames[valueFrame] ?? new Float32Array(0)
      let bins = quantizeFunctionalSurfaceValues(value, mode, range)
      if (fFrame != null && frames[fFrame]) bins = maskSurfaceBinsByF(bins, frames[fFrame], funcThreshold)
      if (funcClipLo != null || funcClipHi != null) bins = maskSurfaceBinsByValue(bins, value, funcClipLo, funcClipHi)
      return bins
    }
    await view.setFunctionSurface(funcChoice.kind, pair, binsFor(funcSurfaceFrames.left), binsFor(funcSurfaceFrames.right), lut, funcOpacity)
  }

  const num = (v: number, unit = ''): string => (Number.isFinite(v) ? `${v.toFixed(2)}${unit}` : '—')

  const updateFunctionReport = (): void => {
    const el = document.getElementById('report-function')
    if (!el || !view || !manifest) return
    const map = funcChoice ? (funcChoice.kind === 'retinotopy' ? manifest.function.retinotopy : manifest.function.somatotopy) : null
    const vox = funcChoice && view.functionCrosshairVox()
    if (!funcChoice || !map || !vox) {
      el.textContent = '—'
      return
    }
    const f = map.frames
    el.innerHTML = ''
    if (funcChoice.kind === 'retinotopy') {
      const polar = view.sampleFunctionFrame(vox, f.polar)
      const ecc = view.sampleFunctionFrame(vox, f.eccentricity)
      const [vx, vy] = visualXY(polar, ecc)
      // Single dl keeps every label:value pair aligned; the last three ids are filled by
      // updateVisualField from the sampled neighborhood (kept in sync via the crosshair order).
      const dl = h('dl', { class: 'dl-paired' })
      const rowPaired = (label1: string, val1: string, label2: string, val2: string): void => {
        dl.append(h('dt', {}, [label1]), h('dd', {}, [val1]), h('dt', {}, [label2]), h('dd', {}, [val2]))
      }
      rowPaired('polar angle (rad)', num(polar), 'F', num(view.sampleFunctionFrame(vox, f.polarF)))
      rowPaired('eccentricity (°)', num(ecc), 'F', num(view.sampleFunctionFrame(vox, f.eccentricityF)))
      rowPaired('visual X (°)', num(vx), 'visual Y (°)', num(vy))
      dl.append(h('dt', {}, ['valid voxels']), h('dd', { id: 'func-valid' }, ['—']), h('dt', {}, ['local spread (°)']), h('dd', { id: 'func-spread' }, ['—']))
      el.append(dl)
    } else {
      const dl = h('dl', { class: 'dl-paired' })
      dl.append(
        h('dt', {}, ['body position']),
        h('dd', {}, [num(view.sampleFunctionFrame(vox, f.phase))]),
        h('dt', {}, ['F']),
        h('dd', {}, [num(view.sampleFunctionFrame(vox, f.fstat))]),
      )
      el.append(dl)
    }
  }

  const updateVisualField = (): void => {
    const canvas = document.getElementById('visual-field-canvas') as HTMLCanvasElement | null
    const note = document.getElementById('report-visual-note')
    if (!canvas || !view || !manifest) return
    if (funcChoice?.kind !== 'retinotopy') {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
      if (note) note.textContent = 'Add retinotopy in FUNC MAP first'
      return
    }
    const vox = view.functionCrosshairVox()
    const dims = view.functionDims()
    const f = manifest.function.retinotopy!.frames
    if (!vox || !dims) return
    const s = Number(neighborhoodSelect.value)
    const points: VfPoint[] = []
    let possible = 0 // in-bounds neighborhood voxels considered (denominator of "valid voxels")
    for (let dx = -s; dx <= s; dx++)
      for (let dy = -s; dy <= s; dy++)
        for (let dz = -s; dz <= s; dz++) {
          const v: [number, number, number] = [vox[0] + dx, vox[1] + dy, vox[2] + dz]
          if (v[0] < 0 || v[1] < 0 || v[2] < 0 || v[0] >= dims[0] || v[1] >= dims[1] || v[2] >= dims[2]) continue
          possible++
          const polar = view.sampleFunctionFrame(v, f.polar)
          const polarF = view.sampleFunctionFrame(v, f.polarF)
          const ecc = view.sampleFunctionFrame(v, f.eccentricity)
          const eccF = view.sampleFunctionFrame(v, f.eccentricityF)
          if (!(ecc >= 0 && ecc <= ECC_MAX && polarF >= funcThreshold && eccF >= funcThreshold)) continue
          const [x, y] = visualXY(polar, ecc)
          points.push({ x, y, polar, ecc, center: dx === 0 && dy === 0 && dz === 0 })
        }
    const stats = visualFieldStats(points)
    drawVisualField(canvas, points, stats)
    // Mirror the neighborhood stats into the Function column (dds built by updateFunctionReport).
    const setDd = (id: string, text: string): void => {
      const d = document.getElementById(id)
      if (d) d.textContent = text
    }
    setDd('func-valid', `${points.length} / ${possible}`)
    setDd('func-spread', points.length ? stats.spread.toFixed(2) : 'N/A')
    if (note) note.textContent = points.length ? '' : 'No valid retinotopic voxel here.'
  }

  // Active volume colormap for the function overlay: the user override, else the map's default.
  const funcColormapKey = (): string => funcColormap ?? funcChoice?.mode.colormap ?? 'gray'

  const applyFunctionNow = (): void => {
    if (view && funcChoice) {
      // Fixed cal range = the map's natural range (keeps index-0 transparent for masking); the user
      // display range (funcCalMin/Max) is applied as a color remap so it clamps instead of hiding.
      view.applyFunctional(funcChoice.mode.valueFrame, funcChoice.mode.fFrame, funcThreshold, funcColormapKey(), funcOpacity, funcChoice.mode.calMin, funcChoice.mode.calMax, funcCalMin, funcCalMax, funcClipLo, funcClipHi)
      refreshColorDisplay()
    }
  }

  // Single entry point that recolors BOTH the volume slices and the 3D surface for the function
  // overlay, so callers never have to remember to pair applyFunctional + applyFunctionSurface (a
  // missed pairing silently desyncs slices from mesh). Exactly one surface pass — safe against the
  // func-surface layer race (never fire a second applyFunctionSurface() alongside this).
  const applyFunctionColor = (): void => {
    applyFunctionNow()
    void applyFunctionSurface()
  }

  // Preserved function display settings, carried verbatim across a monkey switch (else recomputed to
  // this map's defaults). Passing these THROUGH selectFunction keeps the surface application a single
  // pass — applying it via a second applyFunctionSurface() would race the first (from inside
  // selectFunction) on the shared surface layer and can leave it with the default gray colormap,
  // painting every masked vertex opaque black.
  type FuncPreserve = { threshold: number; colormap: string | null; calMin: number; calMax: number; clipLo: number | null; clipHi: number | null }
  const selectFunction = async (choice: FunctionChoice | null, preserve?: FuncPreserve): Promise<void> => {
    if (!view || !manifest) return
    const token = ++funcToken
    funcChoice = choice
    funcSurfaceFrames = null // invalidate the cached surface frames for the previous choice
    // Reset per-map display overrides: default colormap, display range = the map's natural range,
    // clip nothing — unless a snapshot is being restored, in which case adopt its exact values.
    funcColormap = preserve ? preserve.colormap : null
    funcClipLo = preserve ? preserve.clipLo : null
    funcClipHi = preserve ? preserve.clipHi : null
    if (choice) {
      funcCalMin = preserve ? preserve.calMin : choice.mode.calMin
      funcCalMax = preserve ? preserve.calMax : choice.mode.calMax
    }
    functionPanel?.setActive(choice ? choiceKey(choice) : null)
    if (!choice) {
      view.removeFunctional()
      view.clearSurfaceFunctionLayers()
      refreshColorDisplay()
      updateFunctionReport()
      updateVisualField()
      return
    }
    const map = choice.kind === 'retinotopy' ? manifest.function.retinotopy : manifest.function.somatotopy
    if (!map) return
    try {
      await view.loadFunctional(map.combined, choice.mode.colormap, funcOpacity)
      if (token !== funcToken) return
      if (choice.mode.fFrame != null) {
        const { min, max } = finiteExtrema(view.scaledFrame(choice.mode.fFrame))
        // Restore keeps the carried threshold (clamped into this map's range); else default F ≥ 5.
        funcThreshold = preserve ? Math.min(Math.max(preserve.threshold, min), max) : Math.min(Math.max(min, 5), max)
        functionPanel?.setThresholdBounds(min, max, funcThreshold)
      } else {
        funcThreshold = preserve ? preserve.threshold : 0
        functionPanel?.setThresholdBounds(0, 0, 0)
      }
      applyFunctionColor() // single vol+surf pass (one applyFunctionSurface — see race note above)
      updateFunctionReport()
      updateVisualField()
    } catch (err) {
      showError(errorText(err))
    }
  }

  neighborhoodSelect.addEventListener('change', updateVisualField)

  // Drag the top boundary of the info panel: update --info-height and redraw the visual field.
  {
    let dragging = false
    const setInfoHeight = (clientY: number): void => {
      const rect = main.getBoundingClientRect()
      const height = Math.max(120, Math.min(rect.height - 200, rect.bottom - clientY))
      document.documentElement.style.setProperty('--info-height', `${Math.round(height)}px`)
      view?.resize()
      updateVisualField()
    }
    infoResizer.addEventListener('pointerdown', (e) => {
      dragging = true
      infoResizer.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    infoResizer.addEventListener('pointermove', (e) => {
      if (dragging) setInfoHeight(e.clientY)
    })
    const end = (e: PointerEvent): void => {
      if (!dragging) return
      dragging = false
      try {
        infoResizer.releasePointerCapture(e.pointerId)
      } catch {
        /* pointer already released */
      }
    }
    infoResizer.addEventListener('pointerup', end)
    infoResizer.addEventListener('pointercancel', end)
  }

  // --- surface report (morphology at the crosshair vertex) ---
  let lastMm: [number, number, number] | null = null
  const morphShape: { curvature?: [Float32Array, Float32Array]; sulc?: [Float32Array, Float32Array]; thickness?: [Float32Array, Float32Array] } = {}

  // --- unified "Color display" section routing (colormap + legend + display range + clip) ---
  const morphActiveMetric = (): MorphologyMetric => (morphMetric === 'none' ? 'curvature' : morphMetric)
  // Morphology has color controls only for continuous shading (None + binary curvature are fixed).
  const morphColorable = (): boolean => morphMetric !== 'none' && !(morphMetric === 'curvature' && morphStyle === 'binary')

  // Which overlay the bottom color-display section targets, following the docked tab + selection.
  const colorTarget = (): ColorTarget => {
    if (dockedTab === 'function' && funcChoice) return 'function'
    if (dockedTab === 'morphology' && morphColorable()) return 'morphology'
    if (dockedTab === 'atlas' && lastAtlasSel != null) return 'atlas'
    return null
  }

  // Retinotopy legends are circular: polar angle → wheel, eccentricity → concentric rings.
  const legendShapeForFunc = (): 'bar' | 'wheel' | 'rings' => {
    if (!funcChoice || funcChoice.kind !== 'retinotopy') return 'bar'
    return funcChoice.mode.id === 'polar' ? 'wheel' : funcChoice.mode.id === 'eccentricity' ? 'rings' : 'bar'
  }

  const refreshColorDisplay = (): void => {
    if (!colorDisplay) return
    const target = colorTarget()
    if (target === 'function' && funcChoice) {
      const key = funcColormapKey()
      colorDisplay.setTarget({
        title: `${funcChoice.kind === 'retinotopy' ? 'Retinotopy' : 'Somatotopy'} · ${funcChoice.mode.label}`,
        colormap: key,
        legendShape: legendShapeForFunc(),
        gradient: colormapGradients[key] ?? FALLBACK_GRADIENT,
        lut: colormapLuts[key],
        // Display range is hidden only for the fixed-domain cyclic retinotopy maps (polar/eccentricity);
        // somatotopy (body position) is a normal 0–100 map, so it gets the generic display-range control.
        displayDomain: { min: funcChoice.mode.calMin, max: funcChoice.mode.calMax },
        displayRange: { min: funcCalMin, max: funcCalMax },
        showDisplayRange: funcChoice.kind !== 'retinotopy',
        clip: 'range',
        clipDomain: { min: funcChoice.mode.calMin, max: funcChoice.mode.calMax },
        clipValue: { lo: funcClipLo, hi: funcClipHi },
        // Somatotopy's 0–100 axis is a body map (foot → hand → face); anchor the bar with those
        // parts so the numbers read as anatomy. Retinotopy uses wheel/rings legends (no bar ticks).
        barTicks: funcChoice.kind === 'somatotopy' ? ['foot', 'hand', 'face'] : undefined,
        colormaps: colormapInfos.filter((i) => i.key !== LABELS_KEY), // "labels" is atlas-only
      })
    } else if (target === 'morphology') {
      const metric = morphActiveMetric()
      const key = morphColormaps[metric] ?? 'gray'
      colorDisplay.setTarget({
        title: `morphology · ${metric}`,
        colormap: key,
        legendShape: 'bar',
        gradient: colormapGradients[key] ?? FALLBACK_GRADIENT,
        lut: colormapLuts[key],
        displayDomain: MORPH_DOMAIN[metric],
        displayRange: morphRanges[metric],
        clip: 'range',
        clipDomain: MORPH_DOMAIN[metric],
        clipValue: morphClip[metric],
        colormaps: colormapInfos.filter((i) => i.key !== LABELS_KEY), // "labels" is atlas-only
      })
    } else if (target === 'atlas' && lastAtlasSel) {
      const key = atlasColormap ?? LABELS_KEY
      const continuous = atlasColormap !== null
      colorDisplay.setTarget({
        title: `atlas · ${lastAtlasSel.name}`,
        colormap: key,
        legendShape: 'bar',
        // Categorical atlas has no meaningful colormap (colors come from the per-ROI label table, and
        // the picker shows "none"); a continuous legend bar over label ids is misleading, so hide it.
        // Continuous atlas: the gradient bar IS the legend, so keep it.
        showLegend: continuous,
        gradient: colormapGradients[key] ?? FALLBACK_GRADIENT,
        lut: colormapLuts[key],
        // Range + clip belong to a CONTINUOUS colormap only. In labels mode (colormap "none") the
        // display window is inert (colors come from the label table) and a clip-by-id duplicates the
        // ROI list's per-ROI toggles — so hide both; they reappear when a real colormap is picked.
        displayDomain: atlasDomain,
        displayRange: { min: atlasDisplayMin, max: atlasDisplayMax },
        showDisplayRange: continuous,
        // A continuous gradient has no categorical mode, so don't offer "none" in the picker.
        colormaps: atlasContinuous ? colormapInfos.filter((i) => i.key !== LABELS_KEY) : colormapInfos,
        clip: continuous ? 'range' : 'none',
        clipDomain: atlasDomain,
        clipValue: { lo: atlasClipLo, hi: atlasClipHi },
        // Categorical: the ROI list already shows the real palette, so start the section collapsed.
        // Continuous: the bar + range ARE the legend, so keep it open.
        collapsed: !continuous,
      })
    } else {
      colorDisplay.setTarget(null)
    }
    // The overlay-value probe in Coordinates tracks the same target — refresh it on overlay/tab change.
    updateOverlayValue()
  }

  // Route the section's controls to whichever overlay is active.
  const colorDisplayCallbacks = {
    onColormap: (key: string): void => {
      const t = colorTarget()
      if (key === LABELS_KEY && t !== 'atlas') return // "Labels" only means anything for the atlas
      if (t === 'function') {
        funcColormap = key
        applyFunctionColor()
      } else if (t === 'morphology') {
        morphColormaps[morphActiveMetric()] = key
        view?.applyMorphologyDisplay(morphDisplay())
        refreshColorDisplay()
      } else if (t === 'atlas') {
        if (key === LABELS_KEY && atlasContinuous) return // a gradient has no categorical mode
        atlasColormap = key === LABELS_KEY ? null : key
        applyAtlasColormap() // recolors BOTH the volume slices and the 3D surface
        refreshColorDisplay()
      }
    },
    onDisplayRange: (min: number, max: number): void => {
      const t = colorTarget()
      if (t === 'function') {
        funcCalMin = min
        funcCalMax = max
        applyFunctionColor() // range recolors both slices and surface
      } else if (t === 'morphology') {
        morphRanges[morphActiveMetric()] = { min, max }
        view?.applyMorphologyDisplay(morphDisplay())
        refreshColorDisplay()
      } else if (t === 'atlas') {
        atlasDisplayMin = min
        atlasDisplayMax = max
        // Continuous: re-quantize the volume + surface over the new window (no full refresh mid-drag).
        // Categorical: the window is inert (colors come from the label table), so nothing to re-apply.
        if (atlasColormap) applyAtlasColormap()
      }
    },
    onDisplayAuto: (): void => {
      const t = colorTarget()
      if (t === 'morphology') {
        const m = morphActiveMetric()
        morphRanges[m] = autoMorphRange(m)
        view?.applyMorphologyDisplay(morphDisplay())
        refreshColorDisplay()
      } else if (t === 'function' && funcChoice) {
        funcCalMin = funcChoice.mode.calMin
        funcCalMax = funcChoice.mode.calMax
        applyFunctionNow()
      }
    },
    onClipRange: (lo: number | null, hi: number | null): void => {
      const t = colorTarget()
      if (t === 'function') {
        funcClipLo = lo
        funcClipHi = hi
        applyFunctionColor() // clip hides the same vertices on both slices and surface
      } else if (t === 'morphology') {
        morphClip[morphActiveMetric()] = { lo, hi }
        view?.applyMorphologyDisplay(morphDisplay())
        refreshColorDisplay()
      } else if (t === 'atlas') {
        atlasClipLo = lo
        atlasClipHi = hi
        // Continuous: mask voxels outside [lo, hi]. Categorical: hide ROIs whose id is outside
        // [lo, hi] by folding them into the colortable's hidden set (see applyAtlasColormap).
        applyAtlasColormap()
      }
    },
    onReset: (): void => {
      const t = colorTarget()
      if (t === 'function' && funcChoice) {
        funcColormap = null
        funcCalMin = funcChoice.mode.calMin
        funcCalMax = funcChoice.mode.calMax
        funcClipLo = null
        funcClipHi = null
        applyFunctionColor()
      } else if (t === 'morphology') {
        const m = morphActiveMetric()
        morphColormaps[m] = MORPH_DEFAULT_COLORMAP[m]
        morphRanges[m] = { ...MORPH_DEFAULT_RANGE[m] }
        morphClip[m] = { lo: null, hi: null }
        view?.applyMorphologyDisplay(morphDisplay())
        refreshColorDisplay()
      } else if (t === 'atlas') {
        // Continuous atlas resets to the default colormap + full data range; a parcellation resets
        // to its categorical labels.
        atlasColormap = atlasContinuous ? CONTINUOUS_DEFAULT : null
        atlasDisplayMin = atlasDomain.min
        atlasDisplayMax = atlasDomain.max
        atlasClipLo = null
        atlasClipHi = null
        applyAtlasColormap()
        refreshColorDisplay()
      }
    },
  }

  // 2.5–97.5 percentile of the loaded .shape.gii data across both hemispheres (thickness ignores
  // non-positive samples). Curvature is forced symmetric around zero.
  const autoMorphRange = (metric: MorphologyMetric): { min: number; max: number } => {
    const pair = morphShape[metric]
    if (!pair) return { ...MORPH_DEFAULT_RANGE[metric] }
    const all: number[] = []
    for (const arr of pair) for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (Number.isFinite(v) && (metric !== 'thickness' || v > 0)) all.push(v) }
    if (all.length === 0) return { ...MORPH_DEFAULT_RANGE[metric] }
    all.sort((a, b) => a - b)
    const at = (p: number): number => all[Math.min(all.length - 1, Math.max(0, Math.round((p / 100) * (all.length - 1))))]
    let min = at(2.5)
    let max = at(97.5)
    if (metric === 'curvature') { const m = Math.max(Math.abs(min), Math.abs(max)); min = -m; max = m }
    return { min, max }
  }

  const loadMorphology = (m: Manifest): void => {
    morphShape.curvature = undefined
    morphShape.sulc = undefined
    morphShape.thickness = undefined
    const shape = m.morphology?.shape
    if (!shape) return
    const load = async (key: 'curvature' | 'sulc' | 'thickness', pair: SurfacePair | undefined): Promise<void> => {
      if (!pair?.left || !pair?.right) return
      try {
        const [l, r] = await Promise.all([
          client.apiFetch(pair.left).then((x) => x.text()).then((t) => parseGiftiFloat32(t)[0]),
          client.apiFetch(pair.right).then((x) => x.text()).then((t) => parseGiftiFloat32(t)[0]),
        ])
        if (l && r) {
          morphShape[key] = [l, r]
          updateSurfaceReport()
        }
      } catch {
        /* morphology optional */
      }
    }
    void load('curvature', shape.curvature)
    void load('sulc', shape.sulc)
    void load('thickness', shape.thickness)
  }

  const updateSurfaceReport = (): void => {
    const el = document.getElementById('report-surface')
    if (!el || !view) return
    if (!currentNode) {
      el.textContent = '—'
      return
    }
    const node = currentNode
    const refV = view.referenceVertexWorld(node)
    const dist = refV && lastMm ? Math.hypot(refV[0] - lastMm[0], refV[1] - lastMm[1], refV[2] - lastMm[2]) : NaN
    const sample = (key: 'curvature' | 'sulc' | 'thickness'): number => {
      const a = morphShape[key]?.[node.hemi]
      return a && node.index < a.length ? a[node.index] : NaN
    }
    const rows: Array<[string, string]> = [
      ['nearest vertex', String(node.index)],
      ['distance (mm)', Number.isFinite(dist) ? dist.toFixed(2) : '—'],
      ['curvature', num(sample('curvature'))],
      ['sulcal depth', num(sample('sulc'))],
      ['thickness (mm)', num(sample('thickness'))],
    ]
    el.innerHTML = ''
    el.append(dlRows(rows))
  }

  // --- category tabs: an exclusive selector that docks one picker at the top of the side panel ---
  const atlasBtn = panelBtns[PANEL_BUTTONS.indexOf('atlas')]
  const morphBtn = panelBtns[PANEL_BUTTONS.indexOf('morphology')]
  const functionBtn = panelBtns[PANEL_BUTTONS.indexOf('func map')]

  // Reflect the docked tab in the button highlight, the docked picker, and the content slot.
  const updateTabUI = (): void => {
    atlasBtn.classList.toggle('active', dockedTab === 'atlas')
    morphBtn.classList.toggle('active', dockedTab === 'morphology')
    functionBtn.classList.toggle('active', dockedTab === 'function')
    if (atlasPanel) atlasPanel.element.hidden = dockedTab !== 'atlas'
    if (morphPanel) morphPanel.element.hidden = dockedTab !== 'morphology'
    if (functionPanel) functionPanel.element.hidden = dockedTab !== 'function'
    legendSlot.hidden = dockedTab !== 'atlas'
    funcSlot.hidden = dockedTab !== 'function'
    morphSlot.hidden = dockedTab !== 'morphology'
    sidePlaceholder.hidden = dockedTab !== null
    refreshColorDisplay() // the bottom color-display section follows the docked tab's overlay
  }

  // Atlas and Function are mutually-exclusive overlays: entering one clears the other (its last
  // selection is remembered, so re-entering restores it). Morphology is the always-on base layer, so
  // its tab leaves the active overlay alone — only the docked controls swap. Re-clicking the docked
  // tab toggles it off (an atlas/function overlay is cleared back to the bare morphology base).
  const selectTab = (tab: 'atlas' | 'morphology' | 'function'): void => {
    if (dockedTab === tab) {
      dockedTab = null
      if (tab === 'atlas') void selectAtlas(null)
      else if (tab === 'function') void selectFunction(null)
      updateTabUI()
      return
    }
    dockedTab = tab
    if (tab === 'atlas') {
      void selectFunction(null) // hide the function overlay (keeps lastFuncChoice)
      void selectAtlas(lastAtlasSel) // restore the atlas overlay
    } else if (tab === 'function') {
      void selectAtlas(null) // hide the atlas overlay (keeps lastAtlasSel)
      void selectFunction(lastFuncChoice) // restore the function overlay
    }
    // morphology: overlay unchanged — the base persists under any active atlas/function overlay.
    updateTabUI()
  }

  atlasBtn.addEventListener('click', () => selectTab('atlas'))
  morphBtn.addEventListener('click', () => selectTab('morphology'))
  functionBtn.addEventListener('click', () => selectTab('function'))

  // Atlas report: every discovered atlas at the crosshair (sampled from report-only volumes).
  let reportSpecs: Array<{ key: string; label: string; byId: Map<number, AtlasLabel> }> = []

  const updateAnatomyReport = (): void => {
    const el = document.getElementById('report-anatomy')
    if (!el || !view) return
    if (reportSpecs.length === 0) {
      el.textContent = '—'
      return
    }
    el.innerHTML = ''
    // Continuous float atlas (e.g. CortHierarchy): show the raw value, no id/label lookup. 0 and
    // non-finite are background → blank. Float-vs-int is an atlas-level property, so always show
    // fixed decimals — a whole value reads as 1.000, never a bare 1 (which looks like a label id).
    const fmtValue = (v: number): string => (Number.isFinite(v) && v !== 0 ? v.toFixed(3) : '')
    for (const spec of reportSpecs) {
      const raw = view.sampleReportVolume(spec.key)
      if (view.reportVolumeContinuous(spec.key)) {
        el.append(
          h('div', { class: 'atlas-report-row' }, [
            h('span', { class: 'atlas-report-name' }, [spec.label]),
            h('span', { class: 'atlas-report-id' }, [raw != null ? fmtValue(raw) : '']),
            h('span', { class: 'atlas-report-label' }, ['']),
          ]),
        )
        continue
      }
      const id = raw != null ? Math.round(raw) : null
      const label = id != null && id !== 0 ? spec.byId.get(id) : null
      const isUnknown = !label && id != null && id !== 0 // id present but no region name resolves
      const name = label ? label.name.replace(/_/g, ' ') : isUnknown ? '(unlabeled)' : ''
      const short = label?.nameShort ? label.nameShort.replace(/_/g, ' ') : ''
      el.append(
        h('div', { class: 'atlas-report-row' }, [
          h('span', { class: 'atlas-report-name' }, [spec.label]),
          h('span', { class: 'atlas-report-id' }, [id != null && id !== 0 ? String(id) : '']),
          h('span', { class: `atlas-report-label${isUnknown ? ' unknown' : ''}` }, [
            ...(short ? [h('span', { class: 'atlas-report-short' }, [short]), ' · '] : []),
            name,
          ]),
        ]),
      )
    }
  }

  // Overlay-value probe for the Coordinates section: the value of the currently overlaid map at the
  // crosshair. Follows the docked tab via colorTarget() and reuses the same per-kind samplers the
  // dedicated info sections already run each crosshair move (no extra sampling infrastructure).
  const updateOverlayValue = (): void => {
    if (!view) {
      coordEditor.setOverlay(null)
      return
    }
    const target = colorTarget()
    if (target === 'atlas' && lastAtlasSel) {
      const name = lastAtlasSel.name
      const raw = view.sampleReportVolume(name)
      if (raw == null) {
        coordEditor.setOverlay(null)
      } else if (view.reportVolumeContinuous(name)) {
        coordEditor.setOverlay(raw !== 0 ? raw.toFixed(3) : null) // float atlas: fixed decimals
      } else {
        const id = Math.round(raw)
        coordEditor.setOverlay(id !== 0 ? String(id) : null) // parcellation: numeric id only
      }
      return
    }
    if (target === 'function' && funcChoice) {
      const vox = view.functionCrosshairVox()
      const v = vox ? view.sampleFunctionFrame(vox, funcChoice.mode.valueFrame) : NaN
      coordEditor.setOverlay(num(v))
      return
    }
    if (target === 'morphology' && currentNode) {
      const metric = morphActiveMetric()
      const a = morphShape[metric]?.[currentNode.hemi]
      const v = a && currentNode.index < a.length ? a[currentNode.index] : NaN
      coordEditor.setOverlay(num(v))
      return
    }
    coordEditor.setOverlay(null) // nothing overlaid on the docked tab
  }

  const loadReportSpecs = (m: Manifest): void => {
    if (!view) return
    view.clearReportVolumes()
    const specEntries: Array<{ key: string; label: string; entry: { volume: string; labels: string | null } }> = []
    for (const e of m.atlases) specEntries.push({ key: e.name, label: e.label, entry: e })
    reportSpecs = specEntries.map((s) => ({ key: s.key, label: s.label, byId: new Map<number, AtlasLabel>() }))
    for (const s of specEntries) {
      view.loadReportVolume(s.key, s.entry.volume).then(updateAnatomyReport).catch(() => {})
      if (s.entry.labels) {
        client
          .apiFetch(s.entry.labels)
          .then((r) => r.text())
          .then((tsv) => {
            const spec = reportSpecs.find((x) => x.key === s.key)
            if (spec) {
              for (const e of parseAtlasTsv(tsv)) spec.byId.set(e.id, e)
              updateAnatomyReport()
            }
          })
          .catch(() => {})
      }
    }
  }

  // --- subject loading ---
  // Snapshot of the current view, captured before a monkey switch so the incoming subject restores
  // the exact same view (camera, overlays, settings) instead of resetting to defaults. Null on the
  // first-ever load. Goal: "keep the current view, just swap the data" so two monkeys compare 1:1.
  type ViewSnapshot = {
    volumeKey: string | null
    surfaceKind: string | null
    camera: { azimuth: number; elevation: number; scale: number; baseScale: number }
    crosshairMm: [number, number, number] | null
    dockedTab: 'atlas' | 'morphology' | 'function' | null
    // The overlay actually painted on the surface right now (at most one of atlas/function); plus the
    // "remembered" selections for tab toggling, restored best-effort.
    activeOverlay: 'atlas' | 'function' | null
    lastAtlasSel: AtlasSelection | null
    lastFuncChoice: FunctionChoice | null
    atlas: { opacity: number; colormap: string | null; hidden: Set<number> }
    func: { threshold: number; opacity: number; brightness: number; colormap: string | null; calMin: number; calMax: number; clipLo: number | null; clipHi: number | null }
    morph: {
      metric: MorphologyDisplayMetric
      style: CurvatureStyle
      ranges: Record<MorphologyMetric, { min: number; max: number }>
      colormaps: Partial<Record<MorphologyMetric, string>>
      clip: Record<MorphologyMetric, { lo: number | null; hi: number | null }>
    }
  }

  const MORPH_METRICS: MorphologyMetric[] = ['curvature', 'sulc', 'thickness']
  // Apply a snapshot's morphology shading state (or the defaults). Must run BEFORE applySurface, which
  // reads morphDisplay(). A restored metric whose shape is missing on the new subject falls back to
  // binary curvature (or 'none' if the subject has no curvature) so the surface still shades.
  const applyMorphSnapshot = (m: ViewSnapshot['morph'] | null, mf: Manifest): void => {
    for (const k of MORPH_METRICS) {
      morphRanges[k] = m ? { ...m.ranges[k] } : { ...MORPH_DEFAULT_RANGE[k] }
      morphColormaps[k] = m ? (m.colormaps[k] ?? MORPH_DEFAULT_COLORMAP[k]) : MORPH_DEFAULT_COLORMAP[k]
      morphClip[k] = m ? { ...m.clip[k] } : { lo: null, hi: null }
    }
    let metric: MorphologyDisplayMetric = m?.metric ?? 'curvature'
    if (metric !== 'none' && !mf.morphology?.shape?.[metric]) metric = mf.morphology?.shape?.curvature ? 'curvature' : 'none'
    morphMetric = metric
    morphStyle = m?.style ?? 'binary'
  }

  const loadSubject = async (sourceId: string, subjectId: string): Promise<void> => {
    const label = subjectId.replace(/^sub-/, '')
    showLoading(`Loading ${label}…`)
    // Capture the outgoing view before any state is overwritten, so it can be restored onto the new
    // subject. Only when a view already exists (the first load has nothing to preserve).
    const snap: ViewSnapshot | null =
      view && manifest
        ? {
            volumeKey: manifest.volumes[Number(volSelect.value)]?.key ?? null,
            surfaceKind: surfSelect.value || null,
            camera: view.getCamera(),
            crosshairMm: lastCrosshairMm,
            dockedTab,
            // lastAtlasSel (not atlasEntries.length) marks an active atlas: a continuous atlas has
            // no ROIs (atlasEntries === []) yet is still a painted overlay to restore. Matches colorTarget().
            activeOverlay: funcChoice ? 'function' : lastAtlasSel != null ? 'atlas' : null,
            lastAtlasSel,
            lastFuncChoice,
            atlas: { opacity: atlasOpacity, colormap: atlasColormap, hidden: new Set(atlasHidden) },
            func: { threshold: funcThreshold, opacity: funcOpacity, brightness: funcBrightness, colormap: funcColormap, calMin: funcCalMin, calMax: funcCalMax, clipLo: funcClipLo, clipHi: funcClipHi },
            morph: {
              metric: morphMetric,
              style: morphStyle,
              ranges: { curvature: { ...morphRanges.curvature }, sulc: { ...morphRanges.sulc }, thickness: { ...morphRanges.thickness } },
              colormaps: { ...morphColormaps },
              clip: { curvature: { ...morphClip.curvature }, sulc: { ...morphClip.sulc }, thickness: { ...morphClip.thickness } },
            },
          }
        : null
    try {
      manifest = (await files.getManifest(sourceId, subjectId)) as unknown as Manifest
      store.update({ sourceId, subjectId })

      // vol dropdown
      volSelect.innerHTML = ''
      manifest.volumes.forEach((v, i) => volSelect.append(h('option', { value: String(i) }, [v.label])))
      // Keep the same base volume across a switch when this subject has it; else default (norm.mgz).
      const snapVolIdx = snap?.volumeKey != null ? manifest.volumes.findIndex((v) => v.key === snap.volumeKey) : -1
      const volIdx = snapVolIdx >= 0 ? snapVolIdx : defaultVolumeIndex(manifest.volumes)
      volSelect.value = String(volIdx)

      // surf dropdown (only present surfaces)
      const available = SURFACE_ORDER.filter((k) => manifest!.surfaces[k])
      surfSelect.innerHTML = ''
      available.forEach((k) => surfSelect.append(h('option', { value: k }, [SURFACE_LABELS[k]])))
      // Keep the same surface type across a switch when this subject has it; else inflated / first.
      const surfDefault =
        snap?.surfaceKind && (available as string[]).includes(snap.surfaceKind)
          ? snap.surfaceKind
          : available.includes('inflated')
            ? 'inflated'
            : available[0]
      if (surfDefault) surfSelect.value = surfDefault

      // Decide morphology shading now — applySurface (below) builds the surface from morphDisplay().
      applyMorphSnapshot(snap?.morph ?? null, manifest)

      if (!view) {
        view = new MultiView(slicesCanvas, surfaceCanvas, client)
        // The panes get their final flex/grid size only after this dashboard lays out; NiiVue
        // sized its canvases against the pre-layout dimensions, leaving a first-paint artifact
        // that only cleared when the user resized the window (fullscreen toggle, devtools). Observe
        // the panes so the view re-fits the instant they get their real size, and on any later
        // layout change — self-correcting, no manual resize needed.
        const paneObserver = new ResizeObserver(() => view?.resize())
        paneObserver.observe(slicePane)
        paneObserver.observe(surfacePane)
        // Colormap registry + assets are subject-independent — build once from every map NiiVue
        // offers (brainana maps + built-ins), then mount the shared color-display section. The
        // synthetic entry (categorical restore) is only meaningful for the atlas target. It is
        // labelled "none" — a categorical atlas has no continuous colormap; its colors come from the
        // per-ROI label table (the ROI list above), so the picker reads "none" with a neutral swatch.
        const built = buildColormapRegistry(availableColormaps(view.slices))
        colormapInfos = [{ key: LABELS_KEY, label: 'none', group: 'Brainana' }, ...built]
        const assets = buildColormapAssets(view.slices, built.map((c) => c.key))
        colormapGradients = { ...assets.gradients, [LABELS_KEY]: 'linear-gradient(90deg, #6b6b6b, #6b6b6b)' }
        colormapLuts = assets.luts
        colorDisplay = createColorDisplay(colorDisplayCallbacks, colormapGradients, colormapInfos)
        colorDock.append(colorDisplay.element)
        marker = new Marker(view.render)
        // Orientation gizmo (R/L·A/P·S/I) is a permanent surface-pane widget, always shown.
        gizmo = new OrientationGizmo(surfacePane, view.render)
        gizmo.start()
        syncMarkerControls()
        view.onCrosshair((info) => {
          lastMm = info.mm
          lastCrosshairMm = info.mm
          // Map the crosshair to a reference-surface node, then pin it on the displayed surface.
          const node = view!.nearestNode(info.mm)
          if (node) {
            currentNode = node
            placeMarker()
          }
          const ijk = view!.baseVox(info.mm)
          const hemiNode = node ?? currentNode
          coordEditor.update(info.mm, ijk, hemiNode ? (hemiNode.hemi === 0 ? 'left' : 'right') : '—')
          updateAnatomyReport()
          updateFunctionReport()
          updateVisualField()
          updateSurfaceReport()
          updateOverlayValue()
        })
      }

      const baseVol = manifest.volumes[volIdx]
      if (baseVol) await view.setBaseVolume(baseVol.url, 1)
      syncVolumeControls() // seed the underlay rail (window/clip/zoom) from the loaded volume
      // Reference surface for node lookup (pial in world space; fall back to white).
      await view.setReference(manifest.surfaces.pial ?? manifest.surfaces.white)
      if (surfDefault) await applySurface(surfDefault)
      setActiveLayout(store.get('layout')) // sizes the surface pane before we auto-fit
      // Fresh load: frame the mesh to this pane. A snapshot restore instead reapplies the saved
      // camera further below, so it wins over the fit (Req 11).
      if (!snap && surfDefault) view.fitSurface()

      // (re)build the atlas panel for this subject, restoring the prior opacity onto the slider.
      atlasPanel?.element.remove()
      if (snap) atlasOpacity = snap.atlas.opacity
      atlasPanel = createAtlasPanel(
        manifest,
        {
          onSelect: (sel) => {
            lastAtlasSel = sel
            void selectAtlas(sel)
          },
          onOpacity: (v) => {
            atlasOpacity = v
            view!.setAtlasOpacity(v) // slices volume
            view!.setSurfaceOverlayOpacity(v) // surface layer
          },
        },
        { opacity: atlasOpacity },
      )
      sidePicker.append(atlasPanel.element)
      // Restore the remembered atlas (for tab toggling) only if this subject has one of the same name.
      lastAtlasSel = snap?.lastAtlasSel && manifest.atlases?.some((a) => a.name === snap.lastAtlasSel!.name) ? snap.lastAtlasSel : null
      if (snap?.activeOverlay === 'atlas' && lastAtlasSel) {
        await selectAtlas(lastAtlasSel) // selectAtlas sets colormap (magma for float atlases, else categorical), hidden→∅
        view!.setSurfaceOverlayOpacity(atlasOpacity)
        if (snap.atlas.colormap && snap.atlas.colormap !== atlasColormap) {
          atlasColormap = snap.atlas.colormap
          applyAtlasColormap() // re-apply the saved colormap override on vol + surf
        }
        if (snap.atlas.hidden.size) applyHidden(new Set(snap.atlas.hidden)) // restore hidden ROIs (also re-applies colormap)
        refreshColorDisplay()
      } else {
        await selectAtlas(null)
      }
      loadReportSpecs(manifest)

      // (re)build the function panel for this subject, restoring the prior opacity/brightness sliders.
      functionPanel?.element.remove()
      if (snap) {
        funcOpacity = snap.func.opacity
        funcBrightness = snap.func.brightness
      }
      functionPanel = createFunctionPanel(
        manifest,
        {
          onSelect: (choice) => {
            lastFuncChoice = choice
            void selectFunction(choice)
          },
          onThreshold: (v) => {
            funcThreshold = v
            applyFunctionColor() // re-mask both slices and surface at the new threshold
            updateFunctionReport()
            updateVisualField()
          },
          onOpacity: (v) => {
            funcOpacity = v
            view!.setFunctionalOpacity(v)
            void applyFunctionSurface() // opacity also drives the surface layer
          },
          onBrightness: (v) => {
            funcBrightness = v
            void applyFunctionSurface()
          },
        },
        { opacity: funcOpacity, brightness: funcBrightness },
      )
      sidePicker.append(functionPanel.element)
      // Restore the remembered function map if this subject has the same map kind; else clear. Pass the
      // snapshot settings THROUGH selectFunction (single surface pass) for an exact "carry over" match.
      lastFuncChoice = snap?.lastFuncChoice ? functionPanel.getChoice(choiceKey(snap.lastFuncChoice)) : null
      if (snap?.activeOverlay === 'function' && lastFuncChoice) {
        await selectFunction(lastFuncChoice, snap.func)
      } else {
        funcChoice = null
      }
      loadMorphology(manifest)

      // (re)build the morphology panel, reflecting the restored shading (set by applyMorphSnapshot).
      morphPanel?.element.remove()
      morphPanel = createMorphologyPanel(
        {
          onDisplay: (m) => {
            morphMetric = m
            view?.applyMorphologyDisplay(morphDisplay())
            refreshColorDisplay()
          },
          onCurvatureStyle: (s) => {
            morphStyle = s
            view?.applyMorphologyDisplay(morphDisplay())
            refreshColorDisplay()
          },
        },
        { metric: morphMetric, style: morphStyle },
      )
      sidePicker.append(morphPanel.element)
      refreshColorDisplay()

      // Restore the docked side tab (which picker is open); overlays were restored above.
      dockedTab = snap ? snap.dockedTab : null
      updateTabUI()

      // Restore the surface camera (zoom + orientation) and the crosshair coordinate, so the switch is
      // a pure data swap. Done last, after all mesh/volume loads that could otherwise reset the camera.
      if (snap) {
        view!.setCamera(snap.camera)
        if (snap.crosshairMm) view!.moveCrosshairToWorld(snap.crosshairMm)
      }

      main.classList.add('monkey-loaded')
      hideLoading()
    } catch (err) {
      showError(errorText(err))
    }
  }

  // --- monkey dropdown across all sources ---
  // Overlapping invocations (sources.subscribe fires immediately, the boot chain, and the
  // Dataset dialog all trigger this near-simultaneously) used to each clear + append a full
  // set, duplicating every monkey. Guard with a run token: build into a detached fragment and
  // only the newest run swaps it in; stale runs bail after each await.
  let monkeyRun = 0
  const repopulateMonkeys = async (): Promise<void> => {
    const run = ++monkeyRun
    const list = sources.list()
    const frag = document.createDocumentFragment()
    frag.append(h('option', { value: '' }, ['select monkey…']))
    for (const src of list) {
      let monkeys: MonkeySummary[] = []
      try {
        monkeys = await files.listMonkeys(src.id)
      } catch {
        continue
      }
      if (run !== monkeyRun) return // a newer run superseded this one
      const group = h('optgroup', { label: src.customLabel || src.label }) as HTMLOptGroupElement
      for (const m of monkeys) {
        const opt = h('option', { value: `${src.id}::${m.id}` }, [m.label]) as HTMLOptionElement
        group.append(opt)
      }
      frag.append(group)
    }
    if (run !== monkeyRun) return
    const prev = monkeySelect.value
    monkeySelect.innerHTML = ''
    monkeySelect.append(frag)
    if (prev && Array.from(monkeySelect.options).some((o) => o.value === prev)) monkeySelect.value = prev
  }
  monkeySelect.addEventListener('change', () => {
    const [sourceId, subjectId] = monkeySelect.value.split('::')
    if (sourceId && subjectId) void loadSubject(sourceId, subjectId)
  })

  datasetBtn.addEventListener('click', () =>
    mountSourcesDialog(deps, () => void repopulateMonkeys(), () => {
      // Guide the eye to the now-populated monkey picker after the Datasets dialog closes.
      monkeySelect.focus()
      monkeySelect.classList.add('pulse')
      setTimeout(() => monkeySelect.classList.remove('pulse'), 1200)
    }),
  )
  sources.subscribe(() => void repopulateMonkeys())

  // Arrow keys nudge the crosshair ±1.5 mm (Left/Right = x, Up/Down = superior/inferior).
  const NUDGE = 1.5
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
    const delta: Record<string, [number, number, number]> = {
      ArrowLeft: [-NUDGE, 0, 0],
      ArrowRight: [NUDGE, 0, 0],
      ArrowUp: [0, 0, NUDGE],
      ArrowDown: [0, 0, -NUDGE],
    }
    const d = delta[e.key]
    if (d && view) {
      e.preventDefault()
      view.nudgeCrosshair(d)
    }
  })

  // Drag the yellow marker on the surface to move the crosshair (Req 8). Listen in the CAPTURE
  // phase on the surface pane (the marker's parent) so a drag that starts on the marker is
  // intercepted before NiiVue's camera rotation; drags elsewhere fall through to rotate as usual.
  {
    let draggingMarker = false
    let rafPending = false
    let pending: { x: number; y: number } | null = null
    const HIT_PX = 26
    const nearMarker = (clientX: number, clientY: number): boolean => {
      if (!view || !currentNode || !paneState().surf) return false
      const world = view.nodeWorld(currentNode)
      if (!world) return false
      // The pin is DRAWN lifted outward along the surface normal (Marker.setWorld); grab-test that
      // same lifted centre, not the bare vertex, so the hit region tracks where the pin actually is.
      const normal = view.nodeWorldNormal(currentNode)
      const lift = marker?.liftAmount() ?? 0
      const target: [number, number, number] =
        normal && lift ? [world[0] + normal[0] * lift, world[1] + normal[1] * lift, world[2] + normal[2] * lift] : world
      const sp = view.projectToScreen(target, surfaceCanvas)
      if (!sp || !(sp.w > 0)) return false
      return Math.hypot(sp.x - clientX, sp.y - clientY) <= HIT_PX
    }
    const applyPick = (x: number, y: number): void => {
      if (!view) return
      // Constrain the drag to walk along mesh neighbours from the current vertex so it can't jump
      // across a thin cortical ribbon to the far wall. Fall back to the global pick only when there
      // is no current node yet (or no adjacency for its hemisphere).
      const node = (currentNode && view.walkNode(currentNode, x, y, surfaceCanvas)) || view.pickNodeAtScreen(x, y, surfaceCanvas)
      if (!node) return
      const refWorld = view.refNodeWorld(node)
      if (refWorld) {
        view.moveCrosshairToWorld(refWorld) // syncs slices + re-pins via onCrosshair
      } else {
        currentNode = node
        placeMarker()
      }
    }
    surfacePane.addEventListener(
      'pointerdown',
      (e) => {
        if (!nearMarker(e.clientX, e.clientY)) return
        draggingMarker = true
        surfacePane.setPointerCapture(e.pointerId)
        e.preventDefault()
        e.stopPropagation()
      },
      true,
    )
    surfacePane.addEventListener(
      'pointermove',
      (e) => {
        if (!draggingMarker) return
        e.preventDefault()
        e.stopPropagation()
        pending = { x: e.clientX, y: e.clientY }
        if (rafPending) return
        rafPending = true
        requestAnimationFrame(() => {
          rafPending = false
          if (pending) applyPick(pending.x, pending.y)
        })
      },
      true,
    )
    const endDrag = (e: PointerEvent): void => {
      if (!draggingMarker) return
      draggingMarker = false
      try {
        surfacePane.releasePointerCapture(e.pointerId)
      } catch {
        /* already released */
      }
    }
    surfacePane.addEventListener('pointerup', endDrag, true)
    surfacePane.addEventListener('pointercancel', endDrag, true)
  }

  window.addEventListener('resize', () => {
    view?.resize()
    updateVisualField()
  })

  // Boot: ensure sources are loaded, then populate.
  sources
    .refresh()
    .then(() => repopulateMonkeys())
    .catch((err) => showError(errorText(err)))
}
