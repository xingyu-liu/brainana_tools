// Dashboard shell (P1): the v1.2.25 single-screen layout — top bar, slice pane + surface
// pane, right atlas-legend column, bottom info grid. P1 wires the top bar (Monkey across all
// sources, vol/surf selectors, montage layout), the 2-instance MultiView, and base
// volume + surface loading. The right column, info grid, and panel buttons are placeholders
// filled by later phases.
import type { RuntimeClient } from '../../../core/client/runtimeClient.ts'
import type { SourceManager } from '../../../core/client/sourceManager.ts'
import type { FilesystemClient, MonkeySummary } from '../../../core/client/filesystemClient.ts'
import type { Manifest, SurfacePair } from '../types.ts'
import { MultiView, type SurfaceNode, type SurfacePairUrls, type MorphologyDisplay, type MorphologyDisplayMetric, type MorphologyMetric, type MorphologyShapePairs, type CurvatureStyle } from '../niivue/multiView.ts'
import { Marker } from '../niivue/marker.ts'
import { OrientationGizmo } from '../niivue/orientation.ts'
import { createViewerStore, type Layout } from '../state/store.ts'
import { parseAtlasTsv, buildLabelColortable, type AtlasLabel } from '../data/atlas.ts'
import { ARM_SEED, D99_SEED } from '../data/colors.ts'
import { finiteExtrema, createFunctionalSurfaceLut, quantizeFunctionalSurfaceValues, maskSurfaceBinsByF, type SurfaceFunctionMode } from '../data/functional.ts'
import { visualXY, visualFieldStats, ECC_MAX, type VfPoint } from '../data/visualField.ts'
import { parseGiftiFloat32 } from '../data/gifti.ts'
import { RoiLegend } from './roiLegend.ts'
import { createAtlasPanel, type AtlasPanel, type AtlasSelection } from './panels/atlas.ts'
import { createFunctionPanel, choiceKey, type FunctionPanel, type FunctionChoice } from './panels/function.ts'
import { createMorphologyPanel, type MorphologyPanel, type MarkerMode } from './panels/morphology.ts'
import { drawVisualField } from './visualFieldPlot.ts'
import { h, errorText } from './dom.ts'
import { mountSourcesDialog } from './dialogs/sources.ts'

interface Deps {
  client: RuntimeClient
  sources: SourceManager
  files: FilesystemClient
}

// 'veryinflated' is deliberately omitted: it has no real FreeSurfer source file (the server
// synthesizes it by puffing 'inflated'), so it isn't offered as a surface.
const SURFACE_ORDER = ['pial', 'white', 'smoothwm', 'inflated', 'sphere'] as const
const SURFACE_LABELS: Record<string, string> = {
  pial: 'Pial',
  white: 'White',
  smoothwm: 'SmoothWM',
  inflated: 'Inflated',
  sphere: 'Sphere',
}

