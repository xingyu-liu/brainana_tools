import './style.css'
import { Niivue, NVImage, SLICE_TYPE } from '@niivue/niivue'
import type { FitState, Landmark, Loaded, Modality, OptimizationWindows, Params6, Plane, ReviewView, View, WindowConstraint } from './appTypes'
import { gzipSync } from 'fflate'
import { applyAffine, frame, invertAffine, sampleLinear, type RawNifti } from './roiWarp'
import { installRuntimeIntegration } from './runtimeIntegration'
import { applyMat4, fitRigid, invertRigid, multiplyMat4, rigidDelta, type Mat4, type Vec3 } from './rigid'
import { countOptimizationWindows, optimizationConstraint as getOptimizationConstraint, planeAxes, sanitizeOptimizationWindows, withinOptimizationWindows } from './optimizationWindows'
import { installOptimizationWindowCapture } from './optimizationWindowInteraction'
import { installHoverKeyboardPan, installProjectionRefresh, installWheelZoomAndSlice, isTypingTarget, panViewInScreenDirection, type HoveredView } from './viewInteraction'
import { canvasPointToImageOnCurrentSlice, coordinateLabel, isFiniteVec3, planeDepthAxis } from './coordinateProjection'
import { setOrthogonalCrosshairs, setReviewCrosshairs } from './crosshairController'
import { renderModalityMarkers, renderReviewLandmarks } from './landmarkRenderer'
import { VERSION as APP_VERSION } from './version'
import { createSessionPayload, parseSessionPayload, sessionGeometryMismatches } from './sessionPersistence'
import { createRegistrationArtifacts, saveArtifact, saveArtifacts } from './exportArtifacts'
import { detectBrowserCapabilities } from './browserCapabilities'
import { installBrowserCompatibilityBanner } from './browserCompatibility'

const planeTypes: Record<Plane, SLICE_TYPE> = {
  sagittal: SLICE_TYPE.SAGITTAL,
  coronal: SLICE_TYPE.CORONAL,
  axial: SLICE_TYPE.AXIAL,
}

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
<header class="topbar">
  <div class="brand">Brainana Align <span>v0.16.26-docs.1</span></div>
  <div class="workflow-group image-loads">
    <label class="load compact-load" title="Load an MRI volume"><input id="mri-file" type="file" multiple accept=".nii,.nii.gz,.hdr,.img,.img.gz,.head,.brik,.brik.gz,.mgh,.mgz,.nrrd,.nhdr,.mif,.mha,.mhd,.raw,.v,.v16,.vmr,.npy,.npz,.fib,.src,.gz,application/gzip,application/x-gzip,application/octet-stream"><strong id="mri-name">Load MRI</strong></label>
    <label class="load compact-load" title="Load a CT volume"><input id="ct-file" type="file" multiple accept=".nii,.nii.gz,.hdr,.img,.img.gz,.head,.brik,.brik.gz,.mgh,.mgz,.nrrd,.nhdr,.mif,.mha,.mhd,.raw,.v,.v16,.vmr,.npy,.npz,.fib,.src,.gz,application/gzip,application/x-gzip,application/octet-stream"><strong id="ct-name">Load CT</strong></label>
  </div>
  <div class="toolbar-divider"></div>
  <div class="workflow-group landmark-actions">
    <button id="save-session" title="Save landmarks and registration state">Save session</button>
    <label class="session-load" title="Restore a saved Brainana Align session"><input id="load-session" type="file" accept=".json,application/json"><span>Load session</span></label>
    <button id="new-pair" class="primary-action">New landmark</button>
  </div>
  <div class="toolbar-divider"></div>
  <div class="workflow-group registration-actions">
    <button id="reset-view" title="Reset zoom and field of view">Reset view</button>
    <button id="export-open" disabled>Export</button>
  </div>
  <button id="undo" class="icon-action" title="Undo last landmark edit">Undo</button>
  <span id="status">Load MRI and CT to begin.</span>
</header>
<main>
  <section class="workspace">
    <div class="column-head"></div><div class="column-head">Sagittal</div><div class="column-head">Coronal</div><div class="column-head">Axial</div>
    ${(['mri','ct'] as Modality[]).map(modality => `
      <div class="row-head"><strong>${modality.toUpperCase()}</strong><small id="${modality}-coords">x — y — z —</small></div>
      ${(['sagittal','coronal','axial'] as Plane[]).map(plane => `<div class="view-card" data-modality="${modality}" data-plane="${plane}"><canvas id="${modality}-${plane}"></canvas><svg class="marker-overlay" id="${modality}-${plane}-overlay"></svg><div class="optimization-window-layer" id="${modality}-${plane}-window-layer"></div><div class="image-placeholder" id="${modality}-${plane}-placeholder">No ${modality.toUpperCase()} selected</div></div>`).join('')}
    `).join('')}
    <div class="row-head review-head"><strong>OVERLAY</strong><small id="review-label">Fit a transform to review alignment</small></div>
    ${(['sagittal','coronal','axial'] as Plane[]).map(plane => `<div class="view-card review-card" data-plane="${plane}"><canvas id="review-${plane}"></canvas><svg class="marker-overlay" id="review-${plane}-overlay"></svg><div class="review-placeholder">Fit a rigid transform to display the aligned overlay</div></div>`).join('')}
  </section>
  <aside class="sidebar">
    <details class="panel" open>
      <summary><span>Landmarks</span><span id="pair-count">0 pairs</span></summary>
      <div class="panel-body">
        <p class="hint">Create a pair, navigate each image, then set its MRI and CT positions. Drag a visible marker to adjust it within the current slice.</p>
        <div id="selected-landmark-summary" class="selected-summary">No landmark selected</div>
        <div id="landmark-list" class="landmark-list"></div>
      </div>
    </details>
    <details class="panel" open>
      <summary><span>Rigid alignment</span></summary>
      <div class="panel-body">
        <label>Transform direction<select id="direction"><option value="ct-mri">CT → MRI</option><option value="mri-ct">MRI → CT</option></select></label>
        <button id="fit-side" class="primary">Fit six-parameter transform</button>
        <button id="restore-alignment-landmarks" disabled>Restore alignment landmarks</button>
        <div id="fit-summary" class="summary">At least three complete, enabled landmark pairs are required.</div>
        <label class="check"><input id="link-after" type="checkbox" checked> Link navigation after fitting</label>
      </div>
    </details>
    <details class="panel" id="manual-panel">
      <summary><span>Manual adjustment</span></summary>
      <div class="panel-body">
        <p class="hint">Nudges move the current moving image only. Translations use fixed-image world axes; rotations occur about the fixed-image center.</p>
        <div class="step-grid"><label>Translation step<select id="translation-step"><option value="0.1">0.1 mm</option><option value="0.5" selected>0.5 mm</option><option value="1">1 mm</option><option value="2">2 mm</option><option value="5">5 mm</option></select></label><label>Rotation step<select id="rotation-step"><option value="0.1">0.1°</option><option value="0.25">0.25°</option><option value="0.5" selected>0.5°</option><option value="1">1°</option><option value="2">2°</option></select></label></div>
        <div id="nudge-controls" class="nudge-controls">
          <div class="nudge-row"><span>X · L/R</span><button data-param="0" data-sign="-1">◀</button><output id="param-0">0.0 mm</output><button data-param="0" data-sign="1">▶</button></div>
          <div class="nudge-row"><span>Y · P/A</span><button data-param="1" data-sign="-1">◀</button><output id="param-1">0.0 mm</output><button data-param="1" data-sign="1">▶</button></div>
          <div class="nudge-row"><span>Z · I/S</span><button data-param="2" data-sign="-1">▼</button><output id="param-2">0.0 mm</output><button data-param="2" data-sign="1">▲</button></div>
          <div class="nudge-row"><span>Rotate X</span><button data-param="3" data-sign="-1">↶</button><output id="param-3">0.0°</output><button data-param="3" data-sign="1">↷</button></div>
          <div class="nudge-row"><span>Rotate Y</span><button data-param="4" data-sign="-1">↶</button><output id="param-4">0.0°</output><button data-param="4" data-sign="1">↷</button></div>
          <div class="nudge-row"><span>Rotate Z</span><button data-param="5" data-sign="-1">↶</button><output id="param-5">0.0°</output><button data-param="5" data-sign="1">↷</button></div>
        </div>
        <button id="reset-manual" disabled>Reset manual nudges</button><button id="reset-landmark" disabled>Reset to landmark fit</button>
      </div>
    </details>
    <details class="panel" id="refine-panel">
      <summary><span>Automatic refinement</span></summary>
      <div class="panel-body">
        <label>Search preset<select id="refine-bounds"><option value="tight">Tight</option><option value="standard" selected>Standard</option><option value="custom">Custom</option></select></label>
        <div class="step-grid refine-grid"><label>Translation limit<input id="refine-translation-limit" type="number" min="0.1" step="0.1" value="5"> mm</label><label>Rotation limit<input id="refine-rotation-limit" type="number" min="0.1" step="0.1" value="10"> °</label></div>
        <details class="nested"><summary>Advanced settings</summary><div class="step-grid refine-grid"><label>Translation start step<input id="refine-translation-step" type="number" min="0.05" step="0.05" value="2"> mm</label><label>Rotation start step<input id="refine-rotation-step" type="number" min="0.05" step="0.05" value="1"> °</label></div></details>
        <div class="optimization-window-controls">
          <label>Optimization windows<select id="window-target"><option value="both">MRI and CT</option><option value="mri">MRI only</option><option value="ct">CT only</option></select></label>
          <button id="define-windows">Define windows</button>
          <button id="clear-windows">Clear windows</button>
          <p id="window-summary" class="hint">No optimization windows defined. The full geometric overlap will be used.</p>
        </div>
        <button id="refine" disabled>Refine rigid alignment</button>
        <div id="refine-summary" class="summary">Fits locally around the current transform using normalized mutual information and geometrically overlapping voxels only.</div>
        <div id="refine-actions" class="refine-actions hidden"><button id="accept-refine" class="primary">Accept refinement</button><button id="reject-refine">Reject</button></div>
      </div>
    </details>
    <details class="panel" open>
      <summary><span>Alignment display</span></summary>
      <div class="panel-body">
        <label>Display mode<select id="review-mode"><option value="falsecolor">Green–magenta false color</option><option value="opacity">Grayscale opacity</option></select></label>
        <label>Moving image opacity <span id="opacity-value">55%</span><input id="review-opacity" type="range" min="0" max="100" value="55"></label>
        <p class="hint">The fixed image defines the review grid. Paired landmark positions are shown as circles and diamonds after fitting.</p>
        <p class="hint interaction-hint"><strong>Zoom:</strong> mouse wheel or two-finger trackpad scroll. <strong>Change slices:</strong> Shift + wheel or Shift + two-finger scroll. <strong>Pan the field of view:</strong> hover a panel and use the arrow keys, or drag empty image space. Dragging a landmark still moves only that landmark.</p>
      </div>
    </details>
  </aside>
