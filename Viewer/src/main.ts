import { detectGraphicsSupport, installWebGLContextLifecycleReporting, renderGraphicsFailure } from './browserSupport'
import './style.css'
import { Niivue, NVImage, NVMesh, NVMeshLayerDefaults, SLICE_TYPE } from '@niivue/niivue'
import { gzipSync, zipSync } from 'fflate'
import { createGaussianRoi, frame as rawFrame, loadRawNifti, normalizePositive, resampleNmt as resampleNmtRaw, resampleScanner as resampleScannerRaw, resampleScannerToT1w, resampleTemplateToT1w, scalarCorrelation as rawScalarCorrelation } from './roiWarp'

type LocationData = { mm?: number[]; vox?: number[]; values?: number[] }
type SurfaceKind = 'pial' | 'smoothwm' | 'inflated' | 'veryinflated' | 'sphere'
type ArmLookupEntry = { id: number; label: string; region: string; name: string; nameFull: string; hemi: string }
type ArmLookupRecord = Record<string, ArmLookupEntry>
type D99LookupRecord = Record<string, { name: string; region?: string }>
type AtlasKind = 'charm' | 'd99'
type AtlasLayerState = {
  visible: boolean
  opacity: number
}
type LabelLut = { lut: Uint8ClampedArray; min: number; max: number; labels: string[] }
type AtlasReportRow = { key: string; atlas: string; value: number | null; label: string }
type FunctionalDisplay = 'none' | 'polar' | 'eccentricity'
type FunctionalThreshold = 'none' | 'polarF' | 'eccentricityF'
type SomatotopyDisplay = 'none' | 'phase'

type AssetPair = { left: string; right: string }
type TemplateCapability = { enabled: boolean; transform?: string; reference?: string; reason?: string }
type TemplateManifest = { import: TemplateCapability; export: TemplateCapability }
type RuntimeConfig = { app: string; version: string; buildId: string; mode: 'local' | 'proxy' | 'workstation'; workstation: boolean; capabilities: { serverSideExport: boolean; localDirectoryPicker: boolean } }
type MonkeyManifest = {
  id: string
  label: string
  relativePath: string
  anatomy: string | null
  atlases: { charm: Record<string, string | null>; d99: string | null }
  function: {
    retinotopy: { combined: string; frames: { polar: number; polarF: number; eccentricity: number; eccentricityF: number } } | null
    somatotopy: { combined: string; frames: { phase: number; fstat: number } } | null
  }
  surfaces: Record<SurfaceKind | 'white', AssetPair | null>
  morphology: {
    raw: Record<'curvature' | 'sulc' | 'thickness', AssetPair>
    shape: Record<'curvature' | 'sulc' | 'thickness', AssetPair>
  }
  capabilities: { volume: boolean; surfaces: boolean; atlases: boolean; retinotopy: boolean; somatotopy: boolean }
  transforms?: {
    scanner?: { reference: string; outputToT1wAffine: string } | null
    nmt2sym?: { reference: string; outputToT1wWarp: string; inputToT1wWarp?: string | null } | null
    templates?: Record<string, TemplateManifest>
  }
}
let currentMonkey: MonkeyManifest | null = null
let runtimeConfig: RuntimeConfig = { app: 'brainana-viewer', version: '2.1.0', buildId: 'unknown', mode: 'local', workstation: false, capabilities: { serverSideExport: false, localDirectoryPicker: true } }
function requireMonkey(): MonkeyManifest {
  if (!currentMonkey) throw new Error('Select a monkey first')
  return currentMonkey
}
function requiredUrl(value: string | null | undefined, label: string): string {
  if (!value) throw new Error(`${label} is not available for this monkey`)
  return value
}

type FunctionalSources = {
  polar: NVImage | null
  polarF: NVImage | null
  eccentricity: NVImage | null
  eccentricityF: NVImage | null
}
type SomatotopySources = { phase: NVImage | null; fstat: NVImage | null }

const SURFACE_SCALE = 2.15
const SURFACE_SCALE_BY_KIND: Record<SurfaceKind, number> = {
  pial: SURFACE_SCALE,
  smoothwm: SURFACE_SCALE,
  inflated: 1.45,
  veryinflated: 1.35,
  sphere: 1.25,
}
const INFLATED_VERTICAL_OFFSET_MM = 6
const ARM_MIN = -1501
const ARM_MAX = 1818
const D99_MIN = 0
const D99_MAX = 522

const views = {
  sagittal: new Niivue({ show3Dcrosshair: false, isColorbar: false }),
  coronal: new Niivue({ show3Dcrosshair: false, isColorbar: false }),
  axial: new Niivue({ show3Dcrosshair: false, isColorbar: false }),
  surface: new Niivue({ show3Dcrosshair: false, isColorbar: false }),
}

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <header class="toolbar">
    <div class="brand">Brainana Viewer <span class="badge">v1.2.25</span></div>
    <label>Monkey <select id="monkey-select"><option value="">Select monkey…</option></select></label>
    <label>Surface
      <select id="surface-kind">
        <option value="pial">Pial</option>
        <option value="smoothwm">SmoothWM</option>
        <option value="inflated">Inflated</option>
        <option value="veryinflated">Very Inflated</option>
        <option value="sphere">Sphere</option>
      </select>
    </label>
    <button id="atlas-panel-button" class="active">Atlases</button>
    <button id="morphology-panel-button">Morphology</button>
    <button id="function-panel-button">Function</button>
    <button id="import-panel-button">Imported</button>
    <button id="import-button" class="snapshot-button" title="Import a NIfTI volume">Import</button>
    <button id="snapshot-button" class="snapshot-button" title="Export images, metadata, and ROI files">Export</button>
    <button id="reset">Reset views</button>
    <span id="status">Starting…</span>
  </header>
  <div id="monkey-placeholder" class="monkey-placeholder">Select a monkey to begin.</div>

  <div id="atlas-panel" class="atlas-panel" aria-label="Atlas controls">
    <div class="atlas-panel-header">
      <strong>Atlases</strong>
      <button id="atlas-panel-close" class="icon-button" aria-label="Close atlas panel">×</button>
    </div>

    <section class="atlas-control-group">
      <h3>ARM</h3>
      <label class="control-row checkbox-row">
        <input id="charm-visible" type="checkbox">
        <span>Visible on volume</span>
      </label>
      <label class="control-row checkbox-row">
        <input id="charm-surface-visible" type="checkbox">
        <span>Visible on surface</span>
      </label>
      <label class="control-row">
        <span>Visible level</span>
        <select id="charm-level">
          <option value="1">Level 1</option>
          <option value="2" selected>Level 2</option>
          <option value="3">Level 3</option>
          <option value="4">Level 4</option>
          <option value="5">Level 5</option>
          <option value="6">Level 6</option>
        </select>
      </label>
      <label class="control-row opacity-row">
        <span>Opacity</span>
        <input id="charm-opacity" type="range" min="0" max="1" value="0.58" step="0.02">
        <output id="charm-opacity-value">58%</output>
      </label>
      <label class="control-row checkbox-row">
        <input id="charm-lookup" type="checkbox" checked disabled>
        <span>Always report all six levels</span>
      </label>
    </section>

    <section class="atlas-control-group">
      <h3>D99</h3>
      <label class="control-row checkbox-row">
        <input id="d99-visible" type="checkbox">
        <span>Visible on volume</span>
      </label>
      <label class="control-row checkbox-row">
        <input id="d99-surface-visible" type="checkbox">
        <span>Visible on surface</span>
      </label>
      <label class="control-row opacity-row">
        <span>Opacity</span>
        <input id="d99-opacity" type="range" min="0" max="1" value="0.48" step="0.02">
        <output id="d99-opacity-value">48%</output>
      </label>
      <label class="control-row checkbox-row">
        <input id="d99-lookup" type="checkbox" checked disabled>
        <span>Always report at location</span>
      </label>
    </section>

    <p class="atlas-panel-note">Lookup and visibility are independent. Hidden atlases can still contribute to the location report.</p>
  </div>


  <div id="morphology-panel" class="atlas-panel morphology-panel" aria-label="Surface morphology controls">
    <div class="atlas-panel-header">
      <strong>Morphology</strong>
      <button id="morphology-panel-close" class="icon-button" aria-label="Close morphology panel">×</button>
    </div>

    <section class="atlas-control-group">
      <h3>Display</h3>
      <label class="control-row">
        <span>Morphology</span>
        <select id="morphology-display">
          <option value="curvature" selected>Curvature</option>
          <option value="sulc">Sulcal depth</option>
          <option value="thickness">Thickness</option>
          <option value="none">None</option>
        </select>
      </label>
      <label class="control-row">
        <span>Yellow marker</span>
        <select id="surface-marker-mode">
          <option value="crosshair3d" selected>3D crosshair position</option>
          <option value="nearestNode">Nearest surface node</option>
        </select>
      </label>
      <p class="atlas-panel-note">Nearest surface node snaps only the yellow marker. The volume crosshair remains unchanged.</p>
    </section>

    <section class="atlas-control-group" id="curvature-style-group">
      <h3>Curvature style</h3>
      <label class="control-row">
        <span>Style</span>
        <select id="curvature-style">
          <option value="binary" selected>Binary (FreeSurfer)</option>
          <option value="continuous">Continuous grayscale</option>
        </select>
      </label>
      <p class="atlas-panel-note">Binary uses light gray for concave cortex and dark gray for convex cortex.</p>
    </section>

    <section class="atlas-control-group" id="morphology-range-group">
      <div class="range-heading">
        <h3>Color range</h3>
        <button id="morphology-auto" class="small-button">Auto 2.5–97.5%</button>
      </div>
      <div class="range-values">
        <output id="morphology-min-value">—</output>
        <output id="morphology-max-value">—</output>
      </div>
      <div id="morphology-dual-range" class="dual-range curvature">
        <div class="dual-range-track"></div>
        <div class="dual-range-selection"></div>
        <input id="morphology-min" class="range-thumb" type="range" aria-label="Morphology minimum">
        <input id="morphology-max" class="range-thumb" type="range" aria-label="Morphology maximum">
      </div>
      <label class="control-row checkbox-row">
        <input id="morphology-symmetric" type="checkbox" checked>
        <span>Symmetric around zero</span>
      </label>
      <p class="atlas-panel-note">Auto range uses the 2.5th and 97.5th percentiles across both hemispheres.</p>
    </section>
  </div>



  <div id="function-panel" class="atlas-panel function-panel" aria-label="Functional overlay controls">
    <div class="atlas-panel-header">
      <strong>Function</strong>
      <button id="function-panel-close" class="icon-button" aria-label="Close function panel">×</button>
    </div>

    <section class="atlas-control-group">
      <h3>Retinotopy</h3>
      <label class="control-row">
        <span>Display map</span>
        <select id="functional-display">
          <option value="none" selected>None</option>
          <option value="polar">Polar angle</option>
          <option value="eccentricity">Eccentricity</option>
        </select>
      </label>
      <label class="control-row">
        <span>Threshold map</span>
        <select id="functional-threshold-map" disabled>
          <option value="none">None</option>
          <option value="polarF" selected>Polar-angle F</option>
          <option value="eccentricityF">Eccentricity F</option>
        </select>
      </label>
      <label class="control-row opacity-row">
        <span>F threshold</span>
        <input id="functional-threshold" type="range" disabled min="0" max="120" value="5" step="0.5">
        <output id="functional-threshold-value">5.0</output>
      </label>
      <label class="control-row opacity-row">
        <span>Opacity</span>
        <input id="functional-opacity" type="range" disabled min="0" max="1" value="0.78" step="0.02">
        <output id="functional-opacity-value">78%</output>
      </label>
      <label class="control-row opacity-row">
        <span>Surface brightness</span>
        <input id="functional-surface-brightness" type="range" disabled min="0.5" max="2" value="1.25" step="0.05">
        <output id="functional-surface-brightness-value">125%</output>
      </label>
      <label class="control-row checkbox-row">
        <input id="functional-volume-visible" type="checkbox" checked disabled>
        <span>Visible on volume</span>
      </label>
      <label class="control-row checkbox-row">
        <input id="functional-surface-visible" type="checkbox" disabled>
        <span>Visible on surface</span>
      </label>
      <div id="projection-progress" class="projection-progress hidden">
        <span id="projection-progress-label">Projecting…</span>
        <progress id="projection-progress-bar" max="100" value="0"></progress>
      </div>
    </section>

    <p class="atlas-panel-note">Retinotopy is loaded only when you choose Polar angle or Eccentricity. Display and threshold maps remain independent after loading.</p>

    <section class="atlas-control-group">
      <h3>Somatotopy</h3>
      <label class="control-row">
        <span>Display map</span>
        <select id="somatotopy-display">
          <option value="none" selected>None</option>
          <option value="phase">Body map</option>
        </select>
      </label>
      <label class="control-row">
        <span>Threshold map</span>
        <select id="somatotopy-threshold-map" disabled>
          <option value="fstat" selected>Somatotopy F</option>
        </select>
      </label>
      <label class="control-row opacity-row">
        <span>F threshold</span>
        <input id="somatotopy-threshold" type="range" disabled min="0" max="120" value="5" step="0.5">
        <output id="somatotopy-threshold-value">5.0</output>
      </label>
      <label class="control-row opacity-row">
        <span>Opacity</span>
        <input id="somatotopy-opacity" type="range" disabled min="0" max="1" value="0.78" step="0.02">
        <output id="somatotopy-opacity-value">78%</output>
      </label>
      <label class="control-row opacity-row">
        <span>Surface brightness</span>
        <input id="somatotopy-surface-brightness" type="range" disabled min="0.5" max="2" value="1.25" step="0.05">
        <output id="somatotopy-surface-brightness-value">125%</output>
      </label>
      <label class="control-row checkbox-row">
        <input id="somatotopy-volume-visible" type="checkbox" checked disabled>
        <span>Visible on volume</span>
      </label>
      <label class="control-row checkbox-row">
        <input id="somatotopy-surface-visible" type="checkbox" disabled>
        <span>Visible on surface</span>
      </label>
      <div id="somatotopy-projection-progress" class="projection-progress hidden">
        <span id="somatotopy-projection-progress-label">Projecting…</span>
        <progress id="somatotopy-projection-progress-bar" max="100" value="0"></progress>
      </div>
    </section>
    <section class="atlas-control-group">
      <h3>Surface overlap</h3>
      <label class="control-row">
        <span>Top layer</span>
        <select id="functional-surface-order">
          <option value="somatotopy" selected>Somatotopy</option>
          <option value="retinotopy">Retinotopy</option>
        </select>
      </label>
      <p class="atlas-panel-note">Retinotopy and somatotopy can be displayed together on the surface. Opacity and brightness remain independent.</p>
    </section>
    <p class="atlas-panel-note">Somatotopy uses frame 0 for the 0–100 body-position map and frame 1 for the F statistic.</p>
  </div>


  <div id="imported-panel" class="atlas-panel imported-panel" aria-label="Imported volume controls">
    <div class="atlas-panel-header">
      <strong>Imported</strong>
      <button id="imported-panel-close" class="icon-button" aria-label="Close imported panel">×</button>
    </div>
    <div id="imported-empty" class="imported-empty">No imported volumes. Use Import to add anatomical, atlas, or functional data.</div>
    <div id="imported-layer-list" class="imported-layer-list"></div>
  </div>

  <div id="import-dialog" class="snapshot-dialog hidden" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
    <div class="snapshot-card import-card">
      <div class="snapshot-card-header">
        <div><h2 id="import-dialog-title">Import NIfTI</h2><p>Add a 3D anatomical, atlas, or functional image to the active monkey.</p></div>
        <button id="import-close" class="icon-button" aria-label="Close import dialog">×</button>
      </div>
      <fieldset class="snapshot-options import-file-section">
        <legend>File</legend>
        <div class="import-browser-toolbar">
          <button id="import-up" type="button" class="small-button">Up</button>
          <input id="import-search" type="search" placeholder="Search this folder" aria-label="Search files">
        </div>
        <div id="import-path" class="monkey-folder-path">/</div>
        <div id="import-file-list" class="monkey-folder-list import-file-list" role="listbox" aria-label="NIfTI files"></div>
        <div id="import-selected-file" class="monkey-folder-note">Choose a .nii or .nii.gz file.</div>
      </fieldset>
      <fieldset class="snapshot-options import-settings-grid">
        <legend>Import settings</legend>
        <label><span>Input space</span><select id="import-space"><option value="T1w" selected>T1w</option><option value="scanner">Scanner</option></select></label>
        <label><span>Data type</span><select id="import-type"><option value="anatomical" selected>Anatomical</option><option value="atlas">Atlas / labels</option><option value="functional">Functional / statistical</option></select></label>
        <label><span>Interpolation</span><select id="import-interpolation"><option value="auto" selected>Auto</option><option value="nearest">Nearest neighbor</option><option value="linear">Linear</option></select></label>
        <label><span>Display name</span><input id="import-name" type="text" maxlength="80"></label>
        <p id="import-auto-note" class="snapshot-help import-auto-note">Auto selected: Linear</p>
      </fieldset>
      <div id="import-progress" class="snapshot-progress hidden">Reading NIfTI…</div>
      <div id="import-error" class="snapshot-error hidden" role="alert"></div>
      <div class="snapshot-actions"><button id="import-cancel" type="button">Cancel</button><button id="import-confirm" type="button" class="primary-button" disabled>Import</button></div>
    </div>
  </div>

  <div id="monkey-folder-dialog" class="snapshot-dialog hidden" role="dialog" aria-modal="true" aria-labelledby="monkey-folder-dialog-title">
    <div class="snapshot-card monkey-folder-card">
      <div class="snapshot-card-header">
        <div>
          <h2 id="monkey-folder-dialog-title">Choose Monkey Folder</h2>
          <p>Navigate within the configured Brainana output directory. Select a <code>sub-*</code> folder that contains an <code>anat/</code> directory.</p>
        </div>
        <button id="monkey-folder-close" class="icon-button" aria-label="Close monkey folder chooser">×</button>
      </div>
      <div class="monkey-folder-toolbar">
        <button id="monkey-folder-up" type="button" class="small-button">Up</button>
        <div id="monkey-folder-path" class="monkey-folder-path">/</div>
      </div>
      <div id="monkey-folder-list" class="monkey-folder-list" role="listbox" aria-label="Folders"></div>
      <div id="monkey-folder-note" class="monkey-folder-note">Choose a folder to continue.</div>
      <div class="snapshot-actions">
        <button id="monkey-folder-cancel" type="button">Cancel</button>
        <button id="monkey-folder-select" type="button" class="primary-button" disabled>Select Monkey</button>
      </div>
    </div>
  </div>

  <div id="snapshot-workstation-folder-dialog" class="snapshot-dialog hidden" role="dialog" aria-modal="true" aria-labelledby="snapshot-workstation-folder-title">
    <div class="snapshot-card monkey-folder-card">
      <div class="snapshot-card-header"><div><h2 id="snapshot-workstation-folder-title">Choose workstation monkey folder</h2><p>Select the destination folder here, then use the Export button in the main export window.</p></div><button id="snapshot-workstation-folder-close" class="icon-button" aria-label="Close">×</button></div>
      <p id="snapshot-workstation-folder-path" class="snapshot-help">/</p>
      <div id="snapshot-workstation-folder-list" class="monkey-folder-list"></div>
      <div class="snapshot-actions"><button id="snapshot-workstation-folder-up" type="button">Up</button><button id="snapshot-workstation-folder-cancel" type="button">Cancel</button><button id="snapshot-workstation-folder-select" type="button" class="primary-button">Use this folder</button></div>
    </div>
  </div>
  <div id="snapshot-dialog" class="snapshot-dialog hidden" role="dialog" aria-modal="true" aria-labelledby="snapshot-dialog-title">
    <div class="snapshot-card">
      <div class="snapshot-card-header">
        <div>
          <h2 id="snapshot-dialog-title">Export</h2>
          <p>Export images, provenance, and an optional ROI from the current location.</p>
        </div>
        <button id="snapshot-close" class="icon-button" aria-label="Close snapshot dialog">×</button>
      </div>
      <label class="snapshot-field">
        <span>Optional name</span>
        <input id="snapshot-name" type="text" maxlength="80" placeholder="e.g. Figure2_left_visual_field">
      </label>
      <label class="snapshot-field">
        <span>Resolution</span>
        <select id="snapshot-scale">
          <option value="1">Standard (1×)</option>
          <option value="2" selected>High (2×)</option>
          <option value="4">Publication (4×)</option>
        </select>
      </label>
      <fieldset class="snapshot-options">
        <legend>Images</legend>
        <label><input id="snapshot-composite" type="checkbox" checked> Composite image</label>
        <label><input id="snapshot-individual" type="checkbox" checked> Individual views</label>
      </fieldset>
      <fieldset class="snapshot-options">
        <legend>Provenance</legend>
        <label><input id="snapshot-metadata" type="checkbox" checked> Metadata JSON</label>
        <label><input id="snapshot-state" type="checkbox" checked> Restorable state JSON</label>
      </fieldset>
      <fieldset class="snapshot-options roi-export-options">
        <legend>ROI</legend>
        <label class="roi-enable-row"><input id="snapshot-roi-enabled" type="checkbox"> Export Gaussian ROI</label>
        <div id="snapshot-roi-controls" class="roi-export-controls disabled">
          <div class="roi-option-row">
            <span class="roi-row-heading">Extent</span>
            <div class="roi-inline-options roi-extent-control">
              <input id="snapshot-roi-extent" type="number" min="1" max="50" step="0.5" value="5" inputmode="decimal" aria-label="Gaussian ROI extent in millimeters">
              <span>mm</span>
            </div>
          </div>
          <div class="roi-option-row">
            <span class="roi-row-heading">Output spaces</span>
            <div class="roi-inline-options">
              <label><input id="snapshot-roi-space-t1w" type="checkbox" checked> T1w</label>
              <label><input id="snapshot-roi-space-scanner" type="checkbox"> Scanner</label>
              <span id="snapshot-roi-template-spaces"></span>
            </div>
          </div>
          <label class="roi-sanity-row"><input id="snapshot-roi-warped-t1w" type="checkbox"> Export warped T1w sanity checks</label>
          <p class="snapshot-help">Creates a float32 Gaussian ROI centered on the nearest T1w voxel. Extent is the total physical width along each axis. Values range from 0 to 1 and can be thresholded dynamically. The sanity-check option also resamples the displayed T1w with the exact transform used for each selected output space.</p>
          <p id="snapshot-roi-availability" class="snapshot-help"></p>
        </div>
      </fieldset>
      <div class="snapshot-destination">
        <strong>Destination</strong>
        <span id="snapshot-destination-label">ZIP download. Choose a local or workstation folder to save directly into viewer/snapshots.</span>
        <div class="snapshot-destination-buttons">
          <button id="snapshot-choose-local-folder" type="button" class="small-button">Choose local folder</button>
          <button id="snapshot-choose-workstation-folder" type="button" class="small-button hidden">Choose workstation folder</button>
        </div>
      </div>
      <div id="snapshot-progress" class="snapshot-progress hidden">Rendering high-resolution views…</div>
      <div id="snapshot-error" class="snapshot-error hidden" role="alert"></div>
      <div class="snapshot-actions">
        <button id="snapshot-cancel" type="button">Cancel</button>
        <button id="snapshot-save" type="button" class="primary-button">Export</button>
      </div>
    </div>
  </div>

  <main>
    <div class="viewer-area">
      <section class="slice-stack" aria-label="Volume navigation views">
        <div class="viewport"><div class="view-title">Sagittal</div><canvas id="sagittal"></canvas></div>
        <div class="viewport"><div class="view-title">Coronal</div><canvas id="coronal"></canvas></div>
        <div class="viewport"><div class="view-title">Axial</div><canvas id="axial"></canvas></div>
      </section>
      <section class="surface-pane">
        <div class="viewport surface">
          <div class="view-title" id="surface-title">Surface (Pial)</div>
          <svg id="surface-orientation" class="orientation-widget" viewBox="0 0 96 96" aria-label="Dynamic surface orientation" role="img">
            <g class="orientation-axis orientation-axis-lr">
              <line id="orientation-line-lr" x1="48" y1="48" x2="48" y2="48"></line>
              <text id="orientation-label-r" x="48" y="48">R</text>
              <text id="orientation-label-l" x="48" y="48">L</text>
            </g>
            <g class="orientation-axis orientation-axis-ap">
              <line id="orientation-line-ap" x1="48" y1="48" x2="48" y2="48"></line>
              <text id="orientation-label-a" x="48" y="48">A</text>
              <text id="orientation-label-p" x="48" y="48">P</text>
            </g>
            <g class="orientation-axis orientation-axis-si">
              <line id="orientation-line-si" x1="48" y1="48" x2="48" y2="48"></line>
              <text id="orientation-label-s" x="48" y="48">S</text>
              <text id="orientation-label-i" x="48" y="48">I</text>
            </g>
            <circle class="orientation-origin" cx="48" cy="48" r="2.2"></circle>
          </svg>
          <div id="functional-map-legends" class="functional-map-legends" aria-label="Active functional color maps">
            <figure id="polar-angle-legend" class="functional-map-legend hidden">
              <figcaption>Polar angle</figcaption>
              <img src="/data/function-legends/polar-angle.png" alt="Polar-angle color map">
            </figure>
            <figure id="eccentricity-legend" class="functional-map-legend hidden">
              <figcaption>Eccentricity</figcaption>
              <img src="/data/function-legends/eccentricity.png" alt="Eccentricity color map">
            </figure>
            <figure id="somatotopy-legend" class="functional-map-legend somatotopy-map-legend hidden">
              <figcaption>Somatotopy</figcaption>
              <img src="/data/function-legends/somatotopy.png" alt="Somatotopy body-position color map">
              <div class="somatotopy-range"><span class="somatotopy-low">0</span><span class="somatotopy-high">100</span></div>
            </figure>
          </div>
          <div id="surface-message" class="surface-message">Click a slice or the surface to synchronize location</div>
          <div class="surface-help">Drag surface to rotate · drag yellow marker to move crosshair · arrow keys to shift · double-click to reset</div>
          <canvas id="surface"></canvas>
        </div>
      </section>
    </div>

    <aside class="atlas-legend" aria-label="Interactive atlas ROI controls">
      <div class="legend-heading-row">
        <div>
          <div class="legend-title" id="legend-title">ARM Level 2</div>
          <div class="legend-subtitle" id="legend-subtitle">0 and negative tissue labels hidden</div>
        </div>
        <span id="legend-visible-count" class="legend-count"></span>
      </div>
      <div class="legend-actions">
        <button id="legend-show-all" class="legend-action-button" type="button">Show all</button>
        <button id="legend-hide-all" class="legend-action-button" type="button">Hide all</button>
        <button id="legend-invert" class="legend-action-button" type="button">Invert</button>
      </div>
      <input id="legend-search" class="legend-search" type="search" placeholder="Search ROIs…" aria-label="Search atlas ROIs">
      <div id="legend-items" class="legend-items"></div>
    </aside>

    <section class="info-panel">
      <div class="coordinates-panel">
        <h2>Coordinates</h2>
        <dl>
          <dt>XYZ (mm)</dt><dd id="mm">—</dd>
          <dt>IJK</dt><dd id="vox">—</dd>
          <dt>Hemisphere</dt><dd id="hemi">—</dd>
        </dl>
      </div>
      <div class="anatomy-panel">
        <div class="section-heading-row">
          <h2>Anatomy</h2>
          <span id="atlas-report-count" class="count-badge">0</span>
        </div>
        <div id="atlas-report" class="atlas-report"><p class="empty-state">Select a location.</p></div>
      </div>
      <div>
        <h2>Surface</h2>
        <dl>
          <dt>Geometry</dt><dd id="surface-name">Pial</dd>
          <dt>Hemisphere</dt><dd id="surface-hemi">—</dd>
          <dt>Nearest vertex</dt><dd id="vertex">—</dd>
          <dt>Distance</dt><dd id="snap-distance">—</dd>
          <dt>Curvature</dt><dd id="curvature-value">—</dd>
          <dt>Sulcal depth</dt><dd id="sulc-value">—</dd>
          <dt>Thickness</dt><dd id="thickness-value">—</dd>
        </dl>
      </div>
      <div class="function-report-panel">
        <div class="section-heading-row">
          <h2>Function</h2>
        </div>
        <div class="function-values">
          <h3 class="function-report-subheading">Retinotopy</h3>
          <dl>
            <dt>Polar angle</dt><dd id="polar-angle-value">—</dd>
            <dt>Polar-angle F</dt><dd id="polar-f-value">—</dd>
            <dt>Eccentricity</dt><dd id="eccentricity-value">—</dd>
            <dt>Eccentricity F</dt><dd id="eccentricity-f-value">—</dd>
            <dt>Visual X</dt><dd id="visual-x-value">—</dd>
            <dt>Visual Y</dt><dd id="visual-y-value">—</dd>
            <dt>Valid voxels</dt><dd id="retino-valid-count">—</dd>
            <dt>Offset to median</dt><dd id="retino-median-offset">—</dd>
            <dt>Local spread</dt><dd id="retino-spread">—</dd>
          </dl>
          <h3 class="function-report-subheading">Somatotopy</h3>
          <dl>
            <dt>Body position</dt><dd id="somatotopy-phase-value">—</dd>
            <dt>Somatotopy F</dt><dd id="somatotopy-f-value">—</dd>
            <dt>Status</dt><dd id="somatotopy-status-value">—</dd>
          </dl>
        </div>
      </div>
      <div class="visual-field-panel">
        <div class="section-heading-row">
          <h2>Visual field</h2>
          <label class="neighborhood-control">Neighborhood
            <select id="retino-neighborhood-size">
              <option value="1">1 × 1 × 1</option>
              <option value="3" selected>3 × 3 × 3</option>
              <option value="5">5 × 5 × 5</option>
              <option value="7">7 × 7 × 7</option>
            </select>
          </label>
        </div>
        <div class="visual-field-wrap">
          <div class="visual-field-stage">
            <canvas id="visual-field-plot" width="320" height="320" aria-label="Local retinotopic visual field"></canvas>
            <div id="visual-field-note" class="visual-field-note">Select a valid retinotopic voxel.</div>
          </div>
        </div>
      </div>
    </section>
  </main>
