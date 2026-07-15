// Tool-agnostic atomic write helpers for server-side export.
// Ported from server.mjs:558-577 (writeRequestFile). Standardising on server-side export
// removes the Chromium-only File System Access dependency (finding R8, plan §6.3).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

// Unique temp suffix that does not depend on Date.now ordering for correctness.
function tempSuffix() {
  return `brainana-partial-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
}

// Stream `readable` to `destination` atomically: write to a temp file in the same
// directory, then rename into place. Honors `overwrite=false` by refusing to clobber
// (checked both before and after the write to narrow the race window).
export async function writeStreamAtomic(readable, destination, overwrite) {
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  if (!overwrite && exists(destination)) return { exists: true }
  const temp = `${destination}.${tempSuffix()}`
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(temp, { flags: 'wx' })
      readable.on('error', reject)
      out.on('error', reject)
      out.on('finish', resolve)
      readable.pipe(out)
    })
    if (!overwrite && exists(destination)) {
      await fsp.unlink(temp).catch(() => {})
      return { exists: true }
    }
    await fsp.rename(temp, destination)
    return { exists: false, bytes: fs.statSync(destination).size }
  } catch (error) {
    await fsp.unlink(temp).catch(() => {})
    throw error
  }
}

// Write an in-memory buffer/string atomically (used for small derived JSON, meta, etc.).
export async function writeFileAtomic(destination, data) {
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  const temp = `${destination}.${tempSuffix()}`
  try {
    await fsp.writeFile(temp, data, { flag: 'wx' })
    await fsp.rename(temp, destination)
  } catch (error) {
    await fsp.unlink(temp).catch(() => {})
    throw error
  }
}