</main>
<div id="export-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="export-title">
  <div class="modal-card">
    <div class="modal-head"><h2 id="export-title">Export registration</h2><button id="export-close" aria-label="Close">×</button></div>
    <p class="hint">Aligned images use linear interpolation on the selected reference grid.</p>
    <button id="save-aligned" disabled>Save aligned image</button>
    <button id="save-transform" disabled>Save transforms and landmarks</button>
    <button id="save-session-export">Save reloadable session</button>
  </div>
</div>
`

const statusEl = document.querySelector<HTMLSpanElement>('#status')!
const landmarkList = document.querySelector<HTMLDivElement>('#landmark-list')!
const fitSummary = document.querySelector<HTMLDivElement>('#fit-summary')!
const directionSelect = document.querySelector<HTMLSelectElement>('#direction')!
const linkAfter = document.querySelector<HTMLInputElement>('#link-after')!
const saveAligned = document.querySelector<HTMLButtonElement>('#save-aligned')!
const saveTransform = document.querySelector<HTMLButtonElement>('#save-transform')!
const reviewMode = document.querySelector<HTMLSelectElement>('#review-mode')!
const reviewOpacity = document.querySelector<HTMLInputElement>('#review-opacity')!
const opacityValue = document.querySelector<HTMLSpanElement>('#opacity-value')!
const translationStep = document.querySelector<HTMLSelectElement>('#translation-step')!
const rotationStep = document.querySelector<HTMLSelectElement>('#rotation-step')!
const resetManual = document.querySelector<HTMLButtonElement>('#reset-manual')!
const resetLandmark = document.querySelector<HTMLButtonElement>('#reset-landmark')!
const refineButton = document.querySelector<HTMLButtonElement>('#refine')!
const refineBounds = document.querySelector<HTMLSelectElement>('#refine-bounds')!
const refineTranslationLimit = document.querySelector<HTMLInputElement>('#refine-translation-limit')!
const refineRotationLimit = document.querySelector<HTMLInputElement>('#refine-rotation-limit')!
const refineTranslationStartStep = document.querySelector<HTMLInputElement>('#refine-translation-step')!
const refineRotationStartStep = document.querySelector<HTMLInputElement>('#refine-rotation-step')!
const refineSummary = document.querySelector<HTMLDivElement>('#refine-summary')!
const refineActions = document.querySelector<HTMLDivElement>('#refine-actions')!
const acceptRefine = document.querySelector<HTMLButtonElement>('#accept-refine')!
const rejectRefine = document.querySelector<HTMLButtonElement>('#reject-refine')!
const restoreAlignmentLandmarks = document.querySelector<HTMLButtonElement>('#restore-alignment-landmarks')!
const defineWindows = document.querySelector<HTMLButtonElement>('#define-windows')!
const clearWindows = document.querySelector<HTMLButtonElement>('#clear-windows')!
const windowTarget = document.querySelector<HTMLSelectElement>('#window-target')!
const windowSummary = document.querySelector<HTMLParagraphElement>('#window-summary')!

const views: Record<Modality, Record<Plane, View>> = { mri: {} as Record<Plane, View>, ct: {} as Record<Plane, View> }
const reviewViews = {} as Record<Plane, ReviewView>
const loaded: Record<Modality, Loaded | null> = { mri: null, ct: null }
const currentMm: Record<Modality, Vec3 | null> = { mri: null, ct: null }
let landmarks: Landmark[] = []
let selectedId: number | null = null
let nextId = 1
let fitResult: FitState | null = null
let reviewBuildTimer: number | null = null
let history: Landmark[][] = []
let suppressLinkedUpdate = false
let suppressReviewUpdate = false
const suppressCrosshairSync: Record<Modality, boolean> = { mri: false, ct: false }
let reviewImages: { fixed: NVImage; moving: NVImage; fixedModality: Modality; movingModality: Modality } | null = null
let optimizationWindows: OptimizationWindows = { mri: {}, ct: {} }
let definingWindows = false

function setStatus(text: string, error = false) { statusEl.textContent = text; statusEl.classList.toggle('error', error) }

function setImagePlaceholder(modality: Modality, mode: 'empty' | 'loading' | 'hidden', detail?: string) {
  const label = modality.toUpperCase()
  for (const plane of ['sagittal','coronal','axial'] as Plane[]) {
    const placeholder = document.querySelector<HTMLDivElement>(`#${modality}-${plane}-placeholder`)!
    placeholder.classList.toggle('hidden', mode === 'hidden')
    placeholder.classList.toggle('loading', mode === 'loading')
    if (mode === 'empty') placeholder.textContent = `No ${label} selected`
    else if (mode === 'loading') placeholder.textContent = detail ? `Loading ${label}: ${detail}` : `Loading ${label}…`
  }
}
function snapshot() { history.push(structuredClone(landmarks)); if (history.length > 40) history.shift() }

let hoveredView: HoveredView | null = null

document.addEventListener('keydown', event => {
  if (!hoveredView || isTypingTarget(event.target)) return
  const directions: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
  }
  const direction = directions[event.key]
  if (!direction) return
  event.preventDefault()
  const step = event.shiftKey ? 36 : 12
  panViewInScreenDirection(hoveredView, direction[0] * step, direction[1] * step)
})