`

const setText = (id: string, value: string) => {
  const element = document.getElementById(id)
  if (element) element.textContent = value
}

function formatCoordinate(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const rounded = Math.abs(value) < 0.005 ? 0 : value
  return rounded.toFixed(2)
}

function formatCoordinateTriplet(value: string): string {
  const parts = value.split(',').map((part) => Number(part.trim()))
  if (parts.length !== 3 || !parts.every(Number.isFinite)) return value
  return parts.map(formatCoordinate).join(', ')
}

function enforceCoordinateFormatting(): void {
  const element = document.getElementById('mm')
  if (!element) return
  let rewriting = false
  const normalize = () => {
    if (rewriting) return
    const current = element.textContent ?? ''
    const formatted = formatCoordinateTriplet(current)
    if (formatted !== current) {
      rewriting = true
      element.textContent = formatted
      rewriting = false
    }
  }
  normalize()
  new MutationObserver(normalize).observe(element, {
    childList: true,
    characterData: true,
    subtree: true,
  })
}

enforceCoordinateFormatting()

const sliceViews = [views.sagittal, views.coronal, views.axial]
const visibleState: Record<AtlasKind, AtlasLayerState> = {
  charm: { visible: false, opacity: 0.58 },
  d99: { visible: false, opacity: 0.48 },
}

let currentCharmLevel = 2
let armLookup: ArmLookupRecord[] = []
let d99Lookup: D99LookupRecord = {}
let armLookupImages: NVImage[] = []
let d99LookupImage: NVImage | null = null
let charmLut: LabelLut
let d99Lut: LabelLut
let currentVisibleAtlasNames: string[] = []
let layerRefreshToken = 0

const functionalSources: FunctionalSources = { polar: null, polarF: null, eccentricity: null, eccentricityF: null }
const somatotopySources: SomatotopySources = { phase: null, fstat: null }
let functionalDisplay: FunctionalDisplay = 'none'
let functionalThresholdMap: FunctionalThreshold = 'polarF'
let functionalThresholdValue = 5.0
let functionalOpacity = 0.78
let functionalSurfaceBrightness = 1.25
let functionalVolumeVisible = true
let functionalLoadPromise: Promise<void> | null = null
let somatotopyDisplay: SomatotopyDisplay = 'none'
let somatotopyThresholdValue = 5.0
let somatotopyOpacity = 0.78
let somatotopySurfaceBrightness = 1.25
let functionalSurfaceOrder: 'retinotopy' | 'somatotopy' = 'somatotopy'
let somatotopyVolumeVisible = true
let somatotopySurfaceVisible = false
let somatotopyLoadPromise: Promise<void> | null = null
let charmSurfaceVisible = false
let d99SurfaceVisible = false
let functionalSurfaceVisible = false
let projectionWorker: Worker | null = null
let projectionRequestId = 0
let projectionCacheReady = false
let whiteSurfacePoints: [Float32Array, Float32Array] | null = null
let pialSurfacePoints: [Float32Array, Float32Array] | null = null
let currentSurfaceKind: SurfaceKind = 'pial'
let pialReferenceMeshes: [NVMesh, NVMesh] | null = null
let mappingDisplaySurfaceClick = false
const projectedSurfaceCache = new Map<string, [Float32Array, Float32Array]>()
const hiddenCharmLabels = Array.from({ length: 6 }, () => new Set<number>())
const hiddenD99Labels = new Set<number>()
let activeLegendAtlas: AtlasKind = 'charm'
let legendSearchTerm = ''
let atlasVisibilityRefreshPending = false

type ImportDataType = 'anatomical' | 'atlas' | 'functional'
type ImportSpace = string
type ImportInterpolation = 'auto' | 'nearest' | 'linear'
type ImportedProjectionMethod = 'mean' | 'maximum' | 'maxabs' | 'modal'
type ImportedLayer = {
  id: string
  name: string
  sourceName: string
  sourcePath: string
  sourceUrl: string
  displayUrl: string
  ownedObjectUrl: boolean
  space: ImportSpace
  dataType: ImportDataType
  interpolation: 'nearest' | 'linear'
  visible: boolean
  opacity: number
  colormap: string
  calMin: number
  calMax: number
  rawMin: number
  rawMax: number
  zeroBackground: boolean
  uniqueLabels: number[]
  projectionMethod: ImportedProjectionMethod
}
const importedLayers: ImportedLayer[] = []
let activeImportedProjectionId: string | null = null
let importBrowserPath = ''
let importSelectedFile: { name: string; path: string; url: string; size: number | null } | null = null
let importConfigured = false


function isDisplayOnlySurface(kind: SurfaceKind): boolean {
  return kind === 'inflated' || kind === 'veryinflated' || kind === 'sphere'
}

function surfaceDisplayName(kind: SurfaceKind): string {
  if (kind === 'smoothwm') return 'SmoothWM'
  if (kind === 'inflated') return 'Inflated'
  if (kind === 'veryinflated') return 'Very Inflated'
  if (kind === 'sphere') return 'Sphere'
  return 'Pial'
}

let locationUpdateRequested = false
let pendingLocation: LocationData | null = null
let markerMesh: NVMesh | null = null
let markerOffsets: Float32Array | null = null
let markerPosition: [number, number, number] | null = null
let surfaceMarkerMode: SurfaceMarkerMode = 'crosshair3d'
let surfaceMarkerDragging = false
let surfaceMarkerDragPointerId: number | null = null
let selectedMM: [number, number, number] | null = null
let surfaceLookupTimer: number | null = null
let surfaceLookupGeneration = 0

type Hemisphere = 'Left' | 'Right'
type MorphologyMetric = 'curvature' | 'sulc' | 'thickness'
type MorphologyDisplay = MorphologyMetric | 'none'
type CurvatureStyle = 'binary' | 'continuous'
type SurfaceMarkerMode = 'crosshair3d' | 'nearestNode'
type MorphologyData = Record<Hemisphere, Record<MorphologyMetric, Float32Array | null>>

const morphologyData: MorphologyData = {
  Left: { curvature: null, sulc: null, thickness: null },
  Right: { curvature: null, sulc: null, thickness: null },
}


type MorphologyRange = {
  domainMin: number
  domainMax: number
  autoMin: number
  autoMax: number
  min: number
  max: number
  symmetric: boolean
}

const morphologyLayerIndex = { curvatureBinary: 0, curvatureContinuous: 1, sulc: 2, thickness: 3 } as const
const morphologyLabel: Record<MorphologyMetric, string> = { curvature: 'Curvature', sulc: 'Sulcal depth', thickness: 'Thickness' }
const morphologyRanges: Record<MorphologyMetric, MorphologyRange> = {
  curvature: { domainMin: -1, domainMax: 1, autoMin: -0.2, autoMax: 0.2, min: -0.2, max: 0.2, symmetric: true },
  sulc: { domainMin: -6, domainMax: 6, autoMin: -3, autoMax: 3, min: -3, max: 3, symmetric: false },
  thickness: { domainMin: 0, domainMax: 4, autoMin: 1, autoMax: 3, min: 1, max: 3, symmetric: false },
}
let activeMorphology: MorphologyDisplay = 'curvature'
let curvatureStyle: CurvatureStyle = 'binary'
let snapshotSubjectDirectory: any = null
let snapshotWorkstationPath: string | null = null
let snapshotWorkstationBrowserPath = ''
let snapshotSaving = false


function readUint24(view: DataView, offset: number): number {
  return (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2)
}

function parseFreeSurferMorphology(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer)
  if (view.byteLength < 6) throw new Error('Morphology file is too small')
  const magic = readUint24(view, 0)
  if (magic === 0xFFFFFF) {
    if (view.byteLength < 15) throw new Error('Invalid FreeSurfer morphology header')
    const vertexCount = view.getInt32(3, false)
    const valuesPerVertex = view.getInt32(11, false)
    if (vertexCount <= 0 || valuesPerVertex <= 0) throw new Error('Invalid FreeSurfer morphology dimensions')
    const values = new Float32Array(vertexCount)
    let offset = 15
    const stride = valuesPerVertex * 4
    if (offset + vertexCount * stride > view.byteLength) throw new Error('Truncated FreeSurfer morphology file')
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      values[vertex] = view.getFloat32(offset, false)
      offset += stride
    }
    return values
  }

  const vertexCount = magic
  let offset = 6
  if (offset + vertexCount * 2 > view.byteLength) throw new Error('Truncated legacy FreeSurfer morphology file')
  const values = new Float32Array(vertexCount)
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    values[vertex] = view.getInt16(offset, false) / 100
    offset += 2
  }
  return values
}


function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const position = Math.min(sorted.length - 1, Math.max(0, fraction * (sorted.length - 1)))
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const weight = position - lower
  return sorted[lower] * (1 - weight) + sorted[upper] * weight
}

function initializeMorphologyRanges() {
  for (const metric of ['curvature', 'sulc', 'thickness'] as MorphologyMetric[]) {
    const values: number[] = []
    for (const hemisphere of ['Left', 'Right'] as Hemisphere[]) {
      const data = morphologyData[hemisphere][metric]
      if (!data) continue
      for (const raw of data) {
        const value = Number(raw)
        if (!Number.isFinite(value)) continue
        if (metric === 'thickness' && value <= 0) continue
        values.push(value)
      }
    }
    values.sort((a, b) => a - b)
    if (values.length === 0) continue
    let low = percentile(values, 0.025)
    let high = percentile(values, 0.975)
    if (metric === 'curvature') {
      const limit = Math.max(Math.abs(low), Math.abs(high))
      low = -limit
      high = limit
    }
    const fullLow = values[0]
    const fullHigh = values[values.length - 1]
    const span = Math.max(fullHigh - fullLow, 1e-6)
    const padding = span * 0.02
    morphologyRanges[metric] = {
      domainMin: fullLow - padding,
      domainMax: fullHigh + padding,
      autoMin: low,
      autoMax: high,
      min: low,
      max: high,
      symmetric: metric === 'curvature',
    }
  }
}

async function loadMorphologyData() {
  const files: Array<[Hemisphere, MorphologyMetric, string]> = [
    ['Left', 'curvature', requireMonkey().morphology.raw.curvature.left],
    ['Right', 'curvature', requireMonkey().morphology.raw.curvature.right],
    ['Left', 'sulc', requireMonkey().morphology.raw.sulc.left],
    ['Right', 'sulc', requireMonkey().morphology.raw.sulc.right],
    ['Left', 'thickness', requireMonkey().morphology.raw.thickness.left],
    ['Right', 'thickness', requireMonkey().morphology.raw.thickness.right],
  ]
  const results = await Promise.all(files.map(async ([hemisphere, metric, url]) => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Unable to load ${url}: ${response.status}`)
    return [hemisphere, metric, parseFreeSurferMorphology(await response.arrayBuffer())] as const
  }))
  for (const [hemisphere, metric, values] of results) morphologyData[hemisphere][metric] = values
  initializeMorphologyRanges()
}

function morphologyValue(hemisphere: Hemisphere, metric: MorphologyMetric, vertex: number): number | null {
  const values = morphologyData[hemisphere][metric]
  if (!values || vertex < 0 || vertex >= values.length) return null
  const value = Number(values[vertex])
  return Number.isFinite(value) ? value : null
}

function clearMorphologyReport(value = '—') {
  setText('curvature-value', value)
  setText('sulc-value', value)
  setText('thickness-value', value)
}

function categoricalColor(value: number, seed = 0): [number, number, number, number] {
  if (value <= 0) return [0, 0, 0, 0]
  const normalized = value >= 1000 ? value - 1000 : value
  const hue = ((normalized * 137.508 + seed) % 360 + 360) % 360
  const saturation = 62 + (normalized % 3) * 8
  const lightness = 49 + (normalized % 4) * 5
  const c = (1 - Math.abs(2 * lightness / 100 - 1)) * saturation / 100
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1))
  const m = lightness / 100 - c / 2
  let rgb: [number, number, number]
  if (hue < 60) rgb = [c, x, 0]
  else if (hue < 120) rgb = [x, c, 0]
  else if (hue < 180) rgb = [0, c, x]
  else if (hue < 240) rgb = [0, x, c]
  else if (hue < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return [
    Math.round((rgb[0] + m) * 255),
    Math.round((rgb[1] + m) * 255),
    Math.round((rgb[2] + m) * 255),
    255,
  ]
}

function armColor(levelIndex: number, rawValue: number): [number, number, number, number] {
  if (rawValue === 0) return [0, 0, 0, 0]
  const entry = armEntry(levelIndex, rawValue)
  if (!entry) return [0, 0, 0, 0]
  if (entry.region === 'WM') return [205, 205, 205, 255]
  if (entry.region === 'CSF') return [105, 190, 245, 255]
  const bilateralId = rawValue >= 1000 ? rawValue - 1000 : rawValue
  const positiveSeed = Math.abs(bilateralId) + (entry.region === 'subcortex' ? 503 : 0)
  return categoricalColor(positiveSeed, 12)
}

function createArmLut(levelIndex: number): LabelLut {
  const count = ARM_MAX - ARM_MIN + 1
  const rgba = new Uint8ClampedArray(count * 4)
  const labels = new Array<string>(count)
  for (let raw = ARM_MIN; raw <= ARM_MAX; raw += 1) {
    const index = raw - ARM_MIN
    rgba.set(armColor(levelIndex, raw), index * 4)
    labels[index] = armLabel(levelIndex, raw)
  }
  return { lut: rgba, min: ARM_MIN, max: ARM_MAX, labels }
}

function createCategoricalLut(
  min: number,
  max: number,
  labelForRawValue: (value: number) => string,
  seed: number,
): LabelLut {
  const count = max - min + 1
  const rgba = new Uint8ClampedArray(count * 4)
  const labels = new Array<string>(count)
  for (let raw = min; raw <= max; raw += 1) {
    const index = raw - min
    const color = categoricalColor(raw, seed)
    if (raw === 0) color[3] = 0
    rgba.set(color, index * 4)
    labels[index] = labelForRawValue(raw)
  }
  return { lut: rgba, min, max, labels }
}

function atlasLabelIsHidden(kind: AtlasKind, rawValue: number, charmLevelIndex = currentCharmLevel - 1): boolean {
  const id = Math.round(rawValue)
  if (id === 0) return true
  if (kind === 'd99') return hiddenD99Labels.has(id)
  return hiddenCharmLabels[charmLevelIndex]?.has(id) ?? false
}

function atlasLabelIsKnown(kind: AtlasKind, rawValue: number, charmLevelIndex = currentCharmLevel - 1): boolean {
  if (!Number.isFinite(rawValue) || Math.round(rawValue) === 0) return false
  const id = Math.round(rawValue)
  if (kind === 'd99') return Object.prototype.hasOwnProperty.call(d99Lookup, String(id))
  return Object.prototype.hasOwnProperty.call(armLookup[charmLevelIndex] ?? {}, String(id))
}

function atlasLabelShouldRender(kind: AtlasKind, rawValue: number, charmLevelIndex = currentCharmLevel - 1): boolean {
  return atlasLabelIsKnown(kind, rawValue, charmLevelIndex) && !atlasLabelIsHidden(kind, rawValue, charmLevelIndex)
}

function applyAtlasVisibilityMask(base: LabelLut, kind: AtlasKind, charmLevelIndex = currentCharmLevel - 1): LabelLut {
  // Build the visible LUT from a fully transparent baseline. This prevents
  // unknown/tissue codes that are absent from the interactive ROI list from
  // retaining a color when all listed ROIs are hidden.
  const lut = new Uint8ClampedArray(base.lut)
  for (let raw = base.min; raw <= base.max; raw += 1) {
    const alphaIndex = (raw - base.min) * 4 + 3
    lut[alphaIndex] = atlasLabelShouldRender(kind, raw, charmLevelIndex)
      ? base.lut[alphaIndex]
      : 0
  }
  return { lut, min: base.min, max: base.max, labels: base.labels }
}

function maskAtlasVolumeData(
  image: NVImage,
  kind: AtlasKind,
  charmLevelIndex = currentCharmLevel - 1,
) {
  const values = image.img as unknown as {
    length: number
    [index: number]: number
  }
  for (let index = 0; index < values.length; index += 1) {
    const raw = Number(values[index])
    if (!atlasLabelShouldRender(kind, raw, charmLevelIndex)) values[index] = 0
  }
}

function cleanArmName(value: string): string {
  return value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
}

function armEntry(levelIndex: number, rawValue: number): ArmLookupEntry | null {
  if (!Number.isFinite(rawValue)) return null
  return armLookup[levelIndex]?.[String(Math.round(rawValue))] ?? null
}

function armLabel(levelIndex: number, rawValue: number): string {
  if (!Number.isFinite(rawValue)) return 'N/A'
  if (Math.round(rawValue) === 0) return 'Background'
  const entry = armEntry(levelIndex, rawValue)
  if (!entry) return 'N/A'
  return cleanArmName(entry.nameFull || entry.name || entry.label) || 'N/A'
}

function armLegendLabel(levelIndex: number, rawValue: number): string {
  const entry = armEntry(levelIndex, rawValue)
  if (!entry) return armLabel(levelIndex, rawValue)
  const name = cleanArmName(entry.name || entry.nameFull || entry.label)
  const hemi = entry.hemi === 'lh' ? 'LH' : entry.hemi === 'rh' ? 'RH' : ''
  return hemi ? `${name} · ${hemi}` : name
}

function parseArmTsv(text: string): ArmLookupRecord {
  const lines = text.replace(/\r/g, '').split('\n').filter((line) => line.length > 0)
  if (lines.length === 0) return {}
  const header = lines[0].split('\t')
  const column = (name: string) => header.indexOf(name)
  const idColumn = column('ID')
  if (idColumn < 0) throw new Error('ARM TSV is missing the ID column')
  const result: ArmLookupRecord = {}
  for (const line of lines.slice(1)) {
    const fields = line.split('\t')
    const id = Number(fields[idColumn])
    if (!Number.isFinite(id)) continue
    const read = (name: string) => {
      const index = column(name)
      return index >= 0 ? (fields[index] ?? '').trim() : ''
    }
    result[String(Math.round(id))] = {
      id: Math.round(id),
      label: read('label'),
      region: read('region'),
      name: read('name'),
      nameFull: read('name_full'),
      hemi: read('hemi'),
    }
  }
  return result
}

function d99Label(rawValue: number): string {
  if (!Number.isFinite(rawValue) || rawValue === 0) return rawValue === 0 ? 'Background' : 'N/A'
  return d99Lookup[String(rawValue)]?.name ?? 'N/A'
}

async function loadLookupTables() {
  const armResponses = await Promise.all(Array.from({ length: 6 }, (_, index) => fetch(`/data/arm/atlas-ARM${index + 1}.tsv`)))
  for (let index = 0; index < armResponses.length; index += 1) {
    if (!armResponses[index].ok) throw new Error(`Unable to load ARM${index + 1} labels (${armResponses[index].status})`)
  }
  const d99Response = await fetch('/data/d99_lookup.json')
  if (!d99Response.ok) throw new Error(`Unable to load D99 lookup (${d99Response.status})`)
  armLookup = await Promise.all(armResponses.map(async (response) => parseArmTsv(await response.text())))
  d99Lookup = await d99Response.json() as D99LookupRecord

  charmLut = createArmLut(currentCharmLevel - 1)
  d99Lut = createCategoricalLut(D99_MIN, D99_MAX, d99Label, 211)
}

async function loadLookupVolumes() {
  setText('status', 'Loading atlas lookup data…')
  const charmPromises = Array.from({ length: 6 }, (_, index) => NVImage.loadFromUrl({
    url: requiredUrl(requireMonkey().atlases.charm[String(index + 1)], `ARM Level ${index + 1}`),
    name: `ARM Level ${index + 1}`,
  }))
  const [charmImages, d99Image] = await Promise.all([
    Promise.all(charmPromises),
    NVImage.loadFromUrl({ url: requiredUrl(requireMonkey().atlases.d99, 'D99'), name: 'D99' }),
  ])
  armLookupImages = charmImages
  d99LookupImage = d99Image
}

async function loadFunctionalSources() {
  setText('status', 'Loading retinotopy…')
  const functional = requireMonkey().function.retinotopy
  if (!functional) throw new Error('Retinotopy is not available for this monkey')
  const [polar, polarF, eccentricity, eccentricityF] = await Promise.all([
    NVImage.loadFromUrl({ url: functional.combined, name: 'Polar angle' }),
    NVImage.loadFromUrl({ url: functional.combined, name: 'Polar-angle F' }),
    NVImage.loadFromUrl({ url: functional.combined, name: 'Eccentricity' }),
    NVImage.loadFromUrl({ url: functional.combined, name: 'Eccentricity F' }),
  ])
  polar.frame4D = functional.frames.polar
  polarF.frame4D = functional.frames.polarF
  eccentricity.frame4D = functional.frames.eccentricity
  eccentricityF.frame4D = functional.frames.eccentricityF
  functionalSources.polar = polar
  functionalSources.polarF = polarF
  functionalSources.eccentricity = eccentricity
  functionalSources.eccentricityF = eccentricityF
  if (selectedMM) updateFunctionalReport(selectedMM)
  setText('status', 'Ready · retinotopy loaded')
}

async function ensureFunctionalSourcesLoaded(): Promise<void> {
  if (functionalSources.polar && functionalSources.polarF && functionalSources.eccentricity && functionalSources.eccentricityF) return
  if (!functionalLoadPromise) {
    functionalLoadPromise = loadFunctionalSources().catch((error) => {
      functionalLoadPromise = null
      throw error
    })
  }
  await functionalLoadPromise
}

async function loadSomatotopySources() {
  setText('status', 'Loading somatotopy…')
  const somatotopy = requireMonkey().function.somatotopy
  if (!somatotopy) throw new Error('Somatotopy is not available for this monkey')
  const [phase, fstat] = await Promise.all([
    NVImage.loadFromUrl({ url: somatotopy.combined, name: 'Somatotopy body map' }),
    NVImage.loadFromUrl({ url: somatotopy.combined, name: 'Somatotopy F' }),
  ])
  phase.frame4D = somatotopy.frames.phase
  fstat.frame4D = somatotopy.frames.fstat
  somatotopySources.phase = phase
  somatotopySources.fstat = fstat
  updateSomatotopyThresholdRange()
  if (selectedMM) updateSomatotopyReport(selectedMM)
  setText('status', 'Ready · somatotopy loaded')
}

async function ensureSomatotopySourcesLoaded(): Promise<void> {
  if (somatotopySources.phase && somatotopySources.fstat) return
  if (!somatotopyLoadPromise) {
    somatotopyLoadPromise = loadSomatotopySources().catch((error) => {
      somatotopyLoadPromise = null
      throw error
    })
  }
  await somatotopyLoadPromise
}

function sampleFunctionalAtMM(image: NVImage | null, mm: [number, number, number]): number | null {
  if (!image) return null
  const vox = image.mm2vox(mm, false)
  const x = Math.round(Number(vox[0]))
  const y = Math.round(Number(vox[1]))
  const z = Math.round(Number(vox[2]))
  if (![x, y, z].every(Number.isFinite)) return null
  const value = Number(image.getValue(x, y, z, image.frame4D))
  return Number.isFinite(value) ? value : null
}

type RetinoPoint = { x: number; y: number; polar: number; eccentricity: number; polarF: number; eccentricityF: number; center: boolean }

function sampleImageAtVoxel(image: NVImage | null, x: number, y: number, z: number): number | null {
  if (!image) return null
  const dims = volumeDimensions(image)
  if (x < 0 || y < 0 || z < 0 || x >= dims[0] || y >= dims[1] || z >= dims[2]) return null
  const value = Number(image.getValue(x, y, z, image.frame4D))
  return Number.isFinite(value) ? value : null
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function collectRetinoNeighborhood(mm: [number, number, number]): { points: RetinoPoint[]; possible: number } {
  const reference = functionalSources.polar
  if (!reference) return { points: [], possible: 0 }
  const centerVox = reference.mm2vox(mm, false)
  const cx = Math.round(Number(centerVox[0]))
  const cy = Math.round(Number(centerVox[1]))
  const cz = Math.round(Number(centerVox[2]))
  if (![cx, cy, cz].every(Number.isFinite)) return { points: [], possible: 0 }
  const size = Number(document.querySelector<HTMLSelectElement>('#retino-neighborhood-size')?.value ?? '3')
  const radius = Math.floor(size / 2)
  const dims = volumeDimensions(reference)
  const points: RetinoPoint[] = []
  let possible = 0
  for (let dz = -radius; dz <= radius; dz += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const x = cx + dx
        const y = cy + dy
        const z = cz + dz
        if (x < 0 || y < 0 || z < 0 || x >= dims[0] || y >= dims[1] || z >= dims[2]) continue
        possible += 1
        const polar = sampleImageAtVoxel(functionalSources.polar, x, y, z)
        const polarF = sampleImageAtVoxel(functionalSources.polarF, x, y, z)
        const eccentricity = sampleImageAtVoxel(functionalSources.eccentricity, x, y, z)
        const eccentricityF = sampleImageAtVoxel(functionalSources.eccentricityF, x, y, z)
        if (polar === null || polarF === null || eccentricity === null || eccentricityF === null) continue
        if (eccentricity < 0 || eccentricity > 10) continue
        // The local visual-field summary requires support from both fitted maps.
        // This restores the original neighborhood semantics: every plotted point,
        // including the selected center voxel, must pass both F thresholds. The
        // dots, median, covariance ellipse, spread, and offset therefore all use
        // one internally consistent set of voxels.
        if (polarF < functionalThresholdValue || eccentricityF < functionalThresholdValue) continue
        points.push({ x: eccentricity * Math.cos(polar), y: eccentricity * Math.sin(polar), polar, eccentricity, polarF, eccentricityF, center: dx === 0 && dy === 0 && dz === 0 })
      }
    }
  }
  return { points, possible }
}

