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

  async #applyOverlayLut(table: LabelColortable): Promise<void> {
    if (this.#atlasLayerIndex < 0) return
    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    for (const mesh of this.#displayMeshes) {
      // setLayerProperty runs makeLabelLut with the now-settled layer.global_max, so pass the
      // RAW table; it also requires the colormapLabel key to already exist on the layer (set
      // via the load descriptor below).
      await (mesh as unknown as { setLayerProperty: (i: number, k: string, v: unknown, gl: WebGL2RenderingContext) => Promise<void> }).setLayerProperty(this.#atlasLayerIndex, 'colormapLabel', table, gl).catch(() => {})
    }
    this.render.drawScene()
  }

  // Show a hemisphere-pair surface: binary curvature shading (layer 0) + an optional
  // precomputed atlas/function surface overlay (layer 1, colored by its label colortable).
  async setSurface(pair: SurfacePairUrls | null, curvature: SurfacePairUrls | null, overlay: SurfaceOverlay | null = null): Promise<void> {
    this.#clearDisplayMeshes()
    if (!pair) return
    const u = (url: string) => this.#client.dataUrl(url)
    const layersFor = (hemi: 'left' | 'right'): Record<string, unknown>[] => {
      const arr: Record<string, unknown>[] = []
      if (curvature) arr.push({ ...NVMeshLayerDefaults, url: u(curvature[hemi]), colormap: 'brainana_curvature', opacity: 1, cal_min: -0.5, cal_max: 0.5, showLegend: false })
      if (overlay) arr.push({ ...NVMeshLayerDefaults, url: u(overlay[hemi]), colormapLabel: overlay.table, opacity: 1, showLegend: false })
      return arr
    }
    this.#atlasLayerIndex = overlay ? (curvature ? 1 : 0) : -1
    await this.render.loadMeshes([
      { url: u(pair.left), layers: layersFor('left') as never },
      { url: u(pair.right), layers: layersFor('right') as never },
    ])
    // Identify the two just-loaded hemisphere meshes (exclude the marker).
    this.#displayMeshes = (this.render.meshes as NVMesh[]).filter((m) => m.name !== 'selected-location').slice(-2)

    // Re-apply the label LUT now that layer.global_max is settled (the load descriptor's
    // colormapLabel is processed too early, collapsing all labels to one color).
    if (overlay) await this.#applyOverlayLut(overlay.table)
  }

  // Update the atlas surface layer's colortable in place (ROI toggle) — no mesh reload.
  async updateSurfaceOverlayTable(table: LabelColortable): Promise<void> {
    await this.#applyOverlayLut(table)
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

  setSurfaceScale(kind: string): void {
    const scale = SURFACE_SCALE[kind] ?? 2.0
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
  // Absolute NiiVue azimuth/elevation per named view. Lateral/Medial depend on the hemisphere.
  // NOTE: these angle constants are the most likely thing to need a visual tweak.
  setView(name: 'lateral' | 'medial' | 'ventral' | 'dorsal' | 'anterior' | 'posterior', preferHemi: 0 | 1 = 0): void {
    const LEFT_SIDE = 270
    const RIGHT_SIDE = 90
    let az = 110
    let el = 0
    switch (name) {
      case 'lateral':
        az = preferHemi === 0 ? LEFT_SIDE : RIGHT_SIDE
        break
      case 'medial':
        az = preferHemi === 0 ? RIGHT_SIDE : LEFT_SIDE
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