function setupViews() {
  for (const modality of ['mri','ct'] as Modality[]) {
    for (const plane of ['sagittal','coronal','axial'] as Plane[]) {
      const canvas = document.querySelector<HTMLCanvasElement>(`#${modality}-${plane}`)!
      const overlay = document.querySelector<SVGSVGElement>(`#${modality}-${plane}-overlay`)!
      const windowLayer = document.querySelector<HTMLDivElement>(`#${modality}-${plane}-window-layer`)!
      const nv = new Niivue({ show3Dcrosshair: false, isColorbar: false })
      views[modality][plane] = { nv, modality, plane, canvas, overlay, windowLayer }
      nv.attachToCanvas(canvas)
      nv.setSliceMM(true)
      nv.setDragMode('pan')
      nv.setSliceType(planeTypes[plane])
      nv.setCrosshairColor(modality === 'mri' ? [0.25,0.85,1,1] : [1,0.7,0.15,1])
      nv.onLocationChange = (loc: any) => handleLocation(modality, loc?.mm, plane)
      installWheelZoomAndSlice(canvas, nv, () => loaded[modality]?.raw.dims ?? null, plane, mm => gotoMm(modality, mm))
      installHoverKeyboardPan(canvas, nv, () => renderMarkers(modality), view => { hoveredView = view })
      installProjectionRefresh(canvas, () => renderMarkers(modality))
      const card = canvas.closest<HTMLElement>('.view-card')!
      installWindowCapture(views[modality][plane])
      window.addEventListener('resize', () => renderMarkers(modality))
    }
  }
}

function setupReviewViews() {
  for (const plane of ['sagittal','coronal','axial'] as Plane[]) {
    const canvas = document.querySelector<HTMLCanvasElement>(`#review-${plane}`)!
    const overlay = document.querySelector<SVGSVGElement>(`#review-${plane}-overlay`)!
    const nv = new Niivue({ show3Dcrosshair: false, isColorbar: false })
    nv.addColormap('brainanaMagenta', { R: [0, 128, 255], G: [0, 0, 0], B: [0, 128, 255], A: [0, 64, 128], I: [0, 128, 255] })
    reviewViews[plane] = { nv, plane, canvas, overlay }
    nv.attachToCanvas(canvas)
    nv.setSliceMM(true)
    nv.setDragMode('pan')
    nv.setSliceType(planeTypes[plane])
    nv.setCrosshairColor([1,1,1,0.85])
    nv.onLocationChange = (loc: any) => {
      if (suppressReviewUpdate || !reviewImages || !loc?.mm) return
      const mm: Vec3 = [loc.mm[0], loc.mm[1], loc.mm[2]]
      // Overlay coordinates are in the fixed-image world. Update the fixed image,
      // map the same location back into the original moving image, and then redraw
      // every overlay plane. This keeps MRI, CT, and overlay navigation coherent.
      suppressReviewUpdate = true
      suppressLinkedUpdate = true
      gotoMm(reviewImages.fixedModality, mm)
      if (fitResult) {
        const movingMm = applyMat4(fitResult.inverse, mm)
        gotoMm(reviewImages.movingModality, movingMm)
      }
      for (const reviewView of Object.values(reviewViews)) {
        if (!reviewView.nv.volumes.length) continue
        reviewView.nv.scene.crosshairPos = reviewView.nv.mm2frac(mm)
        reviewView.nv.drawScene()
      }
      renderReviewMarkers()
      requestAnimationFrame(() => {
        suppressLinkedUpdate = false
        suppressReviewUpdate = false
      })
    }
    installWheelZoomAndSlice(canvas, nv, () => {
      if (!reviewImages) return null
      const fixed = loaded[reviewImages.fixedModality]
      return fixed?.raw.dims ?? null
    }, plane, mm => {
      if (!reviewImages) return
      gotoMm(reviewImages.fixedModality, mm)
    })
    installHoverKeyboardPan(canvas, nv, renderReviewMarkers, view => { hoveredView = view })
    installProjectionRefresh(canvas, renderReviewMarkers)
    window.addEventListener('resize', renderReviewMarkers)
  }
}

const supportedExtensions = [
  '.nii', '.nii.gz', '.hdr', '.img', '.img.gz', '.head', '.brik', '.brik.gz',
  '.mgh', '.mgz', '.nrrd', '.nhdr', '.mif', '.mha', '.mhd', '.raw',
  '.v', '.v16', '.vmr', '.npy', '.npz', '.fib', '.src',
]

function matchesSupportedExtension(name: string): boolean {
  const lower = name.toLowerCase()
  return supportedExtensions.some(ext => lower.endsWith(ext))
}

function rawFromNVImage(image: NVImage): RawNifti {
  if (!image.img) throw new Error('The selected image contains no voxel data')
  const dimsSource = image.hdr?.dims ?? image.dims
  if (!dimsSource || dimsSource.length < 4) throw new Error('Unable to determine image dimensions')
  const dims: [number, number, number] = [Number(dimsSource[1]), Number(dimsSource[2]), Number(dimsSource[3])]
  if (!dims.every(v => Number.isFinite(v) && v > 0)) throw new Error('Invalid image dimensions')
  const frameCount = Math.max(1, Number(dimsSource[4]) || 1)
  const affine = image.getAffine().map(row => row.map(Number))
  const pix = image.hdr?.pixDims ?? image.pixDims
  const pixDims: [number, number, number] = [
    Math.abs(Number(pix?.[1] ?? 1)),
    Math.abs(Number(pix?.[2] ?? 1)),
    Math.abs(Number(pix?.[3] ?? 1)),
  ]
  const slope = Number(image.hdr?.scl_slope) || 1
  const intercept = Number(image.hdr?.scl_inter) || 0
  const source = image.img as ArrayLike<number>
  const expected = dims[0] * dims[1] * dims[2] * frameCount
  if (source.length < expected) throw new Error(`Image payload is truncated: expected ${expected} voxels, found ${source.length}`)
  const values = new Float32Array(expected)
  for (let i = 0; i < expected; i += 1) values[i] = Number(source[i]) * slope + intercept
  return {
    dims,
    frameCount,
    affine,
    pixDims,
    values,
    datatypeCode: Number(image.hdr?.datatypeCode) || 16,
    littleEndian: Boolean(image.hdr?.littleEndian ?? true),
    slope,
    intercept,
  }
}

async function loadFiles(modality: Modality, files: File[]) {
  if (!files.length) return
  if (fitResult) clearFit()
  if (!files.some(file => matchesSupportedExtension(file.name))) {
    throw new Error('Unsupported image format. Select a standard volumetric neuroimaging file.')
  }
  const displayName = files.length === 1 ? files[0].name : `${files[0].name} + ${files.length - 1} paired file${files.length === 2 ? '' : 's'}`
  const hadExistingImage = Boolean(loaded[modality])
  setImagePlaceholder(modality, 'loading', displayName)
  setStatus(`Loading ${displayName}…`)
  try {
    const nvImage = await NVImage.loadFromFile({ file: files.length === 1 ? files[0] : files, name: files[0].name })
    const raw = rawFromNVImage(nvImage)
    loaded[modality] = { name: displayName, raw, nvImage, sourceFiles: files.map(file => file.name) }
    document.querySelector<HTMLElement>(`#${modality}-name`)!.textContent = displayName
    for (const view of Object.values(views[modality])) {
      while (view.nv.volumes.length) view.nv.removeVolumeByIndex(0)
      view.nv.addVolume(nvImage.clone())
    }
    currentMm[modality] = applyAffine(raw.affine, [(raw.dims[0]-1)/2,(raw.dims[1]-1)/2,(raw.dims[2]-1)/2])
    gotoMm(modality, currentMm[modality]!)
    renderMarkers(modality)
    setImagePlaceholder(modality, 'hidden')
    setStatus(`${modality.toUpperCase()} loaded: ${raw.dims.join(' × ')} voxels from ${files.length} file${files.length === 1 ? '' : 's'}.`)
  } catch (error) {
    setImagePlaceholder(modality, hadExistingImage ? 'hidden' : 'empty')
    throw error
  }
}

function handleLocation(modality: Modality, mm: number[] | undefined, sourcePlane?: Plane) {
  if (!isFiniteVec3(mm)) return
  const nextMm: Vec3 = [mm[0], mm[1], mm[2]]
  currentMm[modality] = nextMm

  if (!suppressCrosshairSync[modality]) {
    suppressCrosshairSync[modality] = true
    setOrthogonalCrosshairs(modality, views[modality], nextMm, sourcePlane)
    requestAnimationFrame(() => { suppressCrosshairSync[modality] = false })
  } else {
    document.querySelector(`#${modality}-coords`)!.textContent = coordinateLabel(nextMm)
  }

  renderMarkers(modality)
  if (reviewImages && modality === reviewImages.fixedModality && !suppressReviewUpdate) gotoReviewMm(nextMm)
  if (fitResult && linkAfter.checked && !suppressLinkedUpdate) {
    const other: Modality = modality === 'mri' ? 'ct' : 'mri'
    if (!loaded[other]) return
    const mapped = applyMat4(
      (fitResult.direction === 'ct-mri' ? modality === 'ct' : modality === 'mri') ? fitResult.matrix : fitResult.inverse,
      nextMm,
    )
    suppressLinkedUpdate = true
    gotoMm(other, mapped)
    requestAnimationFrame(() => { suppressLinkedUpdate = false })
  }
}