function drawVisualFieldPlot(points: RetinoPoint[], possible: number) {
  const canvas = document.querySelector<HTMLCanvasElement>('#visual-field-plot')
  const context = canvas?.getContext('2d')
  if (!canvas || !context) return
  const width = canvas.width, height = canvas.height, centerY = height / 2
  context.clearRect(0, 0, width, height)
  context.save()
  context.font = '700 18px system-ui, sans-serif'
  const leftLabelWidth = context.measureText('Left').width
  const rightLabelWidth = context.measureText('Right').width
  const sideGap = 12
  const edgePadding = 10
  // Keep the anatomical side labels fully inside the canvas at every responsive size.
  // A slight leftward center bias gives the longer "Right" label equal visual breathing room.
  const centerX = width / 2 - Math.max(0, (rightLabelWidth - leftLabelWidth) / 4)
  const horizontalRadius = Math.min(
    centerX - leftLabelWidth - sideGap - edgePadding,
    width - centerX - rightLabelWidth - sideGap - edgePadding,
  )
  const verticalRadius = Math.min(width, height) * 0.365
  const radius = Math.max(20, Math.min(verticalRadius, horizontalRadius))
  const scale = radius / 10
  context.lineWidth = 2.8; context.strokeStyle = 'rgba(180,195,214,0.36)'
  for (const ecc of [2, 4, 6, 8, 10]) { context.beginPath(); context.arc(centerX, centerY, ecc * scale, 0, Math.PI * 2); context.stroke() }
  context.strokeStyle = 'rgba(215,225,237,0.68)'; context.lineWidth = 3.0
  context.beginPath(); context.moveTo(centerX - radius, centerY); context.lineTo(centerX + radius, centerY); context.stroke()
  context.beginPath(); context.moveTo(centerX, centerY - radius); context.lineTo(centerX, centerY + radius); context.stroke()
  context.fillStyle = 'rgba(230,237,246,0.98)'; context.font = '700 18px system-ui, sans-serif'
  context.textAlign = 'center'; context.fillText('Upper', centerX, centerY - radius - 12); context.fillText('Lower', centerX, centerY + radius + 22)
  context.textAlign = 'right'; context.fillText('Left', centerX - radius - 12, centerY + 6)
  context.textAlign = 'left'; context.fillText('Right', centerX + radius + 12, centerY + 6)
  context.fillStyle = 'rgba(225,234,244,0.92)'; context.font = '700 14px system-ui, sans-serif'
  for (const ecc of [2, 4, 6, 8, 10]) context.fillText(`${ecc}°`, centerX + 3, centerY - ecc * scale + 10)
  context.strokeStyle = 'rgba(235,241,247,0.9)'; context.lineWidth = 2.6; context.beginPath(); context.moveTo(centerX - 4, centerY); context.lineTo(centerX + 4, centerY); context.moveTo(centerX, centerY - 4); context.lineTo(centerX, centerY + 4); context.stroke()
  const neighbors = points.filter((point) => !point.center), centerPoint = points.find((point) => point.center)
  const summaryPoints = neighbors.length >= 3 ? neighbors : points
  let medianX = Number.NaN, medianY = Number.NaN, spread = Number.NaN
  if (summaryPoints.length > 0) {
    medianX = median(summaryPoints.map((point) => point.x)); medianY = median(summaryPoints.map((point) => point.y))
    spread = Math.sqrt(summaryPoints.reduce((sum, point) => sum + (point.x - medianX) ** 2 + (point.y - medianY) ** 2, 0) / summaryPoints.length)
  }
  if (summaryPoints.length >= 3 && Number.isFinite(medianX) && Number.isFinite(medianY)) {
    let cxx = 0, cyy = 0, cxy = 0
    for (const point of summaryPoints) { const dx = point.x - medianX, dy = point.y - medianY; cxx += dx * dx; cyy += dy * dy; cxy += dx * dy }
    const denominator = Math.max(1, summaryPoints.length - 1); cxx /= denominator; cyy /= denominator; cxy /= denominator
    const trace = cxx + cyy, discriminant = Math.sqrt(Math.max(0, (cxx - cyy) ** 2 + 4 * cxy * cxy))
    const lambda1 = Math.max(0, (trace + discriminant) / 2), lambda2 = Math.max(0, (trace - discriminant) / 2)
    const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy), ellipseScale = 1.79
    context.save(); context.translate(centerX + medianX * scale, centerY - medianY * scale); context.rotate(-angle)
    context.beginPath(); context.ellipse(0, 0, Math.sqrt(lambda1) * ellipseScale * scale, Math.sqrt(lambda2) * ellipseScale * scale, 0, 0, Math.PI * 2)
    context.fillStyle = 'rgba(67,154,232,0.14)'; context.strokeStyle = 'rgba(93,174,245,0.78)'; context.lineWidth = 3.2; context.fill(); context.stroke(); context.restore()
  }
  if (centerPoint) {
    context.strokeStyle = 'rgba(255,205,72,0.92)'; context.lineWidth = 2.8
    context.beginPath(); context.moveTo(centerX, centerY); context.lineTo(centerX + centerPoint.x * scale, centerY - centerPoint.y * scale); context.stroke()
    if (Number.isFinite(medianX) && Number.isFinite(medianY)) {
      context.save(); context.setLineDash([4, 4]); context.strokeStyle = 'rgba(236,241,247,0.6)'
      context.beginPath(); context.moveTo(centerX + centerPoint.x * scale, centerY - centerPoint.y * scale); context.lineTo(centerX + medianX * scale, centerY - medianY * scale); context.stroke(); context.restore()
    }
  }
  for (const point of neighbors) {
    const averageF = (point.polarF + point.eccentricityF) / 2
    const confidence = Math.max(0, Math.min(1, (averageF - functionalThresholdValue) / Math.max(10, functionalThresholdValue * 3)))
    context.beginPath(); context.arc(centerX + point.x * scale, centerY - point.y * scale, 5.4, 0, Math.PI * 2)
    context.fillStyle = `rgba(83,184,238,${(0.3 + 0.58 * confidence).toFixed(3)})`; context.fill()
  }
  if (Number.isFinite(medianX) && Number.isFinite(medianY)) {
    const mx = centerX + medianX * scale, my = centerY - medianY * scale
    context.save(); context.translate(mx, my); context.rotate(Math.PI / 4); context.strokeStyle = 'rgba(244,247,251,0.9)'; context.lineWidth = 2.7; context.strokeRect(-5.25, -5.25, 10.5, 10.5); context.restore()
  }
  if (centerPoint) {
    const px = centerX + centerPoint.x * scale, py = centerY - centerPoint.y * scale
    context.beginPath(); context.arc(px, py, 8.8, 0, Math.PI * 2); context.fillStyle = '#ffd04a'; context.fill(); context.strokeStyle = '#15191f'; context.lineWidth = 3.2; context.stroke()
  }
  context.restore()
  setText('retino-valid-count', `${points.length} / ${possible}`)
  setText('retino-spread', Number.isFinite(spread) ? `${spread.toFixed(2)}°` : 'N/A')
  setText('retino-median-offset', centerPoint && Number.isFinite(medianX) && Number.isFinite(medianY) ? `${Math.hypot(centerPoint.x - medianX, centerPoint.y - medianY).toFixed(2)}°` : 'N/A')
  const note = document.getElementById('visual-field-note')
  note?.classList.toggle('hidden', points.length > 0)
  if (note) note.textContent = points.length > 0 ? '' : 'No retinotopy data in the selected neighborhood pass both F thresholds.'
}

function updateFunctionalReport(mm: [number, number, number]) {
  const polar = sampleFunctionalAtMM(functionalSources.polar, mm)
  const polarF = sampleFunctionalAtMM(functionalSources.polarF, mm)
  const eccentricity = sampleFunctionalAtMM(functionalSources.eccentricity, mm)
  const eccentricityF = sampleFunctionalAtMM(functionalSources.eccentricityF, mm)
  const polarSupported = polarF !== null && polarF > 0, eccentricitySupported = eccentricityF !== null && eccentricityF > 0
  setText('polar-angle-value', polar !== null && polarSupported ? `${polar.toFixed(3)} rad` : 'N/A')
  setText('polar-f-value', polarF === null ? 'N/A' : polarF.toFixed(2))
  setText('eccentricity-value', eccentricity !== null && eccentricitySupported ? `${eccentricity.toFixed(2)}°` : 'N/A')
  setText('eccentricity-f-value', eccentricityF === null ? 'N/A' : eccentricityF.toFixed(2))
  if (polar !== null && eccentricity !== null && polarSupported && eccentricitySupported) {
    setText('visual-x-value', `${(eccentricity * Math.cos(polar)).toFixed(2)}°`); setText('visual-y-value', `${(eccentricity * Math.sin(polar)).toFixed(2)}°`)
  } else { setText('visual-x-value', 'N/A'); setText('visual-y-value', 'N/A') }
  const neighborhood = collectRetinoNeighborhood(mm); drawVisualFieldPlot(neighborhood.points, neighborhood.possible)
}

function updateSomatotopyReport(mm: [number, number, number]) {
  const phase = sampleFunctionalAtMM(somatotopySources.phase, mm)
  const fstat = sampleFunctionalAtMM(somatotopySources.fstat, mm)
  const supported = phase !== null && phase >= 0 && phase <= 100 && fstat !== null && fstat > 0
  setText('somatotopy-phase-value', supported ? phase.toFixed(2) : 'N/A')
  setText('somatotopy-f-value', fstat === null ? 'N/A' : fstat.toFixed(2))
  setText('somatotopy-status-value', fstat === null ? 'N/A' : fstat >= somatotopyThresholdValue && supported ? 'Passes threshold' : 'Below threshold')
}

function createMaskedSomatotopyImage(): NVImage | null {
  const source = somatotopySources.phase
  const support = somatotopySources.fstat
  if (!source?.img || !support?.img) return null
  const sourceValues = copyImageValues(source)
  const thresholdValues = copyImageValues(support)
  const output = new Float32Array(sourceValues.length)
  const sentinel = -1000
  for (let index = 0; index < sourceValues.length; index += 1) {
    const value = Number(sourceValues[index])
    const threshold = Number(thresholdValues[index])
    output[index] = Number.isFinite(value) && value >= 0 && value <= 100 && Number.isFinite(threshold) && threshold >= somatotopyThresholdValue ? value : sentinel
  }
  const image = source.clone()
  image.id = crypto.randomUUID()
  image.name = 'Somatotopy: Body map'
  image.img = output
  image.frame4D = 0
  if (image.hdr?.dims && image.hdr.dims.length > 4) image.hdr.dims[4] = 1
  image.opacity = somatotopyOpacity
  image.ignoreZeroVoxels = false
  image.colormapType = 0
  image.colorbarVisible = false
  image.setColormap('brainana_somatotopy_0_100')
  image.cal_min = -(100 / 254)
  image.cal_max = 100
  ;(image as unknown as { isTransparentBelowCalMin?: boolean }).isTransparentBelowCalMin = false
  return image
}

async function addSomatotopyOverlay(nv: Niivue) {
  const image = createMaskedSomatotopyImage()
  if (!image) return
  nv.addVolume(image)
  const layerIndex = nv.volumes.length - 1
  image.opacity = somatotopyOpacity
  const previousNearest = nv.opts.isNearestInterpolation
  nv.opts.isNearestInterpolation = false
  nv.updateInterpolation(layerIndex)
  nv.opts.isNearestInterpolation = previousNearest
  nv.updateGLVolume()
}

function functionalDisplaySource(): NVImage | null {
  if (functionalDisplay === 'polar') return functionalSources.polar
  if (functionalDisplay === 'eccentricity') return functionalSources.eccentricity
  return null
}

function functionalThresholdSource(): NVImage | null {
  if (functionalThresholdMap === 'polarF') return functionalSources.polarF
  if (functionalThresholdMap === 'eccentricityF') return functionalSources.eccentricityF
  return null
}

function pairedSupportSource(): NVImage | null {
  if (functionalDisplay === 'polar') return functionalSources.polarF
  if (functionalDisplay === 'eccentricity') return functionalSources.eccentricityF
  return null
}

function createMaskedFunctionalImage(): NVImage | null {
  const source = functionalDisplaySource()
  if (!source?.img) return null
  const explicitThreshold = functionalThresholdSource()
  const support = explicitThreshold ?? pairedSupportSource()
  const sourceValues = copyImageValues(source)
  const thresholdValues = support ? copyImageValues(support) : null
  const output = new Float32Array(sourceValues.length)
  const cutoff = explicitThreshold ? functionalThresholdValue : 0
  // Masked samples use a value far below the display range. The custom
  // functional colormaps reserve their first LUT entry for transparent
  // masked voxels, while valid negative and zero map values start at LUT
  // entry 1 and remain visible.
  const sentinel = -1000
  for (let index = 0; index < sourceValues.length; index += 1) {
    const value = Number(sourceValues[index])
    const threshold = thresholdValues ? Number(thresholdValues[index]) : 1
    const passesThreshold = Number.isFinite(threshold) && threshold >= cutoff
    output[index] = Number.isFinite(value) && passesThreshold ? value : sentinel
  }
  const image = source.clone()
  image.id = crypto.randomUUID()
  image.name = functionalDisplay === 'polar' ? 'Retinotopy: Polar angle' : 'Retinotopy: Eccentricity'
  image.img = output
  image.frame4D = 0
  if (image.hdr?.dims && image.hdr.dims.length > 4) image.hdr.dims[4] = 1
  image.opacity = functionalOpacity
  image.ignoreZeroVoxels = false
  // MIN_TO_MAX preserves signed polar-angle values. Transparency for
  // thresholded voxels is encoded in LUT entry 0 rather than by suppressing
  // values below zero, so valid negative values and valid zero remain visible.
  image.colormapType = 0
  image.colorbarVisible = false
  if (functionalDisplay === 'polar') {
    image.setColormap('brainana_polar_angle')
    // Reserve LUT entry 0 for the transparent sentinel. This slightly
    // extends the calibration below -pi so -pi itself maps to visible green.
    image.cal_min = -Math.PI - (2 * Math.PI / 254)
    image.cal_max = Math.PI
  } else {
    image.setColormap('brainana_eccentricity_0_10')
    // Likewise reserve LUT entry 0 while keeping eccentricity 0 visible red.
    image.cal_min = -(10 / 254)
    image.cal_max = 10
  }
  ;(image as unknown as { isTransparentBelowCalMin?: boolean }).isTransparentBelowCalMin = false
  return image
}

async function addFunctionalOverlay(nv: Niivue) {
  const image = createMaskedFunctionalImage()
  if (!image) return
  nv.addVolume(image)
  const layerIndex = nv.volumes.length - 1
  const previousNearest = nv.opts.isNearestInterpolation
  // Functional maps are sampled with nearest-neighbor interpolation so
  // values are not spatially blended between voxels.
  nv.opts.isNearestInterpolation = true
  nv.updateInterpolation(layerIndex)
  nv.opts.isNearestInterpolation = previousNearest
  nv.updateGLVolume()
}

function sampleImageAtMM(image: NVImage | null | undefined, mm: [number, number, number]): number | null {
  if (!image) return null
  const vox = image.mm2vox(mm, false)
  const x = Math.round(Number(vox[0]))
  const y = Math.round(Number(vox[1]))
  const z = Math.round(Number(vox[2]))
  if (![x, y, z].every(Number.isFinite)) return null
  const value = Math.round(image.getValue(x, y, z))
  return Number.isFinite(value) ? value : null
}

function atlasReportsAtMM(mm: [number, number, number]): AtlasReportRow[] {
  // Anatomical reporting is intentionally independent of visualization state.
  // Always sample the original, unfiltered ARM and D99 lookup volumes.
  const reports: AtlasReportRow[] = []
  for (let index = 0; index < 6; index += 1) {
    const value = sampleImageAtMM(armLookupImages[index], mm)
    reports.push({
      key: `charm-${index + 1}`,
      atlas: `ARM L${index + 1}`,
      value,
      label: value === null ? 'N/A' : armLabel(index, value),
    })
  }
  const d99Value = sampleImageAtMM(d99LookupImage, mm)
  reports.push({
    key: 'd99',
    atlas: 'D99',
    value: d99Value,
    label: d99Value === null ? 'N/A' : d99Label(d99Value),
  })
  return reports
}

function renderAtlasReport(rows: AtlasReportRow[]) {
  const root = document.getElementById('atlas-report')!
  setText('atlas-report-count', String(rows.length))
  if (rows.length === 0) {
    root.innerHTML = '<p class="empty-state">No atlas lookup enabled.</p>'
    return
  }
  root.innerHTML = ''
  for (const row of rows) {
    const item = document.createElement('div')
    item.className = `atlas-report-row${row.key === 'd99' ? ' atlas-report-d99' : ''}`
    const value = row.value === null ? '—' : String(row.value)
    item.innerHTML = `
      <span class="atlas-report-name">${row.atlas}</span>
      <span class="atlas-report-value">${value}</span>
      <span class="atlas-report-label ${row.label === 'N/A' ? 'unknown' : ''}">${row.label}</span>
    `
    root.appendChild(item)
  }
}

function atlasIsDisplayed(kind: AtlasKind): boolean {
  return kind === 'charm'
    ? visibleState.charm.visible || charmSurfaceVisible
    : visibleState.d99.visible || d99SurfaceVisible
}

function activeLegend(): { kind: AtlasKind; levelIndex: number; title: string; subtitle: string; entries: { id: number; label: string; color: [number, number, number, number]; hidden: boolean }[] } | null {
  let kind = activeLegendAtlas
  if (!atlasIsDisplayed(kind)) {
    if (atlasIsDisplayed('charm')) kind = 'charm'
    else if (atlasIsDisplayed('d99')) kind = 'd99'
    else return null
  }
  activeLegendAtlas = kind
  if (kind === 'd99') {
    const entries = Object.keys(d99Lookup).map(Number).sort((a, b) => a - b).map((id) => ({
      id,
      label: d99Label(id),
      color: categoricalColor(id, 211),
      hidden: hiddenD99Labels.has(id),
    }))
    return { kind, levelIndex: -1, title: 'D99', subtitle: 'Click rows to toggle ROIs', entries }
  }
  const levelIndex = currentCharmLevel - 1
  const entries = Object.keys(armLookup[levelIndex] ?? {}).map(Number).sort((a, b) => a - b).map((id) => ({
    id,
    label: armLegendLabel(levelIndex, id),
    color: armColor(levelIndex, id),
    hidden: hiddenCharmLabels[levelIndex].has(id),
  }))
  return { kind, levelIndex, title: `ARM Level ${currentCharmLevel}`, subtitle: 'Click to toggle · Shift-click to isolate', entries }
}

function renderLegend() {
  const legend = activeLegend()
  const panel = document.querySelector('.atlas-legend') as HTMLElement
  const root = document.getElementById('legend-items')!
  const previousScrollTop = root.scrollTop
  root.innerHTML = ''
  if (!legend) {
    setText('legend-title', 'Atlases')
    setText('legend-subtitle', 'No visible atlas')
    setText('legend-visible-count', '')
    panel.classList.add('hidden')
    return
  }
  panel.classList.remove('hidden')
  setText('legend-title', legend.title)
  setText('legend-subtitle', legend.subtitle)
  const visibleCount = legend.entries.filter((entry) => !entry.hidden).length
  setText('legend-visible-count', `${visibleCount} of ${legend.entries.length} visible`)
  const query = legendSearchTerm.trim().toLowerCase()
  const filtered = query
    ? legend.entries.filter((entry) => String(entry.id).includes(query) || entry.label.toLowerCase().includes(query))
    : legend.entries
  for (const entry of filtered) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = `legend-row${entry.hidden ? ' hidden-roi' : ''}`
    row.dataset.roiId = String(entry.id)
    row.dataset.atlasKind = legend.kind
    row.setAttribute('aria-pressed', String(!entry.hidden))
    row.innerHTML = `
      <span class="legend-checkbox" aria-hidden="true">${entry.hidden ? '' : '✓'}</span>
      <span class="legend-swatch" style="background:rgb(${entry.color[0]},${entry.color[1]},${entry.color[2]})"></span>
      <span class="legend-id">${entry.id}</span>
      <span class="legend-label">${entry.label}</span>
    `
    row.title = `${entry.hidden ? 'Show' : 'Hide'} ${entry.id}: ${entry.label}`
    root.appendChild(row)
  }
  if (filtered.length === 0) root.innerHTML = '<div class="legend-empty">No matching ROIs</div>'
  root.scrollTop = previousScrollTop
}

function setLegendVisibilityMode(mode: 'showAll' | 'hideAll' | 'invert') {
  const legend = activeLegend()
  if (!legend) return
  const hidden = legend.kind === 'charm' ? hiddenCharmLabels[legend.levelIndex] : hiddenD99Labels
  if (mode === 'showAll') hidden.clear()
  else if (mode === 'hideAll') {
    hidden.clear()
    for (const entry of legend.entries) hidden.add(entry.id)
  } else {
    const next = new Set<number>()
    for (const entry of legend.entries) if (!hidden.has(entry.id)) next.add(entry.id)
    hidden.clear()
    for (const id of next) hidden.add(id)
  }
  void refreshAtlasRoiVisibility()
}

function toggleLegendRoi(id: number, isolate: boolean) {
  const legend = activeLegend()
  if (!legend) return
  const hidden = legend.kind === 'charm' ? hiddenCharmLabels[legend.levelIndex] : hiddenD99Labels
  if (isolate) {
    hidden.clear()
    for (const entry of legend.entries) if (entry.id !== id) hidden.add(entry.id)
  } else if (hidden.has(id)) hidden.delete(id)
  else hidden.add(id)
  void refreshAtlasRoiVisibility()
}

async function refreshAtlasRoiVisibility() {
  if (atlasVisibilityRefreshPending) return
  atlasVisibilityRefreshPending = true
  renderLegend()
  try {
    await replaceVisibleAtlasLayers()
    if (charmSurfaceVisible || d99SurfaceVisible) await refreshProjectedSurfaceLayers()
  } finally {
    atlasVisibilityRefreshPending = false
    renderLegend()
  }
}

function configureInteractiveLegend() {
  const items = document.getElementById('legend-items')!
  items.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const row = target.closest<HTMLButtonElement>('.legend-row')
    if (!row) return
    const id = Number(row.dataset.roiId)
    if (!Number.isFinite(id)) return
    toggleLegendRoi(id, (event as MouseEvent).shiftKey)
  })
  document.getElementById('legend-show-all')!.addEventListener('click', () => setLegendVisibilityMode('showAll'))
  document.getElementById('legend-hide-all')!.addEventListener('click', () => setLegendVisibilityMode('hideAll'))
  document.getElementById('legend-invert')!.addEventListener('click', () => setLegendVisibilityMode('invert'))
  document.getElementById('legend-search')!.addEventListener('input', (event) => {
    legendSearchTerm = (event.target as HTMLInputElement).value
    renderLegend()
  })
}

function updateLocationText(data: LocationData) {
  const mm = data.mm?.slice(0, 3).map(Number) ?? []
  const vox = data.vox?.slice(0, 3).map(Number) ?? []
  setText('mm', mm.length === 3 && mm.every(Number.isFinite) ? formatCoordinateTriplet(mm.join(',')) : '—')
  setText('vox', vox.length === 3 ? vox.map((value) => Math.round(value)).join(', ') : '—')
  if (mm.length === 3 && mm.every(Number.isFinite)) {
    const location: [number, number, number] = [mm[0], mm[1], mm[2]]
    renderAtlasReport(atlasReportsAtMM(location))
    updateFunctionalReport(location)
    updateSomatotopyReport(location)
  }
}

function makeSphereGeometry(radius = 1.35, latitudeBands = 8, longitudeBands = 12) {
  const offsets: number[] = []
  const triangles: number[] = []
  for (let lat = 0; lat <= latitudeBands; lat += 1) {
    const theta = (lat * Math.PI) / latitudeBands
    const sinTheta = Math.sin(theta)
    const cosTheta = Math.cos(theta)
    for (let lon = 0; lon <= longitudeBands; lon += 1) {
      const phi = (lon * 2 * Math.PI) / longitudeBands
      offsets.push(radius * Math.cos(phi) * sinTheta, radius * Math.sin(phi) * sinTheta, radius * cosTheta)
    }
  }
  for (let lat = 0; lat < latitudeBands; lat += 1) {
    for (let lon = 0; lon < longitudeBands; lon += 1) {
      const first = lat * (longitudeBands + 1) + lon
      const second = first + longitudeBands + 1
      triangles.push(first, second, first + 1, second, second + 1, first + 1)
    }
  }
  return { offsets: new Float32Array(offsets), triangles: new Uint32Array(triangles) }
}

function ensureSurfaceMarker(): NVMesh | null {
  const nv = views.surface
  if (!nv.gl) return null
  if (markerMesh && markerOffsets) return markerMesh
  const geometry = makeSphereGeometry()
  markerOffsets = geometry.offsets
  const initial = selectedMM ?? [0, 0, 0]
  const initialDisplay = displayPositionForMM(initial as [number, number, number])
  const vertices = new Float32Array(markerOffsets.length)
  for (let index = 0; index < markerOffsets.length; index += 3) {
    vertices[index] = markerOffsets[index] + initialDisplay[0]
    vertices[index + 1] = markerOffsets[index + 1] + initialDisplay[1]
    vertices[index + 2] = markerOffsets[index + 2] + initialDisplay[2]
  }
  markerMesh = new NVMesh(
    vertices,
    geometry.triangles,
    'selected-location',
    new Uint8Array([255, 196, 0, 255]),
    1.0,
    Boolean(selectedMM),
    nv.gl,
    null, null, null, null, null,
    false,
  )
  nv.addMesh(markerMesh)
  markerPosition = initial as [number, number, number]
  return markerMesh
}


function nearestPialVertex(mm: [number, number, number]) {
  const meshes = pialReferenceMeshes
  if (!meshes) return null
  const candidates = meshes.map((mesh, hemisphereIndex) => {
    const nearest = mesh.indexNearestXYZmm(mm[0], mm[1], mm[2])
    return {
      hemisphereIndex,
      hemisphere: hemisphereIndex === 0 ? 'Left' as const : 'Right' as const,
      vertex: Math.round(nearest[0]),
      distance: Number(nearest[1]),
    }
  })
  return candidates[0].distance <= candidates[1].distance ? candidates[0] : candidates[1]
}

function displayPositionForMM(mm: [number, number, number]): [number, number, number] {
  if (surfaceMarkerMode === 'crosshair3d') return mm
  const nearest = nearestPialVertex(mm)
  const meshes = views.surface.meshes.slice(0, 2)
  if (!nearest || meshes.length < 2) return mm
  const pts = meshes[nearest.hemisphereIndex].pts
  const offset = nearest.vertex * 3
  if (offset + 2 >= pts.length) return mm
  return [pts[offset], pts[offset + 1], pts[offset + 2]]
}


function projectSurfacePointToCanvas(mm: [number, number, number]): [number, number] | null {
  const nv = views.surface
  if (!nv.gl || !nv.canvas) return null
  const width = Number(nv.canvas.width || nv.gl.canvas.width || 0)
  const height = Number(nv.canvas.height || nv.gl.canvas.height || 0)
  if (width <= 0 || height <= 0) return null
  try {
    const matrices = nv.calculateMvpMatrix(null, [0, 0, width, height], Number(nv.scene.renderAzimuth ?? 0), Number(nv.scene.renderElevation ?? 0))
    const m = matrices[0] as ArrayLike<number>
    const x = mm[0], y = mm[1], z = mm[2]
    const clipX = m[0] * x + m[4] * y + m[8] * z + m[12]
    const clipY = m[1] * x + m[5] * y + m[9] * z + m[13]
    const clipW = m[3] * x + m[7] * y + m[11] * z + m[15]
    if (!Number.isFinite(clipW) || Math.abs(clipW) < 1e-8) return null
    const ndcX = clipX / clipW
    const ndcY = clipY / clipW
    return [(ndcX * 0.5 + 0.5) * width, (1 - (ndcY * 0.5 + 0.5)) * height]
  } catch {
    return null
  }
}

function surfacePointerCanvasPosition(event: PointerEvent): [number, number] {
  const canvas = views.surface.canvas as HTMLCanvasElement
  const rect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / Math.max(1, rect.width)
  const scaleY = canvas.height / Math.max(1, rect.height)
  return [(event.clientX - rect.left) * scaleX, (event.clientY - rect.top) * scaleY]
}

function isPointerNearSurfaceMarker(event: PointerEvent): boolean {
  if (!markerMesh?.visible || !markerPosition) return false
  const projected = projectSurfacePointToCanvas(markerPosition)
  if (!projected) return false
  const [x, y] = surfacePointerCanvasPosition(event)
  const dpr = Number(views.surface.uiData?.dpr ?? window.devicePixelRatio ?? 1)
  const radius = 14 * Math.max(1, dpr)
  return Math.hypot(x - projected[0], y - projected[1]) <= radius
}

function pickSurfaceAtPointer(event: PointerEvent) {
  const nv = views.surface
  const canvas = nv.canvas as HTMLCanvasElement
  if (!nv.gl || !canvas) return
  const rect = canvas.getBoundingClientRect()
  const cssX = event.clientX - rect.left
  const cssY = event.clientY - rect.top
  if (cssX < 0 || cssY < 0 || cssX > rect.width || cssY > rect.height) return

  const wasVisible = markerMesh?.visible ?? false
  if (markerMesh) markerMesh.visible = false
  try {
    nv.mouseDown(cssX, cssY)
    nv.uiData.mouseDepthPicker = true
    // NiiVue uses the first draw for the picking pass and the second to redraw
    // the normal scene after the picked crosshair has been updated.
    nv.drawScene()
    nv.drawScene()
  } finally {
    if (markerMesh) markerMesh.visible = wasVisible
    nv.drawScene()
  }
}

