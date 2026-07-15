// Two NiiVue instances (audit decision): one MULTIPLANAR for the slice montage, one RENDER
// for the surface + marker. Crosshair is coupled with NiiVue's native broadcastTo({crosshair})
// (independent cameras). The base volume is loaded once and cloned into both instances.
import { Niivue, NVImage, NVMesh, SLICE_TYPE, MULTIPLANAR_TYPE, SHOW_RENDER, NVMeshLayerDefaults } from '@niivue/niivue'
import type { RuntimeClient } from '../../../core/client/runtimeClient.ts'
import type { Layout } from '../state/store.ts'
import { registerColormaps } from './colormaps.ts'

// Per-surface render zoom so different geometries fill the pane consistently (v1.2.25 f_).
const SURFACE_SCALE: Record<string, number> = { pial: 2.15, white: 2.15, smoothwm: 2.15, inflated: 1.45, veryinflated: 1.35, sphere: 1.25 }

export interface SurfacePairUrls {
  left: string
  right: string
}

export interface LabelColortable {
  R: number[]
  G: number[]
  B: number[]
  A: number[]
  I: number[]
  labels: string[]
}

// Precomputed surface atlas/function layer (per-hemisphere .func.gii) + its colortable.
export interface SurfaceOverlay {
  left: string
  right: string
  table: LabelColortable
}

export type MorphologyMetric = 'curvature' | 'sulc' | 'thickness'
export type MorphologyDisplayMetric = MorphologyMetric | 'none'
export type CurvatureStyle = 'binary' | 'continuous'

// The three per-hemisphere morphology shading sources (.shape.gii pairs). Any may be absent.
export interface MorphologyShapePairs {
  curvature?: SurfacePairUrls
  sulc?: SurfacePairUrls
  thickness?: SurfacePairUrls
}

export interface MorphologyDisplay {
  metric: MorphologyDisplayMetric
  curvatureStyle: CurvatureStyle
  ranges: Record<MorphologyMetric, { min: number; max: number }>
}

export interface CrosshairInfo {
  mm: [number, number, number]
}

export interface SurfaceNode {
  hemi: 0 | 1
  index: number
}

function niivue(): Niivue {
  return new Niivue({ backColor: [0, 0, 0, 1], show3Dcrosshair: false, isColorbar: false, dragAndDropEnabled: false })
}

export class MultiView {
  readonly slices: Niivue
  readonly render: Niivue
  #client: RuntimeClient
  #baseVol: NVImage | null = null
  #atlasVol: NVImage | null = null
  #displayMeshes: NVMesh[] = [] // [left, right] currently displayed surface (render instance)
  #refMeshes: NVMesh[] = [] // [left, right] reference surface in WORLD space (not displayed)
  #crosshairCb: ((info: CrosshairInfo) => void) | null = null
  #syncing = false

  constructor(slicesCanvas: HTMLCanvasElement, renderCanvas: HTMLCanvasElement, client: RuntimeClient) {
    this.#client = client
    this.slices = niivue()
    this.render = niivue()
    this.slices.attachToCanvas(slicesCanvas)
    this.render.attachToCanvas(renderCanvas)
    this.slices.setSliceType(SLICE_TYPE.MULTIPLANAR)
    // The surface lives in its own RENDER instance; keep the slice montage to pure planes.
    this.slices.opts.multiplanarShowRender = SHOW_RENDER.NEVER
    this.render.setSliceType(SLICE_TYPE.RENDER)
    this.render.opts.isOrientCube = false
    // Never draw NiiVue's on-canvas mesh legend (hundreds of ARM labels = far too busy).
    this.render.opts.showLegend = false
    this.slices.opts.showLegend = false
    registerColormaps(this.slices)
    registerColormaps(this.render)

    // Manual crosshair coupling (Align pattern): each instance mirrors the world coord to the
    // other via mm2frac; a suppress flag cleared on the next rAF prevents feedback loops.
    this.slices.onLocationChange = (d: unknown) => this.#handleLoc(this.slices, this.render, d)
    this.render.onLocationChange = (d: unknown) => this.#handleLoc(this.render, this.slices, d)
  }