function gotoMm(modality: Modality, mm: Vec3) {
  currentMm[modality] = mm
  setOrthogonalCrosshairs(modality, views[modality], mm)
  renderMarkers(modality)
  if (reviewImages && modality === reviewImages.fixedModality && !suppressReviewUpdate) gotoReviewMm(mm)
}

function gotoReviewMm(mm: Vec3) {
  suppressReviewUpdate = true
  setReviewCrosshairs(reviewViews, mm)
  renderReviewMarkers()
  requestAnimationFrame(() => { suppressReviewUpdate = false })
}

function renderMarkers(modality: Modality) {
  renderModalityMarkers({
    views: views[modality],
    loaded: loaded[modality],
    currentMm: currentMm[modality],
    landmarks,
    selectedId,
    fitResult,
    renderOptimizationWindow,
    onMarkerPointerDown: startMarkerDrag,
  })
}

function reviewPointFor(lm: Landmark, modality: Modality): Vec3 | null {
  if (!fitResult) return null
  const point = lm[modality]
  if (!point) return null
  const sourceMod: Modality = fitResult.direction === 'ct-mri' ? 'ct' : 'mri'
  return modality === sourceMod ? applyMat4(fitResult.matrix, point) : point
}

function renderReviewMarkers() {
  renderReviewLandmarks({
    views: reviewViews,
    fixedLoaded: reviewImages ? loaded[reviewImages.fixedModality] : null,
    fixedCurrentMm: reviewImages ? currentMm[reviewImages.fixedModality] : null,
    fitResult,
    pointFor: reviewPointFor,
    fixedModality: reviewImages?.fixedModality ?? null,
    movingModality: reviewImages?.movingModality ?? null,
  })
}