function configureSurfaceMarkerDragging(canvas: HTMLCanvasElement) {
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !isPointerNearSurfaceMarker(event)) return
    surfaceMarkerDragging = true
    surfaceMarkerDragPointerId = event.pointerId
    canvas.setPointerCapture(event.pointerId)
    canvas.classList.add('dragging-surface-marker')
    event.preventDefault()
    event.stopImmediatePropagation()
  }, true)

  canvas.addEventListener('pointermove', (event) => {
    if (!surfaceMarkerDragging || event.pointerId !== surfaceMarkerDragPointerId) return
    event.preventDefault()
    event.stopImmediatePropagation()
    pickSurfaceAtPointer(event)
  }, true)

  const finish = (event: PointerEvent) => {
    if (!surfaceMarkerDragging || event.pointerId !== surfaceMarkerDragPointerId) return
    event.preventDefault()
    event.stopImmediatePropagation()
    surfaceMarkerDragging = false
    surfaceMarkerDragPointerId = null
    canvas.classList.remove('dragging-surface-marker')
    try { canvas.releasePointerCapture(event.pointerId) } catch { /* already released */ }
  }
  canvas.addEventListener('pointerup', finish, true)
  canvas.addEventListener('pointercancel', finish, true)
  canvas.addEventListener('lostpointercapture', (event) => {
    if (surfaceMarkerDragPointerId !== event.pointerId) return
    surfaceMarkerDragging = false
    surfaceMarkerDragPointerId = null
    canvas.classList.remove('dragging-surface-marker')
  }, true)
}

function setVolumeLocationFromMM(mm: [number, number, number]) {
  const reference = views.sagittal.volumes[0]
  for (const nv of sliceViews) {
    nv.scene.crosshairPos = nv.mm2frac(mm as never)
    nv.drawScene()
  }
  const vox = reference ? Array.from(reference.mm2vox(mm, true)).slice(0, 3).map(Number) : undefined
  scheduleLocationUpdate({ mm, vox })
}

function handleSurfaceLocationChange(data: LocationData) {
  if (!isDisplayOnlySurface(currentSurfaceKind) || mappingDisplaySurfaceClick) {
    scheduleLocationUpdate(data)
    return
  }
  const displayMM = data.mm?.slice(0, 3).map(Number) ?? []
  if (displayMM.length !== 3 || !displayMM.every(Number.isFinite)) return
  const meshes = views.surface.meshes.slice(0, 2)
  if (meshes.length < 2 || !pialSurfacePoints) return
  const candidates = meshes.map((mesh, hemisphereIndex) => {
    const nearest = mesh.indexNearestXYZmm(displayMM[0], displayMM[1], displayMM[2])
    return { hemisphereIndex, vertex: Math.round(nearest[0]), distance: Number(nearest[1]) }
  })
  const best = candidates[0].distance <= candidates[1].distance ? candidates[0] : candidates[1]
  const anatomical = pialSurfacePoints[best.hemisphereIndex]
  const offset = best.vertex * 3
  if (offset + 2 >= anatomical.length) return
  const anatomicalMM: [number, number, number] = [anatomical[offset], anatomical[offset + 1], anatomical[offset + 2]]
  mappingDisplaySurfaceClick = true
  try {
    setVolumeLocationFromMM(anatomicalMM)
  } finally {
    mappingDisplaySurfaceClick = false
  }
}

function updateSurfaceMarker(mm: [number, number, number]) {
  selectedMM = mm
  const nv = views.surface
  const marker = ensureSurfaceMarker()
  if (!marker || !markerOffsets || !nv.gl) return
  const displayMM = displayPositionForMM(mm)
  if (markerPosition && markerPosition.every((value, index) => Math.abs(value - displayMM[index]) < 1e-4)) return
  const points = marker.pts
  for (let index = 0; index < markerOffsets.length; index += 3) {
    points[index] = markerOffsets[index] + displayMM[0]
    points[index + 1] = markerOffsets[index + 1] + displayMM[1]
    points[index + 2] = markerOffsets[index + 2] + displayMM[2]
  }
  marker.visible = true
  markerPosition = [...displayMM]
  marker.updateMesh(nv.gl)
  nv.drawScene()
}

function scheduleSurfaceLocationReport(mm: [number, number, number]) {
  surfaceLookupGeneration += 1
  const generation = surfaceLookupGeneration
  if (surfaceLookupTimer !== null) window.clearTimeout(surfaceLookupTimer)
  setText('surface-hemi', mm[0] < 0 ? 'Left' : mm[0] > 0 ? 'Right' : 'Midline')
  setText('vertex', '…')
  setText('snap-distance', '…')
  clearMorphologyReport('…')
  surfaceLookupTimer = window.setTimeout(() => {
    if (generation !== surfaceLookupGeneration) return
    const corticalMeshes = views.surface.meshes.slice(0, 2)
    if (corticalMeshes.length < 2) {
      setText('vertex', 'Unavailable')
      setText('snap-distance', 'Unavailable')
      clearMorphologyReport('Unavailable')
      return
    }
    const best = isDisplayOnlySurface(currentSurfaceKind)
      ? nearestPialVertex(mm)
      : (() => {
          const results = corticalMeshes.map((mesh, index) => {
            const nearest = mesh.indexNearestXYZmm(mm[0], mm[1], mm[2])
            return { hemisphereIndex: index, hemisphere: index === 0 ? 'Left' as const : 'Right' as const, vertex: Math.round(nearest[0]), distance: Number(nearest[1]) }
          })
          return results[0].distance <= results[1].distance ? results[0] : results[1]
        })()
    if (!best) {
      setText('vertex', 'Unavailable')
      setText('snap-distance', 'Unavailable')
      clearMorphologyReport('Unavailable')
      return
    }
    setText('surface-hemi', best.hemisphere)
    setText('vertex', best.vertex.toLocaleString())
    setText('snap-distance', `${best.distance.toFixed(2)} mm`)
    const hemisphere = best.hemisphere as Hemisphere
    const curvature = morphologyValue(hemisphere, 'curvature', best.vertex)
    const sulc = morphologyValue(hemisphere, 'sulc', best.vertex)
    const thickness = morphologyValue(hemisphere, 'thickness', best.vertex)
    setText('curvature-value', curvature === null ? 'N/A' : curvature.toFixed(3))
    setText('sulc-value', sulc === null ? 'N/A' : sulc.toFixed(3))
    setText('thickness-value', thickness === null ? 'N/A' : `${thickness.toFixed(2)} mm`)
  }, 110)
}

function updateLocation(data: LocationData) {
  updateLocationText(data)
  const mm = data.mm?.slice(0, 3).map(Number) ?? []
  if (mm.length === 3 && mm.every(Number.isFinite)) {
    const location: [number, number, number] = [mm[0], mm[1], mm[2]]
    setText('hemi', mm[0] < 0 ? 'Left' : mm[0] > 0 ? 'Right' : 'Midline')
    setText('status', `Ready · ${currentVisibleAtlasNames.length ? currentVisibleAtlasNames.join(' + ') : 'no atlas visible'}`)
    document.getElementById('surface-message')?.classList.add('hidden')
    updateSurfaceMarker(location)
    scheduleSurfaceLocationReport(location)
  }
}

function scheduleLocationUpdate(data: LocationData) {
  pendingLocation = data
  if (locationUpdateRequested) return
  locationUpdateRequested = true
  requestAnimationFrame(() => {
    locationUpdateRequested = false
    const location = pendingLocation
    pendingLocation = null
    if (location) updateLocation(location)
  })
}

async function loadSliceView(nv: Niivue, canvasId: string, sliceType: SLICE_TYPE) {
  await nv.attachTo(canvasId)
  nv.setSliceType(sliceType)
  nv.setSliceMM(true)
  nv.setCrosshairWidth(1)
  await nv.loadVolumes([{ url: requiredUrl(requireMonkey().anatomy, 'T1w anatomy'), colormap: 'gray', colorbarVisible: false }])
  // Slice views always report anatomical volume coordinates. Do not route these
  // events through the inflated-surface click mapper, which interprets coordinates
  // in displaced display space.
  nv.onLocationChange = (location: unknown) => scheduleLocationUpdate(location as LocationData)
}

async function addCategoricalAtlas(
  nv: Niivue,
  options: {
    url: string
    name: string
    opacity: number
    lut: LabelLut
    calMin: number
    calMax: number
    kind: AtlasKind
    charmLevelIndex?: number
  },
) {
  await nv.addVolumeFromUrl({
    url: options.url,
    name: options.name,
    opacity: options.opacity,
    colormapLabel: options.lut,
    ignoreZeroVoxels: true,
    colorbarVisible: false,
    cal_min: options.calMin,
    cal_max: options.calMax,
    trustCalMinMax: false,
  })

  // Match the categorical setup used by the earlier working ARM2 spike.
  // Explicitly reapply the LUT after loading because NiiVue may otherwise
  // retain the volume's continuous grayscale calibration.
  const layerIndex = nv.volumes.length - 1
  const volume = nv.volumes[layerIndex]
  volume.colormapLabel = options.lut
  volume.cal_min = options.calMin
  volume.cal_max = options.calMax
  volume.opacity = options.opacity
  // NiiVue colormap type 2 applies a hard transparent threshold below cal_min.
  // With cal_min=1, atlas background value 0 is not blended into the T1.
  volume.colormapType = options.kind === 'charm' ? 0 : 2
  volume.ignoreZeroVoxels = true
  ;(volume as unknown as { isTransparentBelowCalMin?: boolean }).isTransparentBelowCalMin = options.kind !== 'charm'
  // Enforce ROI visibility in the voxel data as well as in the LUT. NiiVue's
  // categorical shader does not consistently honor per-label alpha on every
  // volume path, so hidden and unknown labels are converted to background.
  maskAtlasVolumeData(volume, options.kind, options.charmLevelIndex ?? currentCharmLevel - 1)
  const previousNearest = nv.opts.isNearestInterpolation
  nv.opts.isNearestInterpolation = true
  nv.updateInterpolation(layerIndex)
  nv.opts.isNearestInterpolation = previousNearest
  nv.updateGLVolume()
}

function updateFunctionalMapLegends() {
  const retinotopyActive = functionalDisplay !== 'none' && (functionalVolumeVisible || functionalSurfaceVisible)
  const somatotopyActive = somatotopyDisplay !== 'none' && (somatotopyVolumeVisible || somatotopySurfaceVisible)
  document.getElementById('polar-angle-legend')?.classList.toggle('hidden', !(retinotopyActive && functionalDisplay === 'polar'))
  document.getElementById('eccentricity-legend')?.classList.toggle('hidden', !(retinotopyActive && functionalDisplay === 'eccentricity'))
  document.getElementById('somatotopy-legend')?.classList.toggle('hidden', !somatotopyActive)
  document.getElementById('functional-map-legends')?.classList.toggle('hidden', !retinotopyActive && !somatotopyActive)
}

async function replaceVisibleAtlasLayers() {
  updateFunctionalMapLegends()
  const token = ++layerRefreshToken
  setText('status', 'Updating layers…')
  for (const nv of sliceViews) {
    while (nv.volumes.length > 1) nv.removeVolumeByIndex(nv.volumes.length - 1)
  }

  currentVisibleAtlasNames = []
  if (visibleState.charm.visible) currentVisibleAtlasNames.push(`ARM L${currentCharmLevel}`)
  if (visibleState.d99.visible) currentVisibleAtlasNames.push('D99')
  if (functionalVolumeVisible && functionalDisplay !== 'none') {
    currentVisibleAtlasNames.push(functionalDisplay === 'polar' ? 'Polar angle' : 'Eccentricity')
  }
  if (somatotopyVolumeVisible && somatotopyDisplay !== 'none') currentVisibleAtlasNames.push('Somatotopy')

  charmLut = applyAtlasVisibilityMask(createArmLut(currentCharmLevel - 1), 'charm')

  // Keep layer insertion order deterministic within each viewer. Earlier
  // Promise-all insertion allowed atlas and functional layers to exchange
  // indices, causing one opacity slider to control another layer.
  await Promise.all(sliceViews.map(async (nv) => {
    if (visibleState.charm.visible) {
      await addCategoricalAtlas(nv, {
        url: requiredUrl(requireMonkey().atlases.charm[String(currentCharmLevel)], `ARM Level ${currentCharmLevel}`),
        name: `ARM Level ${currentCharmLevel}`,
        opacity: visibleState.charm.opacity,
        lut: charmLut,
        calMin: ARM_MIN,
        calMax: ARM_MAX,
        kind: 'charm',
        charmLevelIndex: currentCharmLevel - 1,
      })
    }
    if (visibleState.d99.visible) {
      await addCategoricalAtlas(nv, {
        url: requiredUrl(requireMonkey().atlases.d99, 'D99'),
        name: 'D99',
        opacity: visibleState.d99.opacity,
        lut: applyAtlasVisibilityMask(d99Lut, 'd99'),
        calMin: 1,
        calMax: D99_MAX,
        kind: 'd99',
      })
    }
    if (functionalVolumeVisible && functionalDisplay !== 'none') {
      await addFunctionalOverlay(nv)
    }
    if (somatotopyVolumeVisible && somatotopyDisplay !== 'none') await addSomatotopyOverlay(nv)
    for (const layer of importedLayers) await addImportedLayerToView(nv, layer)
  }))

  if (token !== layerRefreshToken) return
  renderLegend()
  setText('status', `Ready · ${currentVisibleAtlasNames.length ? currentVisibleAtlasNames.join(' + ') : 'no overlay visible'}`)
  if (selectedMM) renderAtlasReport(atlasReportsAtMM(selectedMM))
}

function surfaceUrls(kind: SurfaceKind): [string, string] {
  const pair = requireMonkey().surfaces[kind]
  if (!pair) throw new Error(`${surfaceDisplayName(kind)} surfaces are not available for this monkey`)
  return [pair.left, pair.right]
}


function registerFunctionalColormaps() {
  // Colors sampled from the supplied AFNI-style reference legends. The
  // first LUT entry is transparent and reserved for thresholded voxels.
  const eccentricityColors = [
    [204, 16, 51], [207, 15, 39], [254, 94, 0], [255, 204, 0],
    [248, 227, 0], [214, 251, 0], [102, 255, 0], [0, 255, 0],
    [0, 220, 51], [0, 185, 102], [0, 255, 255], [0, 204, 255],
    [0, 153, 255], [0, 105, 255], [0, 68, 255], [0, 0, 255],
  ]
  const polarColors = [
    [23, 225, 24], [1, 255, 255], [0, 204, 255], [0, 105, 255],
    [0, 0, 254], [0, 105, 255], [0, 204, 255], [1, 255, 255],
    [0, 255, 1], [204, 255, 0], [255, 204, 0], [255, 102, 0],
    [254, 0, 0], [255, 102, 0], [255, 204, 0], [204, 255, 0],
    [0, 255, 1],
  ]
  const asColormap = (colors: number[][]) => ({
    R: [0, ...colors.map((color) => color[0])],
    G: [0, ...colors.map((color) => color[1])],
    B: [0, ...colors.map((color) => color[2])],
    A: [0, ...colors.map(() => 255)],
    I: [0, ...colors.map((_, index) => 1 + Math.round(index * 254 / Math.max(1, colors.length - 1)))],
  })

  for (const nv of [...sliceViews, views.surface]) {
    nv.addColormap('brainana_eccentricity_0_10', asColormap(eccentricityColors))
    // Somatotopy is linear, but its direction is reversed relative to
    // eccentricity: 0 is blue and 100 is red.
    nv.addColormap('brainana_somatotopy_0_100', asColormap([...eccentricityColors].reverse()))
    nv.addColormap('brainana_polar_angle', asColormap(polarColors))
  }
}

function registerSurfaceColormaps() {
  // A hard sign boundary, modeled after the familiar FreeSurfer/SUMA
  // curvature underlay. Values below zero are light gray (concave),
  // values above zero are dark gray (convex). Adjacent control points
  // at 127/128 prevent interpolation across the zero boundary.
  views.surface.addColormap('brainana_freesurfer_curvature', {
    R: [214, 214, 72, 72],
    G: [214, 214, 72, 72],
    B: [214, 214, 72, 72],
    A: [255, 255, 255, 255],
    I: [0, 127, 128, 255],
  })
}

async function initializeSurfaceView() {
  const nv = views.surface
  await nv.attachTo('surface')
  nv.setHighResolutionCapable(true)
  nv.setSliceMM(true)
  nv.setSliceType(SLICE_TYPE.RENDER)
  nv.opts.show3Dcrosshair = false
  nv.opts.isOrientCube = false
  nv.onLocationChange = (location: unknown) => handleSurfaceLocationChange(location as LocationData)
  registerSurfaceColormaps()
  await nv.loadVolumes([{ url: requiredUrl(requireMonkey().anatomy, 'T1w anatomy'), colormap: 'gray', opacity: 0.0, colorbarVisible: false }])
  await loadSurface('pial')
  if (selectedMM) updateSurfaceMarker(selectedMM)
  nv.setScale(SURFACE_SCALE)
  nv.drawScene()
  updateSurfaceOrientationIndicator(true)
}

async function loadSurface(kind: SurfaceKind) {
  const nv = views.surface
  currentSurfaceKind = kind
  markerMesh = null
  markerOffsets = null
  markerPosition = null

  const layerSpecs = [
    { key: 'curvatureBinary', metric: 'curvature' as MorphologyMetric, urls: [requireMonkey().morphology.shape.curvature.left, requireMonkey().morphology.shape.curvature.right], colormap: 'brainana_freesurfer_curvature' },
    { key: 'curvatureContinuous', metric: 'curvature' as MorphologyMetric, urls: [requireMonkey().morphology.shape.curvature.left, requireMonkey().morphology.shape.curvature.right], colormap: 'gray' },
    { key: 'sulc', metric: 'sulc' as MorphologyMetric, urls: [requireMonkey().morphology.shape.sulc.left, requireMonkey().morphology.shape.sulc.right], colormap: 'blue2red' },
    { key: 'thickness', metric: 'thickness' as MorphologyMetric, urls: [requireMonkey().morphology.shape.thickness.left, requireMonkey().morphology.shape.thickness.right], colormap: 'viridis' },
  ] as const

  const layerIsVisible = (key: typeof layerSpecs[number]['key']) => {
    if (activeMorphology === 'none') return false
    if (key === 'curvatureBinary') return activeMorphology === 'curvature' && curvatureStyle === 'binary'
    if (key === 'curvatureContinuous') return activeMorphology === 'curvature' && curvatureStyle === 'continuous'
    return activeMorphology === key
  }

  const meshSpecs = surfaceUrls(kind).map((url, hemisphereIndex) => ({
    url,
    rgba255: [172, 172, 172, 255],
    colorbarVisible: false,
    layers: layerSpecs.map(({ key, metric, urls, colormap }) => ({
      url: urls[hemisphereIndex],
      colormap,
      cal_min: key === 'curvatureBinary' ? -1 : morphologyRanges[metric].min,
      cal_max: key === 'curvatureBinary' ? 1 : morphologyRanges[metric].max,
      opacity: layerIsVisible(key) ? 1.0 : 0.0,
      colorbarVisible: false,
    })),
  }))

  await nv.loadMeshes(meshSpecs as unknown as Parameters<typeof nv.loadMeshes>[0])
  nv.setSliceType(SLICE_TYPE.RENDER)
  nv.setScale(SURFACE_SCALE_BY_KIND[kind])

  const corticalMeshes = nv.meshes.slice(0, 2)
  for (const mesh of corticalMeshes) {
    const layers = [
      { index: morphologyLayerIndex.curvatureBinary, min: -1, max: 1, visible: activeMorphology === 'curvature' && curvatureStyle === 'binary' },
      { index: morphologyLayerIndex.curvatureContinuous, min: morphologyRanges.curvature.min, max: morphologyRanges.curvature.max, visible: activeMorphology === 'curvature' && curvatureStyle === 'continuous' },
      { index: morphologyLayerIndex.sulc, min: morphologyRanges.sulc.min, max: morphologyRanges.sulc.max, visible: activeMorphology === 'sulc' },
      { index: morphologyLayerIndex.thickness, min: morphologyRanges.thickness.min, max: morphologyRanges.thickness.max, visible: activeMorphology === 'thickness' },
    ]
    for (const layer of layers) {
      if (!mesh.layers?.[layer.index]) continue
      await nv.setMeshLayerProperty(mesh.id, layer.index, 'isTransparentBelowCalMin', 0)
      await nv.setMeshLayerProperty(mesh.id, layer.index, 'cal_min', layer.min)
      await nv.setMeshLayerProperty(mesh.id, layer.index, 'cal_max', layer.max)
      await nv.setMeshLayerProperty(mesh.id, layer.index, 'opacity', layer.visible ? 1.0 : 0.0)
    }
  }

  ensureSurfaceMarker()
  if (selectedMM) updateSurfaceMarker(selectedMM)
  nv.drawScene()
  const display = surfaceDisplayName(kind)
  setText('surface-name', display)
  const morphologyText = activeMorphology === 'none'
    ? 'none'
    : activeMorphology === 'curvature'
      ? `Curvature · ${curvatureStyle === 'binary' ? 'binary' : 'continuous'}`
      : morphologyLabel[activeMorphology]
  setText('surface-title', `Surface (${display} · ${morphologyText})`)
  await refreshProjectedSurfaceLayers()
}

async function applyMorphologyDisplay() {
  const nv = views.surface
  const corticalMeshes = nv.meshes.slice(0, 2)
  for (const mesh of corticalMeshes) {
    const layers = [
      { index: morphologyLayerIndex.curvatureBinary, min: -1, max: 1, visible: activeMorphology === 'curvature' && curvatureStyle === 'binary' },
      { index: morphologyLayerIndex.curvatureContinuous, min: morphologyRanges.curvature.min, max: morphologyRanges.curvature.max, visible: activeMorphology === 'curvature' && curvatureStyle === 'continuous' },
      { index: morphologyLayerIndex.sulc, min: morphologyRanges.sulc.min, max: morphologyRanges.sulc.max, visible: activeMorphology === 'sulc' },
      { index: morphologyLayerIndex.thickness, min: morphologyRanges.thickness.min, max: morphologyRanges.thickness.max, visible: activeMorphology === 'thickness' },
    ]
    for (const layer of layers) {
      if (!mesh.layers?.[layer.index]) continue
      await nv.setMeshLayerProperty(mesh.id, layer.index, 'cal_min', layer.min)
      await nv.setMeshLayerProperty(mesh.id, layer.index, 'cal_max', layer.max)
      await nv.setMeshLayerProperty(mesh.id, layer.index, 'opacity', layer.visible ? 1.0 : 0.0)
    }
  }
  const selectedGeometry = document.querySelector<HTMLSelectElement>('#surface-kind')?.value ?? 'pial'
  const geometry = surfaceDisplayName(selectedGeometry as SurfaceKind)
  const morphologyText = activeMorphology === 'none'
    ? 'none'
    : activeMorphology === 'curvature'
      ? `Curvature · ${curvatureStyle === 'binary' ? 'binary' : 'continuous'}`
      : morphologyLabel[activeMorphology]
  setText('surface-title', `Surface (${geometry} · ${morphologyText})`)
  nv.drawScene()
}




type ProjectionResult = [Float32Array, Float32Array]
const projectionResolvers = new Map<number, { resolve: (value: ProjectionResult) => void; reject: (reason?: unknown) => void }>()

function setProjectionProgress(show: boolean, label = 'Projecting…', value = 0) {
  const root = document.getElementById('projection-progress')
  const bar = document.querySelector<HTMLProgressElement>('#projection-progress-bar')
  root?.classList.toggle('hidden', !show)
  setText('projection-progress-label', label)
  if (bar) bar.value = value
}

function copyImageValues(image: NVImage): Float32Array {
  if (!image.img) throw new Error(`${image.name || 'Volume'} has no voxel data`)
  const [dx, dy, dz] = volumeDimensions(image)
  const frameSize = dx * dy * dz
  const frame = Number(image.frame4D ?? 0)
  const offset = Math.max(0, frame) * frameSize
  const output = new Float32Array(frameSize)
  for (let index = 0; index < frameSize; index += 1) output[index] = Number(image.img[offset + index])
  return output
}

function finiteFrameRange(image: NVImage): { min: number; max: number } | null {
  const values = copyImageValues(image)
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index])
    if (!Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null
}

function thresholdSliderStep(min: number, max: number): number {
  const span = Math.max(0, max - min)
  if (span <= 1) return 0.01
  if (span <= 10) return 0.05
  if (span <= 100) return 0.1
  return 0.5
}

function formatThresholdValue(value: number, step: number): string {
  if (step < 0.05) return value.toFixed(2)
  if (step < 0.5) return value.toFixed(1)
  return value.toFixed(1)
}

function updateFunctionalThresholdRange() {
  const slider = document.querySelector<HTMLInputElement>('#functional-threshold')
  const source = functionalThresholdSource()
  if (!slider || !source) return
  const range = finiteFrameRange(source)
  if (!range) return
  const step = thresholdSliderStep(range.min, range.max)
  const safeMax = range.max > range.min ? range.max : range.min + step
  slider.min = String(range.min)
  slider.max = String(safeMax)
  slider.step = String(step)
  functionalThresholdValue = Math.max(range.min, Math.min(range.max, functionalThresholdValue))
  slider.value = String(functionalThresholdValue)
  slider.title = `Threshold-map range: ${range.min.toFixed(2)} to ${range.max.toFixed(2)}`
  setText('functional-threshold-value', formatThresholdValue(functionalThresholdValue, step))
}

function updateSomatotopyThresholdRange() {
  const slider = document.querySelector<HTMLInputElement>('#somatotopy-threshold')
  const source = somatotopySources.fstat
  if (!slider || !source) return
  const range = finiteFrameRange(source)
  if (!range) return
  const step = thresholdSliderStep(range.min, range.max)
  const safeMax = range.max > range.min ? range.max : range.min + step
  slider.min = String(range.min)
  slider.max = String(safeMax)
  slider.step = String(step)
  somatotopyThresholdValue = Math.max(range.min, Math.min(range.max, somatotopyThresholdValue))
  slider.value = String(somatotopyThresholdValue)
  slider.title = `Somatotopy F range: ${range.min.toFixed(2)} to ${range.max.toFixed(2)}`
  setText('somatotopy-threshold-value', formatThresholdValue(somatotopyThresholdValue, step))
}

function volumeDimensions(image: NVImage): [number, number, number] {
  const dims = image.hdr?.dims ?? image.dims
  if (!dims || dims.length < 4) throw new Error('Unable to determine volume dimensions')
  return [Number(dims[1]), Number(dims[2]), Number(dims[3])]
}

function voxelBasis(image: NVImage) {
  const origin = Array.from(image.mm2vox([0, 0, 0], true)).map(Number)
  const x = Array.from(image.mm2vox([1, 0, 0], true)).map(Number)
  const y = Array.from(image.mm2vox([0, 1, 0], true)).map(Number)
  const z = Array.from(image.mm2vox([0, 0, 1], true)).map(Number)
  return {
    origin,
    axisX: x.map((value, index) => value - origin[index]),
    axisY: y.map((value, index) => value - origin[index]),
    axisZ: z.map((value, index) => value - origin[index]),
  }
}

async function initializeProjectionEngine() {
  const gl = views.surface.gl
  const reference = views.sagittal.volumes[0]
  if (!gl || !reference) throw new Error('Surface projection requires initialized surface and volume viewers')
  setText('status', 'Preparing cortical ribbon projector…')
  const [leftWhite, rightWhite, leftPial, rightPial] = await Promise.all([
    NVMesh.loadFromUrl({ url: requiredUrl(requireMonkey().surfaces.white?.left, 'Left white surface'), gl, visible: false }),
    NVMesh.loadFromUrl({ url: requiredUrl(requireMonkey().surfaces.white?.right, 'Right white surface'), gl, visible: false }),
    NVMesh.loadFromUrl({ url: requiredUrl(requireMonkey().surfaces.pial?.left, 'Left pial surface'), gl, visible: false }),
    NVMesh.loadFromUrl({ url: requiredUrl(requireMonkey().surfaces.pial?.right, 'Right pial surface'), gl, visible: false }),
  ])
  whiteSurfacePoints = [new Float32Array(leftWhite.pts), new Float32Array(rightWhite.pts)]
  pialSurfacePoints = [new Float32Array(leftPial.pts), new Float32Array(rightPial.pts)]
  pialReferenceMeshes = [leftPial, rightPial]
  const basis = voxelBasis(reference)
  projectionWorker = new Worker(new URL('./projection.worker.ts', import.meta.url), { type: 'module' })
  projectionWorker.onmessage = (event: MessageEvent) => {
    const message = event.data as { type: string; id?: number; progress?: number; label?: string; left?: Float32Array; right?: Float32Array; message?: string }
    if (message.type === 'progress') {
      setProjectionProgress(true, message.label ?? 'Projecting…', message.progress ?? 0)
      return
    }
    if (message.type === 'ready') {
      projectionCacheReady = true
      setProjectionProgress(false)
      setText('status', 'Ready · surface projection available')
      return
    }
    if (message.type === 'result' && message.id !== undefined && message.left && message.right) {
      const pending = projectionResolvers.get(message.id)
      projectionResolvers.delete(message.id)
      setProjectionProgress(false)
      pending?.resolve([message.left, message.right])
      return
    }
    if (message.type === 'error' && message.id !== undefined) {
      const pending = projectionResolvers.get(message.id)
      projectionResolvers.delete(message.id)
      setProjectionProgress(false)
      pending?.reject(new Error(message.message ?? 'Projection failed'))
    }
  }
  projectionWorker.postMessage({
    type: 'init',
    leftWhite: whiteSurfacePoints[0],
    rightWhite: whiteSurfacePoints[1],
    leftPial: new Float32Array(leftPial.pts),
    rightPial: new Float32Array(rightPial.pts),
    ...basis,
    dims: volumeDimensions(reference),
    sampleCount: 9,
  })
}

