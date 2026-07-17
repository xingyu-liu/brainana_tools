// Atlas LUTs from the local-source .tsv sidecars (columns: ID, label, region, name,
// name_full, hemi, and an optional color). When a row supplies its own `color` cell we honor
// it; otherwise colors are procedural (golden-angle from the ID, WM/CSF special-cased). Either
// way the same color feeds the volume overlay, the surface projection, and the legend swatch.
import { roiColor, type RGB } from './colors.ts'

export interface AtlasLabel {
  id: number
  name: string
  /** Short `name`-column label (e.g. "ACgG"), set only when it differs from `name`. */
  nameShort?: string
  region: string
  hemi: string
  /** Authored color from the TSV `color` cell, if present and parseable. */
  color?: RGB
}

// Strip a surrounding pair of double quotes (some pipeline TSVs quote every cell, some don't).
function unquote(s: string): string {
  const t = (s ?? '').trim()
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

// Parse an authored color cell into an RGB triple (0–255). Accepts hex (`#RRGGBB` and the
// `#RGB` shorthand) and bracketed/plain triples (`[100 38 124]`, `100,38,124`) with space- or
// comma-separated components. Returns undefined for empty or malformed cells so the caller can
// fall back to the procedural color.
export function parseLabelColor(raw: string): RGB | undefined {
  const s = (raw ?? '').trim()
  if (!s) return undefined
  if (s.startsWith('#')) {
    const hex = s.slice(1)
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
    }
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)]
    }
    return undefined
  }
  const parts = s
    .replace(/[[\]()]/g, ' ')
    .split(/[\s,]+/)
    .filter((p) => p.length > 0)
    .map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return undefined
  return [clamp255(parts[0]), clamp255(parts[1]), clamp255(parts[2])]
}

export function parseAtlasTsv(text: string): AtlasLabel[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length === 0) return []
  const header = lines[0].split('\t').map((h) => unquote(h).toLowerCase())
  const col = (name: string) => header.indexOf(name)
  const idCol = col('id')
  const nameFull = col('name_full')
  const nameCol = col('name')
  const labelCol = col('label')
  const regionCol = col('region')
  const hemiCol = col('hemi')
  const colorCol = col('color')
  const out: AtlasLabel[] = []
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('\t').map(unquote)
    const id = Number(c[idCol])
    if (!Number.isFinite(id)) continue
    const short = nameCol >= 0 ? c[nameCol] || '' : ''
    const name = c[nameFull] || short || c[labelCol] || ''
    const entry: AtlasLabel = {
      id,
      name,
      region: regionCol >= 0 ? c[regionCol] || '' : '',
      hemi: hemiCol >= 0 ? c[hemiCol] || '' : '',
    }
    // Keep the short `name`-column label alongside `name` (the full name) only when the two
    // differ, so the report can show both without redundant duplicates.
    if (short && short !== name) entry.nameShort = short
    // Only attach `color` when the cell actually yields one, so rows without an authored color
    // stay procedural (and the object shape matches a no-color TSV).
    const color = colorCol >= 0 ? parseLabelColor(c[colorCol] || '') : undefined
    if (color) entry.color = color
    out.push(entry)
  }
  return out
}

// Legend display label, e.g. "DVC · LH" (name + hemisphere).
export function displayLabel(l: AtlasLabel): string {
  const h = l.hemi.toLowerCase() === 'lh' ? 'LH' : l.hemi.toLowerCase() === 'rh' ? 'RH' : ''
  const name = (l.name || String(l.id)).replace(/_/g, ' ')
  return h ? `${name} · ${h}` : name
}

// Prefer the authored TSV color when the row supplies one; otherwise fall back to the
// procedural golden-angle color (which also carries the WM/CSF tissue special-cases).
export function labelColor(l: AtlasLabel, seed: number): RGB {
  return l.color ?? roiColor(l.id, l.region, seed)
}

export interface LabelColortable {
  R: number[]
  G: number[]
  B: number[]
  A: number[]
  I: number[]
  labels: string[]
}

// Build a NiiVue label colortable. Background (id 0) and hidden ids are transparent.
// `clipNegative` (surface atlases) also makes negative ids transparent (medial wall / WM).
export function buildLabelColortable(entries: AtlasLabel[], opts: { seed?: number; hidden?: Set<number>; clipNegative?: boolean } = {}): LabelColortable {
  const seed = opts.seed ?? 0
  const hidden = opts.hidden
  const R: number[] = []
  const G: number[] = []
  const B: number[] = []
  const A: number[] = []
  const I: number[] = []
  const labels: string[] = []
  for (const entry of entries) {
    const [r, g, b] = labelColor(entry, seed)
    const off = entry.id === 0 || (opts.clipNegative && entry.id < 0) || (hidden ? hidden.has(entry.id) : false)
    R.push(r)
    G.push(g)
    B.push(b)
    A.push(off ? 0 : 255)
    I.push(entry.id)
    labels.push(entry.name || 'background')
  }
  // Guarantee a transparent background slot at id 0. NiiVue builds the volume/mesh label LUT as a
  // dense range [min(I)..max(I)] and clamps out-of-range voxels to the nearest edge; when a LUT
  // lacks an id-0 row (e.g. the FuncNetwork atlas, ids 1..7) its min becomes 1, so background
  // voxels (value 0) clamp to the FIRST label's OPAQUE color and wash the whole overlay. Adding a
  // transparent id-0 entry when absent keeps min(I) ≤ 0 and maps value 0 to a transparent slot,
  // for both the volume overlay and the surface medial wall. The panel legend is unaffected (it
  // filters id !== 0). Idempotent: atlases that already carry an id-0 row are left as-is.
  if (!I.includes(0)) {
    R.push(0)
    G.push(0)
    B.push(0)
    A.push(0)
    I.push(0)
    labels.push('background')
  }
  return { R, G, B, A, I, labels }
}