function startMarkerDrag(ev: PointerEvent, view: View, id: number) {
  ev.preventDefault(); ev.stopPropagation()
  selectedId = id; snapshot(); renderAll()
  const move = (e: PointerEvent) => {
    const rect = view.canvas.getBoundingClientRect()
    const x = (e.clientX - rect.left) * (view.canvas.width / rect.width)
    const y = (e.clientY - rect.top) * (view.canvas.height / rect.height)
    const mm = canvasPointToImageOnCurrentSlice(view, x, y)
    if (!mm) return
    const lm = landmarks.find(v => v.id === id); if (!lm) return
    const old = lm[view.modality]; if (!old) return
    const axis = planeDepthAxis(view.plane)
    mm[axis] = old[axis]
    lm[view.modality] = mm
    markLandmarksChanged(); renderAll()
  }
  const up = () => { window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',up); renderLandmarks() }
  window.addEventListener('pointermove',move)
  window.addEventListener('pointerup',up)
}

let renderAllFrame: number | null = null
function renderAllNow() {
  renderAllFrame = null
  renderMarkers('mri')
  renderMarkers('ct')
  renderReviewMarkers()
  renderLandmarks()
}
function renderAll() {
  if (renderAllFrame !== null) return
  renderAllFrame = requestAnimationFrame(renderAllNow)
}

function renderLandmarks() {
  document.querySelector('#pair-count')!.textContent = `${landmarks.length} pair${landmarks.length === 1 ? '' : 's'}`
  const selected = landmarks.find(lm => lm.id === selectedId)
  const selectedSummary = document.querySelector<HTMLDivElement>('#selected-landmark-summary')!
  selectedSummary.textContent = selected
    ? `Landmark ${selected.id} · MRI ${selected.mri ? 'set' : 'not set'} · CT ${selected.ct ? 'set' : 'not set'} · ${selected.enabled ? 'included' : 'excluded'}${selected.residual !== undefined ? ` · residual ${selected.residual.toFixed(2)} mm` : ''}`
    : 'No landmark selected'
  landmarkList.innerHTML = landmarks.length ? '' : '<div class="empty">No landmarks yet.</div>'
  for (const lm of landmarks) {
    const row = document.createElement('div')
    row.className = `landmark-row ${selectedId === lm.id ? 'selected' : ''}`
    const coord = (p: Vec3 | null) => p ? p.map(v=>v.toFixed(1)).join(', ') : 'not set'
    row.innerHTML = `
      <div class="landmark-head"><button class="select">Landmark ${lm.id}</button><label><input class="enabled" type="checkbox" ${lm.enabled?'checked':''}> use</label><button class="delete" title="Delete">×</button></div>
      <div class="point-row"><span>MRI</span><code>${coord(lm.mri)}</code><button class="set-mri">${lm.mri?'Replace':'Set'}</button><button class="go-mri" ${lm.mri?'':'disabled'}>Go</button></div>
      <div class="point-row"><span>CT</span><code>${coord(lm.ct)}</code><button class="set-ct">${lm.ct?'Replace':'Set'}</button><button class="go-ct" ${lm.ct?'':'disabled'}>Go</button></div>
      ${lm.residual !== undefined ? `<div class="residual">Residual: ${lm.residual.toFixed(2)} mm</div>` : ''}
    `
    row.querySelector('.select')!.addEventListener('click',()=>{selectedId=lm.id; if(lm.mri)gotoMm('mri',lm.mri); if(lm.ct)gotoMm('ct',lm.ct); renderAll()})
    row.querySelector('.enabled')!.addEventListener('change',(e)=>{snapshot();lm.enabled=(e.target as HTMLInputElement).checked;markLandmarksChanged();renderAll()})
    row.querySelector('.delete')!.addEventListener('click',()=>{snapshot();landmarks=landmarks.filter(v=>v.id!==lm.id);if(selectedId===lm.id)selectedId=null;markLandmarksChanged();renderAll()})
    for (const modality of ['mri','ct'] as Modality[]) {
      row.querySelector(`.set-${modality}`)!.addEventListener('click',()=>{
        if(!loaded[modality]||!currentMm[modality]) return setStatus(`Load ${modality.toUpperCase()} first.`,true)
        snapshot(); lm[modality]=[...currentMm[modality]!] as Vec3; selectedId=lm.id; markLandmarksChanged(); renderAll()
      })
      row.querySelector(`.go-${modality}`)!.addEventListener('click',()=>{if(lm[modality])gotoMm(modality,lm[modality]!);selectedId=lm.id;renderAll()})
    }
    landmarkList.appendChild(row)
  }
}

function markLandmarksChanged() {
  for (const lm of landmarks) delete lm.residual
  if (!fitResult) return
  fitResult.landmarksChanged = true
  fitSummary.innerHTML = `<strong>Accepted alignment preserved</strong><br>Current landmarks differ from the snapshot used for this alignment. Export, manual nudges, and accepted refinement remain available until you run a new landmark fit.`
  restoreAlignmentLandmarks.disabled = false
  setStatus('Landmarks changed. The accepted alignment is still active and exportable.')
}

function clearFit() {
  fitResult = null
  for (const lm of landmarks) delete lm.residual
  fitSummary.textContent = 'At least three complete, enabled landmark pairs are required.'
  saveAligned.disabled = true; saveTransform.disabled = true; document.querySelector<HTMLButtonElement>('#export-open')!.disabled = true; 
  resetManual.disabled = true; resetLandmark.disabled = true; refineButton.disabled = true; restoreAlignmentLandmarks.disabled = true
  refineSummary.textContent = 'Fits locally around the current transform using normalized mutual information and only geometrically overlapping voxels.'
  refineActions.classList.add('hidden')
  clearReview(); updateNudgeOutputs()
}

function clearReview() {
  reviewImages = null
  document.querySelector('#review-label')!.textContent = 'Fit a transform to review alignment'
  document.querySelectorAll('.review-placeholder').forEach(el => el.classList.remove('hidden'))
  for (const view of Object.values(reviewViews)) {
    while (view.nv.volumes.length) view.nv.removeVolumeByIndex(0)
    view.overlay.innerHTML = ''
  }
}

function makeResampledImage(source: Loaded, target: Loaded, matrix: Mat4): NVImage {
  const out = new Float32Array(target.raw.dims[0] * target.raw.dims[1] * target.raw.dims[2])
  const invSourceAffine = invertAffine(source.raw.affine)
  const targetToSource = invertRigid(matrix)
  const vals = frame(source.raw, 0)
  let idx = 0
  for (let k=0;k<target.raw.dims[2];k++) for (let j=0;j<target.raw.dims[1];j++) for (let i=0;i<target.raw.dims[0];i++,idx++) {
    const targetWorld = applyAffine(target.raw.affine,[i,j,k])
    const sourceWorld = applyMat4(targetToSource,targetWorld)
    const sourceVox = applyAffine(invSourceAffine,sourceWorld)
    out[idx] = sampleLinear(vals,source.raw.dims,sourceVox)
  }
  const copy = new NVImage(); Object.assign(copy,target.nvImage)
  if (!target.nvImage.hdr) throw new Error('Reference header unavailable')
  const outputHdr = JSON.parse(JSON.stringify(target.nvImage.hdr)) as NonNullable<NVImage['hdr']>
  outputHdr.datatypeCode=16; outputHdr.numBitsPerVoxel=32; outputHdr.scl_slope=1; outputHdr.scl_inter=0; outputHdr.dims[0]=3; outputHdr.dims[4]=1
  copy.hdr = outputHdr
  copy.img = out
  copy.name = `aligned_${source.name}`
  return copy
}

function applyReviewAppearance() {
  if (!reviewImages) return
  const opacity = Number(reviewOpacity.value) / 100
  opacityValue.textContent = `${reviewOpacity.value}%`
  for (const view of Object.values(reviewViews)) {
    if (view.nv.volumes.length < 2) continue
    const fixed = view.nv.volumes[0]
    const moving = view.nv.volumes[1]
    if (reviewMode.value === 'falsecolor') {
      view.nv.setColormap(fixed.id, 'green')
      view.nv.setColormap(moving.id, 'brainanaMagenta')
      fixed.opacity = 1
      moving.opacity = opacity
    } else {
      view.nv.setColormap(fixed.id, 'gray')
      view.nv.setColormap(moving.id, 'gray')
      fixed.opacity = 1
      moving.opacity = opacity
    }
    view.nv.updateGLVolume()
    view.nv.drawScene()
  }
}

function buildReview() {
  if (!fitResult) return
  const movingModality: Modality = fitResult.direction === 'ct-mri' ? 'ct' : 'mri'
  const fixedModality: Modality = fitResult.direction === 'ct-mri' ? 'mri' : 'ct'
  const moving = loaded[movingModality]
  const fixed = loaded[fixedModality]
  if (!moving || !fixed) return
  const aligned = makeResampledImage(moving, fixed, fitResult.matrix)
  reviewImages = { fixed: fixed.nvImage, moving: aligned, fixedModality, movingModality }
  for (const view of Object.values(reviewViews)) {
    while (view.nv.volumes.length) view.nv.removeVolumeByIndex(0)
    view.nv.addVolume(fixed.nvImage.clone())
    view.nv.addVolume(aligned.clone())
  }
  document.querySelector('#review-label')!.textContent = `${movingModality.toUpperCase()} aligned to ${fixedModality.toUpperCase()}${fitResult.landmarksChanged ? ' · using saved landmark snapshot' : ''}`
  document.querySelectorAll('.review-placeholder').forEach(el => el.classList.add('hidden'))
  applyReviewAppearance()
  gotoReviewMm(currentMm[fixedModality] ?? applyAffine(fixed.raw.affine,[(fixed.raw.dims[0]-1)/2,(fixed.raw.dims[1]-1)/2,(fixed.raw.dims[2]-1)/2]))
}

function runFit() {
  const complete = landmarks.filter(l=>l.enabled&&l.mri&&l.ct)
  if (complete.length < 3) return setStatus('At least three complete, enabled landmark pairs are required.',true)
  const direction = directionSelect.value
  const source = complete.map(l => direction === 'ct-mri' ? l.ct! : l.mri!)
  const target = complete.map(l => direction === 'ct-mri' ? l.mri! : l.ct!)
  try {
    const result = fitRigid(source,target)
    complete.forEach((l,i)=>l.residual=result.residuals[i])
    fitResult={direction,landmarkMatrix:result.matrix,baseMatrix:result.matrix,matrix:result.matrix,inverse:result.inverse,rms:result.rms,manual:[0,0,0,0,0,0],proposal:null,landmarkSnapshot:structuredClone(landmarks),landmarksChanged:false,fittedAt:new Date().toISOString()}
    fitSummary.innerHTML=`<strong>RMS error: ${result.rms.toFixed(3)} mm</strong><br>${complete.length} landmark pairs used.`
    saveAligned.disabled=false;saveTransform.disabled=false;resetManual.disabled=false;resetLandmark.disabled=false;refineButton.disabled=false;restoreAlignmentLandmarks.disabled=false;document.querySelector<HTMLButtonElement>('#export-open')!.disabled=false
    updateNudgeOutputs(); buildReview(); renderAll();setStatus(`Rigid transform fitted with RMS error ${result.rms.toFixed(3)} mm.`)
  } catch(err) { setStatus(err instanceof Error?err.message:String(err),true) }
}


function fixedCenter(): Vec3 {
  if (!fitResult) return [0,0,0]
  const fixedModality: Modality = fitResult.direction === 'ct-mri' ? 'mri' : 'ct'
  const fixed = loaded[fixedModality]!
  return applyAffine(fixed.raw.affine, [(fixed.raw.dims[0]-1)/2,(fixed.raw.dims[1]-1)/2,(fixed.raw.dims[2]-1)/2])
}

function residualRms(matrix: Mat4): number {
  if (!fitResult) return NaN
  const complete = fitResult.landmarkSnapshot.filter(l=>l.enabled&&l.mri&&l.ct)
  if (!complete.length) return NaN
  let sum = 0
  for (const lm of complete) {
    const source = fitResult.direction === 'ct-mri' ? lm.ct! : lm.mri!
    const target = fitResult.direction === 'ct-mri' ? lm.mri! : lm.ct!
    const q = applyMat4(matrix, source)
    const d = Math.hypot(q[0]-target[0],q[1]-target[1],q[2]-target[2])
    lm.residual = d; sum += d*d
  }
  return Math.sqrt(sum/complete.length)
}

function updateNudgeOutputs() {
  const params = fitResult?.manual ?? [0,0,0,0,0,0]
  params.forEach((v,i)=>{ const el=document.querySelector<HTMLOutputElement>(`#param-${i}`); if(el) el.value=`${v.toFixed(i<3?1:2)}${i<3?' mm':'°'}` })
}

function updateCurrentTransform(rebuild = true) {
  if (!fitResult) return
  const delta = rigidDelta(fitResult.manual, fixedCenter())
  fitResult.matrix = multiplyMat4(delta, fitResult.baseMatrix)
  fitResult.inverse = invertRigid(fitResult.matrix)
  fitResult.rms = residualRms(fitResult.matrix)
  fitResult.proposal = null
  refineActions.classList.add('hidden')
  fitSummary.innerHTML = fitResult.landmarksChanged ? `<strong>Accepted alignment preserved</strong><br>Manual correction is relative to the accepted base transform. Current landmarks differ from the alignment snapshot.` : `<strong>Alignment-snapshot RMS: ${fitResult.rms.toFixed(3)} mm</strong><br>Manual correction is relative to the accepted base transform.`
  updateNudgeOutputs(); renderAll()
  if (rebuild) scheduleReviewBuild()
}

function scheduleReviewBuild() {
  if (reviewBuildTimer !== null) window.clearTimeout(reviewBuildTimer)
  reviewBuildTimer = window.setTimeout(()=>{ reviewBuildTimer=null; buildReview() }, 120)
}


function updateWindowControls() {
  const mriCount = countOptimizationWindows(optimizationWindows, 'mri'), ctCount = countOptimizationWindows(optimizationWindows, 'ct')
  windowSummary.textContent = mriCount || ctCount
    ? `Active constraints: MRI ${mriCount} plane${mriCount === 1 ? '' : 's'}, CT ${ctCount} plane${ctCount === 1 ? '' : 's'}. Each defined plane restricts only its two visible axes; any plane without a window is unrestricted.`
    : 'No optimization windows defined. The full geometric overlap will be used.'
  defineWindows.textContent = definingWindows ? 'Finish defining windows' : 'Define windows'
  for (const modality of ['mri','ct'] as Modality[]) for (const view of Object.values(views[modality])) {
    const active = definingWindows && (windowTarget.value === 'both' || windowTarget.value === modality)
    view.windowLayer.classList.toggle('active', active)
    renderOptimizationWindow(view)
  }
}

function canvasToCss(view: View, pos: number[]): [number, number] {
  const rect = view.canvas.getBoundingClientRect()
  return [pos[0] * rect.width / Math.max(1, view.canvas.width), pos[1] * rect.height / Math.max(1, view.canvas.height)]
}

function renderOptimizationWindow(view: View) {
  view.windowLayer.replaceChildren()
  const bounds = optimizationWindows[view.modality][view.plane]
  if (!bounds || !loaded[view.modality]) return
  const [a, b, depth] = planeAxes[view.plane]
  const center = currentMm[view.modality] ?? [0,0,0]
  const first = [...center] as Vec3, second = [...center] as Vec3
  first[a] = bounds.min[a]; first[b] = bounds.min[b]; first[depth] = center[depth]
  second[a] = bounds.max[a]; second[b] = bounds.max[b]; second[depth] = center[depth]
  const raw0 = view.nv.frac2canvasPos(view.nv.mm2frac(first)), raw1 = view.nv.frac2canvasPos(view.nv.mm2frac(second))
  if (!raw0 || !raw1) return
  const p0 = canvasToCss(view, raw0), p1 = canvasToCss(view, raw1)
  const rect = document.createElement('div')
  rect.className = 'optimization-window-box'
  rect.style.left = `${Math.min(p0[0],p1[0])}px`
  rect.style.top = `${Math.min(p0[1],p1[1])}px`
  rect.style.width = `${Math.abs(p1[0]-p0[0])}px`
  rect.style.height = `${Math.abs(p1[1]-p0[1])}px`
  view.windowLayer.appendChild(rect)
}

function eventMm(view: View, event: PointerEvent): Vec3 | null {
  const rect = view.canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const pos: [number,number] = [
    (event.clientX-rect.left)*(view.canvas.width/rect.width),
    (event.clientY-rect.top)*(view.canvas.height/rect.height),
  ]
  const rawFrac = view.nv.canvasPos2frac(pos)
  if (!rawFrac) return null
  const frac = Array.from(rawFrac, Number)
  if (frac.length < 3 || !frac.slice(0,3).every(Number.isFinite)) return null
  const depthAxis = view.plane === 'sagittal' ? 0 : view.plane === 'coronal' ? 1 : 2
  frac[depthAxis] = Number(view.nv.scene.crosshairPos[depthAxis])
  const mm = Array.from(view.nv.frac2mm(frac), Number)
  if (mm.length < 3 || !mm.slice(0,3).every(Number.isFinite)) return null
  return [mm[0],mm[1],mm[2]]
}

function installWindowCapture(view: View) {
  installOptimizationWindowCapture({
    view,
    isEnabled: () => Boolean(
      loaded[view.modality] &&
      definingWindows &&
      (windowTarget.value === 'both' || windowTarget.value === view.modality)
    ),
    getPixDims: () => loaded[view.modality]?.raw.pixDims ?? null,
    eventToMm: event => eventMm(view, event),
    onCommit: bounds => {
      optimizationWindows[view.modality][view.plane] = bounds
      optimizationWindows = sanitizeOptimizationWindows(optimizationWindows)
      updateWindowControls()
      renderMarkers(view.modality)
      setStatus(`${view.modality.toUpperCase()} ${view.plane} optimization window set.`)
    },
    onReject: () => {
      delete optimizationWindows[view.modality][view.plane]
      optimizationWindows = sanitizeOptimizationWindows(optimizationWindows)
      setStatus('Optimization window was too small and was not saved.', true)
      updateWindowControls()
    },
  })
}

function optimizationConstraint(modality: Modality): WindowConstraint | null {
  return getOptimizationConstraint(optimizationWindows, modality)
}

function robustRange(values: Float32Array): [number, number] {
  const stride = Math.max(1, Math.floor(values.length/50000))
  const sample: number[]=[]
  for(let i=0;i<values.length;i+=stride){ const v=values[i]; if(Number.isFinite(v)) sample.push(v) }
  sample.sort((a,b)=>a-b)
  if(!sample.length) return [0,1]
  const at=(p:number)=>sample[Math.min(sample.length-1,Math.max(0,Math.floor(p*(sample.length-1))))]
  let lo=at(.01), hi=at(.99); if(!(hi>lo)){lo=sample[0];hi=sample[sample.length-1]||lo+1} if(!(hi>lo))hi=lo+1
  return [lo,hi]
}

type MetricContext = { fixed: Loaded; moving: Loaded; fixedModality: Modality; movingModality: Modality; movingWindow: WindowConstraint | null; points: Array<[Vec3,number]>; movingInv: number[][]; fixedRange:[number,number]; movingRange:[number,number]; overlapBox:{min:Vec3;max:Vec3}; candidateCount:number; overlapFractionFixed:number }
function imageCornersWorld(image: Loaded): Vec3[] {
  const [nx,ny,nz]=image.raw.dims
  const corners:Vec3[]=[]
  for(const i of [0,nx-1])for(const j of [0,ny-1])for(const k of [0,nz-1]) corners.push(applyAffine(image.raw.affine,[i,j,k]))
  return corners
}

function makeMetricContext(maxSamples=25000): MetricContext {
  if(!fitResult) throw new Error('Fit landmarks first')
  const movingModality: Modality = fitResult.direction === 'ct-mri' ? 'ct' : 'mri'
  const fixedModality: Modality = fitResult.direction === 'ct-mri' ? 'mri' : 'ct'
  const moving=loaded[movingModality]!,fixed=loaded[fixedModality]!
  const fixedWindow=optimizationConstraint(fixedModality), movingWindow=optimizationConstraint(movingModality)
  const fv=frame(fixed.raw,0), fixedInv=invertAffine(fixed.raw.affine)
  const transformedCorners=imageCornersWorld(moving).map(p=>applyMat4(fitResult!.matrix,p)).map(p=>applyAffine(fixedInv,p))
  const mins:[number,number,number]=[0,1,2].map(a=>Math.max(0,Math.floor(Math.min(...transformedCorners.map(p=>p[a]))))) as Vec3
  const maxs:[number,number,number]=[
    Math.min(fixed.raw.dims[0]-1,Math.ceil(Math.max(...transformedCorners.map(p=>p[0])))),
    Math.min(fixed.raw.dims[1]-1,Math.ceil(Math.max(...transformedCorners.map(p=>p[1])))),
    Math.min(fixed.raw.dims[2]-1,Math.ceil(Math.max(...transformedCorners.map(p=>p[2])))),
  ]
  if(maxs.some((v,a)=>v<mins[a])) throw new Error('The images have no geometric overlap at the current transform.')
  const candidateCount=(maxs[0]-mins[0]+1)*(maxs[1]-mins[1]+1)*(maxs[2]-mins[2]+1)
  let stride=Math.max(1,Math.ceil(Math.cbrt(candidateCount/maxSamples)))
  let points:Array<[Vec3,number]>=[]
  const collect = (step:number) => {
    const result:Array<[Vec3,number]>=[]
    for(let k=mins[2];k<=maxs[2];k+=step)for(let j=mins[1];j<=maxs[1];j+=step)for(let i=mins[0];i<=maxs[0];i+=step){
      const idx=i+fixed.raw.dims[0]*(j+fixed.raw.dims[1]*k); const v=fv[idx]
      const world=applyAffine(fixed.raw.affine,[i,j,k])
      if(Number.isFinite(v)&&withinOptimizationWindows(world,fixedWindow)) result.push([world,v])
    }
    return result
  }
  points=collect(stride)
  // Constraints can occupy a small part of a large overlap. Densify sampling
  // before deciding that the region is unusable. Missing planes remain fully unrestricted.
  while(points.length<1000 && stride>1){ stride=Math.max(1,Math.floor(stride/2)); points=collect(stride) }
  const fixedTotal=fixed.raw.dims[0]*fixed.raw.dims[1]*fixed.raw.dims[2]
  if (points.length < 64) {
    if (fixedWindow) {
      const planes = Object.keys(fixedWindow).join(', ')
      throw new Error(`The defined ${fixedModality.toUpperCase()} optimization window${Object.keys(fixedWindow).length === 1 ? '' : 's'} (${planes}) contain too few valid fixed-image voxels. Clear or enlarge a defined window. Any view without a window remains unrestricted.`)
    }
    throw new Error('The current transform leaves too few valid overlapping fixed-image voxels for automatic refinement. Adjust the alignment or verify the image geometry.')
  }
  return {fixed,moving,fixedModality,movingModality,movingWindow,points,movingInv:invertAffine(moving.raw.affine),fixedRange:robustRange(fv),movingRange:robustRange(frame(moving.raw,0)),overlapBox:{min:mins,max:maxs},candidateCount,overlapFractionFixed:candidateCount/fixedTotal}
}

function nmiScore(matrix: Mat4, ctx: MetricContext): number {
  const bins=40, joint=new Uint32Array(bins*bins), fh=new Uint32Array(bins), mh=new Uint32Array(bins)
  const mv=frame(ctx.moving.raw,0), invT=invertRigid(matrix)
  const [flo,fhi]=ctx.fixedRange,[mlo,mhi]=ctx.movingRange
  let n=0
  for(const [world,fv] of ctx.points){
    const sw=applyMat4(invT,world); if(!withinOptimizationWindows(sw,ctx.movingWindow))continue; const vox=applyAffine(ctx.movingInv,sw)
    if(vox[0]<0||vox[1]<0||vox[2]<0||vox[0]>=ctx.moving.raw.dims[0]-1||vox[1]>=ctx.moving.raw.dims[1]-1||vox[2]>=ctx.moving.raw.dims[2]-1)continue
    const mvv=sampleLinear(mv,ctx.moving.raw.dims,vox); if(!Number.isFinite(mvv))continue
    if(fv<=flo && mvv<=mlo) continue
    const fb=Math.max(0,Math.min(bins-1,Math.floor((fv-flo)/(fhi-flo)*bins)))
    const mb=Math.max(0,Math.min(bins-1,Math.floor((mvv-mlo)/(mhi-mlo)*bins)))
    fh[fb]++;mh[mb]++;joint[fb*bins+mb]++;n++
  }
  if(n<Math.min(500, Math.max(64, Math.floor(ctx.points.length*0.25))))return -Infinity
  const entropy=(hist:Uint32Array)=>{let h=0;for(const c of hist)if(c){const p=c/n;h-=p*Math.log(p)}return h}
  const hj=entropy(joint); return hj>0?(entropy(fh)+entropy(mh))/hj:-Infinity
}

async function runRefinement() {
  if(!fitResult||!loaded.mri||!loaded.ct)return
  refineButton.disabled=true; setStatus('Preparing constrained mutual-information refinement…')
  await new Promise(r=>setTimeout(r,20))
  try{
    const ctx=makeMetricContext(30000), start=fitResult.matrix.map(r=>[...r])
    const tLimit=Number(refineTranslationLimit.value), rLimit=Number(refineRotationLimit.value)
    const tStep=Number(refineTranslationStartStep.value), rStep=Number(refineRotationStartStep.value)
    if(![tLimit,rLimit,tStep,rStep].every(v=>Number.isFinite(v)&&v>0)) throw new Error('Refinement limits and steps must be positive numbers.')
    const limits:Params6=[tLimit,tLimit,tLimit,rLimit,rLimit,rLimit]
    let params:Params6=[0,0,0,0,0,0]
    let steps:Params6=[Math.min(tStep,tLimit),Math.min(tStep,tLimit),Math.min(tStep,tLimit),Math.min(rStep,rLimit),Math.min(rStep,rLimit),Math.min(rStep,rLimit)]
    const center=fixedCenter(), matrixFor=(p:Params6)=>multiplyMat4(rigidDelta(p,center),start)
    const before=nmiScore(start,ctx); let best=before
    for(let level=0;level<4;level++){
      let improved=true,passes=0
      while(improved&&passes<2){ improved=false;passes++
        for(let axis=0;axis<6;axis++){
          let bestAxis=best,bestValue=params[axis]
          for(const sign of [-1,1]){
            const candidate=[...params] as Params6; candidate[axis]=Math.max(-limits[axis],Math.min(limits[axis],candidate[axis]+sign*steps[axis]))
            if(candidate[axis]===params[axis])continue
            const score=nmiScore(matrixFor(candidate),ctx)
            if(score>bestAxis+1e-6){bestAxis=score;bestValue=candidate[axis]}
          }
          if(bestValue!==params[axis]){params[axis]=bestValue;best=bestAxis;improved=true}
        }
        await new Promise(r=>setTimeout(r,0))
      }
      steps=steps.map(v=>v/2) as Params6
    }
    const proposal=matrixFor(params)
    fitResult.proposal={matrix:proposal,scoreBefore:before,scoreAfter:best,params}
    fitResult.matrix=proposal;fitResult.inverse=invertRigid(proposal);fitResult.rms=residualRms(proposal)
    buildReview();renderAll()
    const gain=best-before
    const hit=params.some((v,i)=>Math.abs(v)>=limits[i]-1e-6)
    refineSummary.innerHTML=`<strong>NMI ${before.toFixed(5)} → ${best.toFixed(5)}</strong><br>Gain ${gain.toFixed(5)}; proposed Δ ${params.slice(0,3).map(v=>v.toFixed(2)).join(', ')} mm and ${params.slice(3).map(v=>v.toFixed(2)).join(', ')}°<br>Overlap box ${ctx.candidateCount.toLocaleString()} fixed-grid voxels (${(100*ctx.overlapFractionFixed).toFixed(1)}% of fixed image); ${ctx.points.length.toLocaleString()} samples evaluated.${hit?'<br><span class="warning">Warning: a search bound was reached.</span>':''}`
    refineActions.classList.remove('hidden');setStatus('Automatic refinement proposal ready. Review it, then accept or reject.')
  }catch(err){setStatus(err instanceof Error?err.message:String(err),true)}finally{refineButton.disabled=false}
}

function acceptRefinement(){
  if(!fitResult?.proposal)return
  fitResult.baseMatrix=fitResult.proposal.matrix;fitResult.matrix=fitResult.proposal.matrix;fitResult.inverse=invertRigid(fitResult.matrix);fitResult.manual=[0,0,0,0,0,0];fitResult.proposal=null
  fitResult.rms=residualRms(fitResult.matrix);refineActions.classList.add('hidden');updateNudgeOutputs();buildReview();renderAll();setStatus('Automatic refinement accepted.')
}
function rejectRefinement(){
  if(!fitResult?.proposal)return
  fitResult.proposal=null;updateCurrentTransform(true);refineSummary.textContent='Refinement rejected. The previous accepted transform has been restored.';setStatus('Automatic refinement rejected.')
}

function currentSession() {
  return createSessionPayload({
    appVersion: APP_VERSION,
    loaded,
    landmarks,
    selectedId,
    nextId,
    direction: directionSelect.value,
    fit: fitResult,
    optimizationWindows,
  })
}

async function saveSessionFile() {
  await saveArtifact(
    new Blob([JSON.stringify(currentSession(), null, 2)], { type: 'application/json' }),
    'brainana-align_session.json',
  )
  setStatus('Session saved.')
}

async function loadSessionFile(file: File) {
  const payload = parseSessionPayload(JSON.parse(await file.text()))
  const mismatch = sessionGeometryMismatches(payload.images, loaded)
  let restoreFit = true
  if (mismatch.length) {
    restoreFit = false
    const ok = window.confirm(`Image geometry does not match the saved session:\n\n${mismatch.join('\n')}\n\nLoad landmarks only?`)
    if (!ok) return
  }
  snapshot()
  landmarks = structuredClone(payload.landmarks)
  selectedId = payload.selectedId
  nextId = Math.max(payload.nextId, ...landmarks.map(landmark => landmark.id + 1), 1)
  directionSelect.value = payload.direction
  optimizationWindows = sanitizeOptimizationWindows(structuredClone(payload.optimizationWindows))
  updateWindowControls()
  if (restoreFit && payload.fit && loaded.mri && loaded.ct) {
    fitResult = structuredClone(payload.fit)
    if (!fitResult.landmarkSnapshot) fitResult.landmarkSnapshot = structuredClone(payload.landmarks)
    if (fitResult.landmarksChanged === undefined) fitResult.landmarksChanged = false
    if (!fitResult.fittedAt) fitResult.fittedAt = payload.savedAt
    saveAligned.disabled = false
    saveTransform.disabled = false
    resetManual.disabled = false
    resetLandmark.disabled = false
    refineButton.disabled = false
    restoreAlignmentLandmarks.disabled = false
    document.querySelector<HTMLButtonElement>('#export-open')!.disabled = false
    updateNudgeOutputs()
    buildReview()
    fitSummary.innerHTML = fitResult.landmarksChanged
      ? '<strong>Accepted alignment restored</strong><br>Current landmarks differ from the saved alignment snapshot.'
      : '<strong>Accepted alignment restored</strong><br>Landmarks match the saved alignment snapshot.'
  } else {
    clearFit()
  }
  renderAll()
  setStatus(restoreFit && payload.fit ? 'Full session restored.' : 'Landmarks restored; fit was not restored.')
}

async function saveTransformFiles() {
  if (!fitResult) return
  await saveArtifacts(createRegistrationArtifacts({ appVersion: APP_VERSION, fit: fitResult, landmarks }))
  setStatus('Transform files saved.')
}

async function saveAlignedImage() {
  if (!fitResult) return
  const sourceMod: Modality = fitResult.direction === 'ct-mri' ? 'ct' : 'mri'
  const targetMod: Modality = fitResult.direction === 'ct-mri' ? 'mri' : 'ct'
  const source = loaded[sourceMod]
  const target = loaded[targetMod]
  if (!source || !target) return setStatus('Both images must be loaded.', true)
  setStatus('Resampling aligned image…')
  await new Promise(resolve => setTimeout(resolve, 20))
  const copy = makeResampledImage(source, target, fitResult.matrix)
  await saveArtifact(
    new Blob([gzipSync(copy.toUint8Array())], { type: 'application/gzip' }),
    `${sourceMod}_space-${targetMod.toUpperCase()}_rigid.nii.gz`,
  )
  setStatus('Aligned image saved.')
}

document.querySelector<HTMLInputElement>('#mri-file')!.addEventListener('change',e=>{const files=Array.from((e.target as HTMLInputElement).files ?? []);if(files.length)loadFiles('mri',files).catch(err=>setStatus(err.message,true))})
document.querySelector<HTMLInputElement>('#ct-file')!.addEventListener('change',e=>{const files=Array.from((e.target as HTMLInputElement).files ?? []);if(files.length)loadFiles('ct',files).catch(err=>setStatus(err.message,true))})
document.querySelector('#new-pair')!.addEventListener('click',()=>{snapshot();const lm={id:nextId++,mri:null,ct:null,enabled:true};landmarks.push(lm);selectedId=lm.id;markLandmarksChanged();renderAll()})
document.querySelector('#undo')!.addEventListener('click',()=>{const prev=history.pop();if(prev){landmarks=prev;markLandmarksChanged();renderAll()}})
directionSelect.addEventListener('change',clearFit)
saveTransform.addEventListener('click',()=>saveTransformFiles().catch(err=>setStatus(err instanceof Error?err.message:String(err),true)))
saveAligned.addEventListener('click',()=>saveAlignedImage().catch(err=>setStatus(err.message,true)))
reviewMode.addEventListener('change', applyReviewAppearance)
reviewOpacity.addEventListener('input', applyReviewAppearance)
document.querySelectorAll<HTMLButtonElement>('#nudge-controls button').forEach(button=>button.addEventListener('click',()=>{
  if(!fitResult)return
  const index=Number(button.dataset.param),sign=Number(button.dataset.sign)
  const step=index<3?Number(translationStep.value):Number(rotationStep.value)
  fitResult.manual[index]+=sign*step;updateCurrentTransform(true)
}))
resetManual.addEventListener('click',()=>{if(!fitResult)return;fitResult.manual=[0,0,0,0,0,0];updateCurrentTransform(true);setStatus('Manual nudges reset.')})
resetLandmark.addEventListener('click',()=>{if(!fitResult)return;fitResult.baseMatrix=fitResult.landmarkMatrix;fitResult.manual=[0,0,0,0,0,0];updateCurrentTransform(true);setStatus('Restored the original landmark fit.')})
refineButton.addEventListener('click',()=>runRefinement())
defineWindows.addEventListener('click',()=>{definingWindows=!definingWindows;updateWindowControls();renderMarkers('mri');renderMarkers('ct');setStatus(definingWindows?'Drag a rectangle in any selected MRI or CT panel. Draw in multiple planes to define a 3D block.':'Optimization-window definition finished.')})
clearWindows.addEventListener('click',()=>{optimizationWindows={mri:{},ct:{}};updateWindowControls();renderMarkers('mri');renderMarkers('ct');setStatus('Optimization windows cleared.')})
windowTarget.addEventListener('change',updateWindowControls)
updateWindowControls()
acceptRefine.addEventListener('click',acceptRefinement)
rejectRefine.addEventListener('click',rejectRefinement)
document.querySelector('#save-session')!.addEventListener('click',()=>saveSessionFile().catch(err=>setStatus(err instanceof Error?err.message:String(err),true)))
document.querySelector<HTMLInputElement>('#load-session')!.addEventListener('change',e=>{const file=(e.target as HTMLInputElement).files?.[0];if(file)loadSessionFile(file).catch(err=>setStatus(err instanceof Error?err.message:String(err),true));(e.target as HTMLInputElement).value=''})
refineBounds.addEventListener('change',()=>{
  if(refineBounds.value==='tight'){refineTranslationLimit.value='2';refineRotationLimit.value='1';refineTranslationStartStep.value='1';refineRotationStartStep.value='0.5'}
  else if(refineBounds.value==='standard'){refineTranslationLimit.value='5';refineRotationLimit.value='10';refineTranslationStartStep.value='2';refineRotationStartStep.value='1'}
})
for(const input of [refineTranslationLimit,refineRotationLimit,refineTranslationStartStep,refineRotationStartStep])input.addEventListener('input',()=>{refineBounds.value='custom'})

document.querySelector('#fit-side')!.addEventListener('click',runFit)
const exportModal=document.querySelector<HTMLDivElement>('#export-modal')!
const openExport=()=>exportModal.classList.remove('hidden')
const closeExport=()=>exportModal.classList.add('hidden')
document.querySelector('#export-open')!.addEventListener('click',openExport)
document.querySelector('#export-close')!.addEventListener('click',closeExport)
exportModal.addEventListener('click',e=>{if(e.target===exportModal)closeExport()})
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeExport()})
document.querySelector('#save-session-export')!.addEventListener('click',()=>saveSessionFile().catch(err=>setStatus(err instanceof Error?err.message:String(err),true)))