function requestProjection(message: Record<string, unknown>): Promise<ProjectionResult> {
  if (!projectionWorker || !projectionCacheReady) return Promise.reject(new Error('Projection engine is still initializing'))
  const id = ++projectionRequestId
  return new Promise((resolve, reject) => {
    projectionResolvers.set(id, { resolve, reject })
    projectionWorker!.postMessage({ ...message, id })
  })
}

function projectionCacheKey(kind: 'charm' | 'd99' | 'function' | 'somatotopy'): string {
  if (kind === 'charm') return `charm:${currentCharmLevel}`
  if (kind === 'd99') return 'd99'
  if (kind === 'somatotopy') return `somatotopy:${somatotopyThresholdValue.toFixed(3)}`
  return `function:${functionalDisplay}:${functionalThresholdMap}:${functionalThresholdValue.toFixed(3)}`
}

async function projectAtlasToSurface(kind: 'charm' | 'd99'): Promise<ProjectionResult> {
  const key = projectionCacheKey(kind)
  const cached = projectedSurfaceCache.get(key)
  if (cached) return cached
  const image = kind === 'charm' ? armLookupImages[currentCharmLevel - 1] : d99LookupImage
  if (!image) throw new Error(`${kind.toUpperCase()} volume is unavailable`)
  setProjectionProgress(true, `Projecting ${kind === 'charm' ? `ARM L${currentCharmLevel}` : 'D99'}…`, 0)
  const result = await requestProjection({ type: 'projectAtlas', values: copyImageValues(image) })
  projectedSurfaceCache.set(key, result)
  return result
}

async function projectFunctionToSurface(): Promise<ProjectionResult> {
  const key = projectionCacheKey('function')
  const cached = projectedSurfaceCache.get(key)
  if (cached) return cached
  const values = functionalDisplaySource()
  if (!values) throw new Error('Select a functional display map first')
  const explicitThreshold = functionalThresholdSource()
  const support = explicitThreshold ?? pairedSupportSource()
  const cutoff = explicitThreshold ? functionalThresholdValue : 0
  setProjectionProgress(true, `Projecting ${functionalDisplay === 'polar' ? 'polar angle' : 'eccentricity'}…`, 0)
  const result = await requestProjection({
    type: 'projectFunction',
    values: copyImageValues(values),
    thresholds: support ? copyImageValues(support) : null,
    cutoff,
    mode: functionalDisplay,
  })
  projectedSurfaceCache.set(key, result)
  return result
}

async function projectSomatotopyToSurface(): Promise<ProjectionResult> {
  const key = projectionCacheKey('somatotopy')
  const cached = projectedSurfaceCache.get(key)
  if (cached) return cached
  const values = somatotopySources.phase
  const support = somatotopySources.fstat
  if (!values || !support) throw new Error('Somatotopy data are unavailable')
  setProjectionProgress(true, 'Projecting somatotopy…', 0)
  const result = await requestProjection({
    type: 'projectFunction',
    values: copyImageValues(values),
    thresholds: copyImageValues(support),
    cutoff: somatotopyThresholdValue,
    mode: 'somatotopy',
  })
  projectedSurfaceCache.set(key, result)
  return result
}


function importedProjectionCacheKey(layer: ImportedLayer): string {
  return `imported:${layer.id}:${layer.projectionMethod}:${layer.zeroBackground ? 1 : 0}`
}

async function importedVolumeImage(layer: ImportedLayer): Promise<NVImage> {
  const image = views.sagittal.volumes.find((volume) => volume.name === `Imported:${layer.id}`)
  if (image) return image
  return NVImage.loadFromUrl({ url: layer.displayUrl, name: `Imported:${layer.id}` })
}

async function projectImportedToSurface(layer: ImportedLayer): Promise<ProjectionResult> {
  const key = importedProjectionCacheKey(layer)
  const cached = projectedSurfaceCache.get(key)
  if (cached) return cached
  setProjectionProgress(true, `Projecting ${layer.name}…`, 0)
  const result = await requestProjection({
    type: 'projectImported',
    values: copyImageValues(await importedVolumeImage(layer)),
    method: layer.projectionMethod,
    zeroBackground: layer.zeroBackground,
  })
  projectedSurfaceCache.set(key, result)
  return result
}

function removeProjectedSurfaceLayers() {
  const gl = views.surface.gl
  if (!gl) return
  for (const mesh of views.surface.meshes.slice(0, 2)) {
    mesh.layers = mesh.layers.filter((layer) => !layer.name?.startsWith('projection:'))
    mesh.updateMesh(gl)
  }
}

function appendProjectedScalarLayer(
  mesh: NVMesh,
  name: string,
  values: Float32Array,
  lut: LabelLut,
  opacity: number,
) {
  const gl = views.surface.gl
  if (!gl) return
  const vertexCount = mesh.pts.length / 3
  if (values.length !== vertexCount) {
    throw new Error(`${name}: projected vertex count ${values.length} does not match mesh vertex count ${vertexCount}`)
  }

  // Use NiiVue's categorical scalar-layer path rather than packed RGBA values.
  // This preserves the exact LUT colors, honors LUT alpha for background label 0,
  // and alpha-blends the overlay over the active morphology layer.
  mesh.layers.push({
    ...NVMeshLayerDefaults,
    name: `projection:${name}`,
    values,
    opacity,
    colormap: 'gray',
    colormapLabel: lut,
    global_min: lut.min,
    global_max: lut.max,
    cal_min: lut.min,
    cal_max: lut.max,
    nFrame4D: 1,
    frame4D: 0,
    isTransparentBelowCalMin: false,
    colormapType: 0,
    colorbarVisible: false,
    showLegend: false,
  })
  mesh.updateMesh(gl)
}



function appendProjectedContinuousLayer(
  mesh: NVMesh,
  name: string,
  values: Float32Array,
  colormap: string,
  opacity: number,
  calMin: number,
  calMax: number,
  zeroBackground: boolean,
) {
  const gl = views.surface.gl
  if (!gl) return
  const vertexCount = mesh.pts.length / 3
  if (values.length !== vertexCount) throw new Error(`${name}: projected vertex count ${values.length} does not match mesh vertex count ${vertexCount}`)
  mesh.layers.push({
    ...NVMeshLayerDefaults,
    name: `projection:${name}`,
    values,
    opacity,
    colormap,
    global_min: calMin,
    global_max: calMax,
    cal_min: calMin,
    cal_max: calMax,
    nFrame4D: 1,
    frame4D: 0,
    isTransparentBelowCalMin: zeroBackground,
    colormapType: zeroBackground ? 2 : 0,
    colorbarVisible: false,
    showLegend: false,
  })
  mesh.updateMesh(gl)
}

function createImportedAtlasLut(layer: ImportedLayer): LabelLut | null {
  return importedLabelLut(layer.uniqueLabels) ?? null
}

function interpolateRgb(
  stops: Array<{ t: number; rgb: [number, number, number] }>,
  t: number,
): [number, number, number] {
  const x = Math.max(0, Math.min(1, t))
  for (let index = 1; index < stops.length; index += 1) {
    const right = stops[index]
    const left = stops[index - 1]
    if (x <= right.t) {
      const span = Math.max(right.t - left.t, Number.EPSILON)
      const a = (x - left.t) / span
      return [
        Math.round(left.rgb[0] + (right.rgb[0] - left.rgb[0]) * a),
        Math.round(left.rgb[1] + (right.rgb[1] - left.rgb[1]) * a),
        Math.round(left.rgb[2] + (right.rgb[2] - left.rgb[2]) * a),
      ]
    }
  }
  return stops[stops.length - 1].rgb
}

function createFunctionalSurfaceLut(mode: 'polar' | 'eccentricity' | 'somatotopy', brightness = 1): LabelLut {
  const rgba = new Uint8ClampedArray(256 * 4)
  const labels = new Array<string>(256).fill('')
  // Bin 0 is reserved for vertices with no surviving ribbon sample.
  rgba.set([0, 0, 0, 0], 0)
  const stops = mode === 'polar'
    ? [
        { t: 0.00, rgb: [0, 255, 0] as [number, number, number] },
        { t: 0.25, rgb: [0, 0, 255] as [number, number, number] },
        { t: 0.50, rgb: [0, 255, 0] as [number, number, number] },
        { t: 0.75, rgb: [255, 0, 0] as [number, number, number] },
        { t: 1.00, rgb: [0, 255, 0] as [number, number, number] },
      ]
    : [
        { t: 0.00, rgb: [255, 0, 0] as [number, number, number] },
        { t: 0.20, rgb: [255, 140, 0] as [number, number, number] },
        { t: 0.40, rgb: [255, 255, 0] as [number, number, number] },
        { t: 0.60, rgb: [0, 200, 0] as [number, number, number] },
        { t: 0.80, rgb: [0, 255, 255] as [number, number, number] },
        { t: 1.00, rgb: [0, 70, 255] as [number, number, number] },
      ]
  for (let bin = 1; bin < 256; bin += 1) {
    const t = (bin - 1) / 254
    // Eccentricity runs red to blue. Somatotopy uses the opposite mapping:
    // body-position 0 is blue and 100 is red, in both volume and surface views.
    const colorT = mode === 'somatotopy' ? 1 - t : t
    const [r0, g0, b0] = interpolateRgb(stops, colorT)
    const brighten = (channel: number) => brightness >= 1
      ? Math.min(255, Math.round(channel + (255 - channel) * (brightness - 1)))
      : Math.max(0, Math.round(channel * brightness))
    rgba.set([brighten(r0), brighten(g0), brighten(b0), 255], bin * 4)
  }
  return { lut: rgba, min: 0, max: 255, labels }
}

function quantizeFunctionalSurfaceValues(
  values: Float32Array,
  mode: 'polar' | 'eccentricity' | 'somatotopy',
): Float32Array {
  const bins = new Float32Array(values.length)
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!Number.isFinite(value) || value <= -999) {
      bins[index] = 0
      continue
    }
    let t: number
    if (mode === 'polar') {
      const wrapped = ((value + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
      t = wrapped / (2 * Math.PI)
    } else {
      const maximum = mode === 'somatotopy' ? 100 : 10
      t = Math.max(0, Math.min(maximum, value)) / maximum
    }
    bins[index] = 1 + Math.min(254, Math.max(0, Math.round(t * 254)))
  }
  return bins
}

async function refreshProjectedSurfaceLayers() {
  if (!projectionCacheReady) return
  removeProjectedSurfaceLayers()
  const meshes = views.surface.meshes.slice(0, 2)
  if (meshes.length < 2) return
  if (charmSurfaceVisible) {
    const values = await projectAtlasToSurface('charm')
    const lut = applyAtlasVisibilityMask(createArmLut(currentCharmLevel - 1), 'charm')
    appendProjectedScalarLayer(meshes[0], `ARM L${currentCharmLevel}`, values[0], lut, visibleState.charm.opacity)
    appendProjectedScalarLayer(meshes[1], `ARM L${currentCharmLevel}`, values[1], lut, visibleState.charm.opacity)
  }
  if (d99SurfaceVisible) {
    const values = await projectAtlasToSurface('d99')
    const visibleD99Lut = applyAtlasVisibilityMask(d99Lut, 'd99')
    appendProjectedScalarLayer(meshes[0], 'D99', values[0], visibleD99Lut, visibleState.d99.opacity)
    appendProjectedScalarLayer(meshes[1], 'D99', values[1], visibleD99Lut, visibleState.d99.opacity)
  }
  const appendRetinotopySurface = async () => {
    if (!functionalSurfaceVisible || functionalDisplay === 'none') return
    const values = await projectFunctionToSurface()
    const mode = functionalDisplay === 'polar' ? 'polar' : 'eccentricity'
    const lut = createFunctionalSurfaceLut(mode, functionalSurfaceBrightness)
    const leftBins = quantizeFunctionalSurfaceValues(values[0], mode)
    const rightBins = quantizeFunctionalSurfaceValues(values[1], mode)
    const layerName = mode === 'polar' ? 'Polar angle' : 'Eccentricity'
    appendProjectedScalarLayer(meshes[0], layerName, leftBins, lut, functionalOpacity)
    appendProjectedScalarLayer(meshes[1], layerName, rightBins, lut, functionalOpacity)
  }
  const appendSomatotopySurface = async () => {
    if (!somatotopySurfaceVisible || somatotopyDisplay === 'none') return
    const values = await projectSomatotopyToSurface()
    const lut = createFunctionalSurfaceLut('somatotopy', somatotopySurfaceBrightness)
    const leftBins = quantizeFunctionalSurfaceValues(values[0], 'somatotopy')
    const rightBins = quantizeFunctionalSurfaceValues(values[1], 'somatotopy')
    appendProjectedScalarLayer(meshes[0], 'Somatotopy', leftBins, lut, somatotopyOpacity)
    appendProjectedScalarLayer(meshes[1], 'Somatotopy', rightBins, lut, somatotopyOpacity)
  }
  if (functionalSurfaceOrder === 'somatotopy') {
    await appendRetinotopySurface()
    await appendSomatotopySurface()
  } else {
    await appendSomatotopySurface()
    await appendRetinotopySurface()
  }
  if (activeImportedProjectionId) {
    const layer = importedLayers.find((candidate) => candidate.id === activeImportedProjectionId)
    if (layer) {
      const values = await projectImportedToSurface(layer)
      if (layer.dataType === 'atlas') {
        const lut = createImportedAtlasLut(layer)
        if (lut) {
          appendProjectedScalarLayer(meshes[0], `Imported ${layer.name}`, values[0], lut, layer.opacity)
          appendProjectedScalarLayer(meshes[1], `Imported ${layer.name}`, values[1], lut, layer.opacity)
        } else {
          appendProjectedContinuousLayer(meshes[0], `Imported ${layer.name}`, values[0], layer.colormap, layer.opacity, layer.calMin, layer.calMax, layer.zeroBackground)
          appendProjectedContinuousLayer(meshes[1], `Imported ${layer.name}`, values[1], layer.colormap, layer.opacity, layer.calMin, layer.calMax, layer.zeroBackground)
        }
      } else {
        appendProjectedContinuousLayer(meshes[0], `Imported ${layer.name}`, values[0], layer.colormap, layer.opacity, layer.calMin, layer.calMax, layer.zeroBackground)
        appendProjectedContinuousLayer(meshes[1], `Imported ${layer.name}`, values[1], layer.colormap, layer.opacity, layer.calMin, layer.calMax, layer.zeroBackground)
      }
    }
  }
  views.surface.drawScene()
}


type OrientationAxisSpec = {
  key: 'lr' | 'ap' | 'si'
  vector: [number, number, number]
  positiveLabel: 'r' | 'a' | 's'
  negativeLabel: 'l' | 'p' | 'i'
}

const SURFACE_ORIENTATION_AXES: OrientationAxisSpec[] = [
  { key: 'lr', vector: [1, 0, 0], positiveLabel: 'r', negativeLabel: 'l' },
  { key: 'ap', vector: [0, 1, 0], positiveLabel: 'a', negativeLabel: 'p' },
  { key: 'si', vector: [0, 0, 1], positiveLabel: 's', negativeLabel: 'i' },
]

let lastSurfaceOrientationSignature = ''

function transformOrientationDirection(matrix: ArrayLike<number>, vector: [number, number, number]): [number, number, number] {
  // gl-matrix and NiiVue use column-major matrices. A direction has w=0,
  // so camera translation, panning, and pivot offsets do not affect it.
  const [x, y, z] = vector
  const tx = Number(matrix[0]) * x + Number(matrix[4]) * y + Number(matrix[8]) * z
  const ty = Number(matrix[1]) * x + Number(matrix[5]) * y + Number(matrix[9]) * z
  const tz = Number(matrix[2]) * x + Number(matrix[6]) * y + Number(matrix[10]) * z
  const length = Math.hypot(tx, ty, tz) || 1
  return [tx / length, ty / length, tz / length]
}

function setOrientationLabelPosition(label: string, x: number, y: number, opacity: number) {
  const node = document.getElementById(`orientation-label-${label}`)
  if (!node) return
  node.setAttribute('x', x.toFixed(2))
  node.setAttribute('y', y.toFixed(2))
  node.setAttribute('opacity', opacity.toFixed(3))
}

function updateSurfaceOrientationIndicator(force = false) {
  const widget = document.getElementById('surface-orientation')
  const nv = views.surface
  const meshes = Array.isArray(nv?.meshes) ? nv.meshes : []
  if (!widget || !nv?.gl || meshes.length === 0) {
    widget?.classList.add('hidden')
    return
  }
  widget.classList.remove('hidden')

  const azimuth = Number(nv.scene.renderAzimuth ?? 0)
  const elevation = Number(nv.scene.renderElevation ?? 0)
  const signature = `${azimuth.toFixed(4)}|${elevation.toFixed(4)}|${currentSurfaceKind}|${nv.meshes.length}`
  if (!force && signature === lastSurfaceOrientationSignature) return
  lastSurfaceOrientationSignature = signature

  let modelMatrix: ArrayLike<number>
  try {
    const canvas = nv.canvas
    const width = Number(canvas?.width ?? nv.gl.canvas.width ?? 1)
    const height = Number(canvas?.height ?? nv.gl.canvas.height ?? 1)
    modelMatrix = nv.calculateMvpMatrix(null, [0, 0, width, height], azimuth, elevation)[1]
  } catch {
    return
  }

  const origin = 48
  const axisRadius = 29
  const labelRadius = 37
  for (const axis of SURFACE_ORIENTATION_AXES) {
    const [cameraX, cameraY, cameraZ] = transformOrientationDirection(modelMatrix, axis.vector)
    // SVG y increases downward, opposite the rendered camera y direction.
    const screenX = cameraX
    const screenY = -cameraY
    const projectedLength = Math.min(1, Math.hypot(screenX, screenY))
    const lineX = screenX * axisRadius
    const lineY = screenY * axisRadius
    const labelScale = projectedLength > 1e-5 ? labelRadius / Math.max(projectedLength, 0.28) : 0
    const labelX = screenX * labelScale
    const labelY = screenY * labelScale
    const opacity = 0.22 + 0.78 * projectedLength

    const line = document.getElementById(`orientation-line-${axis.key}`)
    if (line) {
      line.setAttribute('x1', (origin - lineX).toFixed(2))
      line.setAttribute('y1', (origin - lineY).toFixed(2))
      line.setAttribute('x2', (origin + lineX).toFixed(2))
      line.setAttribute('y2', (origin + lineY).toFixed(2))
      line.setAttribute('opacity', opacity.toFixed(3))
    }
    setOrientationLabelPosition(axis.positiveLabel, origin + labelX, origin + labelY, opacity)
    setOrientationLabelPosition(axis.negativeLabel, origin - labelX, origin - labelY, opacity)

    // The end pointing toward the viewer is slightly stronger. This provides
    // depth information without changing the anatomical letter positions.
    const positive = document.getElementById(`orientation-label-${axis.positiveLabel}`)
    const negative = document.getElementById(`orientation-label-${axis.negativeLabel}`)
    positive?.classList.toggle('orientation-near', cameraZ > 0.08)
    negative?.classList.toggle('orientation-near', cameraZ < -0.08)
  }
}

let surfaceOrientationAnimationFrame: number | null = null

function runSurfaceOrientationLoop() {
  try {
    updateSurfaceOrientationIndicator()
  } catch (error) {
    // The orientation overlay is nonessential. Never allow a transient NiiVue
    // initialization state to interrupt monkey discovery or viewer startup.
    console.warn('Surface orientation update skipped:', error)
  }
  surfaceOrientationAnimationFrame = window.requestAnimationFrame(runSurfaceOrientationLoop)
}

function startSurfaceOrientationLoop() {
  if (surfaceOrientationAnimationFrame !== null) return
  surfaceOrientationAnimationFrame = window.requestAnimationFrame(runSurfaceOrientationLoop)
}

function configureBidirectionalSync() {
  if (isDisplayOnlySurface(currentSurfaceKind)) {
    // Inflated, very-inflated, and spherical coordinates are display coordinates rather than anatomical mm.
    // Keep the three volume views linked and map surface clicks by vertex index.
    for (const source of sliceViews) source.broadcastTo(sliceViews.filter((target) => target !== source), { '2d': true, '3d': true })
    views.surface.broadcastTo([], { '2d': true, '3d': true })
    return
  }
  const all = [views.sagittal, views.coronal, views.axial, views.surface]
  for (const source of all) source.broadcastTo(all.filter((target) => target !== source), { '2d': true, '3d': true })
}

const SURFACE_KEYBOARD_PAN_STEP_MM = 1.5
let lastPointerClientX = Number.NaN
let lastPointerClientY = Number.NaN

function pointerIsOverSurfacePane(): boolean {
  const canvas = document.getElementById('surface') as HTMLCanvasElement | null
  if (!canvas || !Number.isFinite(lastPointerClientX) || !Number.isFinite(lastPointerClientY)) return false
  const rect = canvas.getBoundingClientRect()
  return lastPointerClientX >= rect.left && lastPointerClientX <= rect.right && lastPointerClientY >= rect.top && lastPointerClientY <= rect.bottom
}

function panSurfaceWithArrowKey(event: KeyboardEvent) {
  const movementByKey: Record<string, [number, number]> = {
    // NiiVue mirrors the render X axis, so a negative camera X translation
    // moves the rendered surface to the right on screen.
    ArrowLeft: [SURFACE_KEYBOARD_PAN_STEP_MM, 0],
    ArrowRight: [-SURFACE_KEYBOARD_PAN_STEP_MM, 0],
    ArrowUp: [0, SURFACE_KEYBOARD_PAN_STEP_MM],
    ArrowDown: [0, -SURFACE_KEYBOARD_PAN_STEP_MM],
  }
  const movement = movementByKey[event.key]
  if (!movement || !pointerIsOverSurfacePane()) return

  // Capture the arrow key before any NiiVue canvas can interpret it as
  // volume navigation. This action changes only the 3D surface camera.
  event.preventDefault()
  event.stopImmediatePropagation()

  const nv = views.surface
  const current = nv.position ?? new Float32Array([0, 0, 0])
  nv.position = new Float32Array([
    Number(current[0] ?? 0) + movement[0],
    Number(current[1] ?? 0) + movement[1],
    Number(current[2] ?? 0),
  ])
  nv.drawScene()
}

function resetSurfaceView() {
  const nv = views.surface
  nv.position = new Float32Array([0, 0, 0])
  nv.setScale(SURFACE_SCALE_BY_KIND[currentSurfaceKind])
  nv.drawScene()
  setText('status', `Ready · ${isDisplayOnlySurface(currentSurfaceKind) ? `${surfaceDisplayName(currentSurfaceKind)} centered +${INFLATED_VERTICAL_OFFSET_MM} mm` : surfaceDisplayName(currentSurfaceKind)}`)
}


function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function sanitizeSnapshotLabel(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
}

function snapshotTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

function snapshotBaseName(customName: string): string {
  const mm = selectedMM ?? [0, 0, 0]
  const coordinates = `x${formatCoordinate(mm[0])}_y${formatCoordinate(mm[1])}_z${formatCoordinate(mm[2])}`
  const label = sanitizeSnapshotLabel(customName)
  return `${snapshotTimestamp()}_${coordinates}${label ? `_${label}` : ''}`
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Unable to encode PNG')), 'image/png')
  })
}

/**
 * Capture a NiiVue WebGL canvas without resizing or waiting for another frame.
 *
 * WebGL canvases commonly use preserveDrawingBuffer=false. Their pixels are only
 * guaranteed to be readable immediately after rendering. Waiting for
 * requestAnimationFrame, or resizing the WebGL canvas before export, can therefore
 * produce an all-black/all-white image. We render once, synchronously copy the
 * current framebuffer into a normal 2D canvas, and encode that stable copy.
 *
 * The requested export scale is applied to the 2D destination. This preserves the
 * rendered content and avoids disturbing NiiVue's viewport, camera, and framebuffer.
 */
async function captureViewerCanvas(canvasId: keyof typeof views, scale: number): Promise<{ blob: Blob; width: number; height: number }> {
  const source = document.getElementById(canvasId) as HTMLCanvasElement | null
  if (!source) throw new Error(`Missing ${canvasId} canvas`)
  const nv = views[canvasId]

  // Render and copy immediately. Do not yield to the browser before drawImage.
  nv.drawScene()
  ;((nv as any).gl as WebGL2RenderingContext | undefined)?.finish?.()

  const sourceWidth = Math.max(1, source.width)
  const sourceHeight = Math.max(1, source.height)
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const output = document.createElement('canvas')
  output.width = width
  output.height = height
  const ctx = output.getContext('2d', { alpha: false })
  if (!ctx) throw new Error(`Unable to create ${canvasId} export canvas`)

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height)

  return { blob: await canvasToBlob(output), width, height }
}

async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Unable to decode snapshot panel'))
      image.src = url
    })
    return image
  } finally {
    // Revocation is delayed until the image has decoded its backing data.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

async function makeCompositeImage(captures: Record<'sagittal' | 'coronal' | 'axial' | 'surface', { blob: Blob; width: number; height: number }>): Promise<Blob> {
  const [sagittal, coronal, axial, surface] = await Promise.all([
    blobToImage(captures.sagittal.blob), blobToImage(captures.coronal.blob),
    blobToImage(captures.axial.blob), blobToImage(captures.surface.blob),
  ])
  const leftWidth = Math.max(captures.sagittal.width, captures.coronal.width, captures.axial.width)
  const leftHeight = captures.sagittal.height + captures.coronal.height + captures.axial.height
  const surfaceWidth = Math.round(captures.surface.width * (leftHeight / captures.surface.height))
  const titleHeight = Math.max(30, Math.round(leftHeight * 0.025))
  const gap = Math.max(8, Math.round(leftHeight * 0.008))
  const canvas = document.createElement('canvas')
  canvas.width = leftWidth + surfaceWidth + gap
  canvas.height = leftHeight + titleHeight
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#05070b'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#dce7f5'
  ctx.font = `${Math.max(18, Math.round(titleHeight * 0.58))}px system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  ctx.fillText('Sagittal / Coronal / Axial', 10, titleHeight / 2)
  ctx.fillText(`Surface: ${surfaceDisplayName(currentSurfaceKind)}`, leftWidth + gap + 10, titleHeight / 2)
  let y = titleHeight
  for (const image of [sagittal, coronal, axial]) {
    const h = image === sagittal ? captures.sagittal.height : image === coronal ? captures.coronal.height : captures.axial.height
    ctx.drawImage(image, 0, y, leftWidth, h)
    y += h
  }
  ctx.drawImage(surface, leftWidth + gap, titleHeight, surfaceWidth, leftHeight)
  return canvasToBlob(canvas)
}

function visibleAtlasLabels(kind: AtlasKind): number[] {
  if (kind === 'charm') {
    const lookup = armLookup[currentCharmLevel - 1] ?? {}
    return Object.keys(lookup).map(Number).filter(Number.isFinite).filter((label) => !hiddenCharmLabels[currentCharmLevel - 1].has(label)).sort((a, b) => a - b)
  }
  return Object.keys(d99Lookup).map(Number).filter(Number.isFinite).filter((label) => !hiddenD99Labels.has(label)).sort((a, b) => a - b)
}


type RoiExportResult = { files: Record<string, Blob>; metadata: Record<string, unknown> }

function nativeDimensions(image: NVImage): [number, number, number] {
  if (!image.hdr) throw new Error('Image NIfTI header is unavailable')
  return [Number(image.hdr.dims[1]), Number(image.hdr.dims[2]), Number(image.hdr.dims[3])]
}

function cloneForNativeOutput(reference: NVImage, values: Uint8Array | Float32Array, datatypeCode: number, bits: number): NVImage {
  if (!reference.hdr) throw new Error('Reference NIfTI header is unavailable')
  const expected = nativeDimensions(reference).reduce((a, b) => a * b, 1)
  if (values.length !== expected) throw new Error(`Output contains ${values.length} values but reference grid requires ${expected}`)
  const copy = new NVImage()
  Object.assign(copy, reference)
  const hdr = JSON.parse(JSON.stringify(reference.hdr)) as NonNullable<NVImage['hdr']>
  hdr.datatypeCode = datatypeCode
  hdr.numBitsPerVoxel = bits
  hdr.scl_slope = 1
  hdr.scl_inter = 0
  hdr.dims[0] = 3
  hdr.dims[4] = 1
  hdr.dims[5] = 1
  copy.hdr = hdr
  copy.img = values
  return copy
}

function niftiScalarBlob(reference: NVImage, valuesNative: Float32Array): Blob {
  const copy = cloneForNativeOutput(reference, valuesNative, 16, 32)
  return new Blob([gzipSync(copy.toUint8Array())], { type: 'application/gzip' })
}

async function loadNvImage(url: string, name: string): Promise<NVImage> {
  return NVImage.loadFromUrl({ url, name })
}

async function parseAffineText(url: string): Promise<number[][]> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Unable to load affine transform (${response.status})`)
  const text = await response.text()
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const numericRows = lines
    .map((line) => line.split(/\s+/).map(Number))
    .filter((row) => row.length === 4 && row.every(Number.isFinite))
  if (numericRows.length >= 4) return numericRows.slice(0, 4)
  if (numericRows.length === 3) return [...numericRows, [0, 0, 0, 1]]
  throw new Error('Scanner affine must be a plain 3 × 4 or 4 × 4 numeric matrix')
}