// Build a <dl> of <dt>/<dd> label:value rows for the info panel.
function dlRows(pairs: Array<[string, string | Node]>): HTMLDListElement {
  const dl = h('dl')
  for (const [label, value] of pairs) dl.append(h('dt', {}, [label]), h('dd', {}, [value]))
  return dl
}
const LAYOUTS: Array<{ k: Layout; glyph: string; title: string }> = [
  { k: 'grid', glyph: '#', title: '2×2 grid (3 planes + surface)' },
  { k: 'row', glyph: '▬', title: 'Surface on top, planes in a row' },
  { k: 'column', glyph: '▮', title: 'Surface on top, planes in a column' },
]
const PANEL_BUTTONS = ['Atlases', 'Morphology', 'Function', 'Imported', 'Import', 'Export']
// Camera view presets shown in the surf row (Req 4). Lateral/Medial are hemisphere-aware.
const VIEW_PRESETS: Array<{ k: 'lateral' | 'medial' | 'ventral' | 'dorsal' | 'anterior' | 'posterior'; label: string }> = [
  { k: 'lateral', label: 'Lat' },
  { k: 'medial', label: 'Med' },
  { k: 'ventral', label: 'Vent' },
  { k: 'dorsal', label: 'Dor' },
  { k: 'anterior', label: 'Ant' },
  { k: 'posterior', label: 'Pos' },
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
  const monkeySelect = h('select', { id: 'monkey-select' }, [h('option', { value: '' }, ['Select monkey…'])])
  const datasetBtn = h('button', { type: 'button', class: 'ghost' }, ['Dataset'])
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
    ['1', '3', '5', '7'].map((n) => h('option', { value: n }, [`${n} × ${n} × ${n}`])),
  ) as HTMLSelectElement
  neighborhoodSelect.value = '3'

  const layoutBtns = LAYOUTS.map((l) => {
    const b = h('button', { type: 'button', class: 'layout-btn', title: l.title }, [l.glyph])
    b.dataset.layout = l.k
    return b
  })
  const enabledPanels = new Set(['Atlases', 'Morphology', 'Function', 'Reset views'])
  const panelBtns = PANEL_BUTTONS.map((name) => h('button', { type: 'button', class: 'panel-btn', disabled: !enabledPanels.has(name) }, [name]))
  const viewBtns = VIEW_PRESETS.map((v) => {
    const b = h('button', { type: 'button', class: 'view-btn', title: `${v.label} view` }, [v.label])
    b.dataset.view = v.k
    return b
  })

  // Two-row × four-column grid (fills column-by-column via grid-auto-flow: column).
  const toolbar = h('header', { class: 'toolbar' }, [
    // col 1: title (row 1) · version (row 2)
    h('div', { class: 'tb-cell brand' }, ['Brainana Viewer']),
    h('div', { class: 'tb-cell' }, [h('span', { class: 'badge' }, [`v${'0.1.0'}`])]),
    // col 2: Dataset (row 1) · Monkey (row 2)
    h('div', { class: 'tb-cell' }, [datasetBtn]),
    h('div', { class: 'tb-cell' }, [h('label', { class: 'tb-field' }, ['Monkey', monkeySelect])]),
    // col 3: vol + layout icons (row 1) · surf + LH/RH + view presets (row 2)
    h('div', { class: 'tb-cell' }, [h('label', { class: 'tb-field inline' }, [volCheck, h('span', {}, ['vol']), volSelect]), h('div', { class: 'montage' }, layoutBtns)]),
    h('div', { class: 'tb-cell' }, [
      h('label', { class: 'tb-field inline' }, [surfCheck, h('span', {}, ['surf']), surfSelect]),
      h('label', { class: 'tb-field inline' }, [lhCheck, h('span', {}, ['LH'])]),
      h('label', { class: 'tb-field inline' }, [rhCheck, h('span', {}, ['RH'])]),
      h('div', { class: 'views' }, viewBtns),
    ]),
    // col 4: Atlases/Morphology/Function (row 1) · Imported/Import/Export (row 2)
    h('div', { class: 'tb-cell panels' }, panelBtns.slice(0, 3)),
    h('div', { class: 'tb-cell panels' }, panelBtns.slice(3)),
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
  const atlasLegend = h('aside', { class: 'atlas-legend' }, [h('div', { class: 'legend-title muted' }, ['No visible atlas'])])
  const infoPanel = h('section', { class: 'info-panel' }, [
    h('div', { class: 'info-col' }, [h('h3', {}, ['Coordinates']), h('div', { id: 'report-coordinates', class: 'muted' }, ['—'])]),
    h('div', { class: 'info-col' }, [h('h3', {}, ['Anatomy']), h('div', { id: 'report-anatomy', class: 'muted' }, ['—'])]),
    h('div', { class: 'info-col' }, [h('h3', {}, ['Surface']), h('div', { id: 'report-surface', class: 'muted' }, ['—'])]),
    h('div', { class: 'info-col' }, [h('h3', {}, ['Function']), h('div', { id: 'report-function', class: 'muted' }, ['—'])]),
    h('div', { class: 'info-col' }, [
      h('h3', {}, ['Visual field']),
      h('label', { class: 'neighborhood-control' }, [h('span', {}, ['Neighborhood']), neighborhoodSelect]),
      h('canvas', { id: 'visual-field-canvas', class: 'vf-canvas' }),
      h('div', { id: 'report-visual-note', class: 'muted' }, ['Select a retinotopy map.']),
    ]),
  ])
  const placeholder = h('div', { class: 'monkey-placeholder' }, ['Select a monkey to begin.'])
  const loadingText = h('div', { class: 'loading-text' }, ['Loading…'])
  const loadingOverlay = h('div', { class: 'loading-overlay', hidden: true }, [h('div', { class: 'spinner' }), loadingText])
  const main = h('main', { class: 'dashboard' }, [viewerArea, atlasLegend, panelResizer, infoPanel, placeholder, loadingOverlay])

  root.append(toolbar, main)

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
  // Kept as a no-op shim so incidental progress calls (volume/atlas titles) no longer render a
  // status bar; meaningful loading/error states go through showLoading/showError explicitly.
  const setStatus = (_text: string): void => {}

  // --- state wiring ---
  let view: MultiView | null = null
  let marker: Marker | null = null
  let gizmo: OrientationGizmo | null = null
  let manifest: Manifest | null = null
  let currentNode: SurfaceNode | null = null
  let surfaceScaled = false // apply the per-surface zoom only once per subject (Req 11)

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
  const morphSymmetric: Record<MorphologyMetric, boolean> = { curvature: true, sulc: true, thickness: false }
  let markerMode: MarkerMode = 'nearestNode'
  let lastCrosshairMm: [number, number, number] | null = null
  const morphDisplay = (): MorphologyDisplay => ({ metric: morphMetric, curvatureStyle: morphStyle, ranges: morphRanges })

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
  const legend = new RoiLegend(atlasLegend, { onHiddenChange: (hidden) => applyHidden(hidden) })
  let atlasPanel: AtlasPanel | null = null
  let atlasEntries: AtlasLabel[] = []
  let atlasSeed = ARM_SEED
  let atlasOpacity = 0.7
  let atlasSurfacePair: { left: string; right: string } | null = null
  let atlasHidden = new Set<number>()

  function applyHidden(hidden: Set<number>): void {
    if (!view || atlasEntries.length === 0) return
    atlasHidden = hidden
    view.setAtlasColortable(buildLabelColortable(atlasEntries, { seed: atlasSeed, hidden })) // slices volume (keeps negatives)
    void view.updateSurfaceOverlayTable(buildLabelColortable(atlasEntries, { seed: atlasSeed, hidden, clipNegative: true })) // surface
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
    atlasPanel?.setActive(sel)
    if (!sel) {
      view.removeAtlas()
      legend.clear()
      atlasEntries = []
      atlasSurfacePair = null
      atlasHidden = new Set()
      await applyOverlay() // drop the atlas surface layer in place (no reload)
      setStatus(manifest.label)
      return
    }
    const entry = sel.atlas === 'D99' ? manifest.atlases.d99 : manifest.atlases.charm[String(sel.level)]
    if (!entry) return
    atlasSeed = sel.atlas === 'D99' ? D99_SEED : ARM_SEED
    const title = sel.atlas === 'D99' ? 'D99' : `ARM${sel.level}`
    setStatus(`${title}…`)
    try {
      atlasEntries = []
      if (entry.labels) {
        const tsv = await (await client.apiFetch(entry.labels)).text()
        atlasEntries = parseAtlasTsv(tsv)
      }
      await view.loadAtlasOverlay(entry.volume, atlasOpacity)
      if (token !== atlasToken) return // a newer selection superseded this one
      atlasHidden = new Set()
      if (atlasEntries.length) {
        view.setAtlasColortable(buildLabelColortable(atlasEntries, { seed: atlasSeed }))
        legend.setAtlas(title, atlasEntries, atlasSeed)
      } else {
        legend.clear()
      }
      // Color the surface with the precomputed atlas .func.gii (same golden-angle table).
      atlasSurfacePair = entry.surface ?? null
      await applyOverlay() // swap the overlay layer in place (no base-surface reload)
      setStatus(title)
    } catch (err) {
      setStatus(errorText(err))
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
    // Scale to fit only the first surface of a subject; switching surface type keeps the
    // current zoom/orientation (Req 11).
    if (!surfaceScaled) {
      view.setSurfaceScale(kind)
      surfaceScaled = true
    }
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
    setStatus(`loading ${vol.label}…`)
    try {
      await view.setBaseVolume(vol.url, paneState().vol ? 1 : 0)
      store.set('volumeKey', vol.key)
      setStatus(vol.label)
    } catch (err) {
      setStatus(errorText(err))
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

  const atlasBtn = panelBtns[PANEL_BUTTONS.indexOf('Atlases')]
  atlasBtn.addEventListener('click', () => {
    atlasPanel?.toggle()
    atlasBtn.classList.toggle('active', !atlasPanel?.element.hidden)
  })

  // --- function state (retinotopy / somatotopy) ---
  let functionPanel: FunctionPanel | null = null
  let funcChoice: FunctionChoice | null = null
  let funcThreshold = 0
  let funcOpacity = 0.85
  let funcBrightness = 1.25
  let funcToken = 0
  // Per-hemisphere parsed frames of the currently loaded function surface .func.gii, cached so a
  // threshold/brightness drag re-quantizes in place without re-fetching (keyed by choice.kind).
  let funcSurfaceFrames: { kind: string; left: Float32Array[]; right: Float32Array[] } | null = null

  // Map a function choice to the categorical surface-LUT mode.
  const surfaceModeFor = (choice: FunctionChoice): SurfaceFunctionMode =>
    choice.kind === 'somatotopy' ? 'somatotopy' : choice.mode.label === 'Eccentricity' ? 'eccentricity' : 'polar'

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
    const lut = createFunctionalSurfaceLut(mode, funcBrightness).lut
    const binsFor = (frames: Float32Array[]): Float32Array => {
      const value = frames[valueFrame] ?? new Float32Array(0)
      let bins = quantizeFunctionalSurfaceValues(value, mode)
      if (fFrame != null && frames[fFrame]) bins = maskSurfaceBinsByF(bins, frames[fFrame], funcThreshold)
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
      const dl = h('dl')
      const row = (label: string, value: string, id?: string): void => {
        dl.append(h('dt', {}, [label]), h('dd', id ? { id } : {}, [value]))
      }
      row('Polar angle', num(polar, ' rad'))
      row('Polar-angle F', num(view.sampleFunctionFrame(vox, f.polarF)))
      row('Eccentricity', num(ecc, '°'))
      row('Eccentricity F', num(view.sampleFunctionFrame(vox, f.eccentricityF)))
      row('Visual X', num(vx))
      row('Visual Y', num(vy))
      row('Valid voxels', '—', 'func-valid')
      row('Offset to median', '—', 'func-offset')
      row('Local spread', '—', 'func-spread')
      el.append(h('h3', { class: 'func-subheading' }, ['Retinotopy']), dl)
    } else {
      const fstat = view.sampleFunctionFrame(vox, f.fstat)
      el.append(
        h('h3', { class: 'func-subheading' }, ['Somatotopy']),
        dlRows([
          ['Body position', num(view.sampleFunctionFrame(vox, f.phase))],
          ['Somatotopy F', num(fstat)],
          ['Status', fstat >= funcThreshold ? 'Passes threshold' : 'Below threshold'],
        ]),
      )
    }
  }

  const updateVisualField = (): void => {
    const canvas = document.getElementById('visual-field-canvas') as HTMLCanvasElement | null
    const note = document.getElementById('report-visual-note')
    if (!canvas || !view || !manifest) return
    if (funcChoice?.kind !== 'retinotopy') {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
      if (note) note.textContent = 'Select a retinotopy map.'
      return
    }
    const vox = view.functionCrosshairVox()
    const dims = view.functionDims()
    const f = manifest.function.retinotopy!.frames
    if (!vox || !dims) return
    const s = Math.floor(Number(neighborhoodSelect.value) / 2)
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
    setDd('func-offset', points.length && stats.offset != null ? `${stats.offset.toFixed(2)}°` : 'N/A')
    setDd('func-spread', points.length ? `${stats.spread.toFixed(2)}°` : 'N/A')
    if (note) note.textContent = points.length ? `${points.length} valid · spread ${stats.spread.toFixed(2)}°${stats.offset != null ? ` · offset ${stats.offset.toFixed(2)}°` : ''}` : 'No valid retinotopic voxel here.'
  }

  const applyFunctionNow = (): void => {
    if (view && funcChoice) view.applyFunctional(funcChoice.mode.valueFrame, funcChoice.mode.fFrame, funcThreshold, funcChoice.mode.colormap, funcOpacity, funcChoice.mode.calMin, funcChoice.mode.calMax)
  }

  const selectFunction = async (choice: FunctionChoice | null): Promise<void> => {
    if (!view || !manifest) return
    const token = ++funcToken
    funcChoice = choice
    funcSurfaceFrames = null // invalidate the cached surface frames for the previous choice
    functionPanel?.setActive(choice ? choiceKey(choice) : null)
    if (!choice) {
      view.removeFunctional()
      view.clearSurfaceFunctionLayers()
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
        funcThreshold = Math.min(Math.max(min, 5), max) // default F ≥ 5, clamped
        functionPanel?.setThresholdBounds(min, max, funcThreshold)
      } else {
        funcThreshold = 0
        functionPanel?.setThresholdBounds(0, 0, 0)
      }
      applyFunctionNow()
      void applyFunctionSurface()
      updateFunctionReport()
      updateVisualField()
    } catch (err) {
      showError(errorText(err))
    }
  }

  neighborhoodSelect.addEventListener('change', updateVisualField)

  // --- surface report (morphology at the crosshair vertex) ---
  let lastMm: [number, number, number] | null = null
  const morphShape: { curvature?: [Float32Array, Float32Array]; sulc?: [Float32Array, Float32Array]; thickness?: [Float32Array, Float32Array] } = {}

  // Push the active metric's colour range into the morphology panel. The range group is hidden
  // for None and for binary curvature (forced ±1).
  const syncMorphRange = (): void => {
    const metric: MorphologyMetric = morphMetric === 'none' ? 'curvature' : morphMetric
    const hidden = morphMetric === 'none' || (morphMetric === 'curvature' && morphStyle === 'binary')
    morphPanel?.setRange({ domainMin: MORPH_DOMAIN[metric].min, domainMax: MORPH_DOMAIN[metric].max, min: morphRanges[metric].min, max: morphRanges[metric].max, metric, hidden, symmetric: morphSymmetric[metric] })
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
      ['Geometry', SURFACE_LABELS[surfSelect.value] ?? surfSelect.value],
      ['Hemisphere', node.hemi === 0 ? 'Left' : 'Right'],
      ['Nearest vertex', String(node.index)],
      ['Distance', Number.isFinite(dist) ? `${dist.toFixed(2)} mm` : '—'],
      ['Curvature', num(sample('curvature'))],
      ['Sulcal depth', num(sample('sulc'))],
      ['Thickness', num(sample('thickness'), ' mm')],
    ]
    el.innerHTML = ''
    el.append(dlRows(rows))
  }

  const functionBtn = panelBtns[PANEL_BUTTONS.indexOf('Function')]
  functionBtn.addEventListener('click', () => {
    functionPanel?.toggle()
    functionBtn.classList.toggle('active', !functionPanel?.element.hidden)
  })

  const morphBtn = panelBtns[PANEL_BUTTONS.indexOf('Morphology')]
  morphBtn.addEventListener('click', () => {
    morphPanel?.toggle()
    morphBtn.classList.toggle('active', !morphPanel?.element.hidden)
  })

  // Anatomy report: all ARM levels + D99 at the crosshair (sampled from report-only volumes).
  let reportSpecs: Array<{ key: string; label: string; byId: Map<number, AtlasLabel> }> = []

  const updateAnatomyReport = (): void => {
    const el = document.getElementById('report-anatomy')
    if (!el || !view) return
    if (reportSpecs.length === 0) {
      el.textContent = '—'
      return
    }
    el.innerHTML = ''
    for (const spec of reportSpecs) {
      const id = view.sampleReportVolume(spec.key)
      const label = id != null && id !== 0 ? spec.byId.get(id) : null
      const isUnknown = !label && id != null && id !== 0 // id present but no region name resolves
      const name = label ? label.name.replace(/_/g, ' ') : isUnknown ? '(unlabeled)' : ''
      el.append(
        h('div', { class: 'atlas-report-row' }, [
          h('span', { class: 'atlas-report-name' }, [spec.label]),
          h('span', { class: 'atlas-report-id' }, [id != null && id !== 0 ? String(id) : '']),
          h('span', { class: `atlas-report-label${isUnknown ? ' unknown' : ''}` }, [name]),
        ]),
      )
    }
  }

  const loadReportSpecs = (m: Manifest): void => {
    if (!view) return
    view.clearReportVolumes()
    const specEntries: Array<{ key: string; label: string; entry: { volume: string; labels: string | null } }> = []
    for (let i = 1; i <= 6; i++) {
      const e = m.atlases.charm[String(i)]
      if (e) specEntries.push({ key: `ARM${i}`, label: `ARM${i}`, entry: e })
    }
    if (m.atlases.d99) specEntries.push({ key: 'D99', label: 'D99', entry: m.atlases.d99 })
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
  const loadSubject = async (sourceId: string, subjectId: string): Promise<void> => {
    const label = subjectId.replace(/^sub-/, '')
    showLoading(`Loading ${label}…`)
    surfaceScaled = false // re-fit the surface once for the new subject (Req 11)
    try {
      manifest = (await files.getManifest(sourceId, subjectId)) as unknown as Manifest
      store.update({ sourceId, subjectId })

      // vol dropdown
      volSelect.innerHTML = ''
      manifest.volumes.forEach((v, i) => volSelect.append(h('option', { value: String(i) }, [v.label])))
      const volIdx = defaultVolumeIndex(manifest.volumes)
      volSelect.value = String(volIdx)

      // surf dropdown (only present surfaces)
      const available = SURFACE_ORDER.filter((k) => manifest!.surfaces[k])
      surfSelect.innerHTML = ''
      available.forEach((k) => surfSelect.append(h('option', { value: k }, [SURFACE_LABELS[k]])))
      const surfDefault = available.includes('inflated') ? 'inflated' : available[0]
      if (surfDefault) surfSelect.value = surfDefault

      if (!view) {
        view = new MultiView(slicesCanvas, surfaceCanvas, client)
        marker = new Marker(view.render)
        gizmo = new OrientationGizmo(surfacePane, view.render)
        gizmo.start()
        view.onCrosshair((info) => {
          lastMm = info.mm
          lastCrosshairMm = info.mm
          // Map the crosshair to a reference-surface node, then pin it on the displayed surface.
          const node = view!.nearestNode(info.mm)
          if (node) {
            currentNode = node
            placeMarker()
          }
          const el = document.getElementById('report-coordinates')
          if (el) {
            const [x, y, z] = info.mm
            const ijk = view!.baseVox(info.mm)
            const hemiNode = node ?? currentNode
            el.innerHTML = ''
            el.append(
              dlRows([
                ['XYZ (mm)', `${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}`],
                ['IJK', ijk ? ijk.join(', ') : '—'],
                ['Hemisphere', hemiNode ? (hemiNode.hemi === 0 ? 'Left' : 'Right') : '—'],
              ]),
            )
          }
          updateAnatomyReport()
          updateFunctionReport()
          updateVisualField()
          updateSurfaceReport()
        })
      }

      const baseVol = manifest.volumes[volIdx]
      if (baseVol) await view.setBaseVolume(baseVol.url, 1)
      // Reference surface for node lookup (pial in world space; fall back to white).
      await view.setReference(manifest.surfaces.pial ?? manifest.surfaces.white)
      if (surfDefault) await applySurface(surfDefault)
      setActiveLayout(store.get('layout'))

      // (re)build the atlas panel for this subject; start with no atlas visible.
      atlasPanel?.element.remove()
      atlasPanel = createAtlasPanel(manifest, {
        onSelect: (sel) => void selectAtlas(sel),
        onOpacity: (v) => {
          atlasOpacity = v
          view!.setAtlasOpacity(v) // slices volume
          view!.setSurfaceOverlayOpacity(v) // surface layer
        },
      })
      main.append(atlasPanel.element)
      await selectAtlas(null)
      loadReportSpecs(manifest)

      // (re)build the function panel for this subject.
      functionPanel?.element.remove()
      functionPanel = createFunctionPanel(manifest, {
        onSelect: (choice) => void selectFunction(choice),
        onThreshold: (v) => {
          funcThreshold = v
          applyFunctionNow()
          void applyFunctionSurface() // re-mask the surface at the new threshold
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
      })
      main.append(functionPanel.element)
      funcChoice = null
      loadMorphology(manifest)

      // (re)build the morphology panel for this subject; reset to the default (binary curvature).
      morphPanel?.element.remove()
      morphMetric = 'curvature'
      morphStyle = 'binary'
      markerMode = 'nearestNode'
      morphRanges.curvature = { ...MORPH_DEFAULT_RANGE.curvature }
      morphRanges.sulc = { ...MORPH_DEFAULT_RANGE.sulc }
      morphRanges.thickness = { ...MORPH_DEFAULT_RANGE.thickness }
      morphPanel = createMorphologyPanel({
        onDisplay: (m) => {
          morphMetric = m
          view?.applyMorphologyDisplay(morphDisplay())
          syncMorphRange()
        },
        onCurvatureStyle: (s) => {
          morphStyle = s
          view?.applyMorphologyDisplay(morphDisplay())
          syncMorphRange()
        },
        onMarkerMode: (mode) => {
          markerMode = mode
          placeMarker()
        },
        onRange: (min, max) => {
          const metric = morphMetric === 'none' ? 'curvature' : morphMetric
          morphRanges[metric] = { min, max }
          view?.applyMorphologyDisplay(morphDisplay())
        },
        onSymmetric: (on) => {
          const metric = morphMetric === 'none' ? 'curvature' : morphMetric
          morphSymmetric[metric] = on
        },
        onAuto: () => {
          const metric = morphMetric === 'none' ? 'curvature' : morphMetric
          morphRanges[metric] = autoMorphRange(metric)
          view?.applyMorphologyDisplay(morphDisplay())
          syncMorphRange()
        },
      })
      main.append(morphPanel.element)
      syncMorphRange()

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
    frag.append(h('option', { value: '' }, ['Select monkey…']))
    for (const src of list) {
      let monkeys: MonkeySummary[] = []
      try {
        monkeys = await files.listMonkeys(src.id)
      } catch {
        continue
      }
      if (run !== monkeyRun) return // a newer run superseded this one
      const group = h('optgroup', { label: src.label }) as HTMLOptGroupElement
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

  datasetBtn.addEventListener('click', () => mountSourcesDialog(deps, () => void repopulateMonkeys()))
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
      const sp = view.projectToScreen(world, surfaceCanvas)
      if (!sp || !(sp.w > 0)) return false
      return Math.hypot(sp.x - clientX, sp.y - clientY) <= HIT_PX
    }
    const applyPick = (x: number, y: number): void => {
      if (!view) return
      const node = view.pickNodeAtScreen(x, y, surfaceCanvas)
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

  window.addEventListener('resize', () => view?.resize())

  // Boot: ensure sources are loaded, then populate.
  sources
    .refresh()
    .then(() => repopulateMonkeys())
    .catch((err) => showError(errorText(err)))
}
