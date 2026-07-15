// SftpDataSource — a DataSource backed by a remote workstation over ssh2/SFTP.
//
// It keeps the old adapter's shape (a lazily-populated local mirror + on-demand fetch)
// but is non-blocking (async ssh2 instead of spawnSync) and remote-OS-agnostic (SFTP
// subsystem only — no GNU find/stat), addressing finding R4. No code runs on the remote.
//
// Data primitives (listMonkeys / listDirectories / listImportFiles / openFile / save*)
// go straight over SFTP + the async cache. buildManifest materialises the subject into
// the local mirror (placeholders + real surface binaries), then reuses the SAME manifest
// builder as LocalDataSource so the Viewer-domain logic is written once.
import fs from 'node:fs'
import path from 'node:path'
import { contentTypeFor, parseRange } from './dataSource.mjs'
import { cleanRelative, isWithin } from './security.mjs'
import { RemoteFileCache } from './cache.mjs'
import { SftpClient } from './sftpClient.mjs'
import { buildManifest, resolveAnatDir, isSubjectDir } from '../../viewer/server/manifest.mjs'

// FreeSurfer surface/morphology files that must be present as REAL bytes locally so
// ensureDerivedAssets can parse them (everything else is served on demand).
const SURF_FILES = new Set([
  'lh.pial', 'rh.pial', 'lh.pial.surf.gii', 'rh.pial.surf.gii',
  'lh.white', 'rh.white', 'lh.white.surf.gii', 'rh.white.surf.gii',
  'lh.smoothwm', 'rh.smoothwm', 'lh.inflated', 'rh.inflated',
  'lh.sphere', 'rh.sphere', 'lh.curv', 'rh.curv', 'lh.sulc', 'rh.sulc',
  'lh.thickness', 'rh.thickness',
])

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

export class SftpDataSource {
  type = 'remote'

  constructor({ id, label, connection, remoteRoot, cacheRoot } = {}) {
    if (!connection) throw new Error('SftpDataSource requires connection details')
    if (!remoteRoot) throw new Error('SftpDataSource requires a remoteRoot')
    if (!cacheRoot) throw new Error('SftpDataSource requires a cacheRoot')
    this.id = id
    this.label = label || `${connection.username}@${connection.host}:${remoteRoot}`
    this.remoteRoot = String(remoteRoot).replace(/\/+$/, '') || '/'
    this.client = new SftpClient(connection)
    this.mirrorRoot = path.join(cacheRoot, 'mirror')
    this.cache = new RemoteFileCache({ cacheRoot, namespace: `${connection.host}\0${this.remoteRoot}` })
    this.placeholders = new Map() // mirrorAbs -> remote relative path
    this.#monkeyCache = null
    fs.mkdirSync(this.mirrorRoot, { recursive: true })
  }

  #monkeyCache

  async open() {
    await this.client.connect()
    return this
  }

