// Sources dialog: add a local folder or a remote SSH/SFTP workstation, list and remove
// sources. Multi-source is held server-side; this just drives /api/sources.
import type { RuntimeClient } from '@brainana/core-client/runtimeClient.ts'
import type { SourceManager, SourceSummary } from '@brainana/core-client/sourceManager.ts'
import type { BrowseListing, FilesystemClient } from '@brainana/core-client/filesystemClient.ts'
import type { RemoteProfile } from '@brainana/core-client/sessionPersistence.ts'
import { loadRecent, rememberLocal, loadProfiles, rememberProfile, forgetProfile } from '@brainana/core-client/sessionPersistence.ts'
import { h, field, errorText } from '@brainana/ui/dom.ts'

interface Deps {
  client: RuntimeClient
  sources: SourceManager
  files: FilesystemClient
}

// Folder glyph reused by the Browse button and by each folder row in the picker (no shared icon set).
const FOLDER_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'

// Dataset-table column widths (px) for the fixed-layout resizable columns. Held at module scope so
// drags survive the table rebuilds fired on every registry change, and persist across reopens of
// the dialog within a page session (not written to storage — matches the panel resizers). The
// `actions` column has no entry: it flexes to absorb the remainder.
const MIN_COL = 48
const datasetColW = { type: 72, name: 240, label: 130 }
type ColKey = keyof typeof datasetColW

