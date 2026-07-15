// Viewer-domain manifest builder + template discovery.
// Ported in behavior from server.mjs:369-503, with two deliberate changes:
//   1. `fileUrl` is INJECTED by the caller (the data source) instead of being a module
//      global, so manifest URLs can be source-scoped (/brainana-data/<sourceId>/<rel>).
//   2. The anat directory and the fastsurfer directory are resolved FLEXIBLY: a subject
//      may store anat directly (sub-*/anat) or under a BIDS session (sub-*/ses-*/anat),
//      and fastsurfer output may be keyed by subject or subject+session.
import fs from 'node:fs'
import path from 'node:path'
import { ensureDerivedAssets } from './freesurfer.mjs'

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}
function filesIn(dir) {
  if (!exists(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() || e.isSymbolicLink())
    .map((e) => path.join(dir, e.name))
}
function pick(files, patterns) {
  for (const pattern of patterns) {
    const found = files.find((f) => pattern.test(path.basename(f)))
    if (found) return found
  }
  return null
}
function filesRecursive(dir, maxDepth = 4) {
  if (!exists(dir) || maxDepth < 0) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isFile() || entry.isSymbolicLink()) out.push(abs)
    else if (entry.isDirectory()) out.push(...filesRecursive(abs, maxDepth - 1))
  }
  return out
}
function pickFunctionalMap(anatDir, preferredFiles, pattern) {
  const preferred = pick(preferredFiles, [pattern])
  if (preferred) return preferred
  const candidates = filesRecursive(anatDir, 4)
    .filter((f) => pattern.test(path.basename(f)))
    .sort((a, b) => {
      const aT1 = a.includes(`${path.sep}atlas_space-T1w${path.sep}`) ? 0 : 1
      const bT1 = b.includes(`${path.sep}atlas_space-T1w${path.sep}`) ? 0 : 1
      return aT1 - bT1 || a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    })
  return candidates[0] ?? null
}

// ---------------------------------------------------------------------------
// Flexible layout resolution (flat sub-*/anat OR sub-*/ses-*/anat)
// ---------------------------------------------------------------------------