  // ---- path helpers ----
  #remoteAbs(rel) {
    const clean = cleanRelative(rel)
    return clean ? `${this.remoteRoot}/${clean}` : this.remoteRoot
  }
  #mirrorAbs(rel) {
    const clean = cleanRelative(rel)
    const abs = path.resolve(this.mirrorRoot, ...clean.split('/').filter(Boolean))
    if (!isWithin(this.mirrorRoot, abs)) throw new Error('Mirror path outside cache')
    return abs
  }

  // Mirror-absolute path → source-scoped URL.
  fileUrl(absPath) {
    if (!absPath) return null
    if (!isWithin(this.mirrorRoot, absPath)) return null
    const relative = path.relative(this.mirrorRoot, absPath)
    const encoded = relative.split(path.sep).map(encodeURIComponent).join('/')
    return `/brainana-data/${this.id}/${encoded}`
  }

  // ---- discovery ----
  async listMonkeys() {
    if (this.#monkeyCache) return this.#monkeyCache
    const entries = await this.client.list(this.remoteRoot)
    const monkeys = []
    for (const entry of entries) {
      if (entry.type !== 'directory' || !entry.name.startsWith('sub-')) continue
      if (await this.#remoteIsSubject(entry.name)) {
        monkeys.push({ id: entry.name, label: entry.name.replace(/^sub-/, ''), relativePath: entry.name })
      }
    }
    monkeys.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' }))
    this.#monkeyCache = monkeys
    return monkeys
  }

  // A remote sub-* is a subject if it has anat directly or under a ses-*.
  async #remoteIsSubject(subjectId) {
    if (await this.client.exists(`${this.#remoteAbs(subjectId)}/anat`)) return true
    const sub = await this.client.list(this.#remoteAbs(subjectId)).catch(() => [])
    for (const e of sub) {
      if (e.type === 'directory' && /^ses-/.test(e.name) && (await this.client.exists(`${this.#remoteAbs(subjectId)}/${e.name}/anat`))) return true
    }
    return false
  }

  async listDirectories(rel = '') {
    const clean = cleanRelative(rel)
    const entries = (await this.client.list(this.#remoteAbs(clean)))
      .filter((e) => e.type === 'directory' && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: [clean, e.name].filter(Boolean).join('/'), isMonkey: e.name.startsWith('sub-') }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    const parent = clean ? path.posix.dirname(clean) : null
    return {
      path: clean,
      displayPath: clean ? `/${clean}` : '/',
      parent: parent === '.' ? '' : parent,
      selectable: clean ? path.posix.basename(clean).startsWith('sub-') && (await this.#remoteIsSubject(clean)) : false,
      entries,
    }
  }

  async listImportFiles(rel = '', query = '') {
    const clean = cleanRelative(rel)
    const needle = String(query || '').trim().toLowerCase()
    const entries = (await this.client.list(this.#remoteAbs(clean)))
      .filter((e) => !e.name.startsWith('.') && (e.type === 'directory' || /\.nii(?:\.gz)?$/i.test(e.name)))
      .filter((e) => !needle || e.name.toLowerCase().includes(needle))
      .map((e) => {
        const p = [clean, e.name].filter(Boolean).join('/')
        const isDirectory = e.type === 'directory'
        return { name: e.name, path: p, isDirectory, size: isDirectory ? null : e.size, url: isDirectory ? null : `/brainana-data/${this.id}/${p.split('/').map(encodeURIComponent).join('/')}` }
      })
      .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    const parent = clean ? path.posix.dirname(clean) : null
    return { path: clean, displayPath: clean ? `/${clean}` : '/', parent: parent === '.' ? '' : parent, entries }
  }

  // ---- file serving ----
  async openFile(rel, rangeHeader) {
    const clean = cleanRelative(rel)
    const mirrorAbs = this.#mirrorAbs(clean)
    // Derived assets and materialised surface binaries live as REAL files in the mirror.
    if (exists(mirrorAbs) && !this.placeholders.has(mirrorAbs) && fs.statSync(mirrorAbs).isFile()) {
      const total = fs.statSync(mirrorAbs).size
      const range = parseRange(rangeHeader, total)
      const opts = range ? { start: range.start, end: range.end } : {}
      return {
        total,
        contentType: contentTypeFor(mirrorAbs),
        start: range ? range.start : 0,
        end: range ? range.end : total - 1,
        partial: Boolean(range),
        stream: fs.createReadStream(mirrorAbs, opts),
      }
    }
    // Otherwise fetch the remote file (cached by size+mtime) and serve the cached copy.
    const remoteAbs = this.#remoteAbs(clean)
    const info = await this.client.stat(remoteAbs)
    if (!info.isFile) throw Object.assign(new Error('File not found'), { statusCode: 404 })
    const cached = await this.cache.ensure(clean, info, (tmp) => this.client.fastGet(remoteAbs, tmp))
    const total = fs.statSync(cached).size
    const range = parseRange(rangeHeader, total)
    const opts = range ? { start: range.start, end: range.end } : {}
    return {
      total,
      contentType: contentTypeFor(remoteAbs),
      start: range ? range.start : 0,
      end: range ? range.end : total - 1,
      partial: Boolean(range),
      stream: fs.createReadStream(cached, opts),
    }
  }

  // ---- manifest via materialisation ----
  async #listRemoteRecursive(rel, maxDepth) {
    const out = []
    const walk = async (currentRel, depth) => {
      if (depth < 0) return
      const list = await this.client.list(this.#remoteAbs(currentRel)).catch(() => [])
      for (const e of list) {
        if (e.name.startsWith('.')) continue
        const childRel = [currentRel, e.name].filter(Boolean).join('/')
        out.push({ ...e, relativePath: childRel })
        if (e.type === 'directory') await walk(childRel, depth - 1)
      }
    }
    await walk(cleanRelative(rel), maxDepth)
    return out
  }

  #addPlaceholder(rel, type) {
    const abs = this.#mirrorAbs(rel)
    if (type === 'directory') fs.mkdirSync(abs, { recursive: true })
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      if (!exists(abs)) fs.closeSync(fs.openSync(abs, 'a'))
      this.placeholders.set(abs, rel)
    }
  }

  async #materialize(subjectId) {
    const clean = cleanRelative(subjectId)
    // Mirror the subject subtree (anat + any ses-*/anat) as placeholders.
    const subjectEntries = await this.#listRemoteRecursive(clean, 5)
    this.#addPlaceholder(clean, 'directory')
    for (const e of subjectEntries) this.#addPlaceholder(e.relativePath, e.type === 'directory' ? 'directory' : 'file')

    // Fetch real surface binaries so ensureDerivedAssets can parse them.
    const fsRel = `fastsurfer/${clean}`
    if (await this.client.exists(this.#remoteAbs(fsRel))) {
      const fsEntries = await this.#listRemoteRecursive(fsRel, 3)
      this.#addPlaceholder(fsRel, 'directory')
      for (const e of fsEntries) {
        if (e.type === 'directory') {
          this.#addPlaceholder(e.relativePath, 'directory')
          continue
        }
        if (SURF_FILES.has(e.name)) {
          const info = await this.client.stat(this.#remoteAbs(e.relativePath))
          const cached = await this.cache.ensure(e.relativePath, info, (tmp) => this.client.fastGet(this.#remoteAbs(e.relativePath), tmp))
          const mirrorAbs = this.#mirrorAbs(e.relativePath)
          fs.mkdirSync(path.dirname(mirrorAbs), { recursive: true })
          fs.copyFileSync(cached, mirrorAbs)
          this.placeholders.delete(mirrorAbs) // now a real file
        } else {
          this.#addPlaceholder(e.relativePath, 'file')
        }
      }
    }
  }

  async buildManifest(subjectId) {
    const clean = cleanRelative(subjectId)
    if (!(await this.#remoteIsSubject(clean))) throw Object.assign(new Error('Monkey not found'), { statusCode: 404 })
    await this.#materialize(clean)
    const subjectDir = this.#mirrorAbs(clean)
    if (!isSubjectDir(subjectDir) || !resolveAnatDir(subjectDir)) throw Object.assign(new Error('Monkey not found'), { statusCode: 404 })
    return buildManifest({ outputRoot: this.mirrorRoot, subjectDir, fileUrl: (p) => this.fileUrl(p) })
  }

  // ---- server-side export (over SFTP) ----
  async saveList(rel = '') {
    const clean = cleanRelative(rel)
    const entries = (await this.client.list(this.#remoteAbs(clean)))
      .filter((e) => e.type === 'directory' && e.name !== '.brainana-viewer-cache')
      .map((e) => ({ name: e.name, path: [clean, e.name].filter(Boolean).join('/') }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    return { path: clean, entries }
  }

  async mkdir(rel) {
    const clean = cleanRelative(rel)
    if (!clean) throw new Error('A folder name is required')
    await this.client.mkdir(this.#remoteAbs(clean))
    return { path: clean }
  }

  async saveFile(rel, readable, { overwrite = false } = {}) {
    const clean = cleanRelative(rel)
    if (!clean) throw new Error('A filename is required')
    const result = await this.client.uploadStream(readable, this.#remoteAbs(clean), { overwrite })
    if (result.exists) return { exists: true, path: clean }
    return { exists: false, path: clean, bytes: result.bytes }
  }

  async close() {
    await this.client.close()
  }
}