// `onDone` fires when the user clicks the next-step "Done — choose a monkey" button (after at
// least one dataset exists): the dialog closes and the caller can steer focus to the monkey picker.
export function mountSourcesDialog(deps: Deps, onChanged: () => void, onDone?: () => void): void {
  const { sources, files } = deps
  const recents = loadRecent()

  const overlay = h('div', { class: 'overlay' })
  const close = (): void => overlay.remove()
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })

  // The header dismiss button doubles as the next step: a plain "Close" while there are no
  // datasets, then a primary "Done — choose a monkey" once one exists (which also steers focus to
  // the monkey picker via onDone). Declared before renderList so the subscription can restyle it.
  let hasSources = false
  const closeBtn = h('button', { type: 'button', class: 'ghost' }, ['close'])
  closeBtn.addEventListener('click', () => {
    unsub()
    close()
    if (hasSources) onDone?.()
  })

  // Wire a header grip so dragging it resizes the column to its left. Mirrors the dashboard's
  // `.info-vresizer` idiom: measure the header cell's left edge, clamp, write the live <col> width.
  const attachGrip = (grip: HTMLElement, th: HTMLElement, col: HTMLTableColElement, key: ColKey): void => {
    let dragging = false
    grip.addEventListener('pointerdown', (e) => {
      dragging = true
      grip.setPointerCapture(e.pointerId)
      e.preventDefault()
      e.stopPropagation()
    })
    grip.addEventListener('pointermove', (e) => {
      if (!dragging) return
      const w = Math.max(MIN_COL, Math.round(e.clientX - th.getBoundingClientRect().left))
      datasetColW[key] = w
      col.style.width = `${w}px`
    })
    const end = (e: PointerEvent): void => {
      if (!dragging) return
      dragging = false
      try {
        grip.releasePointerCapture(e.pointerId)
      } catch {
        // capture may already be gone
      }
    }
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
  }

  const buildDatasetTable = (items: SourceSummary[]): HTMLTableElement => {
    // Fixed layout + explicit <col> widths make the columns resizable; `actions` (last) flexes.
    const mkCol = (key: ColKey): HTMLTableColElement => {
      const col = h('col') as HTMLTableColElement
      col.style.width = `${datasetColW[key]}px`
      return col
    }
    const colType = mkCol('type')
    const colName = mkCol('name')
    const colLabel = mkCol('label')
    const mkTh = (text: string, col: HTMLTableColElement, key: ColKey): HTMLTableCellElement => {
      const th = h('th', {}, [text]) as HTMLTableCellElement
      const grip = h('span', { class: 'col-grip', ariaHidden: 'true' })
      attachGrip(grip, th, col, key)
      th.append(grip)
      return th
    }
    const body = h('tbody')
    for (const s of items) {
      // Editable custom label. Commit on `change` (fires on blur/Enter) rather than `input` so the
      // emit-driven table rebuild in the subscription can't interrupt typing. On failure revert.
      const labelInput = h('input', { type: 'text', class: 'label-input', value: s.customLabel ?? '', placeholder: 'custom name…' }) as HTMLInputElement
      labelInput.addEventListener('change', () => {
        const next = labelInput.value.trim()
        sources.setLabel(s.id, next || null).catch(() => {
          labelInput.value = s.customLabel ?? ''
        })
      })
      const remove = h('button', { type: 'button', class: 'ghost sm' }, ['remove'])
      remove.addEventListener('click', () => sources.remove(s.id).then(onChanged).catch(() => {}))
      body.append(
        h('tr', {}, [
          h('td', {}, [h('span', { class: `badge ${s.type}` }, [s.type])]),
          h('td', {}, [h('span', { class: 'ds-name', title: s.label }, [s.label])]),
          h('td', {}, [labelInput]),
          h('td', { class: 'ds-actions' }, [remove]),
        ]),
      )
    }
    return h('table', { class: 'dataset-table' }, [
      h('colgroup', {}, [colType, colName, colLabel, h('col')]),
      h('thead', {}, [h('tr', {}, [mkTh('type', colType, 'type'), mkTh('name', colName, 'name'), mkTh('label', colLabel, 'label'), h('th', {}, [''])])]),
      body,
    ])
  }

  const list = h('div', { class: 'source-list' })
  const renderList = (items: SourceSummary[]): void => {
    list.innerHTML = ''
    list.append(items.length === 0 ? h('p', { class: 'muted' }, ['No datasets yet.']) : buildDatasetTable(items))
    hasSources = items.length > 0
    closeBtn.className = hasSources ? 'primary' : 'ghost'
    closeBtn.textContent = hasSources ? 'done — choose a monkey' : 'close'
  }
  const unsub = sources.subscribe(renderList)

  // local form
  const localPath = h('input', { type: 'text', placeholder: '/path/to/brainana/output', class: 'grow' }) as HTMLInputElement
  const localRecent = recents.find((r) => r.type === 'local')
  if (localRecent) localPath.value = localRecent.path
  // Folder-icon button that opens the server-side directory picker; the chosen path is written
  // straight back into the input. Inline SVG since the viewer has no shared icon set.
  const browseBtn = h('button', {
    type: 'button',
    class: 'icon-btn',
    title: 'Browse folders',
    ariaLabel: 'Browse folders',
    innerHTML: FOLDER_SVG,
  })
  browseBtn.addEventListener('click', () => {
    openFsPicker({
      title: 'choose folder',
      start: localPath.value.trim(),
      browse: (p) => files.browseFs(p),
      onPick: (chosen) => {
        localPath.value = chosen
      },
    })
  })
  const localBtn = h('button', { type: 'button', class: 'primary' }, ['add local dataset'])
  const localMsg = h('span', { class: 'msg' })
  localBtn.addEventListener('click', async () => {
    if (!localPath.value.trim()) return
    localBtn.disabled = true
    localMsg.textContent = ''
    try {
      const spec = { type: 'local' as const, path: localPath.value.trim() }
      await sources.add(spec)
      rememberLocal(spec)
      localMsg.textContent = '✓ Added'
      localMsg.className = 'msg ok'
      onChanged()
    } catch (err) {
      localMsg.textContent = errorText(err)
      localMsg.className = 'msg error'
    } finally {
      localBtn.disabled = false
    }
  })

  // remote form
  const rHost = h('input', { type: 'text', placeholder: 'host' }) as HTMLInputElement
  const rUser = h('input', { type: 'text', placeholder: 'user' }) as HTMLInputElement
  const rPort = h('input', { type: 'text', placeholder: '22', class: 'port-input', inputMode: 'numeric', ariaLabel: 'port' }) as HTMLInputElement
  const rPass = h('input', { type: 'password', placeholder: 'password' }) as HTMLInputElement
  const remoteMsg = h('span', { class: 'msg' })

  // Build the (secret-carrying) connection object from the fields. Blank/invalid port → undefined,
  // so the server/SftpClient falls back to 22.
  const buildConnection = () => {
    const portNum = rPort.value.trim() ? Number(rPort.value.trim()) : NaN
    return {
      host: rHost.value.trim(),
      username: rUser.value.trim(),
      port: Number.isFinite(portNum) ? portNum : undefined,
      password: rPass.value || undefined,
    }
  }

  // Saved connection profiles (host/port/user only — passwords are never persisted). Auto-saved on a
  // successful Connect; loading one fills the fields. Always shown, with an empty hint.
  const profileSelect = h('select', { class: 'grow', ariaLabel: 'Saved connections' }) as HTMLSelectElement
  const loadBtn = h('button', { type: 'button', class: 'ghost sm' }, ['load'])
  const removeProfileBtn = h('button', { type: 'button', class: 'ghost sm' }, ['remove'])
  let remoteProfiles: RemoteProfile[] = []
  const profileText = (p: RemoteProfile): string => `${p.username}@${p.host}:${p.port ?? 22}`
  const renderProfiles = (): void => {
    remoteProfiles = loadProfiles()
    profileSelect.innerHTML = ''
    const empty = remoteProfiles.length === 0
    if (empty) {
      profileSelect.append(h('option', { value: '' }, ['(none saved yet)']))
    } else {
      remoteProfiles.forEach((p, i) => profileSelect.append(h('option', { value: String(i) }, [profileText(p)])))
    }
    profileSelect.disabled = empty
    loadBtn.disabled = empty
    removeProfileBtn.disabled = empty
  }
  loadBtn.addEventListener('click', () => {
    const p = remoteProfiles[Number(profileSelect.value)]
    if (!p) return
    rHost.value = p.host
    rUser.value = p.username
    rPort.value = p.port ? String(p.port) : ''
    rPass.value = '' // never stored — user re-enters
    rPass.focus()
  })
  removeProfileBtn.addEventListener('click', () => {
    const p = remoteProfiles[Number(profileSelect.value)]
    if (!p) return
    forgetProfile(p)
    renderProfiles()
  })
  // Prefill from the most recent profile.
  const [firstProfile] = loadProfiles()
  if (firstProfile) {
    rHost.value = firstProfile.host
    rUser.value = firstProfile.username
    rPort.value = firstProfile.port ? String(firstProfile.port) : ''
  }
  renderProfiles()

  const connectBtn = h('button', { type: 'button', class: 'primary' }, ['connect'])
  // Add the remote dataset with the folder chosen in the browser opened after a successful Connect.
  const addRemote = async (remoteRoot: string): Promise<void> => {
    remoteMsg.textContent = ''
    remoteMsg.className = 'msg'
    try {
      await sources.add({ type: 'remote', connection: buildConnection(), remoteRoot, cacheRoot: '' })
      rPass.value = ''
      remoteMsg.textContent = '✓ Added'
      remoteMsg.className = 'msg ok'
      onChanged()
    } catch (err) {
      remoteMsg.textContent = errorText(err)
      remoteMsg.className = 'msg error'
    }
  }
  connectBtn.addEventListener('click', async () => {
    if (!rHost.value.trim() || !rUser.value.trim()) return
    connectBtn.disabled = true
    remoteMsg.textContent = 'connecting…'
    remoteMsg.className = 'msg'
    try {
      const connection = buildConnection()
      const { token } = await files.connectRemote(connection)
      // Remember the connection (no path, no password) as soon as it succeeds, and surface it.
      rememberProfile({ host: connection.host, port: connection.port, username: connection.username })
      renderProfiles()
      remoteMsg.textContent = ''
      // Interactive remote browse (mirrors the local picker); the connection is already open, so
      // picking a folder adds the dataset directly. Closing the picker frees the browse socket.
      openFsPicker({
        title: 'choose remote folder',
        start: '',
        browse: (p) => files.browseRemote(token, p),
        onPick: (abs) => void addRemote(abs),
        onClose: () => void files.disconnectRemote(token).catch(() => {}),
      })
    } catch (err) {
      remoteMsg.textContent = errorText(err)
      remoteMsg.className = 'msg error'
    } finally {
      connectBtn.disabled = false
    }
  })

  // Port shares a row with host but must stay narrow rather than flex like the other fields.
  const portField = field('port', rPort)
  portField.classList.add('port-field')

  const dialog = h('div', { class: 'dialog' }, [
    h('div', { class: 'dialog-head' }, [h('h2', {}, ['datasets']), h('span', { class: 'spacer' }), closeBtn]),
    list,
    h('div', { class: 'source-forms' }, [
      h('div', { class: 'source-form' }, [
        h('h3', {}, ['local folder']),
        h('div', { class: 'row' }, [browseBtn, localPath, localBtn]),
        localMsg,
      ]),
      h('div', { class: 'source-form' }, [
        h('h3', {}, ['remote (SSH/SFTP)']),
        // Top recall: reload a saved connection into the fields below.
        h('div', { class: 'row conn-recall' }, [h('span', { class: 'muted' }, ['recent']), profileSelect, loadBtn, removeProfileBtn]),
        // Fields in a 2-column grid: host (wide) + port (narrow); then user + password (equal).
        h('div', { class: 'row' }, [field('host', rHost), portField]),
        h('div', { class: 'row' }, [field('user', rUser), field('password', rPass)]),
        // Primary action bottom-right, status message to its left.
        h('div', { class: 'row' }, [remoteMsg, h('span', { class: 'spacer' }), connectBtn]),
      ]),
    ]),
  ])
  overlay.append(dialog)
  document.body.append(overlay)
}

