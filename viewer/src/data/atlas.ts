// Atlas LUTs from the local-source .tsv sidecars (columns: ID, label, region, name,
// name_full, hemi). Colors are procedural (golden-angle from the ID, WM/CSF special-cased)
// so the same color feeds the volume overlay, the surface projection, and the legend swatch.
import { roiColor, type RGB } from './colors.ts'

export interface AtlasLabel {
  id: number
  name: string
  region: string
  hemi: string
}

// Strip a surrounding pair of double quotes (some pipeline TSVs quote every cell, some don't).
function unquote(s: string): string {
  const t = (s ?? '').trim()
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t
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
  const out: AtlasLabel[] = []
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('\t').map(unquote)
    const id = Number(c[idCol])
    if (!Number.isFinite(id)) continue
    out.push({
      id,
      name: c[nameFull] || c[nameCol] || c[labelCol] || '',
      region: regionCol >= 0 ? c[regionCol] || '' : '',
      hemi: hemiCol >= 0 ? c[hemiCol] || '' : '',
    })
  }
  return out
}

// Legend display label, e.g. "DVC · LH" (name + hemisphere).
export function displayLabel(l: AtlasLabel): string {
  const h = l.hemi.toLowerCase() === 'lh' ? 'LH' : l.hemi.toLowerCase() === 'rh' ? 'RH' : ''
  const name = (l.name || String(l.id)).replace(/_/g, ' ')
  return h ? `${name} · ${h}` : name
}

export function labelColor(l: AtlasLabel, seed: number): RGB {
  return roiColor(l.id, l.region, seed)
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
  return { R, G, B, A, I, labels }
}