function roiDescriptionTsv(description: Record<string, unknown>, outputs: Array<Record<string, unknown>>): Blob {
  const rows: Array<[string, string]> = [
    ['field', 'value'],
    ...Object.entries(description).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : String(value ?? '')] as [string, string]),
    ['outputSpaces', outputs.map((output) => String(output.space ?? '')).join(',')],
    ['outputFiles', outputs.map((output) => String(output.file ?? '')).join(',')],
  ]
  const escape = (value: string) => value.replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
  return new Blob([rows.map(([key, value]) => `${escape(key)}\t${escape(value)}`).join('\n') + '\n'], { type: 'text/tab-separated-values' })
}

function nextBrowserPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)))
}

type ScalarRoiStats = {
  positiveVoxelCount: number
  maximum: number
  minimumPositive: number
  weightedCenterIJK: [number, number, number]
}

function scalarRoiStats(values: Float32Array, dims: [number, number, number]): ScalarRoiStats {
  if (values.length !== dims[0] * dims[1] * dims[2]) throw new Error('ROI grid size is inconsistent with its reference image')
  let positiveVoxelCount = 0
  let maximum = 0
  let minimumPositive = Number.POSITIVE_INFINITY
  let totalWeight = 0
  let wi = 0; let wj = 0; let wk = 0
  for (let k = 0; k < dims[2]; k += 1) for (let j = 0; j < dims[1]; j += 1) for (let i = 0; i < dims[0]; i += 1) {
    const value = values[i + dims[0] * (j + dims[1] * k)]
    if (!Number.isFinite(value)) throw new Error('ROI contains a non-finite value')
    if (value < -1e-7) throw new Error('ROI contains a negative value')
    if (value <= 0) continue
    positiveVoxelCount += 1
    maximum = Math.max(maximum, value)
    minimumPositive = Math.min(minimumPositive, value)
    totalWeight += value; wi += value * i; wj += value * j; wk += value * k
  }
  if (!(totalWeight > 0)) throw new Error('ROI is empty')
  return {
    positiveVoxelCount,
    maximum,
    minimumPositive,
    weightedCenterIJK: [wi / totalWeight, wj / totalWeight, wk / totalWeight],
  }
}

function extentSlug(extentMm: number): string {
  const text = Number(extentMm.toFixed(3)).toString().replace('.', 'p')
  return `gaussian${text}mm`
}

async function buildRoiExports(): Promise<RoiExportResult | null> {
  const enabled = (document.getElementById('snapshot-roi-enabled') as HTMLInputElement).checked
  if (!enabled) return null
  const extentInput = document.getElementById('snapshot-roi-extent') as HTMLInputElement
  const extentMm = Number(extentInput.value)
  if (!Number.isFinite(extentMm) || extentMm < 1 || extentMm > 50) throw new Error('ROI extent must be between 1 and 50 mm')
  const sourceImage = views.sagittal.volumes[0]
  if (!sourceImage || !selectedMM) throw new Error('T1w image and cursor location are required')
  const monkey = requireMonkey()
  const sourceUrl = requiredUrl(monkey.anatomy, 'T1w anatomy')

  setText('snapshot-progress', 'Loading native T1w data for Gaussian ROI export…')
  await nextBrowserPaint()
  const sourceRaw = await loadRawNifti(sourceUrl)
  const gaussian = createGaussianRoi(sourceRaw, [selectedMM[0], selectedMM[1], selectedMM[2]], extentMm)
  const slug = extentSlug(extentMm)
  const sourceStats = scalarRoiStats(gaussian.values, sourceRaw.dims)
  const centerIndex = gaussian.center[0] + sourceRaw.dims[0] * (gaussian.center[1] + sourceRaw.dims[1] * gaussian.center[2])
  if (Math.abs(gaussian.values[centerIndex] - 1) > 1e-6) throw new Error('Gaussian source center is not exactly 1')
  if (Math.abs(sourceStats.maximum - 1) > 1e-6) throw new Error(`Gaussian source maximum is ${sourceStats.maximum}, expected 1`)

  const description: Record<string, unknown> = {
    definition: 'gaussian',
    extentMm: gaussian.extentMm,
    halfExtentMm: gaussian.extentMm / 2,
    fwhmMm: gaussian.fwhmMm,
    sigmaMm: gaussian.sigmaMm,
    centerValue: 1,
    interpolation: 'linear',
    normalization: 'per-output maximum',
    requestedCursorXYZmm: [...selectedMM],
    centerIJKNative: gaussian.center,
    centerVoxelXYZmm: gaussian.centerWorld,
    sourceDimensionsNative: sourceRaw.dims,
    sourceAffineNative: sourceRaw.affine,
    sourcePositiveVoxelCount: sourceStats.positiveVoxelCount,
    sourceWeightedCenterIJK: sourceStats.weightedCenterIJK,
  }
  const files: Record<string, Blob> = {}
  const outputs: Array<Record<string, unknown>> = []
  const errors: Array<{ space: string; message: string }> = []

  if ((document.getElementById('snapshot-roi-space-t1w') as HTMLInputElement).checked) {
    const name = `roi/roi_desc-${slug}_space-T1w_roi.nii.gz`
    files[name] = niftiScalarBlob(sourceImage, gaussian.values)
    outputs.push({ space: 'T1w', file: name, dimensions: sourceRaw.dims, ...sourceStats })
  }

  const transforms = monkey.transforms
  const sanityEnabled = (document.getElementById('snapshot-roi-warped-t1w') as HTMLInputElement).checked

  if ((document.getElementById('snapshot-roi-space-scanner') as HTMLInputElement).checked) {
    try {
      if (!transforms?.scanner) throw new Error('Scanner-space transform is unavailable')
      setText('snapshot-progress', 'Loading scanner reference and FSL conformation transform…')
      await nextBrowserPaint()
      const [referenceNv, referenceRaw, matrix] = await Promise.all([
        loadNvImage(transforms.scanner.reference, 'Scanner reference'),
        loadRawNifti(transforms.scanner.reference),
        parseAffineText(transforms.scanner.outputToT1wAffine),
      ])
      setText('snapshot-progress', 'Warping Gaussian ROI to scanner space…')
      await nextBrowserPaint()
      const warped = resampleScannerRaw(sourceRaw, referenceRaw, matrix, gaussian.values, 'linear')
      const preNormalizationMaximum = normalizePositive(warped)
      const stats = scalarRoiStats(warped, referenceRaw.dims)
      const name = `roi/roi_desc-${slug}_space-scanner_roi.nii.gz`
      files[name] = niftiScalarBlob(referenceNv, warped)
      let sanityFile: string | null = null
      let validationCorrelation: number | null = null
      if (sanityEnabled) {
        setText('snapshot-progress', 'Resampling T1w to scanner space with FLIRT coordinates…')
        await nextBrowserPaint()
        const sanity = resampleScannerRaw(sourceRaw, referenceRaw, matrix)
        sanityFile = 'roi/sanity_space-scanner_desc-warped_T1w.nii.gz'
        validationCorrelation = rawScalarCorrelation(sanity, rawFrame(referenceRaw, 0))
        files[sanityFile] = niftiScalarBlob(referenceNv, sanity)
      }
      outputs.push({
        space: 'scanner', file: name, dimensions: referenceRaw.dims, ...stats, preNormalizationMaximum,
        transform: transforms.scanner.outputToT1wAffine,
        convention: 'FSL FLIRT scaled-voxel coordinates: scanner voxel → scanner FSL mm → from-scanner_to-T1w matrix → T1w FSL mm → T1w voxel',
        sanityFile, validationCorrelation,
      })
    } catch (error) {
      errors.push({ space: 'scanner', message: error instanceof Error ? error.message : String(error) })
    }
  }

  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('#snapshot-roi-template-spaces input[data-template-space]'))) {
    if (!input.checked) continue
    const template = input.dataset.templateSpace ?? ''
    try {
      const capability = transforms?.templates?.[template]?.export
      if (!capability?.enabled || !capability.transform || !capability.reference) throw new Error(capability?.reason ?? `${template} export is unavailable`)
      setText('snapshot-progress', `Loading raw ${template} reference and vector displacement field…`)
      await nextBrowserPaint()
      const [referenceNv, referenceRaw, warpRaw] = await Promise.all([
        loadNvImage(capability.reference, `${template} reference`),
        loadRawNifti(capability.reference),
        loadRawNifti(capability.transform),
      ])
      setText('snapshot-progress', `Warping Gaussian ROI to ${template}…`)
      await nextBrowserPaint()
      const warped = resampleNmtRaw(sourceRaw, referenceRaw, warpRaw, gaussian.values, 'linear')
      const preNormalizationMaximum = normalizePositive(warped)
      const stats = scalarRoiStats(warped, referenceRaw.dims)
      const safeTemplate = template.replace(/[^A-Za-z0-9.-]+/g, '_')
      const name = `roi/roi_desc-${slug}_space-${safeTemplate}_roi.nii.gz`
      files[name] = niftiScalarBlob(referenceNv, warped)
      let sanityFile: string | null = null
      let validationCorrelation: number | null = null
      if (sanityEnabled) {
        setText('snapshot-progress', `Resampling T1w to ${template} using raw vector frames…`)
        await nextBrowserPaint()
        const sanity = resampleNmtRaw(sourceRaw, referenceRaw, warpRaw)
        sanityFile = `roi/sanity_space-${safeTemplate}_desc-warped_T1w.nii.gz`
        validationCorrelation = rawScalarCorrelation(sanity, rawFrame(referenceRaw, 0))
        files[sanityFile] = niftiScalarBlob(referenceNv, sanity)
      }
      outputs.push({ space: template, file: name, dimensions: referenceRaw.dims, ...stats, preNormalizationMaximum, transform: capability.transform, convention: 'Raw NIfTI destination-grid pull using the Brainana vector displacement field', sanityFile, validationCorrelation })
    } catch (error) {
      errors.push({ space: template, message: error instanceof Error ? error.message : String(error) })
    }
  }

  if (!Object.keys(files).length) throw new Error(errors.length ? errors.map((entry) => `${entry.space}: ${entry.message}`).join('; ') : 'Select at least one ROI output space')
  const roiMetadata = { ...description, outputs, errors }
  if (errors.length) files['roi/roi_export_errors.json'] = new Blob([JSON.stringify(errors, null, 2)], { type: 'application/json' })
  files[`roi/roi_desc-${slug}_metadata.tsv`] = roiDescriptionTsv(description, outputs)
  return { files, metadata: roiMetadata }
}

function getSnapshotState(scale: number, outputDimensions: Record<string, { width: number; height: number }>): Record<string, unknown> {
  const surfaceAny = views.surface as any
  const scene = surfaceAny.scene ?? {}
  const surfaceSelect = document.querySelector<HTMLSelectElement>('#surface-kind')
  const voxText = document.getElementById('vox')?.textContent ?? ''
  return {
    schemaVersion: 1,
    viewerVersion: '1.2.19',
    subject: currentMonkey?.id ?? 'unknown',
    coordinates: {
      xyzMm: selectedMM ? [...selectedMM] : null,
      ijk: voxText.split(',').map((v) => Number(v.trim())).filter(Number.isFinite),
    },
    surface: {
      geometry: surfaceSelect?.value ?? currentSurfaceKind,
      hemisphere: document.getElementById('surface-hemi')?.textContent ?? null,
      vertex: Number(document.getElementById('vertex')?.textContent?.replace(/,/g, '')) || null,
      scale: surfaceAny.volScaleMultiplier ?? null,
      position: surfaceAny.position ? [...surfaceAny.position] : null,
      renderAzimuth: scene.renderAzimuth ?? null,
      renderElevation: scene.renderElevation ?? null,
      pan2Dxyzmm: scene.pan2Dxyzmm ? [...scene.pan2Dxyzmm] : null,
    },
    morphology: {
      display: activeMorphology,
      curvatureStyle,
      ranges: morphologyRanges,
    },
    atlases: {
      charm: {
        visibleOnVolume: visibleState.charm.visible,
        visibleOnSurface: charmSurfaceVisible,
        level: currentCharmLevel,
        opacity: visibleState.charm.opacity,
        visibleLabels: visibleAtlasLabels('charm'),
      },
      d99: {
        visibleOnVolume: visibleState.d99.visible,
        visibleOnSurface: d99SurfaceVisible,
        opacity: visibleState.d99.opacity,
        visibleLabels: visibleAtlasLabels('d99'),
      },
    },
    function: {
      retinotopy: {
      display: functionalDisplay,
      thresholdMap: functionalThresholdMap,
      threshold: functionalThresholdValue,
      opacity: functionalOpacity,
      surfaceBrightness: functionalSurfaceBrightness,
      surfaceOrder: functionalSurfaceOrder,
      visibleOnVolume: functionalVolumeVisible,
      visibleOnSurface: functionalSurfaceVisible,
      neighborhoodSize: Number(document.querySelector<HTMLSelectElement>('#retino-neighborhood-size')?.value ?? 3),
      },
      somatotopy: {
        display: somatotopyDisplay,
        threshold: somatotopyThresholdValue,
        opacity: somatotopyOpacity,
        surfaceBrightness: somatotopySurfaceBrightness,
        surfaceOrder: functionalSurfaceOrder,
        visibleOnVolume: somatotopyVolumeVisible,
        visibleOnSurface: somatotopySurfaceVisible,
      },
    },
    imported: importedLayers.map((layer) => ({
      name: layer.name,
      sourceName: layer.sourceName,
      sourcePath: layer.sourcePath,
      inputSpace: layer.space,
      displayedSpace: 'T1w',
      dataType: layer.dataType,
      interpolation: layer.interpolation,
      visible: layer.visible,
      opacity: layer.opacity,
      colormap: layer.colormap,
      calMin: layer.calMin,
      calMax: layer.calMax,
      zeroBackground: layer.zeroBackground,
    })),
    export: { scale, outputDimensions },
  }
}

function getSnapshotMetadata(folderName: string, state: Record<string, unknown>): Record<string, unknown> {
  return {
    title: 'Brainana Viewer Snapshot',
    snapshotFolder: folderName,
    created: new Date().toISOString(),
    description: 'High-resolution Brainana Viewer image bundle with coordinates, active overlays, display settings, and restorable state.',
    ...state,
    sourceFiles: {
      anatomy: currentMonkey?.anatomy ?? null,
      arm: `ARM${currentCharmLevel}.nii.gz`,
      d99: 'D99.nii.gz',
      retinotopy: functionalDisplay === 'none' ? null : currentMonkey?.function.retinotopy?.combined ?? null,
      somatotopy: somatotopyDisplay === 'none' ? null : currentMonkey?.function.somatotopy?.combined ?? null,
      surfaceGeometry: currentSurfaceKind,
    },
  }
}

async function writeBlobFile(directory: any, name: string, blob: Blob): Promise<void> {
  const parts = name.split('/').filter(Boolean)
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true })
  const handle = await directory.getFileHandle(parts[parts.length - 1], { create: true })
  const writable = await handle.createWritable()
  await writable.write(blob)
  await writable.close()
}


async function uniqueSnapshotDirectory(root: any, baseName: string): Promise<{ directory: any; name: string }> {
  const viewer = await root.getDirectoryHandle('viewer', { create: true })
  const snapshots = await viewer.getDirectoryHandle('snapshots', { create: true })
  let name = baseName
  for (let suffix = 1; suffix < 1000; suffix++) {
    try {
      const existing = await snapshots.getDirectoryHandle(name)
      if (existing) name = `${baseName}_${String(suffix + 1).padStart(2, '0')}`
    } catch {
      return { directory: await snapshots.getDirectoryHandle(name, { create: true }), name }
    }
  }
  throw new Error('Unable to create a unique snapshot directory')
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

async function saveSnapshot(): Promise<void> {
  if (snapshotSaving) return
  snapshotSaving = true
  const saveButton = document.getElementById('snapshot-save') as HTMLButtonElement
  const progress = document.getElementById('snapshot-progress')!
  const errorBox = document.getElementById('snapshot-error')!
  errorBox.classList.add('hidden')
  errorBox.textContent = ''
  setText('snapshot-progress', 'Rendering high-resolution views…')
  saveButton.disabled = true
  progress.classList.remove('hidden')
  try {
    const scale = Number((document.getElementById('snapshot-scale') as HTMLSelectElement).value)
    const baseName = snapshotBaseName((document.getElementById('snapshot-name') as HTMLInputElement).value)
    const captures = {
      sagittal: await captureViewerCanvas('sagittal', scale),
      coronal: await captureViewerCanvas('coronal', scale),
      axial: await captureViewerCanvas('axial', scale),
      surface: await captureViewerCanvas('surface', scale),
    }
    const dimensions = Object.fromEntries(Object.entries(captures).map(([key, value]) => [key, { width: value.width, height: value.height }]))
    const state = getSnapshotState(scale, dimensions)
    const metadata = getSnapshotMetadata(baseName, state) as Record<string, any>
    const files: Record<string, Blob> = {}
    const roiExport = await buildRoiExports()
    if (roiExport) { Object.assign(files, roiExport.files); metadata.roi = roiExport.metadata }
    if ((document.getElementById('snapshot-individual') as HTMLInputElement).checked) {
      files['sagittal.png'] = captures.sagittal.blob
      files['coronal.png'] = captures.coronal.blob
      files['axial.png'] = captures.axial.blob
      files['surface.png'] = captures.surface.blob
    }
    if ((document.getElementById('snapshot-composite') as HTMLInputElement).checked) files['composite.png'] = await makeCompositeImage(captures)
    if ((document.getElementById('snapshot-metadata') as HTMLInputElement).checked) files['metadata.json'] = new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' })
    if ((document.getElementById('snapshot-state') as HTMLInputElement).checked) files['state.json'] = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })

    let finalName = baseName
    if (snapshotWorkstationPath !== null && runtimeConfig.workstation) {
      const target = await uniqueRemoteSnapshotDirectory(snapshotWorkstationPath, baseName)
      finalName = target.split('/').at(-1) ?? baseName
      for (const [name, blob] of Object.entries(files)) await writeRemoteBlob(`${target}/${name}`, blob)
      setText('status', `Saved ${target} on workstation`)
    } else if (snapshotSubjectDirectory) {
      const target = await uniqueSnapshotDirectory(snapshotSubjectDirectory, baseName)
      finalName = target.name
      for (const [name, blob] of Object.entries(files)) await writeBlobFile(target.directory, name, blob)
      setText('status', `Saved viewer/snapshots/${finalName}`)
    } else {
      const zipEntries: Record<string, Uint8Array> = {}
      for (const [name, blob] of Object.entries(files)) zipEntries[`${baseName}/${name}`] = new Uint8Array(await blob.arrayBuffer())
      downloadBlob(new Blob([zipSync(zipEntries, { level: 6 })], { type: 'application/zip' }), `${baseName}.zip`)
      setText('status', `Downloaded ${baseName}.zip`)
    }
    document.getElementById('snapshot-dialog')?.classList.add('hidden')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errorBox.textContent = `Export failed: ${message}`
    errorBox.classList.remove('hidden')
    setText('status', `Export error: ${message}`)
  } finally {
    snapshotSaving = false
    saveButton.disabled = false
    progress.classList.add('hidden')
    resizeAllViewers()
  }
}