interface FsPickerOptions {
  title: string
  start: string
  // Directory lister — local (browseFs) or remote (browseRemote with a session token) — returning
  // the shared BrowseListing shape. Empty path lets the backend default to its home directory.
  browse: (path: string) => Promise<BrowseListing>
  onPick: (absPath: string) => void
  onClose?: () => void
}

// An overlay layered over the Sources dialog: navigate directories (local or remote) and pick one.
// Seeds from `start` when valid; otherwise the backend falls back to home. `onPick` gets the chosen
// absolute path; `onClose` fires exactly once when the picker is dismissed (used to free a remote
// browse connection).
function openFsPicker({ title, start, browse, onPick, onClose }: FsPickerOptions): void {
  const overlay = h('div', { class: 'overlay' })
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    overlay.remove()
    onClose?.()
  }
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })

  let current = ''
  const crumb = h('nav', { class: 'fs-crumb', ariaLabel: 'Current path' })
  const listEl = h('div', { class: 'fs-list' })
  const msg = h('span', { class: 'msg' })
  const useBtn = h('button', { type: 'button', class: 'primary' }, ['use this folder'])
  useBtn.addEventListener('click', () => {
    if (current) onPick(current)
    close()
  })

  // Render the absolute path as clickable ancestor segments (standard file-chooser breadcrumb).
  // Each segment except the last navigates to that ancestor; the last marks the current folder.
  const renderCrumb = (absPath: string): void => {
    crumb.innerHTML = ''
    const segs: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }]
    let acc = ''
    for (const part of absPath.split('/').filter(Boolean)) {
      acc += `/${part}`
      segs.push({ label: part, path: acc })
    }
    segs.forEach((seg, i) => {
      if (i > 0) crumb.append(h('span', { class: 'fs-sep' }, ['›']))
      const isCurrent = i === segs.length - 1
      const btn = h('button', { type: 'button', class: `fs-seg${isCurrent ? ' current' : ''}` }, [seg.label])
      if (!isCurrent) btn.addEventListener('click', () => void load(seg.path))
      crumb.append(btn)
    })
  }

  const load = async (abs: string): Promise<void> => {
    msg.textContent = ''
    msg.className = 'msg'
    listEl.classList.add('loading')
    let listing: BrowseListing
    try {
      listing = await browse(abs)
    } catch (err) {
      // On a bad seed path, retry once at the server default (home) so the picker still opens.
      if (abs) return void load('')
      msg.textContent = errorText(err)
      msg.className = 'msg error'
      listEl.classList.remove('loading')
      return
    }
    current = listing.path
    renderCrumb(listing.path)
    useBtn.disabled = false
    listEl.innerHTML = ''
    if (listing.entries.length === 0) {
      listEl.append(h('p', { class: 'muted' }, ['No sub-folders here.']))
    }
    for (const entry of listing.entries) {
      const row = h('button', { type: 'button', class: 'fs-entry' }, [
        h('span', { class: 'fs-ico', innerHTML: FOLDER_SVG }),
        h('span', { class: 'fs-name' }, [entry.name]),
      ])
      row.addEventListener('click', () => void load(entry.path))
      listEl.append(row)
    }
    listEl.classList.remove('loading')
  }

  const closeBtn = h('button', { type: 'button', class: 'ghost' }, ['cancel'])
  closeBtn.addEventListener('click', close)

  const dialog = h('div', { class: 'dialog fs-picker' }, [
    h('div', { class: 'dialog-head' }, [h('h2', {}, [title]), h('span', { class: 'spacer' }), closeBtn]),
    crumb,
    listEl,
    h('div', { class: 'row' }, [msg, h('span', { class: 'spacer' }), useBtn]),
  ])
  overlay.append(dialog)
  document.body.append(overlay)
  void load(start)
}
