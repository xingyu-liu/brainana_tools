// NiiVue integration wrapper. Owns a single Niivue instance bound to a canvas and exposes
// the subset of operations the Viewer panels need. Data URLs pass through RuntimeClient
// (loopback cookie auth — no query params that would corrupt NiiVue's extension detection).
import { Niivue, SLICE_TYPE, MULTIPLANAR_TYPE, SHOW_RENDER, NVMeshLayerDefaults, type NVImage } from '@niivue/niivue'
import type { RuntimeClient } from '../../../core/client/runtimeClient.ts'

export type SurfaceKind = 'pial' | 'white' | 'smoothwm' | 'inflated' | 'veryinflated' | 'sphere'
// Montage layouts. The multiplanar layouts always include the 3D render (surface) tile.
export type ViewLayout = 'single' | 'grid' | 'row' | 'column' | 'render'

// A NiiVue label colortable for atlas volumes.
export interface LabelColortable {
  R: number[]
  G: number[]
  B: number[]
  A: number[]
  I: number[]
  labels: string[]
}

export interface SurfacePairUrls {
  left: string
  right: string
}

interface FunctionalMeta {
  vol: NVImage
  frameSize: number
  frames: number
  slope: number
  inter: number
  // Pristine copies of each value frame's raw voxels, so re-thresholding never reads
  // already-masked data.
  originals: Map<number, Float32Array>
}

export class SubjectViewer {
  #nv: Niivue
  #client: RuntimeClient
  #overlays = new Map<string, NVImage>()
  #functional = new Map<string, FunctionalMeta>()
  #baseVol: NVImage | null = null

