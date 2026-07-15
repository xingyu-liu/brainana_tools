// Dashboard shell (P1): the v1.2.25 single-screen layout — top bar, slice pane + surface
// pane, right atlas-legend column, bottom info grid. P1 wires the top bar (Monkey across all
// sources, vol/surf selectors, montage layout), the 2-instance MultiView, and base
// volume + surface loading. The right column, info grid, and panel buttons are placeholders
// filled by later phases.
import type { RuntimeClient } from '../../../core/client/runtimeClient.ts'
import type { SourceManager } from '../../../core/client/sourceManager.ts'
import type { FilesystemClient, MonkeySummary } from '../../../core/client/filesystemClient.ts'
import type { Manifest, SurfacePair } from '../types.ts'
import { MultiView, type SurfaceNode } from '../niivue/multiView.ts'
import { Marker } from '../niivue/marker.ts'
import { OrientationGizmo } from '../niivue/orientation.ts'
import { createViewerStore, type Layout } from '../state/store.ts'
import { parseAtlasTsv, buildLabelColortable, type AtlasLabel } from '../data/atlas.ts'
import { ARM_SEED, D99_SEED } from '../data/colors.ts'
import { RoiLegend } from './roiLegend.ts'
import { createAtlasPanel, type AtlasPanel, type AtlasSelection } from './panels/atlas.ts'
import { h, errorText } from './dom.ts'
import { mountSourcesDialog } from './dialogs/sources.ts'

interface Deps {
  client: RuntimeClient
  sources: SourceManager
  files: FilesystemClient
}