function templateEntries(): Array<[string, TemplateManifest]> {
  return Object.entries(currentMonkey?.transforms?.templates ?? {}).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
}
function refreshTemplateControls(): void {
  const importSelect = document.getElementById('import-space') as HTMLSelectElement | null
  if (importSelect) {
    const prior = importSelect.value
    importSelect.querySelectorAll('option[data-template="1"]').forEach((option) => option.remove())
    for (const [name, capability] of templateEntries()) {
      if (!capability.import.enabled) continue
      const option = document.createElement('option'); option.value = name; option.textContent = name; option.dataset.template = '1'; importSelect.appendChild(option)
    }
    importSelect.value = Array.from(importSelect.options).some((option) => option.value === prior) ? prior : 'T1w'
  }
  const exportContainer = document.getElementById('snapshot-roi-template-spaces')
  if (exportContainer) {
    exportContainer.innerHTML = ''
    for (const [name, capability] of templateEntries()) {
      const label = document.createElement('label')
      const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.templateSpace = name; input.disabled = !capability.export.enabled
      label.append(input, document.createTextNode(` ${name}`))
      if (!capability.export.enabled && capability.export.reason) label.title = capability.export.reason
      exportContainer.appendChild(label)
    }
  }
}
async function loadWorkstationFolder(pathValue = snapshotWorkstationBrowserPath): Promise<void> {
  const response = await fetch(`/api/save-list?path=${encodeURIComponent(pathValue)}`)
  const payload = await response.json() as { path?: string; entries?: Array<{ name: string; path: string }>; error?: string }
  if (!response.ok) throw new Error(payload.error ?? `Unable to list workstation folders (${response.status})`)
  snapshotWorkstationBrowserPath = payload.path ?? ''
  setText('snapshot-workstation-folder-path', snapshotWorkstationBrowserPath || '/')
  const list = document.getElementById('snapshot-workstation-folder-list')!; list.innerHTML = ''
  for (const entry of payload.entries ?? []) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'monkey-folder-row is-directory'; row.textContent = `▸ ${entry.name}`
    row.addEventListener('click', () => void loadWorkstationFolder(entry.path).catch((error) => setText('snapshot-workstation-folder-path', error instanceof Error ? error.message : String(error))))
    list.appendChild(row)
  }
  if (!(payload.entries ?? []).length) { const empty = document.createElement('div'); empty.className = 'monkey-folder-empty'; empty.textContent = 'No subfolders.'; list.appendChild(empty) }
  const up = document.getElementById('snapshot-workstation-folder-up') as HTMLButtonElement
  up.disabled = !snapshotWorkstationBrowserPath
}
function closeWorkstationFolderDialog(): void {
  document.getElementById('snapshot-workstation-folder-dialog')?.classList.add('hidden')
  ;(document.getElementById(runtimeConfig.workstation ? 'snapshot-choose-workstation-folder' : 'snapshot-choose-local-folder') as HTMLButtonElement | null)?.focus()
}
async function ensureRemoteDirectory(relative: string): Promise<void> {
  const parts = relative.split('/').filter(Boolean); let current = ''
  for (const part of parts) {
    current = [current, part].filter(Boolean).join('/')
    const response = await fetch('/api/save-mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: current }) })
    if (!response.ok && response.status !== 409) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error ?? `Unable to create ${current}`) }
  }
}
async function uniqueRemoteSnapshotDirectory(root: string, baseName: string): Promise<string> {
  await ensureRemoteDirectory([root, 'viewer', 'snapshots'].filter(Boolean).join('/'))
  for (let suffix = 1; suffix < 1000; suffix++) {
    const name = suffix === 1 ? baseName : `${baseName}_${String(suffix).padStart(2, '0')}`
    const relative = [root, 'viewer', 'snapshots', name].filter(Boolean).join('/')
    const response = await fetch('/api/save-mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: relative }) })
    if (response.ok) return relative
    if (response.status !== 409) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error ?? `Unable to create ${relative}`) }
  }
  throw new Error('Unable to create a unique workstation snapshot directory')
}
async function writeRemoteBlob(relative: string, blob: Blob): Promise<void> {
  const response = await fetch(`/api/save-file?path=${encodeURIComponent(relative)}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob })
  if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error ?? `Unable to write ${relative}`) }
}

function setupSnapshotControls(): void {
  const dialog = document.getElementById('snapshot-dialog')!
  const open = () => {
    ;(document.getElementById('snapshot-name') as HTMLInputElement).value = ''
    const transforms = currentMonkey?.transforms
    const workstationButton = document.getElementById('snapshot-choose-workstation-folder') as HTMLButtonElement
    workstationButton.classList.toggle('hidden', !runtimeConfig.workstation)
    const localButton = document.getElementById('snapshot-choose-local-folder') as HTMLButtonElement
    localButton.textContent = runtimeConfig.workstation ? 'Choose local folder' : 'Choose monkey folder'
    const scanner = document.getElementById('snapshot-roi-space-scanner') as HTMLInputElement
    scanner.disabled = !transforms?.scanner
    refreshTemplateControls()
    const availableTemplates = templateEntries().filter(([, item]) => item.export.enabled).map(([name]) => name)
    setText('snapshot-roi-availability', `Available: T1w${transforms?.scanner ? ', Scanner' : ''}${availableTemplates.length ? `, ${availableTemplates.join(', ')}` : ''}`)
    dialog.classList.remove('hidden')
  }
  const close = () => { if (!snapshotSaving) dialog.classList.add('hidden') }
  document.getElementById('snapshot-button')!.addEventListener('click', open)
  document.getElementById('snapshot-close')!.addEventListener('click', close)
  document.getElementById('snapshot-cancel')!.addEventListener('click', close)
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close() })
  document.getElementById('snapshot-save')!.addEventListener('click', () => { void saveSnapshot() })
  const roiEnabled = document.getElementById('snapshot-roi-enabled') as HTMLInputElement
  const roiControls = document.getElementById('snapshot-roi-controls')!
  const updateRoiControls = () => {
    roiControls.classList.toggle('disabled', !roiEnabled.checked)
    roiControls.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((element) => { element.disabled = !roiEnabled.checked })
    const transforms = currentMonkey?.transforms
    ;(document.getElementById('snapshot-roi-space-scanner') as HTMLInputElement).disabled = !roiEnabled.checked || !transforms?.scanner
    document.querySelectorAll<HTMLInputElement>('#snapshot-roi-template-spaces input').forEach((input) => { const capability = transforms?.templates?.[input.dataset.templateSpace ?? '']?.export; input.disabled = !roiEnabled.checked || !capability?.enabled })
  }
  roiEnabled.addEventListener('change', updateRoiControls)
  updateRoiControls()
  const chooseLocalFolder = async () => {
    try {
      const picker = (window as any).showDirectoryPicker
      if (!picker) throw new Error('Direct local folder saving is unavailable in this browser. ZIP download will be used.')
      snapshotSubjectDirectory = await picker({ mode: 'readwrite' })
      snapshotWorkstationPath = null
      setText('snapshot-destination-label', `${snapshotSubjectDirectory.name}/viewer/snapshots on this computer`)
    } catch (error) {
      snapshotSubjectDirectory = null
      setText('snapshot-destination-label', error instanceof Error ? error.message : String(error))
    }
  }
  document.getElementById('snapshot-choose-local-folder')!.addEventListener('click', () => { void chooseLocalFolder() })
  document.getElementById('snapshot-choose-workstation-folder')!.addEventListener('click', async () => {
    try {
      snapshotWorkstationBrowserPath = currentMonkey?.relativePath ?? ''
      const folderDialog = document.getElementById('snapshot-workstation-folder-dialog')
      folderDialog?.classList.remove('hidden')
      ;(document.getElementById('snapshot-workstation-folder-select') as HTMLButtonElement | null)?.focus()
      await loadWorkstationFolder(snapshotWorkstationBrowserPath)
    } catch (error) {
      closeWorkstationFolderDialog()
      setText('snapshot-destination-label', error instanceof Error ? error.message : String(error))
    }
  })
  document.getElementById('snapshot-workstation-folder-close')!.addEventListener('click', closeWorkstationFolderDialog)
  document.getElementById('snapshot-workstation-folder-cancel')!.addEventListener('click', closeWorkstationFolderDialog)
  document.getElementById('snapshot-workstation-folder-up')!.addEventListener('click', () => { const parent = snapshotWorkstationBrowserPath.split('/').filter(Boolean).slice(0, -1).join('/'); void loadWorkstationFolder(parent) })
  document.getElementById('snapshot-workstation-folder-select')!.addEventListener('click', () => {
    snapshotWorkstationPath = snapshotWorkstationBrowserPath
    snapshotSubjectDirectory = null
    setText('snapshot-destination-label', `${snapshotWorkstationPath || '/'}/viewer/snapshots on workstation`)
    document.getElementById('snapshot-workstation-folder-dialog')?.classList.add('hidden')
    ;(document.getElementById('snapshot-save') as HTMLButtonElement | null)?.focus()
  })
}

function resizeViewer(nv: Niivue, canvasId: string) {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const width = Math.max(1, Math.round(rect.width * dpr))
  const height = Math.max(1, Math.round(rect.height * dpr))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  nv.drawScene()
}

function resizeAllViewers() {
  resizeViewer(views.sagittal, 'sagittal')
  resizeViewer(views.coronal, 'coronal')
  resizeViewer(views.axial, 'axial')
  resizeViewer(views.surface, 'surface')
  views.surface.setScale(SURFACE_SCALE_BY_KIND[currentSurfaceKind])
  views.surface.drawScene()
}

function setOverlayOpacityByName(match: (name: string) => boolean, opacity: number) {
  for (const nv of sliceViews) {
    const index = nv.volumes.findIndex((volume) => match(volume.name ?? ''))
    if (index > 0) nv.setOpacity(index, opacity)
  }
}

function configureAtlasPanel() {
  const panel = document.getElementById('atlas-panel')!
  const button = document.getElementById('atlas-panel-button')!
  const close = document.getElementById('atlas-panel-close')!
  const togglePanel = (show?: boolean) => {
    const next = show ?? !panel.classList.contains('open')
    panel.classList.toggle('open', next)
    button.classList.toggle('active', next)
    if (next) {
      document.getElementById('morphology-panel')?.classList.remove('open')
      document.getElementById('morphology-panel-button')?.classList.remove('active')
      document.getElementById('function-panel')?.classList.remove('open')
      document.getElementById('function-panel-button')?.classList.remove('active')
      document.getElementById('imported-panel')?.classList.remove('open')
      document.getElementById('import-panel-button')?.classList.remove('active')
    }
  }
  button.addEventListener('click', () => togglePanel())
  close.addEventListener('click', () => togglePanel(false))

  const charmVisible = document.querySelector<HTMLInputElement>('#charm-visible')!
  const charmSurface = document.querySelector<HTMLInputElement>('#charm-surface-visible')!
  const charmLevel = document.querySelector<HTMLSelectElement>('#charm-level')!
  const charmOpacity = document.querySelector<HTMLInputElement>('#charm-opacity')!
  const armLookupControl = document.querySelector<HTMLInputElement>('#charm-lookup')!
  const d99Visible = document.querySelector<HTMLInputElement>('#d99-visible')!
  const d99Surface = document.querySelector<HTMLInputElement>('#d99-surface-visible')!
  const d99Opacity = document.querySelector<HTMLInputElement>('#d99-opacity')!
  const d99LookupControl = document.querySelector<HTMLInputElement>('#d99-lookup')!

  charmVisible.addEventListener('change', async () => {
    visibleState.charm.visible = charmVisible.checked
    if (charmVisible.checked) activeLegendAtlas = 'charm'
    await replaceVisibleAtlasLayers()
  })
  charmSurface.addEventListener('change', async () => {
    charmSurfaceVisible = charmSurface.checked
    if (charmSurface.checked) activeLegendAtlas = 'charm'
    try { await refreshProjectedSurfaceLayers() } catch (error) { charmSurface.checked = false; charmSurfaceVisible = false; setText('status', `Projection error: ${error instanceof Error ? error.message : String(error)}`) }
  })
  charmLevel.addEventListener('change', async () => {
    currentCharmLevel = Number(charmLevel.value)
    activeLegendAtlas = 'charm'
    await replaceVisibleAtlasLayers()
    if (charmSurfaceVisible) await refreshProjectedSurfaceLayers()
  })
  charmOpacity.addEventListener('input', () => {
    visibleState.charm.opacity = Number(charmOpacity.value)
    setText('charm-opacity-value', `${Math.round(visibleState.charm.opacity * 100)}%`)
    setOverlayOpacityByName((name) => name.startsWith('ARM Level '), visibleState.charm.opacity)
    if (charmSurfaceVisible) void refreshProjectedSurfaceLayers()
  })
  armLookupControl.checked = true
  armLookupControl.disabled = true
  d99Visible.addEventListener('change', async () => {
    visibleState.d99.visible = d99Visible.checked
    if (d99Visible.checked) activeLegendAtlas = 'd99'
    await replaceVisibleAtlasLayers()
  })
  d99Surface.addEventListener('change', async () => {
    d99SurfaceVisible = d99Surface.checked
    if (d99Surface.checked) activeLegendAtlas = 'd99'
    try { await refreshProjectedSurfaceLayers() } catch (error) { d99Surface.checked = false; d99SurfaceVisible = false; setText('status', `Projection error: ${error instanceof Error ? error.message : String(error)}`) }
  })
  d99Opacity.addEventListener('input', () => {
    visibleState.d99.opacity = Number(d99Opacity.value)
    setText('d99-opacity-value', `${Math.round(visibleState.d99.opacity * 100)}%`)
    setOverlayOpacityByName((name) => name === 'D99', visibleState.d99.opacity)
    if (d99SurfaceVisible) void refreshProjectedSurfaceLayers()
  })
  d99LookupControl.checked = true
  d99LookupControl.disabled = true
}

function formatMorphologyRangeValue(metric: MorphologyMetric, value: number): string {
  return metric === 'thickness' ? `${value.toFixed(2)} mm` : value.toFixed(3)
}

function updateMorphologyRangeUi() {
  const display = document.querySelector<HTMLSelectElement>('#morphology-display')!
  const group = document.getElementById('morphology-range-group')!
  const styleGroup = document.getElementById('curvature-style-group')!
  const styleSelect = document.querySelector<HTMLSelectElement>('#curvature-style')!
  const symmetric = document.querySelector<HTMLInputElement>('#morphology-symmetric')!
  const minInput = document.querySelector<HTMLInputElement>('#morphology-min')!
  const maxInput = document.querySelector<HTMLInputElement>('#morphology-max')!
  const rangeRoot = document.getElementById('morphology-dual-range')!

  display.value = activeMorphology
  styleSelect.value = curvatureStyle
  styleGroup.classList.toggle('hidden', activeMorphology !== 'curvature')
  const rangeRelevant = activeMorphology !== 'none' && !(activeMorphology === 'curvature' && curvatureStyle === 'binary')
  group.classList.toggle('hidden', !rangeRelevant)
  group.classList.toggle('disabled', activeMorphology === 'none')
  if (activeMorphology === 'none' || !rangeRelevant) return

  const metric: MorphologyMetric = activeMorphology
  const range = morphologyRanges[metric]
  const span = Math.max(range.domainMax - range.domainMin, 1e-6)
  const step = span / 500
  for (const input of [minInput, maxInput]) {
    input.min = String(range.domainMin)
    input.max = String(range.domainMax)
    input.step = String(step)
    input.disabled = false
  }
  minInput.value = String(range.min)
  maxInput.value = String(range.max)
  symmetric.checked = range.symmetric
  symmetric.disabled = metric === 'thickness'
  rangeRoot.className = `dual-range ${metric}`
  const lowPct = ((range.min - range.domainMin) / span) * 100
  const highPct = ((range.max - range.domainMin) / span) * 100
  rangeRoot.style.setProperty('--low-pct', `${Math.max(0, Math.min(100, lowPct))}%`)
  rangeRoot.style.setProperty('--high-pct', `${Math.max(0, Math.min(100, highPct))}%`)
  setText('morphology-min-value', formatMorphologyRangeValue(metric, range.min))
  setText('morphology-max-value', formatMorphologyRangeValue(metric, range.max))
}

function configureMorphologyPanel() {
  const panel = document.getElementById('morphology-panel')!
  const button = document.getElementById('morphology-panel-button')!
  const close = document.getElementById('morphology-panel-close')!
  const atlasPanel = document.getElementById('atlas-panel')!
  const atlasButton = document.getElementById('atlas-panel-button')!
  const togglePanel = (show?: boolean) => {
    const next = show ?? !panel.classList.contains('open')
    panel.classList.toggle('open', next)
    button.classList.toggle('active', next)
    if (next) {
      atlasPanel.classList.remove('open')
      atlasButton.classList.remove('active')
      document.getElementById('function-panel')?.classList.remove('open')
      document.getElementById('function-panel-button')?.classList.remove('active')
      document.getElementById('imported-panel')?.classList.remove('open')
      document.getElementById('import-panel-button')?.classList.remove('active')
    }
  }
  button.addEventListener('click', () => togglePanel())
  close.addEventListener('click', () => togglePanel(false))

  const display = document.querySelector<HTMLSelectElement>('#morphology-display')!
  const markerModeSelect = document.querySelector<HTMLSelectElement>('#surface-marker-mode')!
  const styleSelect = document.querySelector<HTMLSelectElement>('#curvature-style')!
  const minInput = document.querySelector<HTMLInputElement>('#morphology-min')!
  const maxInput = document.querySelector<HTMLInputElement>('#morphology-max')!
  const symmetric = document.querySelector<HTMLInputElement>('#morphology-symmetric')!
  const autoButton = document.getElementById('morphology-auto')!

  display.addEventListener('change', async () => {
    activeMorphology = display.value as MorphologyDisplay
    updateMorphologyRangeUi()
    await applyMorphologyDisplay()
  })

  markerModeSelect.addEventListener('change', () => {
    surfaceMarkerMode = markerModeSelect.value as SurfaceMarkerMode
    markerPosition = null
    if (selectedMM) updateSurfaceMarker(selectedMM)
  })

  styleSelect.addEventListener('change', async () => {
    curvatureStyle = styleSelect.value as CurvatureStyle
    updateMorphologyRangeUi()
    await applyMorphologyDisplay()
  })

  const applyManualRange = (source: 'min' | 'max') => {
    if (activeMorphology === 'none') return
    const range = morphologyRanges[activeMorphology]
    let low = Number(minInput.value)
    let high = Number(maxInput.value)
    if (range.symmetric && activeMorphology !== 'thickness') {
      const limit = source === 'min' ? Math.abs(low) : Math.abs(high)
      low = -limit
      high = limit
    } else if (low > high) {
      if (source === 'min') low = high
      else high = low
    }
    range.min = low
    range.max = high
    updateMorphologyRangeUi()
  }
  minInput.addEventListener('input', () => applyManualRange('min'))
  maxInput.addEventListener('input', () => applyManualRange('max'))
  minInput.addEventListener('change', () => void applyMorphologyDisplay())
  maxInput.addEventListener('change', () => void applyMorphologyDisplay())

  symmetric.addEventListener('change', async () => {
    if (activeMorphology === 'none' || activeMorphology === 'thickness') return
    const range = morphologyRanges[activeMorphology]
    range.symmetric = symmetric.checked
    if (range.symmetric) {
      const limit = Math.max(Math.abs(range.min), Math.abs(range.max))
      range.min = -limit
      range.max = limit
    }
    updateMorphologyRangeUi()
    await applyMorphologyDisplay()
  })

  autoButton.addEventListener('click', async () => {
    if (activeMorphology === 'none') return
    const range = morphologyRanges[activeMorphology]
    range.min = range.autoMin
    range.max = range.autoMax
    if (range.symmetric && activeMorphology !== 'thickness') {
      const limit = Math.max(Math.abs(range.min), Math.abs(range.max))
      range.min = -limit
      range.max = limit
    }
    updateMorphologyRangeUi()
    await applyMorphologyDisplay()
  })

  updateMorphologyRangeUi()
}


function robustRange(values: ArrayLike<number>): { min: number; max: number; rawMin: number; rawMax: number } {
  const finite: number[] = []
  let rawMin = Number.POSITIVE_INFINITY
  let rawMax = Number.NEGATIVE_INFINITY
  const stride = Math.max(1, Math.floor(values.length / 300000))
  for (let index = 0; index < values.length; index += stride) {
    const value = Number(values[index])
    if (!Number.isFinite(value)) continue
    rawMin = Math.min(rawMin, value); rawMax = Math.max(rawMax, value)
    if (value !== 0) finite.push(value)
  }
  if (!finite.length) finite.push(0)
  finite.sort((a, b) => a - b)
  const q = (fraction: number) => finite[Math.min(finite.length - 1, Math.max(0, Math.floor((finite.length - 1) * fraction)))]
  let min = q(0.02); let max = q(0.98)
  if (!(max > min)) { min = Number.isFinite(rawMin) ? rawMin : 0; max = Number.isFinite(rawMax) ? rawMax : min + 1 }
  if (!(max > min)) max = min + 1
  return { min, max, rawMin: Number.isFinite(rawMin) ? rawMin : 0, rawMax: Number.isFinite(rawMax) ? rawMax : 0 }
}

function uniqueIntegerLabels(values: ArrayLike<number>, limit = 4096): number[] {
  const labels = new Set<number>()
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index])
    if (!Number.isFinite(value) || value === 0) continue
    const rounded = Math.round(value)
    if (Math.abs(value - rounded) > 1e-4) continue
    labels.add(rounded)
    if (labels.size >= limit) break
  }
  return Array.from(labels).sort((a, b) => a - b)
}

function importedLabelLut(labels: number[]): LabelLut | undefined {
  if (!labels.length) return undefined
  const min = Math.min(0, labels[0])
  const max = labels.at(-1) ?? 1
  if (max - min > 10000) return undefined
  const count = max - min + 1
  const lut = new Uint8ClampedArray(count * 4)
  const names = Array.from({ length: count }, (_, index) => String(index + min))
  for (const label of labels) {
    const slot = label - min
    const hue = ((label * 137.508) % 360 + 360) % 360
    const c = 0.72; const x = c * (1 - Math.abs((hue / 60) % 2 - 1)); const m = 0.22
    let rgb: [number, number, number] = [c, x, 0]
    if (hue >= 60 && hue < 120) rgb = [x, c, 0]
    else if (hue >= 120 && hue < 180) rgb = [0, c, x]
    else if (hue >= 180 && hue < 240) rgb = [0, x, c]
    else if (hue >= 240 && hue < 300) rgb = [x, 0, c]
    else if (hue >= 300) rgb = [c, 0, x]
    lut[slot * 4] = Math.round((rgb[0] + m) * 255)
    lut[slot * 4 + 1] = Math.round((rgb[1] + m) * 255)
    lut[slot * 4 + 2] = Math.round((rgb[2] + m) * 255)
    lut[slot * 4 + 3] = 255
  }
  const zero = 0 - min
  if (zero >= 0 && zero < count) lut[zero * 4 + 3] = 0
  return { lut, min, max, labels: names }
}

async function addImportedLayerToView(nv: Niivue, layer: ImportedLayer): Promise<void> {
  if (!layer.visible) return
  const options: any = {
    url: layer.displayUrl,
    name: `Imported:${layer.id}`,
    opacity: layer.opacity,
    colormap: layer.colormap,
    colorbarVisible: false,
    cal_min: layer.calMin,
    cal_max: layer.calMax,
    trustCalMinMax: true,
    ignoreZeroVoxels: layer.zeroBackground,
  }
  if (layer.dataType === 'atlas') {
    const lut = importedLabelLut(layer.uniqueLabels)
    if (lut) options.colormapLabel = lut
  }
  await nv.addVolumeFromUrl(options)
  const index = nv.volumes.length - 1
  const volume = nv.volumes[index]
  volume.opacity = layer.opacity
  volume.cal_min = layer.calMin
  volume.cal_max = layer.calMax
  volume.ignoreZeroVoxels = layer.zeroBackground
  if (layer.dataType === 'atlas') {
    const lut = importedLabelLut(layer.uniqueLabels)
    if (lut) { volume.colormapLabel = lut; volume.colormapType = 2 }
  }
  const previousNearest = nv.opts.isNearestInterpolation
  nv.opts.isNearestInterpolation = layer.interpolation === 'nearest'
  nv.updateInterpolation(index)
  nv.opts.isNearestInterpolation = previousNearest
  nv.updateGLVolume()
}

function openImportedPanel(): void {
  const panel = document.getElementById('imported-panel')!
  panel.classList.add('open')
  document.getElementById('import-panel-button')?.classList.add('active')
  for (const id of ['atlas', 'morphology', 'function']) {
    document.getElementById(`${id}-panel`)?.classList.remove('open')
    document.getElementById(`${id}-panel-button`)?.classList.remove('active')
  }
}

function importedTypeLabel(type: ImportDataType): string {
  return type === 'anatomical' ? 'Anatomical' : type === 'atlas' ? 'Atlas / labels' : 'Functional / statistical'
}

function renderImportedPanel(): void {
  const list = document.getElementById('imported-layer-list')!
  const empty = document.getElementById('imported-empty')!
  empty.classList.toggle('hidden', importedLayers.length > 0)
  list.innerHTML = ''
  importedLayers.forEach((layer, index) => {
    const card = document.createElement('section')
    card.className = 'imported-layer-card'
    card.innerHTML = `
      <div class="imported-layer-header">
        <label><input class="imported-visible" type="checkbox" ${layer.visible ? 'checked' : ''}><strong></strong></label>
        <button class="icon-button imported-remove" title="Remove">×</button>
      </div>
      <div class="imported-layer-subtitle">${importedTypeLabel(layer.dataType)} · ${layer.space}${layer.space === 'T1w' ? '' : ' → T1w'} · ${layer.interpolation === 'nearest' ? 'Nearest neighbor' : 'Linear'}</div>
      <label class="control-row"><span>Name</span><input class="imported-name" type="text" maxlength="80"></label>
      <label class="control-row opacity-row"><span>Opacity</span><input class="imported-opacity" type="range" min="0" max="1" step="0.02" value="${layer.opacity}"><output>${Math.round(layer.opacity * 100)}%</output></label>
      <label class="control-row"><span>Colormap</span><select class="imported-colormap"><option value="gray">Gray</option><option value="viridis">Viridis</option><option value="warm">Warm</option><option value="cool">Cool</option><option value="blue2red">Blue–red</option><option value="rainbow">Rainbow</option></select></label>
      <div class="imported-range-control">
        <div class="range-heading"><span>Display range</span></div>
        <div class="range-values"><output class="imported-cal-min-value"></output><output class="imported-cal-max-value"></output></div>
        <div class="dual-range imported-dual-range">
          <div class="dual-range-track"></div>
          <div class="dual-range-selection"></div>
          <input class="range-thumb imported-cal-min" type="range" aria-label="Imported minimum or threshold">
          <input class="range-thumb imported-cal-max" type="range" aria-label="Imported maximum">
        </div>
      </div>
      <label class="control-row checkbox-row"><input class="imported-zero" type="checkbox" ${layer.zeroBackground ? 'checked' : ''}><span>Treat zero as background</span></label>
      ${layer.dataType === 'atlas' ? `<div class="imported-atlas-summary">${layer.uniqueLabels.length ? `${layer.uniqueLabels.length} integer labels detected` : 'No integer labels detected'}</div>` : ''}
      <div class="imported-surface-section">
        <div class="range-heading"><span>Surface projection</span>${activeImportedProjectionId === layer.id ? '<span class="imported-on-surface">On surface</span>' : ''}</div>
        <label class="control-row"><span>Ribbon summary</span><select class="imported-projection-method">${layer.dataType === 'atlas' ? '<option value="modal">Most frequent label</option>' : `<option value="mean">Mean</option><option value="maximum">Maximum</option><option value="maxabs">Maximum absolute</option>`}</select></label>
        <div class="imported-layer-actions"><button class="small-button imported-project">${activeImportedProjectionId === layer.id ? 'Update projection' : 'Project to surface'}</button>${activeImportedProjectionId === layer.id ? '<button class="small-button imported-clear-projection">Clear projection</button>' : ''}</div>
      </div>
      <div class="imported-layer-actions"><button class="small-button imported-up" ${index === 0 ? 'disabled' : ''}>Move up</button><button class="small-button imported-down" ${index === importedLayers.length - 1 ? 'disabled' : ''}>Move down</button><button class="small-button imported-save">Save T1w copy</button></div>
      <details><summary>File information</summary><div class="imported-file-info">${layer.sourceName}<br>${layer.sourcePath}<br>Range: ${layer.rawMin.toPrecision(5)} to ${layer.rawMax.toPrecision(5)}</div></details>`
    ;(card.querySelector('.imported-layer-header strong') as HTMLElement).textContent = layer.name
    const name = card.querySelector<HTMLInputElement>('.imported-name')!; name.value = layer.name
    const cmap = card.querySelector<HTMLSelectElement>('.imported-colormap')!; cmap.value = layer.colormap
    const projectionMethod = card.querySelector<HTMLSelectElement>('.imported-projection-method')!; projectionMethod.value = layer.projectionMethod
    card.querySelector<HTMLInputElement>('.imported-visible')!.addEventListener('change', async (event) => { layer.visible = (event.target as HTMLInputElement).checked; await replaceVisibleAtlasLayers() })
    card.querySelector<HTMLInputElement>('.imported-opacity')!.addEventListener('input', (event) => { layer.opacity = Number((event.target as HTMLInputElement).value); (card.querySelector('.imported-opacity + output') as HTMLOutputElement).value = `${Math.round(layer.opacity * 100)}%`; setOverlayOpacityByName((n) => n === `Imported:${layer.id}`, layer.opacity); if (activeImportedProjectionId === layer.id) void refreshProjectedSurfaceLayers() })
    name.addEventListener('change', () => { layer.name = name.value.trim() || layer.sourceName; renderImportedPanel() })
    cmap.addEventListener('change', async () => { layer.colormap = cmap.value; await replaceVisibleAtlasLayers(); if (activeImportedProjectionId === layer.id) await refreshProjectedSurfaceLayers() })
    const calMin = card.querySelector<HTMLInputElement>('.imported-cal-min')!
    const calMax = card.querySelector<HTMLInputElement>('.imported-cal-max')!
    const calMinValue = card.querySelector<HTMLOutputElement>('.imported-cal-min-value')!
    const calMaxValue = card.querySelector<HTMLOutputElement>('.imported-cal-max-value')!
    const importedRangeRoot = card.querySelector<HTMLElement>('.imported-dual-range')!
    const domainMin = Number.isFinite(layer.rawMin) ? layer.rawMin : layer.calMin
    const domainMax = Number.isFinite(layer.rawMax) ? layer.rawMax : layer.calMax
    const domainSpan = Math.max(domainMax - domainMin, Math.abs(domainMax || domainMin || 1) * 1e-6, 1e-6)
    const rangeStep = domainSpan / 500
    for (const input of [calMin, calMax]) {
      input.min = String(domainMin)
      input.max = String(domainMax)
      input.step = String(rangeStep)
    }
    const formatImportedRangeValue = (value: number) => {
      const magnitude = Math.max(Math.abs(domainMin), Math.abs(domainMax), Math.abs(value))
      if (magnitude >= 1000 || (magnitude > 0 && magnitude < 0.01)) return value.toExponential(3)
      if (domainSpan >= 100) return value.toFixed(1)
      if (domainSpan >= 10) return value.toFixed(2)
      return value.toFixed(3)
    }
    const updateImportedRangeUi = () => {
      calMin.value = String(layer.calMin)
      calMax.value = String(layer.calMax)
      calMinValue.value = formatImportedRangeValue(layer.calMin)
      calMaxValue.value = formatImportedRangeValue(layer.calMax)
      const lowPct = ((layer.calMin - domainMin) / domainSpan) * 100
      const highPct = ((layer.calMax - domainMin) / domainSpan) * 100
      importedRangeRoot.style.setProperty('--low-pct', `${Math.max(0, Math.min(100, lowPct))}%`)
      importedRangeRoot.style.setProperty('--high-pct', `${Math.max(0, Math.min(100, highPct))}%`)
    }
    updateImportedRangeUi()
    calMin.addEventListener('input', () => {
      const value = Number(calMin.value)
      if (Number.isFinite(value)) layer.calMin = Math.min(value, layer.calMax - rangeStep)
      updateImportedRangeUi()
    })
    calMax.addEventListener('input', () => {
      const value = Number(calMax.value)
      if (Number.isFinite(value)) layer.calMax = Math.max(value, layer.calMin + rangeStep)
      updateImportedRangeUi()
    })
    calMin.addEventListener('change', async () => { await replaceVisibleAtlasLayers(); if (activeImportedProjectionId === layer.id) await refreshProjectedSurfaceLayers() })
    calMax.addEventListener('change', async () => { await replaceVisibleAtlasLayers(); if (activeImportedProjectionId === layer.id) await refreshProjectedSurfaceLayers() })
    card.querySelector<HTMLInputElement>('.imported-zero')!.addEventListener('change', async (event) => { layer.zeroBackground = (event.target as HTMLInputElement).checked; projectedSurfaceCache.delete(importedProjectionCacheKey(layer)); await replaceVisibleAtlasLayers(); if (activeImportedProjectionId === layer.id) await refreshProjectedSurfaceLayers() })
    projectionMethod.addEventListener('change', () => { layer.projectionMethod = projectionMethod.value as ImportedProjectionMethod })
    card.querySelector('.imported-project')!.addEventListener('click', async () => {
      try {
        layer.projectionMethod = projectionMethod.value as ImportedProjectionMethod
        activeImportedProjectionId = layer.id
        await refreshProjectedSurfaceLayers()
        renderImportedPanel()
        setText('status', `Projected ${layer.name} to the cortical surface`)
      } catch (error) {
        activeImportedProjectionId = null
        renderImportedPanel()
        setText('status', `Projection error: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    card.querySelector('.imported-clear-projection')?.addEventListener('click', async () => {
      activeImportedProjectionId = null
      await refreshProjectedSurfaceLayers()
      renderImportedPanel()
      setText('status', 'Imported surface projection cleared')
    })
    card.querySelector('.imported-remove')!.addEventListener('click', async () => { if (layer.ownedObjectUrl) URL.revokeObjectURL(layer.displayUrl); if (activeImportedProjectionId === layer.id) activeImportedProjectionId = null; importedLayers.splice(index, 1); renderImportedPanel(); await replaceVisibleAtlasLayers(); await refreshProjectedSurfaceLayers() })
    card.querySelector('.imported-up')!.addEventListener('click', async () => { [importedLayers[index - 1], importedLayers[index]] = [importedLayers[index], importedLayers[index - 1]]; renderImportedPanel(); await replaceVisibleAtlasLayers() })
    card.querySelector('.imported-down')!.addEventListener('click', async () => { [importedLayers[index + 1], importedLayers[index]] = [importedLayers[index], importedLayers[index + 1]]; renderImportedPanel(); await replaceVisibleAtlasLayers() })
    card.querySelector('.imported-save')!.addEventListener('click', async () => { const response = await fetch(layer.displayUrl); if (!response.ok) throw new Error('Unable to prepare imported volume download'); const blob = await response.blob(); triggerDownload(blob, `${sanitizeSnapshotLabel(layer.name) || 'imported'}_space-T1w_desc-imported.nii.gz`) })
    list.appendChild(card)
  })
}

function resolvedImportInterpolation(): 'nearest' | 'linear' {
  const selected = (document.getElementById('import-interpolation') as HTMLSelectElement).value as ImportInterpolation
  if (selected !== 'auto') return selected
  return (document.getElementById('import-type') as HTMLSelectElement).value === 'atlas' ? 'nearest' : 'linear'
}

function updateImportAutoNote(): void {
  const interpolation = resolvedImportInterpolation()
  setText('import-auto-note', `${(document.getElementById('import-interpolation') as HTMLSelectElement).value === 'auto' ? 'Auto selected' : 'Selected'}: ${interpolation === 'nearest' ? 'Nearest neighbor' : 'Linear'}`)
}

type ImportBrowserEntry = { name: string; path: string; isDirectory: boolean; size: number | null; url: string | null }
async function loadImportDirectory(path = importBrowserPath): Promise<void> {
  importBrowserPath = path
  const query = (document.getElementById('import-search') as HTMLInputElement).value.trim()
  const response = await fetch(`/api/import-files?path=${encodeURIComponent(path)}&q=${encodeURIComponent(query)}`)
  if (!response.ok) throw new Error(`Unable to browse import files (${response.status})`)
  const payload = await response.json() as { path: string; displayPath: string; parent: string | null; entries: ImportBrowserEntry[] }
  importBrowserPath = payload.path
  setText('import-path', payload.displayPath)
  const up = document.getElementById('import-up') as HTMLButtonElement; up.disabled = payload.parent === null; up.dataset.parent = payload.parent ?? ''
  const list = document.getElementById('import-file-list')!; list.innerHTML = ''
  if (!payload.entries.length) { const empty = document.createElement('div'); empty.className = 'monkey-folder-empty'; empty.textContent = 'No matching folders or NIfTI files.'; list.appendChild(empty) }
  for (const entry of payload.entries) {
    const row = document.createElement('button'); row.type = 'button'; row.className = `monkey-folder-row import-file-row${entry.isDirectory ? ' is-directory' : ''}`
    row.innerHTML = `<span class="monkey-folder-icon">${entry.isDirectory ? '▸' : '●'}</span><span class="monkey-folder-name"></span><span class="import-file-size"></span>`
    ;(row.querySelector('.monkey-folder-name') as HTMLElement).textContent = entry.name
    if (!entry.isDirectory && entry.size !== null) (row.querySelector('.import-file-size') as HTMLElement).textContent = entry.size > 1048576 ? `${(entry.size / 1048576).toFixed(1)} MB` : `${Math.ceil(entry.size / 1024)} KB`
    row.addEventListener('click', () => {
      if (entry.isDirectory) { void loadImportDirectory(entry.path) }
      else if (entry.url) {
        importSelectedFile = { name: entry.name, path: entry.path, url: entry.url, size: entry.size }
        for (const item of Array.from(list.children)) item.classList.remove('selected')
        row.classList.add('selected')
        setText('import-selected-file', entry.path)
        const nameInput = document.getElementById('import-name') as HTMLInputElement
        nameInput.value = entry.name.replace(/\.nii(?:\.gz)?$/i, '').replace(/^sub-[^_]+_/, '').replace(/(?:^|_)space-[^_]+/g, '').replace(/(?:^|_)desc-/g, '_').replace(/^_+|_+$/g, '')
        ;(document.getElementById('import-confirm') as HTMLButtonElement).disabled = false
      }
    })
    list.appendChild(row)
  }
}

