// SFTP data-source test (plan §9): stand up an in-process, fs-backed fake SFTP server and
// round-trip through SftpDataSource. Skips (exit 0) when `ssh2` is not installed so the
// suite stays green in environments without the optional dependency.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

function skip(reason) {
  console.log(`  skip - ${reason}`)
  console.log('sftp-source_test: skipped')
  process.exit(0)
}

let ssh2
try {
  ssh2 = (await import('ssh2')).default
} catch {
  skip('ssh2 not installed (run `npm install`)')
}

const { Server } = ssh2
const { OPEN_MODE, STATUS_CODE } = ssh2.utils.sftp

// ---------------------------------------------------------------------------
// Minimal fs-backed SFTP server (test double). Maps SFTP ops onto a temp dir.
// ---------------------------------------------------------------------------
function startFakeSftpServer(rootDir) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })

  // Our client always sends absolute remote paths (remoteRoot is absolute), so serve the
  // real fs directly; relative paths (if any) resolve under rootDir. Test double only.
  const toLocal = (p) => (path.isAbsolute(p) ? p : path.join(rootDir, p))

  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept())
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          const handles = new Map()
          let counter = 0
          const newHandle = (obj) => {
            const id = counter++
            handles.set(id, obj)
            const buf = Buffer.alloc(4)
            buf.writeUInt32BE(id, 0)
            return buf
          }
          const attrsFor = (st) => ({ mode: st.mode, size: st.size, uid: st.uid, gid: st.gid, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) })

          sftp.on('REALPATH', (reqid, p) => {
            const abs = path.posix.normalize(p.startsWith('/') ? p : `/${p}`)
            sftp.name(reqid, [{ filename: abs, longname: abs, attrs: {} }])
          })
          sftp.on('STAT', statHandler)
          sftp.on('LSTAT', statHandler)
          function statHandler(reqid, p) {
            try {
              sftp.attrs(reqid, attrsFor(fs.statSync(toLocal(p))))
            } catch {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            }
          }
          sftp.on('OPENDIR', (reqid, p) => {
            try {
              const names = fs.readdirSync(toLocal(p))
              sftp.handle(reqid, newHandle({ type: 'dir', dir: p, names, read: false }))
            } catch {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            }
          })
          sftp.on('READDIR', (reqid, handle) => {
            const h = handles.get(handle.readUInt32BE(0))
            if (!h || h.type !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE)
            if (h.read) return sftp.status(reqid, STATUS_CODE.EOF)
            h.read = true
            const list = h.names.map((name) => {
              const st = fs.statSync(path.join(toLocal(h.dir), name))
              return { filename: name, longname: name, attrs: attrsFor(st) }
            })
            sftp.name(reqid, list)
          })
          sftp.on('OPEN', (reqid, filename, flags, _attrs) => {
            let mode = 'r'
            if (flags & OPEN_MODE.WRITE) mode = flags & OPEN_MODE.APPEND ? 'a' : 'w'
            try {
              const fd = fs.openSync(toLocal(filename), mode)
              sftp.handle(reqid, newHandle({ type: 'file', fd }))
            } catch {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            }
          })
          sftp.on('READ', (reqid, handle, offset, length) => {
            const h = handles.get(handle.readUInt32BE(0))
            if (!h || h.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
            const buf = Buffer.alloc(length)
            const bytes = fs.readSync(h.fd, buf, 0, length, offset)
            if (bytes <= 0) return sftp.status(reqid, STATUS_CODE.EOF)
            sftp.data(reqid, buf.subarray(0, bytes))
          })
          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const h = handles.get(handle.readUInt32BE(0))
            if (!h || h.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
            fs.writeSync(h.fd, data, 0, data.length, offset)
            sftp.status(reqid, STATUS_CODE.OK)
          })
          sftp.on('MKDIR', (reqid, p) => {
            try {
              fs.mkdirSync(toLocal(p), { recursive: true })
              sftp.status(reqid, STATUS_CODE.OK)
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })
          sftp.on('RENAME', (reqid, from, to) => {
            try {
              fs.renameSync(toLocal(from), toLocal(to))
              sftp.status(reqid, STATUS_CODE.OK)
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })
          sftp.on('REMOVE', (reqid, p) => {
            try {
              fs.rmSync(toLocal(p), { force: true })
              sftp.status(reqid, STATUS_CODE.OK)
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })
          sftp.on('FSTAT', (reqid, handle) => {
            const h = handles.get(handle.readUInt32BE(0))
            if (!h || h.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
            sftp.attrs(reqid, attrsFor(fs.fstatSync(h.fd)))
          })
          sftp.on('CLOSE', (reqid, handle) => {
            const id = handle.readUInt32BE(0)
            const h = handles.get(id)
            if (h?.type === 'file') fs.closeSync(h.fd)
            handles.delete(id)
            sftp.status(reqid, STATUS_CODE.OK)
          })
        })
      })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

async function main() {
  const { SftpDataSource } = await import('../core/server/sftpSource.mjs')

  const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-remote-'))
  const cacheRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-cache-'))
  // Seed a subject with anat + a fastsurfer surf dir.
  await fsp.mkdir(path.join(remoteRoot, 'sub-r1', 'anat'), { recursive: true })
  await fsp.writeFile(path.join(remoteRoot, 'sub-r1', 'anat', 'sub-r1_space-T1w_desc-preproc_T1w.nii.gz'), Buffer.from('REMOTE-VOLUME-BYTES-9876543210'))

  const { server, port } = await startFakeSftpServer(remoteRoot)

  const source = new SftpDataSource({
    id: 'remote-aaaaaaaaaaaa',
    connection: { host: '127.0.0.1', port, username: 'test', password: 'test' },
    remoteRoot,
    cacheRoot,
  })

  try {
    await source.open()
    ok('SftpDataSource connects to the fake SFTP server')

    const monkeys = await source.listMonkeys()
    assert.deepEqual(monkeys.map((m) => m.id), ['sub-r1'])
    ok('listMonkeys finds the remote subject')

    const dirs = await source.listDirectories('')
    assert.ok(dirs.entries.some((e) => e.name === 'sub-r1' && e.isMonkey))
    ok('listDirectories lists remote entries')

    // openFile streams remote bytes (via cache) with range support.
    const opened = await source.openFile('sub-r1/anat/sub-r1_space-T1w_desc-preproc_T1w.nii.gz', 'bytes=0-5')
    const chunks = []
    for await (const c of opened.stream) chunks.push(c)
    assert.equal(opened.partial, true)
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'REMOTE')
    ok('openFile serves a remote byte range through the cache')

    // saveFile uploads over SFTP atomically.
    const { Readable } = await import('node:stream')
    const saved = await source.saveFile('sub-r1/roi/new.txt', Readable.from(['roi-data']), { overwrite: false })
    assert.equal(saved.exists, false)
    assert.equal(fs.readFileSync(path.join(remoteRoot, 'sub-r1', 'roi', 'new.txt'), 'utf8'), 'roi-data')
    ok('saveFile uploads over SFTP and refuses to clobber')

    const clobber = await source.saveFile('sub-r1/roi/new.txt', Readable.from(['x']), { overwrite: false })
    assert.equal(clobber.exists, true)
    ok('saveFile returns exists=true without overwrite')
  } finally {
    await source.close()
    server.close()
    await fsp.rm(remoteRoot, { recursive: true, force: true })
    await fsp.rm(cacheRoot, { recursive: true, force: true })
  }

  console.log(`sftp-source_test: ${passed} checks passed`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
