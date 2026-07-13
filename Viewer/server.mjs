import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { SshFilesystem } from './remote-filesystem.mjs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const requireHttp = http
const requireHttps = https
const args = process.argv.slice(2)
function argValue(name) {
  const eq = args.find((v) => v.startsWith(`${name}=`))
  if (eq) return eq.slice(name.length + 1)
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const outputArg = argValue('--output-dir') || process.env.BRAINANA_OUTPUT_DIR
let outputRoot = outputArg ? path.resolve(outputArg) : null
const sshTarget = argValue('--ssh-target') || process.env.BRAINANA_SSH_TARGET
const sshControl = argValue('--ssh-control') || process.env.BRAINANA_SSH_CONTROL
const remoteRoot = argValue('--remote-root') || process.env.BRAINANA_REMOTE_ROOT
const cacheArg = argValue('--cache-dir') || process.env.BRAINANA_CACHE_DIR
const sshMode = Boolean(sshTarget && sshControl && remoteRoot)
const localCacheRoot = path.resolve(cacheArg || path.join(os.homedir(), 'Library', 'Caches', 'Brainana Viewer', '2.1.1'))
const remoteFs = sshMode ? new SshFilesystem({ target: sshTarget, controlSocket: sshControl, root: remoteRoot, cacheRoot: localCacheRoot }) : null
const remoteMirrorMap = new Map()
let remoteMonkeyCache = null
if (sshMode) { outputRoot = path.join(localCacheRoot, 'mirror'); fs.mkdirSync(outputRoot, { recursive: true }) }
const port = Number(argValue('--port') || process.env.PORT || 5173)
const remoteBaseArg = argValue('--remote-base') || process.env.BRAINANA_REMOTE_BASE
const remoteBase = remoteBaseArg ? new URL(remoteBaseArg) : null
const mode = argValue('--mode') || (sshMode ? 'workstation' : remoteBase ? 'proxy' : 'local')
const APP_VERSION = '2.1.1'
const BUILD_ID = '2026-07-13-modal-stacking-1'


function mirrorLocalPath(relative) {
  const clean = remoteFs.cleanRelative(relative)
  const local = path.resolve(outputRoot, ...clean.split('/').filter(Boolean))
  if (!isWithin(outputRoot, local)) throw new Error('Mirror path outside cache')
  return local
}
function addRemotePlaceholder(entry) {
  const local = mirrorLocalPath(entry.relativePath)
  if (entry.type === 'directory') fs.mkdirSync(local, { recursive: true })
  else if (entry.type === 'file') {
    fs.mkdirSync(path.dirname(local), { recursive: true })
    if (!exists(local)) fs.closeSync(fs.openSync(local, 'a'))
    remoteMirrorMap.set(local, entry.relativePath)
  }
  return local
}
function clearRemoteMirrorPrefix(relativePrefix) {
  const prefix = mirrorLocalPath(relativePrefix)
  for (const key of [...remoteMirrorMap.keys()]) if (key === prefix || key.startsWith(`${prefix}${path.sep}`)) remoteMirrorMap.delete(key)
  fs.rmSync(prefix, { recursive: true, force: true })
}
function materializeRemoteSubject(subjectId) {
  if (!remoteFs) return
  const subjectRel = subjectId
  const anatRel = `${subjectRel}/anat`
  if (!remoteFs.exists(anatRel, 'directory')) throw new Error('Monkey not found')
  clearRemoteMirrorPrefix(subjectRel)
  clearRemoteMirrorPrefix(`fastsurfer/${subjectId}`)
  fs.mkdirSync(mirrorLocalPath(anatRel), { recursive: true })
  for (const entry of remoteFs.list(anatRel, { recursive: true, maxDepth: 5 })) addRemotePlaceholder(entry)
  const fsRel = `fastsurfer/${subjectId}`
  if (remoteFs.exists(fsRel, 'directory')) {
    for (const entry of remoteFs.list(fsRel, { recursive: true, maxDepth: 3 })) addRemotePlaceholder(entry)
    const surfRel = `${fsRel}/surf`
    if (remoteFs.exists(surfRel, 'directory')) {
      const needed = new Set(['lh.pial','rh.pial','lh.pial.surf.gii','rh.pial.surf.gii','lh.white','rh.white','lh.white.surf.gii','rh.white.surf.gii','lh.smoothwm','rh.smoothwm','lh.inflated','rh.inflated','lh.sphere','rh.sphere','lh.curv','rh.curv','lh.sulc','rh.sulc','lh.thickness','rh.thickness'])
      for (const entry of remoteFs.list(surfRel, { maxDepth: 1 })) {
        if (entry.type !== 'file' || !needed.has(entry.name)) continue
        const local = mirrorLocalPath(entry.relativePath)
        const cached = remoteFs.ensureCached(entry.relativePath)
        fs.mkdirSync(path.dirname(local), { recursive: true })
        fs.copyFileSync(cached, local)
        remoteMirrorMap.set(local, entry.relativePath)
      }
    }
  }
}
function remoteAutoMonkeys() {
  if (!remoteFs) return []
  if (remoteMonkeyCache) return remoteMonkeyCache
  const entries = remoteFs.list('', { recursive: true, maxDepth: 2 })
  const dirs = new Set(entries.filter((e) => e.type === 'directory').map((e) => e.relativePath))
  remoteMonkeyCache = [...dirs].filter((rel) => /^sub-[^/]+$/.test(rel) && dirs.has(`${rel}/anat`))
    .map((id) => ({ id, label: id.replace(/^sub-/, ''), relativePath: id }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return remoteMonkeyCache
}
function ensureRemoteLocalFile(absPath) {
  const remoteRelative = remoteMirrorMap.get(absPath)
  if (!remoteRelative) return absPath
  return remoteFs.ensureCached(remoteRelative)
}
function remoteDirectoryListing(relativePath = '') {
  const clean = remoteFs.cleanRelative(relativePath)
  if (!remoteFs.exists(clean, 'directory')) throw new Error('Directory not found inside configured output root')
  const entries = remoteFs.list(clean, { maxDepth: 1 }).filter((e) => e.type === 'directory' && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: e.relativePath, isMonkey: e.name.startsWith('sub-') && remoteFs.exists(`${e.relativePath}/anat`, 'directory') }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  const parent = clean ? path.posix.dirname(clean) : null
  return { path: clean, displayPath: clean ? `/${clean}` : '/', parent: parent === '.' ? '' : parent, selectable: path.posix.basename(clean).startsWith('sub-') && remoteFs.exists(`${clean}/anat`, 'directory'), entries }
}
function remoteImportFileListing(relativePath = '', query = '') {
  const clean = remoteFs.cleanRelative(relativePath)
  if (!remoteFs.exists(clean, 'directory')) throw new Error('Directory not found inside configured output root')
  const needle = String(query || '').trim().toLowerCase()
  const entries = remoteFs.list(clean, { maxDepth: 1 }).filter((e) => !e.name.startsWith('.') && (!needle || e.name.toLowerCase().includes(needle)))
    .map((e) => ({ name: e.name, path: e.relativePath, type: e.type === 'directory' ? 'directory' : 'file', size: e.size }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.type === 'directory' ? -1 : 1))
  const parent = clean ? path.posix.dirname(clean) : null
  return { path: clean, displayPath: clean ? `/${clean}` : '/', parent: parent === '.' ? '' : parent, entries }
}

function isWithin(root, candidate) {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
function exists(p) { try { return fs.existsSync(p) } catch { return false } }
function filesIn(dir) {
  if (!exists(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => path.join(dir, e.name))
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
function fileUrl(absPath) {
  if (!absPath) return null
  if (!outputRoot || !isWithin(outputRoot, absPath)) return null
  // Preserve the real filename extension in the URL path. NiiVue uses the
  // URL suffix to select the correct mesh/overlay parser (e.g. .gii, .curv,
  // FreeSurfer surface names). A generic query-string endpoint caused volume
  // files to load but left mesh format detection undefined.
  const relative = path.relative(outputRoot, absPath)
  const encoded = relative.split(path.sep).map(encodeURIComponent).join('/')
  return `/brainana-data/${encoded}`
}

function parseFsMorphology(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const readUint24 = (offset) => (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2)
  const magic = readUint24(0)
  if (magic === 0xffffff) {
    const vertexCount = view.getInt32(3, false)
    const valuesPerVertex = view.getInt32(11, false)
    let offset = 15
    const values = new Float32Array(vertexCount)
    for (let i = 0; i < vertexCount; i++) { values[i] = view.getFloat32(offset, false); offset += 4 * valuesPerVertex }
    return values
  }
  const vertexCount = magic
  let offset = 6
  const values = new Float32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) { values[i] = view.getInt16(offset, false) / 100; offset += 2 }
  return values
}
function giftiShape(values) {
  const bytes = Buffer.alloc(values.length * 4)
  for (let i = 0; i < values.length; i++) bytes.writeFloatLE(values[i], i * 4)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<GIFTI Version="1.0" NumberOfDataArrays="1">\n  <MetaData/>\n  <LabelTable/>\n  <DataArray Intent="NIFTI_INTENT_SHAPE" DataType="NIFTI_TYPE_FLOAT32" ArrayIndexingOrder="RowMajorOrder" Dimensionality="1" Dim0="${values.length}" Encoding="Base64Binary" Endian="LittleEndian" ExternalFileName="" ExternalFileOffset="">\n    <MetaData/>\n    <CoordinateSystemTransformMatrix><DataSpace>NIFTI_XFORM_UNKNOWN</DataSpace><TransformedSpace>NIFTI_XFORM_UNKNOWN</TransformedSpace><MatrixData>1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</MatrixData></CoordinateSystemTransformMatrix>\n    <Data>${bytes.toString('base64')}</Data>\n  </DataArray>\n</GIFTI>\n`
}
function readFsSurface(buffer) {
  let offset = 0
  const magic = (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2]; offset += 3
  if (magic !== 0xfffffe) throw new Error('Unsupported FreeSurfer surface format')
  const nl1 = buffer.indexOf(10, offset); offset = nl1 + 1
  const nl2 = buffer.indexOf(10, offset); offset = nl2 + 1
  const vertexCount = buffer.readInt32BE(offset); offset += 4
  const faceCount = buffer.readInt32BE(offset); offset += 4
  const verticesOffset = offset
  const vertices = new Float32Array(vertexCount * 3)
  for (let i = 0; i < vertices.length; i++) { vertices[i] = buffer.readFloatBE(offset); offset += 4 }
  return { magic, vertexCount, faceCount, verticesOffset, vertices }
}
function surfaceXBounds(points) {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i]
    if (x < min) min = x
    if (x > max) max = x
  }
  return { min, max, width: max - min }
}
function writeFsSurface(input, parsed, points, dest) {
  const output = Buffer.from(input)
  let offset = parsed.verticesOffset
  for (const value of points) { output.writeFloatBE(value, offset); offset += 4 }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, output)
}
function transformFsSurfacePair(leftSrc, rightSrc, leftDest, rightDest, kind) {
  const leftInput = fs.readFileSync(leftSrc)
  const rightInput = fs.readFileSync(rightSrc)
  const leftParsed = readFsSurface(leftInput)
  const rightParsed = readFsSurface(rightInput)
  const left = new Float32Array(leftParsed.vertices)
  const right = new Float32Array(rightParsed.vertices)
  const radial = kind === 'veryinflated' ? 1.13 : 1

  for (const points of [left, right]) {
    let cx = 0, cy = 0, cz = 0
    const count = points.length / 3
    for (let i = 0; i < points.length; i += 3) {
      cx += points[i]; cy += points[i + 1]; cz += points[i + 2]
    }
    cx /= count; cy /= count; cz /= count
    for (let i = 0; i < points.length; i += 3) {
      points[i] = cx + (points[i] - cx) * radial
      points[i + 1] = cy + (points[i + 1] - cy) * radial + 6
      points[i + 2] = cz + (points[i + 2] - cz) * radial
    }
  }

  const leftBounds = surfaceXBounds(left)
  const rightBounds = surfaceXBounds(right)
  const referenceWidth = Math.max(1, Math.min(leftBounds.width, rightBounds.width))
  const desiredGap = Math.max(4, Math.min(12, referenceWidth * 0.06))

  const leftShift = -desiredGap / 2 - leftBounds.max
  const rightShift = desiredGap / 2 - rightBounds.min
  for (let i = 0; i < left.length; i += 3) left[i] += leftShift
  for (let i = 0; i < right.length; i += 3) right[i] += rightShift

  const finalLeft = surfaceXBounds(left)
  const finalRight = surfaceXBounds(right)
  const pairCenter = (Math.min(finalLeft.min, finalRight.min) + Math.max(finalLeft.max, finalRight.max)) / 2
  for (let i = 0; i < left.length; i += 3) left[i] -= pairCenter
  for (let i = 0; i < right.length; i += 3) right[i] -= pairCenter

  writeFsSurface(leftInput, leftParsed, left, leftDest)
  writeFsSurface(rightInput, rightParsed, right, rightDest)
}

function ensureDerivedAssets(subjectId, fsDir) {
  if (!fsDir || !exists(fsDir)) return {}
  const surf = path.join(fsDir, 'surf')
  const cache = path.join(outputRoot, '.brainana-viewer-cache', 'surface-spacing-v2', subjectId)
  fs.mkdirSync(cache, { recursive: true })
  const result = { shapes: {}, displaySurfaces: {} }

  for (const hemi of ['lh', 'rh']) {
    for (const metric of ['curv', 'sulc', 'thickness']) {
      const src = path.join(surf, `${hemi}.${metric}`)
      if (!exists(src)) continue
      const dest = path.join(cache, `${hemi}.${metric}.shape.gii`)
      if (!exists(dest) || fs.statSync(dest).mtimeMs < fs.statSync(src).mtimeMs) {
        const values = parseFsMorphology(fs.readFileSync(src))
        fs.writeFileSync(dest, giftiShape(values))
      }
      result.shapes[`${hemi}.${metric}`] = dest
    }
  }

  const leftInflated = path.join(surf, 'lh.inflated')
  const rightInflated = path.join(surf, 'rh.inflated')
  if (exists(leftInflated) && exists(rightInflated)) {
    for (const kind of ['inflated', 'veryinflated']) {
      const leftDest = path.join(cache, kind, 'lh.inflated')
      const rightDest = path.join(cache, kind, 'rh.inflated')
      const sourceMtime = Math.max(fs.statSync(leftInflated).mtimeMs, fs.statSync(rightInflated).mtimeMs)
      if (!exists(leftDest) || !exists(rightDest) || fs.statSync(leftDest).mtimeMs < sourceMtime || fs.statSync(rightDest).mtimeMs < sourceMtime) {
        transformFsSurfacePair(leftInflated, rightInflated, leftDest, rightDest, kind)
      }
      result.displaySurfaces[`lh.${kind}`] = leftDest
      result.displaySurfaces[`rh.${kind}`] = rightDest
    }
  }

  const leftSphere = path.join(surf, 'lh.sphere')
  const rightSphere = path.join(surf, 'rh.sphere')
  if (exists(leftSphere) && exists(rightSphere)) {
    const leftDest = path.join(cache, 'sphere', 'lh.sphere')
    const rightDest = path.join(cache, 'sphere', 'rh.sphere')
    const sourceMtime = Math.max(fs.statSync(leftSphere).mtimeMs, fs.statSync(rightSphere).mtimeMs)
    if (!exists(leftDest) || !exists(rightDest) || fs.statSync(leftDest).mtimeMs < sourceMtime || fs.statSync(rightDest).mtimeMs < sourceMtime) {
      transformFsSurfacePair(leftSphere, rightSphere, leftDest, rightDest, 'sphere')
    }
    result.displaySurfaces['lh.sphere'] = leftDest
    result.displaySurfaces['rh.sphere'] = rightDest
  }
  return result
}

function directoryListing(relativePath = '') {
  if (!outputRoot) throw new Error('No output directory configured')
  const current = path.resolve(outputRoot, relativePath || '.')
  if (!isWithin(outputRoot, current) || !exists(current) || !fs.statSync(current).isDirectory()) {
    throw new Error('Directory not found inside the configured output root')
  }
  const relative = path.relative(outputRoot, current)
  const parent = relative ? path.dirname(relative) : null
  const entries = fs.readdirSync(current, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => {
      const abs = path.join(current, entry.name)
      return {
        name: entry.name,
        path: path.relative(outputRoot, abs),
        isMonkey: entry.name.startsWith('sub-') && exists(path.join(abs, 'anat')),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  return {
    path: relative,
    displayPath: relative ? `/${relative.split(path.sep).join('/')}` : '/',
    parent: parent === '.' ? '' : parent,
    selectable: path.basename(current).startsWith('sub-') && exists(path.join(current, 'anat')),
    entries,
  }
}

function importFileListing(relativePath = '', query = '') {
  if (!outputRoot) throw new Error('No output directory configured')
  const current = path.resolve(outputRoot, relativePath || '.')
  if (!isWithin(outputRoot, current) || !exists(current) || !fs.statSync(current).isDirectory()) throw new Error('Directory not found inside the configured output root')
  const relative = path.relative(outputRoot, current)
  const parent = relative ? path.dirname(relative) : null
  const needle = String(query || '').trim().toLowerCase()
  const entries = fs.readdirSync(current, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .filter((entry) => entry.isDirectory() || /\.nii(?:\.gz)?$/i.test(entry.name))
    .filter((entry) => !needle || entry.name.toLowerCase().includes(needle))
    .map((entry) => {
      const abs = path.join(current, entry.name)
      const isDirectory = entry.isDirectory()
      return { name: entry.name, path: path.relative(outputRoot, abs), isDirectory, size: isDirectory ? null : fs.statSync(abs).size, url: isDirectory ? null : fileUrl(abs) }
    })
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  return { path: relative, displayPath: relative ? `/${relative.split(path.sep).join('/')}` : '/', parent: parent === '.' ? '' : parent, entries }
}


function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
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
      template = source; direction = 'importToT1w'
    } else if (source.toLowerCase() === 't1w' && !['t1w', 'scanner'].includes(destination.toLowerCase())) {
      template = destination; direction = 'exportFromT1w'
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
    const score = (f) => /_desc-preproc_T1w\.nii(?:\.gz)?$/i.test(path.basename(f)) ? 0 : 1
    return score(a) - score(b) || path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: 'base' })
  })
  return candidates[0] ?? null
}
function buildTemplateManifest(anatFiles) {
  const discovered = discoverTemplateTransforms(anatFiles)
  const result = {}
  for (const entry of [...discovered.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))) {
    const reference = findTemplateReference(anatFiles, entry.name)
    result[entry.name] = {
      import: entry.importToT1w ? { enabled: true, transform: fileUrl(entry.importToT1w) } : { enabled: false, reason: `No from-${entry.name}_to-T1w NIfTI transform found` },
      export: entry.exportFromT1w && reference
        ? { enabled: true, transform: fileUrl(entry.exportFromT1w), reference: fileUrl(reference) }
        : { enabled: false, reason: !entry.exportFromT1w ? `No from-T1w_to-${entry.name} NIfTI transform found` : `No space-${entry.name} anatomical T1w reference found` },
    }
  }
  return result
}

function buildManifest(subjectDir) {
  const subjectId = path.basename(subjectDir)
  const anat = path.join(subjectDir, 'anat')
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
  const fsDir = path.join(outputRoot, 'fastsurfer', subjectId)
  const surfDir = path.join(fsDir, 'surf')
  const derived = ensureDerivedAssets(subjectId, fsDir)
  const atlas = {}
  for (let i = 1; i <= 6; i++) atlas[i] = pick(atlasFiles, [new RegExp(`atlas-ARM${i}.*\\.nii\\.gz$`, 'i')])
  const d99 = pick(atlasFiles, [/atlas-D99.*\.nii\.gz$/i])
  const retino = pickFunctionalMap(anat, atlasFiles, /^atlas-retinotopy_space-T1w_.*\.nii(?:\.gz)?$/i)
  const somato = pickFunctionalMap(anat, atlasFiles, /^atlas-somatotopy_space-T1w_.*\.nii(?:\.gz)?$/i)
  const scannerReference = pick(anatFiles, [/space-scanner_T1w\.nii\.gz$/i])
  const scannerToT1w = pick(anatFiles, [/from-scanner_to-T1w_mode-image_xfm\.mat$/i])
  const templates = buildTemplateManifest(anatFiles)
  const surfacePair = (name, preferGii = false) => {
    const l = preferGii && exists(path.join(surfDir, `lh.${name}.surf.gii`)) ? path.join(surfDir, `lh.${name}.surf.gii`) : path.join(surfDir, `lh.${name}`)
    const r = preferGii && exists(path.join(surfDir, `rh.${name}.surf.gii`)) ? path.join(surfDir, `rh.${name}.surf.gii`) : path.join(surfDir, `rh.${name}`)
    return exists(l) && exists(r) ? { left: fileUrl(l), right: fileUrl(r) } : null
  }
  return {
    id: subjectId,
    label: subjectId.replace(/^sub-/, ''),
    relativePath: path.relative(outputRoot, subjectDir),
    anatomy: fileUrl(anatomy),
    atlases: { charm: Object.fromEntries(Object.entries(atlas).map(([k, v]) => [k, fileUrl(v)])), d99: fileUrl(d99) },
    function: {
      retinotopy: retino ? { combined: fileUrl(retino), frames: { polar: 0, polarF: 1, eccentricity: 2, eccentricityF: 3 } } : null,
      somatotopy: somato ? { combined: fileUrl(somato), frames: { phase: 0, fstat: 1 } } : null,
    },
    transforms: {
      scanner: scannerReference && scannerToT1w ? { reference: fileUrl(scannerReference), outputToT1wAffine: fileUrl(scannerToT1w) } : null,
      templates,
      nmt2sym: templates.NMT2Sym?.export?.enabled ? {
        reference: templates.NMT2Sym.export.reference,
        outputToT1wWarp: templates.NMT2Sym.export.transform,
        inputToT1wWarp: templates.NMT2Sym.import?.enabled ? templates.NMT2Sym.import.transform : null,
      } : null,
    },
    surfaces: {
      pial: surfacePair('pial', true),
      smoothwm: surfacePair('smoothwm'),
      inflated: derived.displaySurfaces?.['lh.inflated'] ? { left: fileUrl(derived.displaySurfaces['lh.inflated']), right: fileUrl(derived.displaySurfaces['rh.inflated']) } : null,
      veryinflated: derived.displaySurfaces?.['lh.veryinflated'] ? { left: fileUrl(derived.displaySurfaces['lh.veryinflated']), right: fileUrl(derived.displaySurfaces['rh.veryinflated']) } : null,
      sphere: derived.displaySurfaces?.['lh.sphere'] ? { left: fileUrl(derived.displaySurfaces['lh.sphere']), right: fileUrl(derived.displaySurfaces['rh.sphere']) } : null,
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
    capabilities: { volume: Boolean(anatomy), surfaces: Boolean(surfacePair('pial', true)), atlases: Boolean(Object.values(atlas).some(Boolean) || d99), retinotopy: Boolean(retino), somatotopy: Boolean(somato) },
  }
}
function autoMonkeys() {
  if (remoteFs) return remoteAutoMonkeys()
  if (!outputRoot || !exists(outputRoot)) return []
  return fs.readdirSync(outputRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('sub-') && exists(path.join(outputRoot, e.name, 'anat')))
    .map((e) => ({ id: e.name, label: e.name.replace(/^sub-/, ''), relativePath: e.name }))
    .sort((a, b) => a.id.localeCompare(b.id))
}
async function jsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}
function sendJson(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
function serveFile(req, res, absPath) {
  if (!outputRoot || !isWithin(outputRoot, absPath)) return sendJson(res, 404, { error: 'File not found' })
  try { absPath = ensureRemoteLocalFile(absPath) } catch (error) { return sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) }) }
  if (!exists(absPath) || !fs.statSync(absPath).isFile()) return sendJson(res, 404, { error: 'File not found' })
  const stat = fs.statSync(absPath)
  const range = req.headers.range
  const lower = absPath.toLowerCase()
  const contentType = lower.endsWith('.gii') ? 'application/gifti+xml'
    : lower.endsWith('.nii') ? 'application/octet-stream'
    : lower.endsWith('.nii.gz') ? 'application/gzip'
    : lower.endsWith('.json') ? 'application/json'
    : 'application/octet-stream'
  const headers = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'Content-Type': contentType }
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    const start = m?.[1] ? Number(m[1]) : 0
    const end = m?.[2] ? Number(m[2]) : stat.size - 1
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 })
    fs.createReadStream(absPath, { start, end }).pipe(res)
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': stat.size })
    fs.createReadStream(absPath).pipe(res)
  }
}


function cleanRelativePath(raw) {
  const value = String(raw || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = value.split('/').filter(Boolean)
  if (parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) throw new Error('Invalid path')
  return parts.join('/')
}
function resolveSavePath(raw) {
  if (!outputRoot) throw new Error('No output directory configured')
  const clean = cleanRelativePath(raw)
  const resolved = path.resolve(outputRoot, ...clean.split('/').filter(Boolean))
  if (!isWithin(outputRoot, resolved)) throw new Error('Path is outside the configured output root')
  return { clean, resolved }
}
function saveDirectoryListing(raw) {
  const { clean, resolved } = resolveSavePath(raw)
  if (!exists(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('Folder not found')
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '.brainana-viewer-cache')
    .map((entry) => ({ name: entry.name, path: [clean, entry.name].filter(Boolean).join('/') }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  return { path: clean, entries }
}
async function writeRequestFile(req, destination, overwrite) {
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  if (!overwrite && exists(destination)) return { exists: true }
  const temp = `${destination}.brainana-partial-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(temp, { flags: 'wx' })
      req.on('error', reject)
      out.on('error', reject)
      out.on('finish', resolve)
      req.pipe(out)
    })
    if (!overwrite && exists(destination)) { await fsp.unlink(temp).catch(() => {}); return { exists: true } }
    await fsp.rename(temp, destination)
    return { exists: false, bytes: fs.statSync(destination).size }
  } catch (error) {
    await fsp.unlink(temp).catch(() => {})
    throw error
  }
}


function proxyRequest(req, res, url) {
  if (!remoteBase) return false
  const target = new URL(url.pathname + url.search, remoteBase)
  const transport = target.protocol === 'https:' ? requireHttps : requireHttp
  const headers = { ...req.headers, host: target.host }
  const proxy = transport.request(target, { method: req.method, headers }, (upstream) => {
    res.writeHead(upstream.statusCode || 502, upstream.headers)
    upstream.pipe(res)
  })
  proxy.on('error', (error) => {
    console.error('Remote data proxy error:', error)
    if (!res.headersSent) sendJson(res, 502, { error: `Remote data server unavailable: ${error.message}` })
    else res.destroy(error)
  })
  req.pipe(proxy)
  return true
}

const distRoot = path.join(here, 'dist')

function staticContentType(absPath) {
  const lower = absPath.toLowerCase()
  if (lower.endsWith('.html')) return 'text/html; charset=utf-8'
  if (lower.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8'
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.ico')) return 'image/x-icon'
  if (lower.endsWith('.wasm')) return 'application/wasm'
  return 'application/octet-stream'
}

function serveStatic(res, pathname) {
  let decoded
  try { decoded = decodeURIComponent(pathname) } catch { return false }
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  let abs = path.resolve(distRoot, rel)
  if (!isWithin(distRoot, abs) || !exists(abs) || !fs.statSync(abs).isFile()) {
    abs = path.join(distRoot, 'index.html')
  }
  if (!exists(abs) || !fs.statSync(abs).isFile()) return false
  const stat = fs.statSync(abs)
  res.writeHead(200, {
    'Content-Type': staticContentType(abs),
    'Content-Length': stat.size,
    'Cache-Control': abs.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600'
  })
  fs.createReadStream(abs).pipe(res)
  return true
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, app: 'brainana-viewer', version: APP_VERSION, buildId: BUILD_ID, mode })
    if (url.pathname === '/api/runtime') return sendJson(res, 200, { app: 'brainana-viewer', version: APP_VERSION, buildId: BUILD_ID, mode, workstation: mode === 'workstation' || mode === 'proxy', capabilities: { serverSideExport: mode === 'workstation' || mode === 'proxy', localDirectoryPicker: mode === 'local', remoteRuntime: false } })
    if (url.pathname === '/api/version') return sendJson(res, 200, { app: 'brainana-viewer', version: APP_VERSION, buildId: BUILD_ID })
    if (remoteBase && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/brainana-data/') || url.pathname === '/brainana-file')) {
      proxyRequest(req, res, url)
      return
    }
    if (url.pathname === '/api/save-list' && req.method === 'GET') {
      try { return sendJson(res, 200, remoteFs ? remoteDirectoryListing(url.searchParams.get('path') || '') : saveDirectoryListing(url.searchParams.get('path') || '')) }
      catch (error) { return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }) }
    }
    if (url.pathname === '/api/save-mkdir' && req.method === 'POST') {
      try {
        const body = await jsonBody(req)
        if (remoteFs) { const clean = remoteFs.mkdir(body.path || ''); return sendJson(res, 200, { path: clean }) }
        const { clean, resolved } = resolveSavePath(body.path || '')
        await fsp.mkdir(resolved, { recursive: false })
        return sendJson(res, 200, { path: clean })
      } catch (error) {
        const code = error?.code === 'EEXIST' ? 409 : 400
        return sendJson(res, code, { error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (url.pathname === '/api/save-file' && req.method === 'POST') {
      try {
        const requested = url.searchParams.get('path') || ''
        const overwrite = url.searchParams.get('overwrite') === '1'
        if (remoteFs) {
          const clean = remoteFs.cleanRelative(requested)
          if (!clean) return sendJson(res, 400, { error: 'A filename is required' })
          const result = await remoteFs.writeStream(clean, req, { overwrite })
          if (result.exists) return sendJson(res, 409, { error: 'File already exists', path: clean })
          return sendJson(res, 200, { path: clean, bytes: result.bytes })
        }
        const { clean, resolved } = resolveSavePath(requested)
        if (!clean) return sendJson(res, 400, { error: 'A filename is required' })
        const result = await writeRequestFile(req, resolved, overwrite)
        if (result.exists) return sendJson(res, 409, { error: 'File already exists', path: clean })
        return sendJson(res, 200, { path: clean, bytes: result.bytes })
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (url.pathname === '/api/mode') return sendJson(res, 200, { mode })
    if (url.pathname === '/api/config') return sendJson(res, 200, { outputRoot: remoteFs ? remoteRoot : outputRoot, configured: Boolean(outputRoot), monkeys: autoMonkeys(), mode, version: APP_VERSION, buildId: BUILD_ID })
    if (url.pathname === '/api/monkeys') return sendJson(res, 200, autoMonkeys())
    if (url.pathname.startsWith('/api/monkeys/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/monkeys/'.length))
      if (remoteFs) materializeRemoteSubject(id)
      const dir = path.join(outputRoot || '', id)
      if (!outputRoot || !isWithin(outputRoot, dir) || !exists(path.join(dir, 'anat'))) return sendJson(res, 404, { error: 'Monkey not found' })
      return sendJson(res, 200, buildManifest(dir))
    }
    if (url.pathname === '/api/directories' && req.method === 'GET') {
      if (!outputRoot) return sendJson(res, 400, { error: 'No output directory configured' })
      try {
        return sendJson(res, 200, remoteFs ? remoteDirectoryListing(url.searchParams.get('path') || '') : directoryListing(url.searchParams.get('path') || ''))
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (url.pathname === '/api/import-files' && req.method === 'GET') {
      if (!outputRoot) return sendJson(res, 400, { error: 'No output directory configured' })
      try { return sendJson(res, 200, remoteFs ? remoteImportFileListing(url.searchParams.get('path') || '', url.searchParams.get('q') || '') : importFileListing(url.searchParams.get('path') || '', url.searchParams.get('q') || '')) }
      catch (error) { return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }) }
    }
    if (url.pathname === '/api/select-monkey' && req.method === 'POST') {
      if (!outputRoot) return sendJson(res, 400, { error: 'No output directory configured' })
      const body = await jsonBody(req)
      const raw = String(body.path || '').trim()
      if (remoteFs) materializeRemoteSubject(raw)
      const dir = path.resolve(outputRoot, raw)
      if (!isWithin(outputRoot, dir) || !exists(path.join(dir, 'anat')) || !path.basename(dir).startsWith('sub-')) return sendJson(res, 400, { error: 'Choose a sub-* directory inside the output root that contains anat/' })
      return sendJson(res, 200, buildManifest(dir))
    }
    if (url.pathname.startsWith('/brainana-data/')) {
      if (!outputRoot) return sendJson(res, 400, { error: 'No output directory configured' })
      const encodedRelative = url.pathname.slice('/brainana-data/'.length)
      const relative = encodedRelative.split('/').map(decodeURIComponent).join(path.sep)
      return serveFile(req, res, path.resolve(outputRoot, relative))
    }
    // Backward-compatible endpoint for any stale browser state from v1.0.0.
    if (url.pathname === '/brainana-file') {
      if (!outputRoot) return sendJson(res, 400, { error: 'No output directory configured' })
      return serveFile(req, res, path.resolve(outputRoot, url.searchParams.get('path') || ''))
    }
    if (!serveStatic(res, url.pathname)) { res.statusCode = 404; res.end('Not found') }
  } catch (error) {
    console.error(error)
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
})
server.listen(port, () => {
  console.log(`Brainana Viewer ${APP_VERSION} (${BUILD_ID})`)
  console.log(`Brainana output: ${remoteFs ? `${sshTarget}:${remoteRoot}` : outputRoot ?? '(not configured)'}`)
  if (remoteFs) console.log('Workstation access: local SSH filesystem adapter (no remote runtime)')
  if (remoteBase) console.log(`Remote data proxy: ${remoteBase.href}`)
  console.log(`Found ${autoMonkeys().length} top-level monkeys`)
  console.log(`Viewer: http://localhost:${port}`)
})