async function performImport(): Promise<void> {
  if (!importSelectedFile) throw new Error('Choose a NIfTI file')
  const space = (document.getElementById('import-space') as HTMLSelectElement).value as ImportSpace
  const dataType = (document.getElementById('import-type') as HTMLSelectElement).value as ImportDataType
  const interpolation = resolvedImportInterpolation()
  const displayName = (document.getElementById('import-name') as HTMLInputElement).value.trim() || importSelectedFile.name.replace(/\.nii(?:\.gz)?$/i, '')
  const progress = document.getElementById('import-progress')!; const error = document.getElementById('import-error')!
  error.classList.add('hidden'); progress.classList.remove('hidden'); setText('import-progress', 'Reading NIfTI…'); await nextBrowserPaint()
  const source = await loadRawNifti(importSelectedFile.url)
  if (source.frameCount !== 1) throw new Error(`This version supports 3D NIfTI volumes. The selected file contains ${source.frameCount} volumes.`)
  let displayUrl = importSelectedFile.url; let ownedObjectUrl = false; let displayValues = rawFrame(source, 0)
  if (space !== 'T1w') {
    const targetUrl = requiredUrl(requireMonkey().anatomy, 'T1w anatomy')
    setText('import-progress', `Resampling ${space} to T1w…`); await nextBrowserPaint()
    const targetRaw = await loadRawNifti(targetUrl)
    let output: Float32Array
    if (space === 'scanner') {
      const transform = requireMonkey().transforms?.scanner
      if (!transform) throw new Error('Scanner-to-T1w transform is unavailable for this monkey')
      const matrix = await parseAffineText(transform.outputToT1wAffine)
      output = resampleScannerToT1w(source, targetRaw, matrix, displayValues, interpolation)
    } else {
      const capability = requireMonkey().transforms?.templates?.[space]?.import
      if (!capability?.enabled || !capability.transform) throw new Error(capability?.reason ?? `Brainana from-${space}_to-T1w displacement field is unavailable.`)
      const reverse = await loadRawNifti(capability.transform)
      output = resampleTemplateToT1w(source, targetRaw, reverse, displayValues, interpolation)
    }
    const referenceNv = sliceViews[0].volumes[0]
    const blob = niftiScalarBlob(referenceNv, output)
    displayUrl = URL.createObjectURL(blob); ownedObjectUrl = true; displayValues = output
  }
  const range = robustRange(displayValues)
  const labels = dataType === 'atlas' ? uniqueIntegerLabels(displayValues) : []
  if (dataType === 'atlas' && interpolation === 'linear') console.warn('Linear interpolation was selected for atlas data; non-integer labels may be introduced.')
  importedLayers.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: displayName, sourceName: importSelectedFile.name, sourcePath: importSelectedFile.path, sourceUrl: importSelectedFile.url, displayUrl, ownedObjectUrl, space, dataType, interpolation, visible: true, opacity: dataType === 'anatomical' ? 0.65 : 0.78, colormap: dataType === 'anatomical' ? 'gray' : dataType === 'atlas' ? 'rainbow' : (range.rawMin < 0 && range.rawMax > 0 ? 'blue2red' : 'warm'), calMin: dataType === 'functional' && range.rawMin >= 0 ? Math.max(0, range.min) : range.min, calMax: range.max, rawMin: range.rawMin, rawMax: range.rawMax, zeroBackground: dataType !== 'anatomical', uniqueLabels: labels, projectionMethod: dataType === 'atlas' ? 'modal' : 'mean' })
  setText('import-progress', 'Adding imported volume…'); await replaceVisibleAtlasLayers(); renderImportedPanel(); openImportedPanel()
  document.getElementById('import-dialog')!.classList.add('hidden'); progress.classList.add('hidden')
  setText('status', `Imported ${displayName}`)
}

function configureImportFeature(): void {
  if (importConfigured) return
  importConfigured = true
  const dialog = document.getElementById('import-dialog')!
  const close = () => { dialog.classList.add('hidden'); document.getElementById('import-error')?.classList.add('hidden') }
  document.getElementById('import-button')!.addEventListener('click', () => { importSelectedFile = null; (document.getElementById('import-confirm') as HTMLButtonElement).disabled = true; dialog.classList.remove('hidden'); void loadImportDirectory(requireMonkey().relativePath).catch((error) => { const box = document.getElementById('import-error')!; box.textContent = error instanceof Error ? error.message : String(error); box.classList.remove('hidden') }) })
  document.getElementById('import-close')!.addEventListener('click', close); document.getElementById('import-cancel')!.addEventListener('click', close)
  document.getElementById('import-up')!.addEventListener('click', () => void loadImportDirectory((document.getElementById('import-up') as HTMLButtonElement).dataset.parent ?? ''))
  let searchTimer = 0; document.getElementById('import-search')!.addEventListener('input', () => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => void loadImportDirectory(), 180) })
  document.getElementById('import-type')!.addEventListener('change', updateImportAutoNote); document.getElementById('import-interpolation')!.addEventListener('change', updateImportAutoNote)
  document.getElementById('import-confirm')!.addEventListener('click', async () => { const button = document.getElementById('import-confirm') as HTMLButtonElement; button.disabled = true; try { await performImport() } catch (error) { const box = document.getElementById('import-error')!; box.textContent = error instanceof Error ? error.message : String(error); box.classList.remove('hidden'); document.getElementById('import-progress')?.classList.add('hidden') } finally { button.disabled = !importSelectedFile } })
  const panel = document.getElementById('imported-panel')!; const panelButton = document.getElementById('import-panel-button')!
  panelButton.addEventListener('click', () => { const show = !panel.classList.contains('open'); if (show) openImportedPanel(); else { panel.classList.remove('open'); panelButton.classList.remove('active') } })
  document.getElementById('imported-panel-close')!.addEventListener('click', () => { panel.classList.remove('open'); panelButton.classList.remove('active') })
  updateImportAutoNote(); renderImportedPanel()
}

function configureFunctionPanel() {
  const panel = document.getElementById('function-panel')!
  const button = document.getElementById('function-panel-button')!
  const close = document.getElementById('function-panel-close')!
  const togglePanel = (show?: boolean) => {
    const next = show ?? !panel.classList.contains('open')
    panel.classList.toggle('open', next)
    button.classList.toggle('active', next)
    if (next) {
      document.getElementById('atlas-panel')?.classList.remove('open')
      document.getElementById('atlas-panel-button')?.classList.remove('active')
      document.getElementById('morphology-panel')?.classList.remove('open')
      document.getElementById('morphology-panel-button')?.classList.remove('active')
    }
  }
  button.addEventListener('click', () => togglePanel())
  close.addEventListener('click', () => togglePanel(false))

  const display = document.querySelector<HTMLSelectElement>('#functional-display')!
  const thresholdMap = document.querySelector<HTMLSelectElement>('#functional-threshold-map')!
  const threshold = document.querySelector<HTMLInputElement>('#functional-threshold')!
  const opacity = document.querySelector<HTMLInputElement>('#functional-opacity')!
  const surfaceBrightness = document.querySelector<HTMLInputElement>('#functional-surface-brightness')!
  const volumeVisible = document.querySelector<HTMLInputElement>('#functional-volume-visible')!
  const surfaceVisible = document.querySelector<HTMLInputElement>('#functional-surface-visible')!

  display.addEventListener('change', async () => {
    functionalDisplay = display.value as FunctionalDisplay
    const functionEnabled = functionalDisplay !== 'none'
    thresholdMap.disabled = !functionEnabled
    opacity.disabled = !functionEnabled
    surfaceBrightness.disabled = !functionEnabled
    volumeVisible.disabled = !functionEnabled
    surfaceVisible.disabled = !functionEnabled
    threshold.disabled = !functionEnabled || functionalThresholdMap === 'none'
    try {
      if (functionEnabled) await ensureFunctionalSourcesLoaded()
      if (functionalDisplay === 'polar') {
        functionalThresholdMap = 'polarF'
        thresholdMap.value = 'polarF'
      } else if (functionalDisplay === 'eccentricity') {
        functionalThresholdMap = 'eccentricityF'
        thresholdMap.value = 'eccentricityF'
      }
      threshold.disabled = !functionEnabled || functionalThresholdMap === 'none'
      if (functionEnabled && functionalThresholdMap !== 'none') updateFunctionalThresholdRange()
      await replaceVisibleAtlasLayers()
      if (functionalSurfaceVisible) await refreshProjectedSurfaceLayers()
    } catch (error) {
      functionalDisplay = 'none'
      display.value = 'none'
      setText('status', `Retinotopy load error: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  thresholdMap.addEventListener('change', async () => {
    functionalThresholdMap = thresholdMap.value as FunctionalThreshold
    threshold.disabled = functionalThresholdMap === 'none'
    if (functionalDisplay !== 'none') await ensureFunctionalSourcesLoaded()
    if (functionalThresholdMap !== 'none') updateFunctionalThresholdRange()
    await replaceVisibleAtlasLayers()
    if (functionalSurfaceVisible) await refreshProjectedSurfaceLayers()
  })
  threshold.addEventListener('input', () => {
    functionalThresholdValue = Number(threshold.value)
    setText('functional-threshold-value', formatThresholdValue(functionalThresholdValue, Number(threshold.step)))
  })
  threshold.addEventListener('change', async () => {
    await replaceVisibleAtlasLayers()
    if (functionalSurfaceVisible) await refreshProjectedSurfaceLayers()
  })
  opacity.addEventListener('input', () => {
    functionalOpacity = Number(opacity.value)
    setText('functional-opacity-value', `${Math.round(functionalOpacity * 100)}%`)
    setOverlayOpacityByName((name) => name.startsWith('Retinotopy:'), functionalOpacity)
    if (functionalSurfaceVisible) void refreshProjectedSurfaceLayers()
  })
  surfaceBrightness.addEventListener('input', () => {
    functionalSurfaceBrightness = Number(surfaceBrightness.value)
    setText('functional-surface-brightness-value', `${Math.round(functionalSurfaceBrightness * 100)}%`)
    if (functionalSurfaceVisible) void refreshProjectedSurfaceLayers()
  })
  volumeVisible.addEventListener('change', async () => {
    functionalVolumeVisible = volumeVisible.checked
    await replaceVisibleAtlasLayers()
  })
  surfaceVisible.addEventListener('change', async () => {
    functionalSurfaceVisible = surfaceVisible.checked
    try {
      if (functionalSurfaceVisible && functionalDisplay !== 'none') {
        await ensureFunctionalSourcesLoaded()
      }
      await refreshProjectedSurfaceLayers()
    } catch (error) { surfaceVisible.checked = false; functionalSurfaceVisible = false; setText('status', `Projection error: ${error instanceof Error ? error.message : String(error)}`) }
  })

  document.querySelector<HTMLSelectElement>('#retino-neighborhood-size')?.addEventListener('change', () => {
    if (selectedMM) updateFunctionalReport(selectedMM)
  })

  const somatoDisplay = document.querySelector<HTMLSelectElement>('#somatotopy-display')!
  const somatoThreshold = document.querySelector<HTMLInputElement>('#somatotopy-threshold')!
  const somatoOpacity = document.querySelector<HTMLInputElement>('#somatotopy-opacity')!
  const somatoSurfaceBrightness = document.querySelector<HTMLInputElement>('#somatotopy-surface-brightness')!
  const surfaceOrder = document.querySelector<HTMLSelectElement>('#functional-surface-order')!
  const somatoVolumeVisible = document.querySelector<HTMLInputElement>('#somatotopy-volume-visible')!
  const somatoSurfaceVisible = document.querySelector<HTMLInputElement>('#somatotopy-surface-visible')!
  const somatoThresholdMap = document.querySelector<HTMLSelectElement>('#somatotopy-threshold-map')!

  somatoDisplay.addEventListener('change', async () => {
    somatotopyDisplay = somatoDisplay.value as SomatotopyDisplay
    const enabled = somatotopyDisplay !== 'none'
    somatoThreshold.disabled = !enabled
    somatoOpacity.disabled = !enabled
    somatoSurfaceBrightness.disabled = !enabled
    somatoVolumeVisible.disabled = !enabled
    somatoSurfaceVisible.disabled = !enabled
    somatoThresholdMap.disabled = !enabled
    try {
      if (enabled) {
        await ensureSomatotopySourcesLoaded()
        updateSomatotopyThresholdRange()
      }
      await replaceVisibleAtlasLayers()
      if (somatotopySurfaceVisible) await refreshProjectedSurfaceLayers()
      if (selectedMM) updateSomatotopyReport(selectedMM)
    } catch (error) {
      somatotopyDisplay = 'none'
      somatoDisplay.value = 'none'
      setText('status', `Somatotopy load error: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  somatoThreshold.addEventListener('input', () => {
    somatotopyThresholdValue = Number(somatoThreshold.value)
    setText('somatotopy-threshold-value', somatotopyThresholdValue.toFixed(1))
    if (selectedMM) updateSomatotopyReport(selectedMM)
  })
  somatoThreshold.addEventListener('change', async () => {
    projectedSurfaceCache.delete(projectionCacheKey('somatotopy'))
    await replaceVisibleAtlasLayers()
    if (somatotopySurfaceVisible) await refreshProjectedSurfaceLayers()
  })
  somatoOpacity.addEventListener('input', () => {
    somatotopyOpacity = Number(somatoOpacity.value)
    setText('somatotopy-opacity-value', `${Math.round(somatotopyOpacity * 100)}%`)
    setOverlayOpacityByName((name) => name.startsWith('Somatotopy:'), somatotopyOpacity)
    if (somatotopySurfaceVisible) void refreshProjectedSurfaceLayers()
  })
  somatoSurfaceBrightness.addEventListener('input', () => {
    somatotopySurfaceBrightness = Number(somatoSurfaceBrightness.value)
    setText('somatotopy-surface-brightness-value', `${Math.round(somatotopySurfaceBrightness * 100)}%`)
    if (somatotopySurfaceVisible) void refreshProjectedSurfaceLayers()
  })
  surfaceOrder.addEventListener('change', () => {
    functionalSurfaceOrder = surfaceOrder.value as 'retinotopy' | 'somatotopy'
    if (functionalSurfaceVisible || somatotopySurfaceVisible) void refreshProjectedSurfaceLayers()
  })
  somatoVolumeVisible.addEventListener('change', async () => {
    somatotopyVolumeVisible = somatoVolumeVisible.checked
    await replaceVisibleAtlasLayers()
  })
  somatoSurfaceVisible.addEventListener('change', async () => {
    somatotopySurfaceVisible = somatoSurfaceVisible.checked
    try {
      if (somatotopySurfaceVisible && somatotopyDisplay !== 'none') {
        await ensureSomatotopySourcesLoaded()
      }
      await refreshProjectedSurfaceLayers()
    } catch (error) {
      somatoSurfaceVisible.checked = false
      somatotopySurfaceVisible = false
      setText('status', `Projection error: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

async function loadSelectedMonkey(manifest: MonkeyManifest) {
  currentMonkey = manifest
  refreshTemplateControls()
  functionalSources.polar = null
  functionalSources.polarF = null
  functionalSources.eccentricity = null
  functionalSources.eccentricityF = null
  somatotopySources.phase = null
  somatotopySources.fstat = null
  functionalLoadPromise = null
  somatotopyLoadPromise = null
  visibleState.charm.visible = false
  visibleState.d99.visible = false
  charmSurfaceVisible = false
  d99SurfaceVisible = false
  const charmVisibleControl = document.querySelector<HTMLInputElement>('#charm-visible')
  const d99VisibleControl = document.querySelector<HTMLInputElement>('#d99-visible')
  const charmSurfaceControl = document.querySelector<HTMLInputElement>('#charm-surface-visible')
  const d99SurfaceControl = document.querySelector<HTMLInputElement>('#d99-surface-visible')
  if (charmVisibleControl) charmVisibleControl.checked = false
  if (d99VisibleControl) d99VisibleControl.checked = false
  if (charmSurfaceControl) charmSurfaceControl.checked = false
  if (d99SurfaceControl) d99SurfaceControl.checked = false
  projectedSurfaceCache.clear()
  document.getElementById('monkey-placeholder')?.classList.add('hidden')
  document.body.classList.add('monkey-loaded')
  setText('status', `Loading ${manifest.id}…`)
  const surfaceSelect = document.querySelector<HTMLSelectElement>('#surface-kind')!
  for (const option of Array.from(surfaceSelect.options)) {
    option.disabled = !manifest.surfaces[option.value as SurfaceKind]
  }
  const functionDisplay = document.querySelector<HTMLSelectElement>('#functional-display')
  if (functionDisplay) {
    for (const option of Array.from(functionDisplay.options)) if (option.value !== 'none') option.disabled = !manifest.capabilities.retinotopy
  }
  const somatotopyDisplayControl = document.querySelector<HTMLSelectElement>('#somatotopy-display')
  if (somatotopyDisplayControl) {
    const available = manifest.capabilities.somatotopy
    for (const option of Array.from(somatotopyDisplayControl.options)) {
      if (option.value === 'none') continue
      option.disabled = !available
      option.title = available ? '' : 'Somatotopy is unavailable for this monkey'
    }
    if (!available) {
      somatotopyDisplay = 'none'
      somatotopyDisplayControl.value = 'none'
    }
  }
  await Promise.all([
    loadSliceView(views.sagittal, 'sagittal', SLICE_TYPE.SAGITTAL),
    loadSliceView(views.coronal, 'coronal', SLICE_TYPE.CORONAL),
    loadSliceView(views.axial, 'axial', SLICE_TYPE.AXIAL),
    loadLookupVolumes(),
    loadMorphologyData(),
  ])
  await initializeSurfaceView()
  await initializeProjectionEngine()
  configureBidirectionalSync()
  configureInteractiveLegend()
  configureAtlasPanel()
  configureMorphologyPanel()
  configureFunctionPanel()
  await replaceVisibleAtlasLayers()

  surfaceSelect.addEventListener('change', async () => {
    surfaceSelect.disabled = true
    setText('status', `Loading ${surfaceSelect.value} surface…`)
    try {
      await loadSurface(surfaceSelect.value as SurfaceKind)
      configureBidirectionalSync()
      setText('status', `Ready · ${currentVisibleAtlasNames.join(' + ')}`)
    } finally { surfaceSelect.disabled = false }
  })
  const surfaceCanvas = document.getElementById('surface') as HTMLCanvasElement
  configureSurfaceMarkerDragging(surfaceCanvas)
  surfaceCanvas.addEventListener('dblclick', (event) => { event.preventDefault(); event.stopPropagation(); resetSurfaceView() })
  setupSnapshotControls()
  configureImportFeature()
  document.getElementById('snapshot-button')?.removeAttribute('disabled')
  document.getElementById('import-button')?.removeAttribute('disabled')
  document.getElementById('reset')!.addEventListener('click', () => window.location.reload())
  const resizeObserver = new ResizeObserver(() => window.requestAnimationFrame(resizeAllViewers))
  resizeObserver.observe(document.querySelector('.viewer-area')!)
  window.addEventListener('resize', () => window.requestAnimationFrame(resizeAllViewers))
  window.setTimeout(resizeAllViewers, 100)
}

async function selectMonkey(id: string) {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('monkey', id)
  else url.searchParams.delete('monkey')
  window.location.href = url.toString()
}


type DirectoryEntry = { name: string; path: string; isMonkey: boolean }
type DirectoryListing = {
  path: string
  displayPath: string
  parent: string | null
  selectable: boolean
  entries: DirectoryEntry[]
}

let monkeyFolderCurrentPath = ''
let monkeyFolderPreviousSelection = ''

function closeMonkeyFolderChooser(restoreSelection = true) {
  document.getElementById('monkey-folder-dialog')?.classList.add('hidden')
  if (restoreSelection) {
    const select = document.querySelector<HTMLSelectElement>('#monkey-select')
    if (select) select.value = monkeyFolderPreviousSelection
  }
}

async function loadMonkeyFolderDirectory(relativePath: string) {
  const response = await fetch(`/api/directories?path=${encodeURIComponent(relativePath)}`)
  const payload = await response.json() as DirectoryListing & { error?: string }
  if (!response.ok) throw new Error(payload.error ?? 'Unable to read directory')
  monkeyFolderCurrentPath = payload.path
  setText('monkey-folder-path', payload.displayPath)
  const list = document.getElementById('monkey-folder-list')!
  list.replaceChildren()
  if (!payload.entries.length) {
    const empty = document.createElement('div')
    empty.className = 'monkey-folder-empty'
    empty.textContent = 'No subdirectories.'
    list.appendChild(empty)
  }
  for (const entry of payload.entries) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = `monkey-folder-row${entry.isMonkey ? ' is-monkey' : ''}`
    row.innerHTML = `<span class="monkey-folder-icon" aria-hidden="true">▸</span><span class="monkey-folder-name"></span>${entry.isMonkey ? '<span class="monkey-folder-badge">Monkey</span>' : ''}`
    ;(row.querySelector('.monkey-folder-name') as HTMLElement).textContent = entry.name
    row.addEventListener('click', () => void loadMonkeyFolderDirectory(entry.path).catch((error) => setText('monkey-folder-note', error instanceof Error ? error.message : String(error))))
    list.appendChild(row)
  }
  const up = document.getElementById('monkey-folder-up') as HTMLButtonElement
  up.disabled = payload.parent === null
  up.dataset.parent = payload.parent ?? ''
  const choose = document.getElementById('monkey-folder-select') as HTMLButtonElement
  choose.disabled = !payload.selectable
  setText('monkey-folder-note', payload.selectable
    ? `Ready to select ${payload.path.split('/').at(-1) ?? payload.path}.`
    : 'Navigate to a sub-* folder that contains anat/.')
}

async function openMonkeyFolderChooser() {
  const select = document.querySelector<HTMLSelectElement>('#monkey-select')!
  monkeyFolderPreviousSelection = select.dataset.previousValue ?? ''
  document.getElementById('monkey-folder-dialog')?.classList.remove('hidden')
  await loadMonkeyFolderDirectory('')
}

async function confirmMonkeyFolderSelection() {
  const button = document.getElementById('monkey-folder-select') as HTMLButtonElement
  button.disabled = true
  try {
    const response = await fetch('/api/select-monkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: monkeyFolderCurrentPath }),
    })
    const payload = await response.json() as MonkeyManifest & { error?: string }
    if (!response.ok) throw new Error(payload.error ?? 'Unable to select monkey')
    const select = document.querySelector<HTMLSelectElement>('#monkey-select')!
    let option = Array.from(select.options).find((item) => item.value === payload.relativePath)
    if (!option) {
      option = document.createElement('option')
      option.value = payload.relativePath
      option.textContent = `${payload.id} (${payload.relativePath})`
      const chooser = Array.from(select.options).find((item) => item.value === '__choose__')
      select.insertBefore(option, chooser ?? null)
    }
    closeMonkeyFolderChooser(false)
    await selectMonkey(payload.relativePath)
  } catch (error) {
    button.disabled = false
    setText('monkey-folder-note', error instanceof Error ? error.message : String(error))
  }
}

function setupMonkeyFolderChooser() {
  const dialog = document.getElementById('monkey-folder-dialog')!
  document.getElementById('monkey-folder-close')!.addEventListener('click', () => closeMonkeyFolderChooser())
  document.getElementById('monkey-folder-cancel')!.addEventListener('click', () => closeMonkeyFolderChooser())
  document.getElementById('monkey-folder-up')!.addEventListener('click', () => {
    const parent = (document.getElementById('monkey-folder-up') as HTMLButtonElement).dataset.parent ?? ''
    void loadMonkeyFolderDirectory(parent).catch((error) => setText('monkey-folder-note', error instanceof Error ? error.message : String(error)))
  })
  document.getElementById('monkey-folder-select')!.addEventListener('click', () => void confirmMonkeyFolderSelection())
  dialog.addEventListener('click', (event) => { if (event.target === dialog) closeMonkeyFolderChooser() })
}

async function establishLaunchSession(): Promise<void> {
  const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('session')
  if (!token) {
    const health = await fetch('/api/health', { credentials: 'same-origin' })
    if (!health.ok) throw new Error('This Viewer session is no longer authorized. Relaunch Brainana Viewer.')
    return
  }
  const response = await fetch('/api/session/bootstrap', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-Brainana-Session': token },
  })
  if (!response.ok) throw new Error('Unable to authorize this Viewer session. Relaunch Brainana Viewer.')
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
}

async function bootstrap() {
  await establishLaunchSession()
  await loadLookupTables()
  registerFunctionalColormaps()
  const select = document.querySelector<HTMLSelectElement>('#monkey-select')!
  const runtimeResponse = await fetch('/api/runtime')
  if (runtimeResponse.ok) runtimeConfig = await runtimeResponse.json() as RuntimeConfig
  const configResponse = await fetch('/api/config')
  if (!configResponse.ok) throw new Error(`Unable to read Brainana output configuration (${configResponse.status})`)
  const config = await configResponse.json() as { configured: boolean; outputRoot: string | null; monkeys: Array<{ id: string; label: string }>; mode?: string; version?: string; buildId?: string }
  document.title = `Brainana Viewer ${runtimeConfig.version}`
  if (!config.configured) {
    setText('status', 'Launch with --output-dir /path/to/brainana/output')
    document.getElementById('monkey-placeholder')!.textContent = 'No Brainana output directory configured. Launch with: npm run dev -- --output-dir /path/to/output'
    return
  }
  for (const monkey of config.monkeys) {
    const option = document.createElement('option'); option.value = monkey.id; option.textContent = monkey.id; select.appendChild(option)
  }
  const separator = document.createElement('option')
  separator.disabled = true
  separator.textContent = '──────────────'
  select.appendChild(separator)
  const chooser = document.createElement('option')
  chooser.value = '__choose__'
  chooser.textContent = 'Choose monkey folder…'
  select.appendChild(chooser)
  setupMonkeyFolderChooser()
  select.dataset.previousValue = ''
  select.addEventListener('focus', () => { if (select.value !== '__choose__') select.dataset.previousValue = select.value })
  select.addEventListener('change', () => {
    if (select.value === '__choose__') {
      void openMonkeyFolderChooser().catch((error) => {
        closeMonkeyFolderChooser()
        setText('status', `Folder chooser error: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }
    select.dataset.previousValue = select.value
    if (select.value) void selectMonkey(select.value)
  })
  document.getElementById('snapshot-button')?.setAttribute('disabled', 'true')
  const selected = new URLSearchParams(window.location.search).get('monkey')
  if (!selected) { setText('status', `${config.monkeys.length} monkeys found · select one to begin`); return }
  select.value = selected
  if (!select.value) { const option = document.createElement('option'); option.value = selected; option.textContent = selected.split('/').at(-1) ?? selected; select.insertBefore(option, chooser); select.value = selected }
  select.dataset.previousValue = selected
  const response = await fetch(`/api/monkeys/${encodeURIComponent(selected)}`)
  if (!response.ok) throw new Error(`Unable to load monkey manifest (${response.status})`)
  await loadSelectedMonkey(await response.json() as MonkeyManifest)
}

// Install these listeners before main() attaches NiiVue canvases so surface
// arrow-key panning always wins over NiiVue's volume-navigation key handler.
window.addEventListener('pointermove', (event) => {
  lastPointerClientX = event.clientX
  lastPointerClientY = event.clientY
}, { capture: true, passive: true })
window.addEventListener('keydown', panSurfaceWithArrowKey, { capture: true })

const graphicsSupport = detectGraphicsSupport()
if (!graphicsSupport.webgl2) {
  renderGraphicsFailure(graphicsSupport)
} else {
  installWebGLContextLifecycleReporting()
  bootstrap().then(() => {
    startSurfaceOrientationLoop()
  }).catch((error) => {
  console.error(error)
  setText('status', `Error: ${error instanceof Error ? error.message : String(error)}`)
})
}