  #handleLoc(_source: Niivue, target: Niivue, data: unknown): void {
    const mm = (data as { mm?: number[] })?.mm
    if (!mm || mm.length < 3) return
    const v3: [number, number, number] = [mm[0], mm[1], mm[2]]
    if (!this.#syncing) {
      this.#syncing = true
      try {
        target.scene.crosshairPos = target.mm2frac(v3)
        target.drawScene()
      } catch {
        // target may have no volume yet
      }
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16)
      raf(() => {
        this.#syncing = false
      })
    }
    this.#crosshairCb?.({ mm: v3 })
  }

  onCrosshair(cb: (info: CrosshairInfo) => void): void {
    this.#crosshairCb = cb
  }

  // Load (or switch) the base volume. The volume lives ONLY in the slices instance — the
  // surface pane shows the cortical surface + marker, never 3D volume slices.
  async setBaseVolume(url: string, opacity = 1): Promise<void> {
    const img = await NVImage.loadFromUrl({ url: this.#client.dataUrl(url), colormap: 'gray', opacity })
    if (this.#baseVol) this.slices.removeVolume(this.#baseVol)
    this.slices.addVolume(img)
    this.slices.setVolume(img, 0)
    this.#baseVol = img
  }

  setVolumeOpacity(opacity: number): void {
    if (this.#baseVol) this.slices.setOpacity(this.slices.getVolumeIndexByID(this.#baseVol.id), opacity)
  }

  // ---- atlas volume overlay (colored label map on the slices) ----
  async loadAtlasOverlay(url: string, opacity: number): Promise<void> {
    const vol = await NVImage.loadFromUrl({ url: this.#client.dataUrl(url), opacity })
    vol.trustCalMinMax = false
    if (this.#atlasVol) this.slices.removeVolume(this.#atlasVol)
    this.slices.addVolume(vol)
    this.#atlasVol = vol
  }

  setAtlasColortable(table: { R: number[]; G: number[]; B: number[]; A: number[]; I: number[]; labels: string[] }): void {
    if (!this.#atlasVol) return
    this.#atlasVol.setColormapLabel(table)
    this.slices.updateGLVolume()
  }

  setAtlasOpacity(opacity: number): void {
    if (this.#atlasVol) this.slices.setOpacity(this.slices.getVolumeIndexByID(this.#atlasVol.id), opacity)
  }

  removeAtlas(): void {
    if (this.#atlasVol) {
      this.slices.removeVolume(this.#atlasVol)
      this.#atlasVol = null
    }
  }

  // ---- functional overlay (retinotopy/somatotopy 4D volume with F-threshold masking) ----
  #funcVol: NVImage | null = null
  #funcMeta: { frameSize: number; frames: number; slope: number; inter: number; originals: Map<number, Float32Array> } | null = null
  #funcSampler: NVImage | null = null // unmasked copy for the report + visual field

  async loadFunctional(url: string, colormap: string, opacity: number): Promise<number> {
    if (this.#funcVol) this.slices.removeVolume(this.#funcVol)
    const vol = await this.slices.addVolumeFromUrl({ url: this.#client.dataUrl(url), colormap, opacity })
    vol.trustCalMinMax = false
    this.#funcVol = vol
    const dims = vol.hdr?.dims ?? []
    const frameSize = (dims[1] || 1) * (dims[2] || 1) * (dims[3] || 1)
    const frames = dims[4] && dims[4] > 1 ? dims[4] : 1
    const slope = vol.hdr?.scl_slope && vol.hdr.scl_slope !== 0 ? vol.hdr.scl_slope : 1
    const inter = vol.hdr?.scl_inter ?? 0
    this.#funcMeta = { frameSize, frames, slope, inter, originals: new Map() }
    // A separate unmasked copy for crosshair sampling (report / visual field).
    this.#funcSampler = await NVImage.loadFromUrl({ url: this.#client.dataUrl(url) })
    return frames
  }

  removeFunctional(): void {
    if (this.#funcVol) this.slices.removeVolume(this.#funcVol)
    this.#funcVol = null
    this.#funcMeta = null
    this.#funcSampler = null
  }

  setFunctionalOpacity(opacity: number): void {
    if (this.#funcVol) this.slices.setOpacity(this.slices.getVolumeIndexByID(this.#funcVol.id), opacity)
  }

  // Scaled voxel values of one 4D frame (copy) — for computing the F-threshold slider bounds.
  scaledFrame(frameIndex: number): Float32Array {
    const meta = this.#funcMeta
    if (!meta || !this.#funcVol?.img) return new Float32Array()
    const { frameSize, slope, inter } = meta
    const img = this.#funcVol.img
    const start = frameIndex * frameSize
    const out = new Float32Array(frameSize)
    for (let i = 0; i < frameSize; i++) out[i] = img[start + i] * slope + inter
    return out
  }

  // Display `valueFrame` masked by `fFrame` >= threshold. Failing voxels are set to a sentinel
  // BELOW cal_min so they map to the transparent index-0 of the LUT (hidden, not colored-as-0).
  applyFunctional(valueFrame: number, fFrame: number | null, threshold: number, colormap: string, opacity: number, calMin: number, calMax: number): void {
    const meta = this.#funcMeta
    const vol = this.#funcVol
    if (!meta || !vol?.img) return
    const { frameSize, slope, inter, originals } = meta
    const img = vol.img
    const sentinel = calMin - 1000 // guaranteed below cal_min → transparent
    const vStart = valueFrame * frameSize
    if (!originals.has(valueFrame)) originals.set(valueFrame, Float32Array.from(img.subarray(vStart, vStart + frameSize)))
    const original = originals.get(valueFrame) as Float32Array
    if (fFrame == null) {
      img.set(original, vStart)
    } else {
      const fStart = fFrame * frameSize
      for (let i = 0; i < frameSize; i++) {
        const f = img[fStart + i] * slope + inter
        img[vStart + i] = Number.isFinite(f) && f >= threshold ? original[i] : sentinel
      }
    }
    this.slices.setColormap(vol.id, colormap)
    vol.cal_min = calMin
    vol.cal_max = calMax
    this.slices.setFrame4D(vol.id, valueFrame)
    const idx = this.slices.getVolumeIndexByID(vol.id)
    if (idx >= 0) this.slices.setOpacity(idx, opacity)
    this.slices.updateGLVolume()
  }

  // Crosshair voxel of the functional sampler (integer i,j,k) or null.
  functionCrosshairVox(): [number, number, number] | null {
    if (!this.#funcSampler) return null
    try {
      const mm = Array.from(this.slices.frac2mm(this.slices.scene.crosshairPos)) as number[]
      const vox = this.#funcSampler.mm2vox([mm[0], mm[1], mm[2]]) as number[]
      return [Math.round(vox[0]), Math.round(vox[1]), Math.round(vox[2])]
    } catch {
      return null
    }
  }

  // Anatomical (base volume) voxel index i,j,k for a world-mm point, or null.
  baseVox(mm: [number, number, number]): [number, number, number] | null {
    if (!this.#baseVol) return null
    try {
      const v = this.#baseVol.mm2vox([mm[0], mm[1], mm[2]]) as number[]
      return [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])]
    } catch {
      return null
    }
  }

  // Value of a functional frame at a voxel (unmasked sampler). NaN if unavailable.
  sampleFunctionFrame(vox: [number, number, number], frame: number): number {
    if (!this.#funcSampler) return NaN
    try {
      return this.#funcSampler.getValue(vox[0], vox[1], vox[2], frame)
    } catch {
      return NaN
    }
  }

  functionDims(): [number, number, number] | null {
    const d = this.#funcSampler?.hdr?.dims
    return d ? [d[1], d[2], d[3]] : null
  }

  // Sampling-only atlas volumes for the multi-level Anatomy report (loaded but NOT displayed).
  #reportVols = new Map<string, NVImage>()

  async loadReportVolume(key: string, url: string): Promise<void> {
    const vol = await NVImage.loadFromUrl({ url: this.#client.dataUrl(url) })
    this.#reportVols.set(key, vol)
  }

  clearReportVolumes(): void {
    this.#reportVols.clear()
  }

  #sampleVolume(vol: NVImage): number | null {
    try {
      const mm = Array.from(this.slices.frac2mm(this.slices.scene.crosshairPos)) as number[]
      const vox = vol.mm2vox([mm[0], mm[1], mm[2]]) as number[]
      return Math.round(vol.getValue(Math.round(vox[0]), Math.round(vox[1]), Math.round(vox[2])))
    } catch {
      return null
    }
  }

  sampleReportVolume(key: string): number | null {
    const vol = this.#reportVols.get(key)
    return vol ? this.#sampleVolume(vol) : null
  }

  // Label id of the atlas overlay at the current crosshair (for the Anatomy report).
  atlasLabelAtCrosshair(): number | null {
    if (!this.#atlasVol) return null
    try {
      const mm = Array.from(this.slices.frac2mm(this.slices.scene.crosshairPos)) as number[]
      const vox = this.#atlasVol.mm2vox([mm[0], mm[1], mm[2]]) as number[]
      const val = this.#atlasVol.getValue(Math.round(vox[0]), Math.round(vox[1]), Math.round(vox[2]))
      return Math.round(val)
    } catch {
      return null
    }
  }

  // Montage layouts: how the 3 slice planes arrange within the slice instance. The surface pane
  // is positioned alongside them by the dashboard CSS (grid = surface fills the empty 4th
  // quadrant; row/column = surface on top).
  setLayout(layout: Layout): void {
    this.slices.setSliceType(SLICE_TYPE.MULTIPLANAR)
    const type = layout === 'grid' ? MULTIPLANAR_TYPE.GRID : layout === 'row' ? MULTIPLANAR_TYPE.ROW : MULTIPLANAR_TYPE.COLUMN
    this.slices.setMultiplanarLayout(type)
  }

  // ---- surfaces ----
  #clearDisplayMeshes(): void {
    for (const m of [...(this.render.meshes as NVMesh[])]) {
      if (m.name !== 'selected-location') this.render.removeMesh(m) // keep the marker
    }
    this.#displayMeshes = []
    this.#funcLayerIndex = -1 // function-surface layer is gone with the old meshes
    this.#funcLayerKey = null
  }

  // Load the reference surface (typically pial) in WORLD space — used only to map the volume
  // crosshair to a vertex index. Not added to the render scene (won't affect framing).
  async setReference(pair: SurfacePairUrls | null): Promise<void> {
    this.#refMeshes = []
    if (!pair) return
    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    const left = await NVMesh.loadFromUrl({ url: this.#client.dataUrl(pair.left), gl })
    const right = await NVMesh.loadFromUrl({ url: this.#client.dataUrl(pair.right), gl })
    this.#refMeshes = [left, right]
  }

  #atlasLayerIndex = -1

  // Re-apply a label colortable to a layer AFTER load: NiiVue 0.69 drops the descriptor's
  // colormapLabel (it is processed before layer.global_max settles, collapsing all labels to one
  // colour). setLayerProperty re-runs makeLabelLut with the settled global_max, and requires the
  // colormapLabel key to already exist on the layer (seeded via the load descriptor).
  async #applyLabelLutAt(index: number, table: LabelColortable): Promise<void> {
    if (index < 0) return
    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    for (const mesh of this.#displayMeshes) {
      await (mesh as unknown as { setLayerProperty: (i: number, k: string, v: unknown, gl: WebGL2RenderingContext) => Promise<void> }).setLayerProperty(index, 'colormapLabel', table, gl).catch(() => {})
    }
  }

  async #applyOverlayLut(table: LabelColortable): Promise<void> {
    if (this.#atlasLayerIndex < 0) return
    await this.#applyLabelLutAt(this.#atlasLayerIndex, table)
    this.render.drawScene()
  }

  // Show a hemisphere-pair surface: binary curvature shading (layer 0) + an optional
  // precomputed atlas/function surface overlay (layer 1, colored by its label colortable).
  // ---- morphology shading (curvature binary/continuous · sulc · thickness) ----
  // Four categorical/continuous mesh layers are loaded per hemisphere (v1.2.25 model): binary
  // curvature (FreeSurfer sign LUT), continuous curvature (gray), sulc (blue2red), thickness
  // (viridis). Switching the displayed metric only toggles layer opacities — no reload. The
  // morphology layers occupy the LOW indices; the atlas overlay and function layer sit above.
  #morphPairs: MorphologyShapePairs = {}
  #morphDisplay: MorphologyDisplay | null = null
  #morphIndex: Partial<Record<string, number>> = {} // layer key -> layer index (same on both hemis)

  #morphSpecs(): Array<{ key: string; metric: MorphologyMetric; pair: SurfacePairUrls; colormap: string }> {
    const specs: Array<{ key: string; metric: MorphologyMetric; pair: SurfacePairUrls; colormap: string }> = []
    if (this.#morphPairs.curvature) {
      specs.push({ key: 'curvatureBinary', metric: 'curvature', pair: this.#morphPairs.curvature, colormap: 'brainana_curvature' })
      specs.push({ key: 'curvatureContinuous', metric: 'curvature', pair: this.#morphPairs.curvature, colormap: 'gray' })
    }
    if (this.#morphPairs.sulc) specs.push({ key: 'sulc', metric: 'sulc', pair: this.#morphPairs.sulc, colormap: 'blue2red' })
    if (this.#morphPairs.thickness) specs.push({ key: 'thickness', metric: 'thickness', pair: this.#morphPairs.thickness, colormap: 'viridis' })
    return specs
  }

  #morphLayerVisible(key: string): boolean {
    const d = this.#morphDisplay
    if (!d || d.metric === 'none') return false
    if (key === 'curvatureBinary') return d.metric === 'curvature' && d.curvatureStyle === 'binary'
    if (key === 'curvatureContinuous') return d.metric === 'curvature' && d.curvatureStyle === 'continuous'
    return d.metric === key
  }

  // cal range for a morphology layer: binary curvature is forced to ±1; the rest come from the
  // display's per-metric range.
  #morphLayerCal(key: string, metric: MorphologyMetric): { min: number; max: number } {
    if (key === 'curvatureBinary') return { min: -1, max: 1 }
    const r = this.#morphDisplay?.ranges[metric]
    return r ? { min: r.min, max: r.max } : { min: -1, max: 1 }
  }

  async setSurface(pair: SurfacePairUrls | null, morphology: MorphologyShapePairs | null, overlay: SurfaceOverlay | null = null, display: MorphologyDisplay | null = null): Promise<void> {
    this.#clearDisplayMeshes()
    if (!pair) return
    this.#morphPairs = morphology ?? {}
    this.#morphDisplay = display
    this.#morphIndex = {}
    const u = (url: string) => this.#client.dataUrl(url)
    const specs = this.#morphSpecs()
    specs.forEach((s, i) => (this.#morphIndex[s.key] = i))
    const layersFor = (hemi: 'left' | 'right'): Record<string, unknown>[] => {
      const arr: Record<string, unknown>[] = specs.map((s) => {
        const cal = this.#morphLayerCal(s.key, s.metric)
        return { ...NVMeshLayerDefaults, url: u(s.pair[hemi]), colormap: s.colormap, opacity: this.#morphLayerVisible(s.key) ? 1 : 0, cal_min: cal.min, cal_max: cal.max, isTransparentBelowCalMin: false, colorbarVisible: false, showLegend: false }
      })
      if (overlay) arr.push({ ...NVMeshLayerDefaults, url: u(overlay[hemi]), colormapLabel: overlay.table, opacity: 1, showLegend: false })
      return arr
    }
    this.#atlasLayerIndex = overlay ? specs.length : -1
    await this.render.loadMeshes([
      { url: u(pair.left), rgba255: [172, 172, 172, 255], layers: layersFor('left') as never },
      { url: u(pair.right), rgba255: [172, 172, 172, 255], layers: layersFor('right') as never },
    ])
    // Identify the two just-loaded hemisphere meshes (exclude the marker).
    this.#displayMeshes = (this.render.meshes as NVMesh[]).filter((m) => m.name !== 'selected-location').slice(-2)

    // Re-apply the label LUT now that layer.global_max is settled (the load descriptor's
    // colormapLabel is processed too early, collapsing all labels to one color).
    if (overlay) await this.#applyOverlayLut(overlay.table)
  }

  // Live-switch the morphology shading: toggle layer opacities (only the active metric/style is
  // visible) and update cal ranges. No mesh reload.
  applyMorphologyDisplay(display: MorphologyDisplay): void {
    this.#morphDisplay = display
    if (this.#displayMeshes.length < 2) return
    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    for (const spec of this.#morphSpecs()) {
      const idx = this.#morphIndex[spec.key]
      if (idx == null) continue
      const cal = this.#morphLayerCal(spec.key, spec.metric)
      const visible = this.#morphLayerVisible(spec.key)
      for (const mesh of this.#displayMeshes) {
        const layer = (mesh as unknown as { layers?: Array<Record<string, unknown>> }).layers?.[idx]
        if (!layer) continue
        layer.opacity = visible ? 1 : 0
        layer.cal_min = cal.min
        layer.cal_max = cal.max
        ;(mesh as unknown as { updateMesh?: (gl: WebGL2RenderingContext) => void }).updateMesh?.(gl)
      }
    }
    this.render.drawScene()
  }

  // Update the atlas surface layer's colortable in place (ROI toggle) — no mesh reload.
  async updateSurfaceOverlayTable(table: LabelColortable): Promise<void> {
    await this.#applyOverlayLut(table)
  }

  // Swap the atlas/function overlay layer WITHOUT reloading the base surface meshes, so the
  // surface never blanks when the overlay changes (Req 7). Removes the current overlay layer in
  // place, then (if given) adds the new one per hemisphere via NVMesh.loadLayer.
  async setSurfaceOverlay(overlay: SurfaceOverlay | null): Promise<void> {
    if (this.#displayMeshes.length < 2) return
    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    if (this.#atlasLayerIndex >= 0) {
      for (const mesh of this.#displayMeshes) {
        const m = mesh as unknown as { layers?: unknown[]; updateMesh?: (gl: WebGL2RenderingContext) => void }
        if (m.layers && m.layers.length > this.#atlasLayerIndex) m.layers.splice(this.#atlasLayerIndex, 1)
        m.updateMesh?.(gl)
      }
      this.#atlasLayerIndex = -1
    }
    if (overlay) {
      const hemis: Array<'left' | 'right'> = ['left', 'right']
      let idx = -1
      for (let i = 0; i < this.#displayMeshes.length && i < 2; i++) {
        const mesh = this.#displayMeshes[i]
        idx = (mesh as unknown as { layers?: unknown[] }).layers?.length ?? 0 // appended layer's index
        const layer = { ...NVMeshLayerDefaults, url: this.#client.dataUrl(overlay[hemis[i]]), colormapLabel: overlay.table, opacity: 1, showLegend: false }
        await (NVMesh as unknown as { loadLayer: (layer: unknown, mesh: NVMesh) => Promise<void> }).loadLayer(layer, mesh)
      }
      this.#atlasLayerIndex = idx
      await this.#applyOverlayLut(overlay.table) // re-apply LUT once global_max has settled
    }
    this.render.drawScene()
  }

  setSurfaceOverlayOpacity(opacity: number): void {
    if (this.#atlasLayerIndex < 0) return
    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    for (const mesh of this.#displayMeshes) {
      const m = mesh as unknown as { layers?: Array<{ opacity: number }>; updateMesh?: (gl: WebGL2RenderingContext) => void }
      const layer = m.layers?.[this.#atlasLayerIndex]
      if (layer) {
        layer.opacity = opacity
        m.updateMesh?.(gl)
      }
    }
    this.render.drawScene()
  }

  // ---- function ON the surface (single categorical mesh layer with a 256-entry LUT) ----
  // The layer is loaded ONCE per selection via NVMesh.loadLayer (identical init to the working
  // atlas overlay), then its per-vertex values are swapped for the F-masked bin indices on every
  // threshold/brightness change (no re-fetch). Bin 0 is transparent so masked/no-data vertices
  // vanish. The layer sits ABOVE morphology + atlas; the colortable is re-applied via
  // setLayerProperty once global_max settles (the same fix the atlas needed).
  static readonly #FUNC_LAYER_PREFIX = 'brainana-func:'
  #funcLayerIndex = -1
  #funcLayerKey: string | null = null

  // Convert a dense 256-entry RGBA LUT into the {R,G,B,A,I} colortable the label path consumes.
  static #lutToColortable(lut: Uint8ClampedArray): LabelColortable {
    const R: number[] = []
    const G: number[] = []
    const B: number[] = []
    const A: number[] = []
    const I: number[] = []
    const labels: string[] = []
    for (let i = 0; i < 256; i++) {
      R.push(lut[i * 4])
      G.push(lut[i * 4 + 1])
      B.push(lut[i * 4 + 2])
      A.push(lut[i * 4 + 3])
      I.push(i)
      labels.push('')
    }
    return { R, G, B, A, I, labels }
  }

  #removeFunctionLayer(): void {
    if (this.#funcLayerIndex < 0) return
    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    for (const mesh of this.#displayMeshes.slice(0, 2)) {
      const m = mesh as unknown as { layers?: unknown[]; updateMesh?: (gl: WebGL2RenderingContext) => void }
      if (m.layers && m.layers.length > this.#funcLayerIndex) m.layers.splice(this.#funcLayerIndex, 1)
      m.updateMesh?.(gl)
    }
    this.#funcLayerIndex = -1
    this.#funcLayerKey = null
  }

  // Ensure a function-surface layer exists for `key`, loaded from the .func.gii pair (proper
  // readLayer init). Returns false if the base surface isn't present.
  async #ensureFunctionLayer(key: string, pair: SurfacePairUrls): Promise<boolean> {
    if (this.#funcLayerKey === key && this.#funcLayerIndex >= 0) return true
    this.#removeFunctionLayer()
    if (this.#displayMeshes.length < 2) return false
    const hemiUrls = [pair.left, pair.right]
    let idx = -1
    for (let h = 0; h < 2; h++) {
      const mesh = this.#displayMeshes[h]
      idx = (mesh as unknown as { layers?: unknown[] }).layers?.length ?? 0
      // The name MUST end in a real extension: NVMeshLoaders.readLayer picks its parser from the
      // filename extension and throws (`.toUpperCase()` of undefined) on a name without one.
      const layer = { url: this.#client.dataUrl(hemiUrls[h]), name: `${MultiView.#FUNC_LAYER_PREFIX}${key}.func.gii`, colormap: 'gray', opacity: 1, cal_min: 0, cal_max: 255 }
      await (NVMesh as unknown as { loadLayer: (layer: unknown, mesh: NVMesh) => Promise<void> }).loadLayer(layer, mesh)
    }
    this.#funcLayerIndex = idx
    this.#funcLayerKey = key
    return true
  }

  // Show the function-on-surface layer: load once for `key`, then swap in the F-masked bins and
  // apply the 256-entry LUT + opacity. `key` distinguishes retinotopy/somatotopy so switching
  // between them reloads the correct .func.gii; a threshold/brightness change keeps the same key
  // and only mutates values.
  async setFunctionSurface(key: string, pair: SurfacePairUrls, leftBins: Float32Array, rightBins: Float32Array, lut: Uint8ClampedArray, opacity: number): Promise<void> {
    const ok = await this.#ensureFunctionLayer(key, pair)
    if (!ok || this.#funcLayerIndex < 0) return
    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    const table = MultiView.#lutToColortable(lut)
    const bins = [leftBins, rightBins]
    for (let h = 0; h < 2; h++) {
      const mesh = this.#displayMeshes[h]
      const m = mesh as unknown as { layers?: Array<Record<string, unknown>>; updateMesh?: (gl: WebGL2RenderingContext) => void }
      const layer = m.layers?.[this.#funcLayerIndex]
      if (!layer) continue
      layer.values = bins[h]
      layer.nFrame4D = 1
      layer.frame4D = 0
      layer.opacity = opacity
      layer.global_min = 0
      layer.global_max = 255
      layer.cal_min = 0
      layer.cal_max = 255
      layer.isTransparentBelowCalMin = false
      m.updateMesh?.(gl)
    }
    await this.#applyLabelLutAt(this.#funcLayerIndex, table)
    this.render.drawScene()
  }

  clearSurfaceFunctionLayers(): void {
    this.#removeFunctionLayer()
    this.render.drawScene()
  }

  #baseScale = 2.0 // current surface's fit scale; view presets scale relative to this (Req 9)
  setSurfaceScale(kind: string): void {
    const scale = SURFACE_SCALE[kind] ?? 2.0
    this.#baseScale = scale
    try {
      this.render.scene.volScaleMultiplier = scale
      this.render.drawScene()
    } catch {
      // ignore
    }
  }

  setSurfacesVisible(visible: boolean): void {
    for (const mesh of this.#displayMeshes) mesh.visible = visible
    this.render.drawScene()
  }

  // Nearest reference-surface vertex to a world crosshair. The index is reused across all
  // displayed surfaces (pial/white/inflated/sphere), preserving vertex correspondence.
  nearestNode(mm: [number, number, number]): SurfaceNode | null {
    if (this.#refMeshes.length < 2) return null
    let best: SurfaceNode | null = null
    let bestDist = Infinity
    for (let hemi = 0 as 0 | 1; hemi <= 1; hemi = (hemi + 1) as 0 | 1) {
      const pts = this.#refMeshes[hemi].pts
      for (let i = 0, v = 0; v < pts.length; i++, v += 3) {
        const dx = pts[v] - mm[0]
        const dy = pts[v + 1] - mm[1]
        const dz = pts[v + 2] - mm[2]
        const d = dx * dx + dy * dy + dz * dz
        if (d < bestDist) {
          bestDist = d
          best = { hemi, index: i }
        }
      }
    }
    return best
  }

  // World position of a node on the CURRENTLY displayed surface.
  nodeWorld(node: SurfaceNode): [number, number, number] | null {
    const mesh = this.#displayMeshes[node.hemi]
    if (!mesh) return null
    const v = node.index * 3
    return [mesh.pts[v], mesh.pts[v + 1], mesh.pts[v + 2]]
  }

  // World position of a node on the REFERENCE (volume-space) surface — for crosshair distance.
  referenceVertexWorld(node: SurfaceNode): [number, number, number] | null {
    const mesh = this.#refMeshes[node.hemi]
    if (!mesh) return null
    const v = node.index * 3
    return [mesh.pts[v], mesh.pts[v + 1], mesh.pts[v + 2]]
  }

  // Cheap outward normal at a node: direction from the hemisphere centroid to the vertex.
  // Good enough to orient/lift the marker off any of the display surfaces (all roughly convex
  // per hemisphere); the centroid is cached per mesh object (invalidated on surface reload).
  #centroidCache = new WeakMap<NVMesh, [number, number, number]>()
  #centroidOf(mesh: NVMesh): [number, number, number] {
    const cached = this.#centroidCache.get(mesh)
    if (cached) return cached
    const pts = mesh.pts
    let x = 0
    let y = 0
    let z = 0
    const n = pts.length / 3
    for (let v = 0; v < pts.length; v += 3) {
      x += pts[v]
      y += pts[v + 1]
      z += pts[v + 2]
    }
    const cen: [number, number, number] = [x / n, y / n, z / n]
    this.#centroidCache.set(mesh, cen)
    return cen
  }

  nodeWorldNormal(node: SurfaceNode): [number, number, number] | null {
    const mesh = this.#displayMeshes[node.hemi]
    if (!mesh) return null
    const v = node.index * 3
    const c = this.#centroidOf(mesh)
    const nx = mesh.pts[v] - c[0]
    const ny = mesh.pts[v + 1] - c[1]
    const nz = mesh.pts[v + 2] - c[2]
    const len = Math.hypot(nx, ny, nz)
    return len > 1e-6 ? [nx / len, ny / len, nz / len] : [0, 1, 0]
  }

  // ---- render-instance screen projection (for marker drag picking) ----
  #renderMvp(canvas: HTMLCanvasElement): { mvp: unknown; ltwh: number[] } | null {
    const nv = this.render as unknown as {
      scene?: { renderAzimuth?: number; renderElevation?: number }
      calculateMvpMatrix?: (u: unknown, ltwh: number[], az: number, el: number) => unknown[]
    }
    if (!nv.calculateMvpMatrix) return null
    const az = nv.scene?.renderAzimuth ?? 0
    const el = nv.scene?.renderElevation ?? 0
    const ltwh = [0, 0, canvas.width, canvas.height]
    try {
      const mtx = nv.calculateMvpMatrix(null, ltwh, az, el)
      const mvp = Array.isArray(mtx) ? mtx[0] : mtx
      return mvp ? { mvp, ltwh } : null
    } catch {
      return null
    }
  }

  #screenPoint(world: [number, number, number], mvp: unknown, ltwh: number[]): number[] | null {
    const nv = this.render as unknown as { calculateScreenPoint?: (p: [number, number, number], m: unknown, l: number[]) => ArrayLike<number> }
    if (!nv.calculateScreenPoint) return null
    const sp = nv.calculateScreenPoint(world, mvp, ltwh)
    return [sp[0], sp[1], sp[2], sp[3]]
  }

  // Project a world point to CLIENT (CSS-pixel) coordinates for the surface canvas.
  projectToScreen(world: [number, number, number], canvas: HTMLCanvasElement): { x: number; y: number; depth: number; w: number } | null {
    const m = this.#renderMvp(canvas)
    if (!m) return null
    const sp = this.#screenPoint(world, m.mvp, m.ltwh)
    if (!sp) return null
    const dpr = canvas.width / Math.max(1, canvas.clientWidth)
    const rect = canvas.getBoundingClientRect()
    return { x: rect.left + sp[0] / dpr, y: rect.top + sp[1] / dpr, depth: sp[2], w: sp[3] }
  }

  // Pick the nearest FRONT-FACING displayed-surface vertex under a client (CSS-pixel) cursor.
  // Reuses NiiVue's own projection (calculateScreenPoint uses top-left device pixels).
  pickNodeAtScreen(clientX: number, clientY: number, canvas: HTMLCanvasElement): SurfaceNode | null {
    if (this.#displayMeshes.length < 2) return null
    const m = this.#renderMvp(canvas)
    if (!m) return null
    const dpr = canvas.width / Math.max(1, canvas.clientWidth)
    const rect = canvas.getBoundingClientRect()
    const px = (clientX - rect.left) * dpr
    const py = (clientY - rect.top) * dpr
    const R2 = (36 * dpr) * (36 * dpr)
    let best: SurfaceNode | null = null
    let bestDepth = Infinity
    let fallback: SurfaceNode | null = null
    let fallbackDist = Infinity
    for (let hemi = 0 as 0 | 1; hemi <= 1; hemi = (hemi + 1) as 0 | 1) {
      const mesh = this.#displayMeshes[hemi]
      if (!mesh || !mesh.visible) continue
      const pts = mesh.pts
      for (let i = 0, v = 0; v < pts.length; i++, v += 3) {
        const sp = this.#screenPoint([pts[v], pts[v + 1], pts[v + 2]], m.mvp, m.ltwh)
        if (!sp || !(sp[3] > 0)) continue // behind the camera
        const dx = sp[0] - px
        const dy = sp[1] - py
        const d2 = dx * dx + dy * dy
        if (d2 < R2 && sp[2] < bestDepth) {
          bestDepth = sp[2]
          best = { hemi, index: i }
        }
        if (d2 < fallbackDist) {
          fallbackDist = d2
          fallback = { hemi, index: i }
        }
      }
    }
    return best ?? (fallbackDist < R2 ? fallback : null)
  }

  // Reference-surface (volume-space) position for a node — used to sync the slice crosshair when
  // the marker is dragged on a display surface that isn't in volume space (inflated/sphere).
  refNodeWorld(node: SurfaceNode): [number, number, number] | null {
    const mesh = this.#refMeshes[node.hemi]
    if (!mesh) return null
    const v = node.index * 3
    return [mesh.pts[v], mesh.pts[v + 1], mesh.pts[v + 2]]
  }

  // Move the crosshair to a world mm coordinate (slice instance) and re-emit, so the marker and
  // reports follow. Mirrors nudgeCrosshair but takes an absolute position.
  moveCrosshairToWorld(mm: [number, number, number]): void {
    try {
      this.slices.scene.crosshairPos = this.slices.mm2frac(mm)
      this.slices.drawScene()
    } catch {
      // no volume yet
    }
    this.#crosshairCb?.({ mm })
  }

  // ---- camera view presets (surf row) ----
  // Absolute NiiVue azimuth/elevation per named view, plus a per-view zoom so each reframes to
  // best-fit (Req 9). Lateral/Medial are hemisphere-aware (Req 8: the left hemisphere's lateral
  // face is toward RIGHT_SIDE azimuth, its medial face toward LEFT_SIDE — the mirror of before).
  // NOTE: the angle + scale constants are the most likely things to need a visual tweak.
  setView(name: 'lateral' | 'medial' | 'ventral' | 'dorsal' | 'anterior' | 'posterior', preferHemi: 0 | 1 = 0): void {
    const LEFT_SIDE = 270
    const RIGHT_SIDE = 90
    // Dorsal/Ventral look down the long anterior–posterior axis, so they need to zoom out.
    const VIEW_FACTOR: Record<string, number> = { lateral: 1, medial: 1, anterior: 1, posterior: 1, dorsal: 0.72, ventral: 0.72 }
    let az = 110
    let el = 0
    switch (name) {
      case 'lateral':
        az = preferHemi === 0 ? RIGHT_SIDE : LEFT_SIDE
        break
      case 'medial':
        az = preferHemi === 0 ? LEFT_SIDE : RIGHT_SIDE
        break
      case 'anterior':
        az = 180
        break
      case 'posterior':
        az = 0
        break
      case 'dorsal':
        az = 0
        el = 90
        break
      case 'ventral':
        az = 0
        el = -90
        break
    }
    try {
      this.render.scene.volScaleMultiplier = this.#baseScale * (VIEW_FACTOR[name] ?? 1)
      this.render.setRenderAzimuthElevation(az, el)
      this.render.drawScene()
    } catch {
      // no surface yet
    }
  }

  // Per-hemisphere visibility (LH/RH checkboxes). hemi 0 = left, 1 = right.
  setHemisphereVisible(hemi: 0 | 1, visible: boolean): void {
    const mesh = this.#displayMeshes[hemi]
    if (mesh) {
      mesh.visible = visible
      this.render.drawScene()
    }
  }

  emitCrosshair(mm: [number, number, number]): void {
    this.#crosshairCb?.({ mm })
  }

  // Shift the crosshair by a world-mm delta (arrow keys), then re-emit.
  nudgeCrosshair(delta: [number, number, number]): void {
    if (!this.#baseVol) return
    try {
      const cur = Array.from(this.slices.frac2mm(this.slices.scene.crosshairPos)) as number[]
      const mm: [number, number, number] = [cur[0] + delta[0], cur[1] + delta[1], cur[2] + delta[2]]
      this.slices.scene.crosshairPos = this.slices.mm2frac(mm)
      this.slices.drawScene()
      this.#crosshairCb?.({ mm })
    } catch {
      // no volume yet
    }
  }

  resetViews(): void {
    try {
      this.slices.scene.pan2Dxyzmm = [0, 0, 0, 1]
      this.render.setRenderAzimuthElevation(110, 10)
      const center: [number, number, number] = [0.5, 0.5, 0.5]
      this.slices.scene.crosshairPos = center
      const mm = Array.from(this.slices.frac2mm(center)) as number[]
      this.slices.drawScene()
      this.render.drawScene()
      this.#crosshairCb?.({ mm: [mm[0], mm[1], mm[2]] })
    } catch {
      // no volume yet
    }
  }

  resize(): void {
    this.slices.drawScene()
    this.render.drawScene()
  }
}