restoreAlignmentLandmarks.addEventListener('click',()=>{
  if(!fitResult)return
  snapshot()
  landmarks=structuredClone(fitResult.landmarkSnapshot)
  selectedId=landmarks.find(l=>l.id===selectedId)?.id ?? landmarks[0]?.id ?? null
  fitResult.landmarksChanged=false
  residualRms(fitResult.matrix)
  fitSummary.innerHTML=`<strong>Alignment landmarks restored</strong><br>Current landmarks again match the snapshot used by the accepted alignment.`
  renderAll();setStatus('Restored the landmark snapshot used for the accepted alignment.')
})


function resetAllViews() {
  const all = [
    ...Object.values(views.mri),
    ...Object.values(views.ct),
    ...Object.values(reviewViews),
  ]
  for (const view of all) {
    view.nv.scene.pan2Dxyzmm = [0, 0, 0, 1] as any
    view.nv.drawScene()
  }
  renderMarkers('mri')
  renderMarkers('ct')
  renderReviewMarkers()
  setStatus('Zoom and field of view reset for all panels.')
}

document.querySelector('#reset-view')!.addEventListener('click', resetAllViews)

const browserCapabilities = detectBrowserCapabilities()
const browserReady = installBrowserCompatibilityBanner(browserCapabilities)
if (browserReady) {
  setupViews()
  setupReviewViews()
} else {
  setStatus('This browser cannot initialize the required WebGL2 viewer.', true)
}
renderLandmarks()
installRuntimeIntegration(loadFiles, setStatus)