const SURFACE_ORDER = ['pial', 'white', 'smoothwm', 'inflated', 'veryinflated', 'sphere'] as const
const SURFACE_LABELS: Record<string, string> = {
  pial: 'Pial',
  white: 'White',
  smoothwm: 'SmoothWM',
  inflated: 'Inflated',
  veryinflated: 'Very inflated',
  sphere: 'Sphere',
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

function curvatureFor(manifest: Manifest): SurfacePair | null {
  const s = manifest.morphology?.shape?.curvature
  if (s?.left && s?.right) return s
  const r = manifest.morphology?.raw?.curvature
  return r?.left && r?.right ? r : null
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
  const volSelect = h('select', { title: 'Base volume (FreeSurfer mri/)' })
  const surfCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  surfCheck.checked = true
  const surfSelect = h('select', { title: 'Cortical surface' })
  const opacity = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '1', title: 'Volume opacity', class: 'vol-opacity' }) as HTMLInputElement
  const lhCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  lhCheck.checked = true
  const rhCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  rhCheck.checked = true

  const layoutBtns = LAYOUTS.map((l) => {
    const b = h('button', { type: 'button', class: 'layout-btn', title: l.title }, [l.glyph])
    b.dataset.layout = l.k
    return b
  })
  const enabledPanels = new Set(['Atlases'])
  const panelBtns = PANEL_BUTTONS.map((name) => h('button', { type: 'button', class: 'panel-btn', disabled: !enabledPanels.has(name) }, [name]))
  const viewBtns = VIEW_PRESETS.map((v) => {
    const b = h('button', { type: 'button', class: 'view-btn', title: `${v.label} view` }, [v.label])
    b.dataset.view = v.k
    return b
  })

  const volRow = h('div', { class: 'tb-row' }, [
    h('label', { class: 'tb-field inline layer' }, [volCheck, h('span', { class: 'layer-label' }, ['vol']), volSelect]),
    opacity,
    datasetBtn,
    h('div', { class: 'montage' }, layoutBtns),
    h('div', { class: 'panels' }, panelBtns),
  ])
  const surfRow = h('div', { class: 'tb-row' }, [
    h('label', { class: 'tb-field inline layer' }, [surfCheck, h('span', { class: 'layer-label' }, ['surf']), surfSelect]),
    h('label', { class: 'tb-field inline' }, [lhCheck, h('span', {}, ['LH'])]),
    h('label', { class: 'tb-field inline' }, [rhCheck, h('span', {}, ['RH'])]),
    h('div', { class: 'views' }, viewBtns),
    h('label', { class: 'tb-field' }, ['Monkey', monkeySelect]),
  ])
  const toolbar = h('header', { class: 'toolbar' }, [
    h('div', { class: 'brand' }, ['Brainana Viewer', h('span', { class: 'badge' }, [`v${'0.1.0'}`])]),
    h('div', { class: 'tb-rows' }, [volRow, surfRow]),
  ])

  // --- main grid ---
  const slicesCanvas = h('canvas', { id: 'slices', class: 'nv-canvas' }) as HTMLCanvasElement
  const surfaceCanvas = h('canvas', { id: 'surface', class: 'nv-canvas' }) as HTMLCanvasElement
  const slicePane = h('div', { class: 'slice-pane' }, [slicesCanvas])
  const surfacePane = h('div', { class: 'surface-pane' }, [surfaceCanvas])
  const viewerArea = h('div', { class: 'viewer-area' }, [slicePane, surfacePane])
  const legendResizer = h('div', { class: 'legend-resizer', title: 'Drag to resize the panel' })
  const atlasLegend = h('aside', { class: 'atlas-legend' }, [legendResizer, h('div', { class: 'legend-title muted' }, ['No visible atlas'])])
  const infoPanel = h('section', { class: 'info-panel' }, [
    h('div', { class: 'info-col' }, [h('h3', {}, ['Coordinates']), h('div', { id: 'report-coordinates', class: 'muted' }, ['—'])]),
    h('div', { class: 'info-col' }, [h('h3', {}, ['Anatomy']), h('div', { id: 'report-anatomy', class: 'muted' }, ['—'])]),
    h('div', { class: 'info-col' }, [h('h3', {}, ['Surface']), h('div', { id: 'report-surface', class: 'muted' }, ['—'])]),
    h('div', { class: 'info-col' }, [h('h3', {}, ['Function']), h('div', { id: 'report-function', class: 'muted' }, ['—'])]),
    h('div', { class: 'info-col' }, [h('h3', {}, ['Visual field']), h('div', { id: 'report-visual', class: 'muted' }, ['—'])]),
  ])
  const placeholder = h('div', { class: 'monkey-placeholder' }, ['Select a monkey to begin.'])
  const loadingText = h('div', { class: 'loading-text' }, ['Loading…'])
  const loadingOverlay = h('div', { class: 'loading-overlay', hidden: true }, [h('div', { class: 'spinner' }), loadingText])
  const main = h('main', { class: 'dashboard' }, [viewerArea, atlasLegend, infoPanel, placeholder, loadingOverlay])

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
    legendResizer.addEventListener('pointerdown', (e) => {
      dragging = true
      legendResizer.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    legendResizer.addEventListener('pointermove', (e) => {
      if (dragging) setWidth(e.clientX)
    })
    const end = (e: PointerEvent): void => {
      if (!dragging) return
      dragging = false
      try {
        legendResizer.releasePointerCapture(e.pointerId)
      } catch {
        /* pointer already released */
      }
    }
    legendResizer.addEventListener('pointerup', end)
    legendResizer.addEventListener('pointercancel', end)
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

  // Hemisphere shown = surf checkbox AND that hemisphere's LH/RH checkbox.
  const applyHemiVisibility = (): void => {
    if (!view) return
    view.setHemisphereVisible(0, surfCheck.checked && lhCheck.checked)
    view.setHemisphereVisible(1, surfCheck.checked && rhCheck.checked)
  }
  // Which hemisphere Lat/Med orient to: left when LH is on, else right.
  const preferHemi = (): 0 | 1 => (lhCheck.checked ? 0 : 1)

  const placeMarker = (): void => {
    if (!view || !currentNode) return
    if (!surfCheck.checked) {
      marker?.setWorld(null) // no marker while the surface is hidden (Req 6)
      return
    }
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
      await applySurface(surfSelect.value) // drop the atlas surface layer
      setStatus(manifest.label)
      return
    }
    const entry = sel.atlas === 'D99' ? manifest.atlases.d99 : manifest.atlases.charm[String(sel.level)]
    if (!entry) return
    atlasSeed = sel.atlas === 'D99' ? D99_SEED : ARM_SEED
    const title = sel.atlas === 'D99' ? 'D99' : `ARM Level ${sel.level}`
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
      await applySurface(surfSelect.value)
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
    const overlay =
      atlasSurfacePair && atlasEntries.length
        ? { left: atlasSurfacePair.left, right: atlasSurfacePair.right, table: buildLabelColortable(atlasEntries, { seed: atlasSeed, hidden: atlasHidden, clipNegative: true }) }
        : null
    await view.setSurface(pair, curvatureFor(manifest), overlay)
    // Scale to fit only the first surface of a subject; switching surface type keeps the
    // current zoom/orientation (Req 11).
    if (!surfaceScaled) {
      view.setSurfaceScale(kind)
      surfaceScaled = true
    }
    applyHemiVisibility()
    placeMarker() // re-place the pin at the same node on the new surface geometry
  }

  volCheck.addEventListener('change', () => view?.setVolumeOpacity(volCheck.checked ? Number(opacity.value) : 0))
  opacity.addEventListener('input', () => {
    if (volCheck.checked) view?.setVolumeOpacity(Number(opacity.value))
  })
  volSelect.addEventListener('change', async () => {
    if (!view || !manifest) return
    const vol = manifest.volumes[Number(volSelect.value)]
    if (!vol) return
    setStatus(`loading ${vol.label}…`)
    try {
      await view.setBaseVolume(vol.url, volCheck.checked ? Number(opacity.value) : 0)
      store.set('volumeKey', vol.key)
      setStatus(vol.label)
    } catch (err) {
      setStatus(errorText(err))
    }
  })
  surfSelect.addEventListener('change', () => {
    store.set('surfaceKind', surfSelect.value)
    void applySurface(surfSelect.value)
  })
  surfCheck.addEventListener('change', () => {
    applyHemiVisibility()
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
      const name = label ? label.name.replace(/_/g, ' ') : id ? '(unlabeled)' : ''
      el.append(
        h('div', { class: 'report-row' }, [
          h('span', { class: 'report-name' }, [spec.label]),
          h('span', { class: 'report-id' }, [id != null && id !== 0 ? String(id) : '']),
          h('span', { class: 'report-label' }, [name]),
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
      if (e) specEntries.push({ key: `ARM${i}`, label: `ARM L${i}`, entry: e })
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
          const [x, y, z] = info.mm
          const el = document.getElementById('report-coordinates')
          if (el) el.textContent = `XYZ ${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)} mm`
          // Map the crosshair to a reference-surface node, then pin it on the displayed surface.
          const node = view!.nearestNode(info.mm)
          if (node) {
            currentNode = node
            placeMarker()
          }
          updateAnatomyReport()
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
      if (!view || !currentNode || !surfCheck.checked) return false
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