// List immediate ses-* subdirectories, sorted numerically.
function sessionDirs(subjectDir) {
  if (!isDir(subjectDir)) return []
  return fs
    .readdirSync(subjectDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^ses-/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
}

// Resolve the anat directory for a subject. Returns { anatDir, session } or null.
// Prefers a flat sub-*/anat; otherwise the first ses-*/anat that exists.
export function resolveAnatDir(subjectDir) {
  const flat = path.join(subjectDir, 'anat')
  if (isDir(flat)) return { anatDir: flat, session: null }
  for (const ses of sessionDirs(subjectDir)) {
    const anat = path.join(subjectDir, ses, 'anat')
    if (isDir(anat)) return { anatDir: anat, session: ses }
  }
  return null
}

// True when a directory looks like a viewable subject (has anat, flat or session-nested).
export function isSubjectDir(subjectDir) {
  return path.basename(subjectDir).startsWith('sub-') && resolveAnatDir(subjectDir) != null
}

// Resolve the FreeSurfer/fastsurfer directory for a subject, tolerant of layout:
// fastsurfer/<sub>, fastsurfer/<sub>_<ses>, or fastsurfer/<sub>/<ses>. Prefers one
// that actually contains a surf/ directory.
function resolveFsDir(outputRoot, subjectId, session) {
  const base = path.join(outputRoot, 'fastsurfer')
  const candidates = [
    path.join(base, subjectId),
    session ? path.join(base, `${subjectId}_${session}`) : null,
    session ? path.join(base, subjectId, session) : null,
  ].filter(Boolean)
  const withSurf = candidates.find((c) => isDir(path.join(c, 'surf')))
  if (withSurf) return withSurf
  return candidates.find((c) => isDir(c)) ?? candidates[0]
}

// ---------------------------------------------------------------------------
// Template transform discovery (ported from server.mjs:369-421)
// ---------------------------------------------------------------------------

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function discoverTemplateTransforms(anatFiles) {
  const usable = anatFiles.filter((file) => /_mode-image_xfm\.nii(?:\.gz)?$/i.test(path.basename(file)))
  const byName = new Map()
  const pattern = /(?:^|_)from-([^_]+)_to-([^_]+)_mode-image_xfm\.nii(?:\.gz)?$/i
  for (const file of usable) {
    const match = path.basename(file).match(pattern)
    if (!match) continue
    const source = match[1]
    const destination = match[2]
    let template = null
    let direction = null
    if (destination.toLowerCase() === 't1w' && !['t1w', 'scanner'].includes(source.toLowerCase())) {
      template = source
      direction = 'importToT1w'
    } else if (source.toLowerCase() === 't1w' && !['t1w', 'scanner'].includes(destination.toLowerCase())) {
      template = destination
      direction = 'exportFromT1w'
    }
    if (!template) continue
    const key = template.toLowerCase()
    if (!byName.has(key)) byName.set(key, { name: template, importToT1w: null, exportFromT1w: null })
    const entry = byName.get(key)
    if (!entry[direction] || path.basename(file).localeCompare(path.basename(entry[direction]), undefined, { numeric: true }) < 0) entry[direction] = file
  }
  return byName
}
function findTemplateReference(anatFiles, template) {
  const escaped = escapeRegex(template)
  const candidates = anatFiles.filter((file) => {
    const name = path.basename(file)
    if (!new RegExp(`(?:^|_)space-${escaped}(?:_|$)`, 'i').test(name)) return false
    if (!/T1w\.nii(?:\.gz)?$/i.test(name)) return false
    if (/(?:^|_)(?:mask|dseg|probseg|atlas|label|xfm)(?:_|\.)/i.test(name)) return false
    return true
  })
  candidates.sort((a, b) => {
    const score = (f) => (/_desc-preproc_T1w\.nii(?:\.gz)?$/i.test(path.basename(f)) ? 0 : 1)
    return score(a) - score(b) || path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: 'base' })
  })
  return candidates[0] ?? null
}
function buildTemplateManifest(anatFiles, fileUrl) {
  const discovered = discoverTemplateTransforms(anatFiles)
  const result = {}
  for (const entry of [...discovered.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))) {
    const reference = findTemplateReference(anatFiles, entry.name)
    result[entry.name] = {
      import: entry.importToT1w ? { enabled: true, transform: fileUrl(entry.importToT1w) } : { enabled: false, reason: `No from-${entry.name}_to-T1w NIfTI transform found` },
      export:
        entry.exportFromT1w && reference
          ? { enabled: true, transform: fileUrl(entry.exportFromT1w), reference: fileUrl(reference) }
          : { enabled: false, reason: !entry.exportFromT1w ? `No from-T1w_to-${entry.name} NIfTI transform found` : `No space-${entry.name} anatomical T1w reference found` },
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

// Build the per-subject manifest of /brainana-data URLs.
//   outputRoot — the data-source root
//   subjectDir — absolute path to the sub-* directory
//   fileUrl    — (absPath) => URL string | null, injected by the data source so URLs
//                are source-scoped; returns null for paths outside the root.
export function buildManifest({ outputRoot, subjectDir, fileUrl }) {
  const subjectId = path.basename(subjectDir)
  const resolved = resolveAnatDir(subjectDir)
  if (!resolved) throw new Error('Subject has no anat directory')
  const { anatDir: anat, session } = resolved
  const anatFiles = filesIn(anat)
  const t1Atlas = path.join(anat, 'atlas_space-T1w')
  const scannerAtlas = path.join(anat, 'atlas_space-scanner')
  const atlasDir = exists(t1Atlas) ? t1Atlas : scannerAtlas
  const atlasFiles = filesIn(atlasDir)
  const anatomy = pick(anatFiles, [
    /space-T1w_desc-preproc_T1w_brain\.nii\.gz$/i,
    /space-T1w_desc-preproc_T1w\.nii\.gz$/i,
    /desc-preproc_T1w\.nii\.gz$/i,
    /desc-preproc_brain\.nii\.gz$/i,
    /space-scanner_T1w\.nii\.gz$/i,
  ])
  const fsDir = resolveFsDir(outputRoot, subjectId, session)
  const surfDir = path.join(fsDir, 'surf')
  const derived = ensureDerivedAssets(outputRoot, subjectId, fsDir)

  // Selectable base volumes: the preprocessed T1w plus the FreeSurfer mri/*.mgz volumes.
  const mriDir = path.join(fsDir, 'mri')
  const volumes = []
  if (anatomy) volumes.push({ key: 'anat', label: 'T1w (preproc)', url: fileUrl(anatomy) })
  if (isDir(mriDir)) {
    for (const name of fs
      .readdirSync(mriDir)
      .filter((n) => /\.mgz$/i.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))) {
      volumes.push({ key: `mri/${name}`, label: name.replace(/\.mgz$/i, ''), url: fileUrl(path.join(mriDir, name)) })
    }
  }
  // Precomputed surface (fsnative) maps: per-hemisphere .func.gii projected by the pipeline —
  // no client-side volume→surface projection needed.
  const fsnativeFiles = filesIn(path.join(anat, 'atlas_space-fsnative'))
  const surfacePairFor = (base) => {
    const l = pick(fsnativeFiles, [new RegExp(`${base}_space-fsnative_hemi-L.*\\.func\\.gii$`, 'i')])
    const r = pick(fsnativeFiles, [new RegExp(`${base}_space-fsnative_hemi-R.*\\.func\\.gii$`, 'i')])
    return l && r ? { left: fileUrl(l), right: fileUrl(r) } : null
  }

  // Each atlas: its label volume + the .tsv LUT sidecar + the precomputed surface pair.
  const atlasEntry = (base, volFile, lutFile) => (volFile ? { volume: fileUrl(volFile), labels: lutFile ? fileUrl(lutFile) : null, surface: surfacePairFor(base) } : null)
  const atlas = {}
  for (let i = 1; i <= 6; i++) {
    atlas[i] = atlasEntry(
      `atlas-ARM${i}`,
      pick(atlasFiles, [new RegExp(`atlas-ARM${i}.*\\.nii\\.gz$`, 'i')]),
      pick(atlasFiles, [new RegExp(`atlas-ARM${i}\\.tsv$`, 'i')]),
    )
  }
  const d99 = atlasEntry('atlas-D99', pick(atlasFiles, [/atlas-D99.*\.nii\.gz$/i]), pick(atlasFiles, [/atlas-D99\.tsv$/i]))
  const retino = pickFunctionalMap(anat, atlasFiles, /^atlas-retinotopy_space-T1w_.*\.nii(?:\.gz)?$/i)
  const somato = pickFunctionalMap(anat, atlasFiles, /^atlas-somatotopy_space-T1w_.*\.nii(?:\.gz)?$/i)
  const scannerReference = pick(anatFiles, [/space-scanner_T1w\.nii\.gz$/i])
  const scannerToT1w = pick(anatFiles, [/from-scanner_to-T1w_mode-image_xfm\.mat$/i])
  const templates = buildTemplateManifest(anatFiles, fileUrl)
  const surfacePair = (name, preferGii = false) => {
    const l = preferGii && exists(path.join(surfDir, `lh.${name}.surf.gii`)) ? path.join(surfDir, `lh.${name}.surf.gii`) : path.join(surfDir, `lh.${name}`)
    const r = preferGii && exists(path.join(surfDir, `rh.${name}.surf.gii`)) ? path.join(surfDir, `rh.${name}.surf.gii`) : path.join(surfDir, `rh.${name}`)
    return exists(l) && exists(r) ? { left: fileUrl(l), right: fileUrl(r) } : null
  }
  // Derived (server-generated) display surfaces: only emit when BOTH hemisphere files are
  // actually present on disk, so a stale/failed cache entry never becomes a phantom dropdown
  // option that 404s on load.
  const derivedPair = (kind) => {
    const l = derived.displaySurfaces?.[`lh.${kind}`]
    const r = derived.displaySurfaces?.[`rh.${kind}`]
    return l && r && exists(l) && exists(r) ? { left: fileUrl(l), right: fileUrl(r) } : null
  }
  return {
    id: subjectId,
    label: subjectId.replace(/^sub-/, ''),
    session,
    relativePath: path.relative(outputRoot, subjectDir),
    anatomy: fileUrl(anatomy),
    volumes,
    // atlas[i] / d99 are already { volume, labels } objects (or null) from atlasEntry —
    // emit them directly; do NOT re-wrap in fileUrl (that would pass an object to path.relative).
    atlases: { charm: atlas, d99 },
    function: {
      retinotopy: retino ? { combined: fileUrl(retino), frames: { polar: 0, polarF: 1, eccentricity: 2, eccentricityF: 3 }, surface: surfacePairFor('atlas-retinotopy') } : null,
      somatotopy: somato ? { combined: fileUrl(somato), frames: { phase: 0, fstat: 1 }, surface: surfacePairFor('atlas-somatotopy') } : null,
    },
    transforms: {
      scanner: scannerReference && scannerToT1w ? { reference: fileUrl(scannerReference), outputToT1wAffine: fileUrl(scannerToT1w) } : null,
      templates,
      nmt2sym: templates.NMT2Sym?.export?.enabled
        ? {
            reference: templates.NMT2Sym.export.reference,
            outputToT1wWarp: templates.NMT2Sym.export.transform,
            inputToT1wWarp: templates.NMT2Sym.import?.enabled ? templates.NMT2Sym.import.transform : null,
          }
        : null,
    },
    surfaces: {
      pial: surfacePair('pial', true),
      smoothwm: surfacePair('smoothwm'),
      inflated: derivedPair('inflated'),
      veryinflated: derivedPair('veryinflated'),
      sphere: derivedPair('sphere'),
      white: surfacePair('white', true),
    },
    morphology: {
      raw: {
        curvature: { left: fileUrl(path.join(surfDir, 'lh.curv')), right: fileUrl(path.join(surfDir, 'rh.curv')) },
        sulc: { left: fileUrl(path.join(surfDir, 'lh.sulc')), right: fileUrl(path.join(surfDir, 'rh.sulc')) },
        thickness: { left: fileUrl(path.join(surfDir, 'lh.thickness')), right: fileUrl(path.join(surfDir, 'rh.thickness')) },
      },
      shape: {
        curvature: { left: fileUrl(derived.shapes?.['lh.curv']), right: fileUrl(derived.shapes?.['rh.curv']) },
        sulc: { left: fileUrl(derived.shapes?.['lh.sulc']), right: fileUrl(derived.shapes?.['rh.sulc']) },
        thickness: { left: fileUrl(derived.shapes?.['lh.thickness']), right: fileUrl(derived.shapes?.['rh.thickness']) },
      },
    },
    capabilities: {
      volume: Boolean(anatomy),
      surfaces: Boolean(surfacePair('pial', true)),
      atlases: Boolean(Object.values(atlas).some(Boolean) || d99),
      retinotopy: Boolean(retino),
      somatotopy: Boolean(somato),
    },
  }
}
