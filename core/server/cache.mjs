// Tool-agnostic async cache for remote files, validated by size + mtime.
// Ported/generalised from remote-filesystem.mjs ensureCached (server.mjs finding R4):
// the SSH-specific spawnSync fetch is replaced by an injected async `fetchToTemp`.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export class RemoteFileCache {
  // namespace scopes the digest so two sources (different host/root) never collide.
  constructor({ cacheRoot, namespace = '' }) {
    if (!cacheRoot) throw new Error('RemoteFileCache requires a cacheRoot')
    this.cacheRoot = cacheRoot
    this.namespace = namespace
    fs.mkdirSync(cacheRoot, { recursive: true })
  }

  cachePath(relative) {
    const digest = crypto.createHash('sha256').update(`${this.namespace}\0${relative}`).digest('hex').slice(0, 20)
    const basename = path.basename(relative) || 'root'
    return path.join(this.cacheRoot, 'files', digest, basename)
  }

  // Return a local path to the cached file, fetching it if the cache is missing or stale.
  //   relative     — key identifying the remote file
  //   info         — { size, mtimeMs } remote stat used to validate the cache
  //   fetchToTemp  — async (tempPath) => void; must write the full file to tempPath
  async ensure(relative, info, fetchToTemp) {
    const dest = this.cachePath(relative)
    const metaPath = `${dest}.brainana-meta.json`

    let valid = false
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
      valid =
        fs.existsSync(dest) &&
        meta.size === info.size &&
        meta.mtimeMs === info.mtimeMs &&
        fs.statSync(dest).size === info.size
    } catch {
      // no/invalid meta → refetch
    }
    if (valid) return dest

    await fsp.mkdir(path.dirname(dest), { recursive: true })
    const temp = `${dest}.partial-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
    try {
      await fetchToTemp(temp)
      const written = fs.statSync(temp).size
      if (written !== info.size) throw new Error(`Remote file transfer incomplete (${written}/${info.size} bytes)`)
      await fsp.rename(temp, dest)
      await fsp.writeFile(metaPath, JSON.stringify({ size: info.size, mtimeMs: info.mtimeMs, relative }))
      return dest
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }
}
