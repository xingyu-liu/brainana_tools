// Sources dialog: add a local folder or a remote SSH/SFTP workstation, list and remove
// sources. Multi-source is held server-side; this just drives /api/sources.
import type { RuntimeClient } from '../../../../core/client/runtimeClient.ts'
import type { SourceManager, SourceSummary } from '../../../../core/client/sourceManager.ts'
import type { FilesystemClient } from '../../../../core/client/filesystemClient.ts'
import { loadRecent, rememberLocal, rememberRemote } from '../../../../core/client/sessionPersistence.ts'
import { h, field, errorText } from '../dom.ts'

interface Deps {
  client: RuntimeClient
  sources: SourceManager
  files: FilesystemClient
}

export function mountSourcesDialog(deps: Deps, onChanged: () => void): void {
  const { sources } = deps
  const recents = loadRecent()

  const overlay = h('div', { class: 'overlay' })
  const close = (): void => overlay.remove()
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })

  const list = h('div', { class: 'source-list' })
  const renderList = (items: SourceSummary[]): void => {
    list.innerHTML = ''
    if (items.length === 0) list.append(h('p', { class: 'muted' }, ['No sources yet.']))
    for (const s of items) {
      const remove = h('button', { type: 'button', class: 'ghost' }, ['Remove'])
      remove.addEventListener('click', () => sources.remove(s.id).then(onChanged).catch(() => {}))
      list.append(h('div', { class: 'source-row' }, [h('span', { class: `badge ${s.type}` }, [s.type]), h('strong', {}, [s.label]), h('span', { class: 'spacer' }), remove]))
    }
  }
  const unsub = sources.subscribe(renderList)

  // local form
  const localPath = h('input', { type: 'text', placeholder: '/path/to/preprocessed', class: 'grow' }) as HTMLInputElement
  const localRecent = recents.find((r) => r.type === 'local')
  if (localRecent) localPath.value = localRecent.path
  const localBtn = h('button', { type: 'button' }, ['Add local'])
  const localMsg = h('span', { class: 'msg' })
  localBtn.addEventListener('click', async () => {
    if (!localPath.value.trim()) return
    localBtn.disabled = true
    localMsg.textContent = ''
    try {
      const spec = { type: 'local' as const, path: localPath.value.trim() }
      await sources.add(spec)
      rememberLocal(spec)
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
  const rPass = h('input', { type: 'password', placeholder: 'password' }) as HTMLInputElement
  const rRoot = h('input', { type: 'text', placeholder: '/remote/preprocessed', class: 'grow' }) as HTMLInputElement
  const remoteRecent = recents.find((r) => r.type === 'remote')
  if (remoteRecent) {
    rHost.value = remoteRecent.host
    rUser.value = remoteRecent.username
    rRoot.value = remoteRecent.remoteRoot
  }
  const remoteBtn = h('button', { type: 'button' }, ['Add remote'])
  const remoteMsg = h('span', { class: 'msg' })
  remoteBtn.addEventListener('click', async () => {
    if (!rHost.value.trim() || !rUser.value.trim() || !rRoot.value.trim()) return
    remoteBtn.disabled = true
    remoteMsg.textContent = ''
    try {
      const spec = { type: 'remote' as const, connection: { host: rHost.value.trim(), username: rUser.value.trim(), password: rPass.value || undefined }, remoteRoot: rRoot.value.trim(), cacheRoot: '' }
      await sources.add(spec)
      rememberRemote(spec)
      rPass.value = ''
      onChanged()
    } catch (err) {
      remoteMsg.textContent = errorText(err)
      remoteMsg.className = 'msg error'
    } finally {
      remoteBtn.disabled = false
    }
  })

  const closeBtn = h('button', { type: 'button', class: 'ghost' }, ['Close'])
  closeBtn.addEventListener('click', () => {
    unsub()
    close()
  })

  const dialog = h('div', { class: 'dialog' }, [
    h('div', { class: 'dialog-head' }, [h('h2', {}, ['Sources']), h('span', { class: 'spacer' }), closeBtn]),
    list,
    h('div', { class: 'source-forms' }, [
      h('div', { class: 'source-form' }, [h('h3', {}, ['Local folder']), field('Folder', localPath), h('div', { class: 'row' }, [localBtn, localMsg])]),
      h('div', { class: 'source-form' }, [
        h('h3', {}, ['Remote (SSH/SFTP)']),
        h('div', { class: 'row' }, [field('Host', rHost), field('User', rUser), field('Password', rPass)]),
        field('Remote path', rRoot),
        h('div', { class: 'row' }, [remoteBtn, remoteMsg]),
      ]),
    ]),
  ])
  overlay.append(dialog)
  document.body.append(overlay)
}
