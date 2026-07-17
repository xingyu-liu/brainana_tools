// Thin promise wrapper over ssh2's SFTP subsystem.
// `ssh2` is imported LAZILY (dynamic import in connect()) so that the server, the local
// data source, and the local test suite all work even when ssh2 is not installed — only
// actually opening a remote source requires the dependency.
//
// This keeps the "no code runs on the workstation" property of the old SSH layer: we use
// the SFTP subsystem only, no remote shell commands, so it is also remote-OS-agnostic
// (fixes R4 — no reliance on GNU find/stat).
import path from 'node:path'
import crypto from 'node:crypto'

export class SftpClient {
  #conn = null
  #sftp = null

  constructor({ host, port = 22, username, password, privateKey, passphrase, agent, keepaliveInterval = 15000, readyTimeout = 20000 } = {}) {
    if (!host || !username) throw new Error('SFTP connection requires host and username')
    this.options = { host, port, username, password, privateKey, passphrase, agent, keepaliveInterval, readyTimeout }
  }

  async connect() {
    if (this.#sftp) return this
    let Client
    try {
      ;({ Client } = await import('ssh2'))
    } catch {
      throw new Error("The 'ssh2' package is required for remote sources. Run `npm install` first.")
    }
    const conn = new Client()
    // Drop undefined auth fields so ssh2 falls back to the agent / other methods cleanly.
    const opts = Object.fromEntries(Object.entries(this.options).filter(([, v]) => v !== undefined))
    await new Promise((resolve, reject) => {
      conn.on('ready', resolve).on('error', reject).connect(opts)
    })
    // The connection is now open; if the SFTP subsystem fails to start, tear the connection
    // down before surfacing the error so we never leak a dangling SSH/TCP connection.
    let sftp
    try {
      sftp = await new Promise((resolve, reject) => {
        conn.sftp((err, s) => (err ? reject(err) : resolve(s)))
      })
    } catch (error) {
      try {
        conn.end()
      } catch {
        // best-effort
      }
      throw error
    }
    this.#conn = conn
    this.#sftp = sftp
    return this
  }

  #require() {
    if (!this.#sftp) throw new Error('SFTP client is not connected')
    return this.#sftp
  }

  // List a directory. Returns [{ name, type: 'file'|'directory'|'other', size, mtimeMs }].
  async list(dir) {
    const sftp = this.#require()
    const list = await new Promise((resolve, reject) => {
      sftp.readdir(dir, (err, l) => (err ? reject(err) : resolve(l)))
    })
    return Promise.all(
      list.map(async (entry) => {
        const attrs = entry.attrs
        let type = attrs.isDirectory() ? 'directory' : attrs.isFile() ? 'file' : 'other'
        // readdir returns lstat attrs (the link itself, not its target). Follow symlinks so a
        // symlinked directory is listed as a directory, not silently hidden as a 'file'.
        if (attrs.isSymbolicLink?.()) {
          try {
            const target = await this.stat(path.posix.join(dir, entry.filename))
            type = target.isDirectory ? 'directory' : target.isFile ? 'file' : 'other'
          } catch {
            type = 'other' // dangling or unreadable link
          }
        }
        return { name: entry.filename, type, size: attrs.size, mtimeMs: (attrs.mtime || 0) * 1000 }
      }),
    )
  }

  // Stat a path (follows symlinks). Returns { isFile, isDirectory, size, mtimeMs }.
  async stat(remotePath) {
    const sftp = this.#require()
    const attrs = await new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, a) => (err ? reject(err) : resolve(a)))
    })
    return { isFile: attrs.isFile(), isDirectory: attrs.isDirectory(), size: attrs.size, mtimeMs: (attrs.mtime || 0) * 1000 }
  }

  async exists(remotePath) {
    try {
      await this.stat(remotePath)
      return true
    } catch {
      return false
    }
  }

  // Resolve a path to an absolute one (standard SFTP realpath). Passing '.' returns the login
  // directory (home) — used as the default start for the pre-add remote folder picker.
  async realpath(remotePath = '.') {
    const sftp = this.#require()
    return new Promise((resolve, reject) => {
      sftp.realpath(remotePath, (err, abs) => (err ? reject(err) : resolve(abs)))
    })
  }

  // Download a whole remote file to a local path (used by the cache).
  async fastGet(remotePath, localPath) {
    const sftp = this.#require()
    await new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) => (err ? reject(err) : resolve()))
    })
  }

  async mkdir(remotePath) {
    const sftp = this.#require()
    await new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => (err ? reject(err) : resolve()))
    })
  }

  async rename(from, to) {
    const sftp = this.#require()
    await new Promise((resolve, reject) => {
      sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
    })
  }

  // Atomic-ish upload: stream to a temp name, then rename into place.
  async uploadStream(readable, remotePath, { overwrite = false } = {}) {
    const sftp = this.#require()
    if (!overwrite && (await this.exists(remotePath))) return { exists: true }
    const dir = path.posix.dirname(remotePath)
    await this.mkdir(dir).catch(() => {}) // parent may already exist
    const temp = `${remotePath}.brainana-partial-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
    try {
      await new Promise((resolve, reject) => {
        const out = sftp.createWriteStream(temp)
        readable.on('error', reject)
        out.on('error', reject)
        out.on('close', resolve)
        readable.pipe(out)
      })
    } catch (error) {
      // Don't leave a half-written .brainana-partial-* orphan on the remote when the transfer fails.
      await new Promise((resolve) => sftp.unlink(temp, () => resolve()))
      throw error
    }
    if (!overwrite && (await this.exists(remotePath))) {
      await new Promise((resolve) => this.#require().unlink(temp, () => resolve()))
      return { exists: true }
    }
    await this.rename(temp, remotePath)
    const { size } = await this.stat(remotePath)
    return { exists: false, bytes: size }
  }

  async close() {
    try {
      this.#conn?.end()
    } catch {
      // best-effort
    }
    this.#conn = null
    this.#sftp = null
  }
}