  constructor(canvas: HTMLCanvasElement, client: RuntimeClient) {
    this.#client = client
    this.#nv = new Niivue({
      backColor: [0, 0, 0, 1],
      show3Dcrosshair: true,
      dragAndDropEnabled: false,
      isColorbar: false,
      // Always include the 3D render (surface) tile in multiplanar layouts.
      multiplanarShowRender: SHOW_RENDER.ALWAYS,
    })
    this.#nv.attachToCanvas(canvas)
  }

  /**
   * Set (or switch) the base anatomical volume, kept at draw index 0 so any atlas /
   * functional overlays already loaded are preserved rather than cleared.
   */
  async setBaseVolume(url: string, opacity = 1): Promise<void> {
    const previous = this.#baseVol
    const vol = await this.#nv.addVolumeFromUrl({ url: this.#client.dataUrl(url), colormap: 'gray', opacity })
    this.#nv.setVolume(vol, 0)
    if (previous) this.#nv.removeVolume(previous)
    this.#baseVol = vol
  }

  hasBaseVolume(): boolean {
    return this.#baseVol != null
  }

  setVolumeOpacity(opacity: number): void {
    if (!this.#baseVol) return
    const idx = this.#nv.getVolumeIndexByID(this.#baseVol.id)
    if (idx >= 0) this.#nv.setOpacity(idx, opacity)
  }

  // --- overlays (atlases, functional maps) keyed by their manifest URL ---

  hasOverlay(url: string): boolean {
    return this.#overlays.has(url)
  }

  async addOverlay(url: string, colormap: string, opacity: number): Promise<void> {
    if (this.#overlays.has(url)) return
    const volume = await this.#nv.addVolumeFromUrl({ url: this.#client.dataUrl(url), colormap, opacity })
    // Nearest-neighbour so integer label boundaries stay crisp.
    volume.trustCalMinMax = false
    this.#overlays.set(url, volume)
    this.#nv.updateGLVolume()
  }

  removeOverlay(url: string): void {
    const volume = this.#overlays.get(url)
    if (!volume) return
    this.#nv.removeVolume(volume)
    this.#overlays.delete(url)
    this.#functional.delete(url)
  }

  setOverlayOpacity(url: string, opacity: number): void {
    const volume = this.#overlays.get(url)
    if (!volume) return
    const idx = this.#nv.getVolumeIndexByID(volume.id)
    if (idx >= 0) this.#nv.setOpacity(idx, opacity)
  }

  /** Apply a label colortable to an atlas overlay: named, colored regions + crosshair names. */
  applyLabelColortable(url: string, table: LabelColortable): void {
    const volume = this.#overlays.get(url)
    if (!volume) return
    volume.setColormapLabel(table)
    this.#nv.updateGLVolume()
  }

  // --- functional maps (retinotopy / somatotopy): 4D volume, F-stat masking ---

  /** Load a 4D functional volume as an overlay. Returns its frame count. */
  async loadFunctional(url: string, colormap: string, opacity: number): Promise<number> {
    let vol = this.#overlays.get(url)
    if (!vol) {
      vol = await this.#nv.addVolumeFromUrl({ url: this.#client.dataUrl(url), colormap, opacity })
      vol.trustCalMinMax = false
      this.#overlays.set(url, vol)
    }
    const dims = vol.hdr?.dims ?? []
    const frameSize = (dims[1] || 1) * (dims[2] || 1) * (dims[3] || 1)
    const frames = dims[4] && dims[4] > 1 ? dims[4] : 1
    const slope = vol.hdr?.scl_slope && vol.hdr.scl_slope !== 0 ? vol.hdr.scl_slope : 1
    const inter = vol.hdr?.scl_inter ?? 0
    this.#functional.set(url, { vol, frameSize, frames, slope, inter, originals: new Map() })
    return frames
  }

  /** Scaled voxel values of one 4D frame (copy) — for computing threshold bounds. */
  scaledFrame(url: string, frameIndex: number): Float32Array {
    const meta = this.#functional.get(url)
    if (!meta) return new Float32Array()
    const { vol, frameSize, slope, inter } = meta
    if (!vol.img) return new Float32Array()
    const img = vol.img
    const start = frameIndex * frameSize
    const out = new Float32Array(frameSize)
    for (let i = 0; i < frameSize; i++) out[i] = img[start + i] * slope + inter
    return out
  }

  /**
   * Display `valueFrame` masked by `fFrame` >= threshold. Voxels failing the threshold (or
   * with a non-finite F-stat) become NaN and render transparent. Colormap + opacity applied.
   */
  applyFunctional(url: string, valueFrame: number, fFrame: number | null, threshold: number, colormap: string, opacity: number): void {
    const meta = this.#functional.get(url)
    if (!meta) return
    const { vol, frameSize, slope, inter, originals } = meta
    const img = vol.img
    if (!img) return
    const vStart = valueFrame * frameSize
    if (!originals.has(valueFrame)) originals.set(valueFrame, Float32Array.from(img.subarray(vStart, vStart + frameSize)))
    const original = originals.get(valueFrame) as Float32Array

    if (fFrame == null) {
      img.set(original, vStart)
    } else {
      const fStart = fFrame * frameSize
      for (let i = 0; i < frameSize; i++) {
        const f = img[fStart + i] * slope + inter
        img[vStart + i] = Number.isFinite(f) && f >= threshold ? original[i] : NaN
      }
    }

    this.#nv.setColormap(vol.id, colormap)
    this.#nv.setFrame4D(vol.id, valueFrame)
    const idx = this.#nv.getVolumeIndexByID(vol.id)
    if (idx >= 0) this.#nv.setOpacity(idx, opacity)
    this.#nv.updateGLVolume()
  }

  /** Report the value(s) under the crosshair as NiiVue formats them. */
  onCrosshair(cb: (text: string) => void): void {
    this.#nv.onLocationChange = (data: unknown) => {
      const value = (data as { string?: string })?.string ?? ''
      cb(value)
    }
  }

  setLayout(layout: ViewLayout): void {
    if (layout === 'render') {
      this.#nv.setSliceType(SLICE_TYPE.RENDER)
      return
    }
    if (layout === 'single') {
      this.#nv.setSliceType(SLICE_TYPE.AXIAL)
      return
    }
    this.#nv.setSliceType(SLICE_TYPE.MULTIPLANAR)
    const type = layout === 'grid' ? MULTIPLANAR_TYPE.GRID : layout === 'row' ? MULTIPLANAR_TYPE.ROW : MULTIPLANAR_TYPE.COLUMN
    this.#nv.setMultiplanarLayout(type)
  }

  #clearMeshes(): void {
    while (this.#nv.meshes.length) this.#nv.removeMesh(this.#nv.meshes[0])
  }

  /**
   * Show a hemisphere-pair surface, optionally shaded by a curvature layer per hemisphere.
   * Passing `null` clears surfaces.
   */
  async setSurface(pair: SurfacePairUrls | null, curvature: SurfacePairUrls | null): Promise<void> {
    this.#clearMeshes()
    if (!pair) return
    // Curvature as a per-hemisphere gray shading layer (gyri/sulci), like the default look.
    const layer = (url?: string) =>
      url ? [{ ...NVMeshLayerDefaults, url: this.#client.dataUrl(url), colormap: 'gray', opacity: 0.7, cal_min: -0.5, cal_max: 0.5 }] : []
    await this.#nv.loadMeshes([
      { url: this.#client.dataUrl(pair.left), layers: layer(curvature?.left) },
      { url: this.#client.dataUrl(pair.right), layers: layer(curvature?.right) },
    ])
  }

  setSurfacesVisible(visible: boolean): void {
    for (const mesh of this.#nv.meshes) mesh.visible = visible
    this.#nv.drawScene()
  }

  redraw(): void {
    this.#nv.drawScene()
  }

  /** Release GPU resources. */
  destroy(): void {
    this.#clearMeshes()
    try {
      const gl = (this.#nv as unknown as { gl?: WebGL2RenderingContext }).gl
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    } catch {
      // best-effort
    }
  }
}
