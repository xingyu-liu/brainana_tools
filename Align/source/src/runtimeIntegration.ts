/* Source reconstruction of the v0.15.x workstation file browser and export UI. */
export type Modality = 'mri' | 'ct'
export type RuntimeConfig = { enabled?: boolean; mode?: 'local' | 'remote'; remote?: boolean; label?: string }
export type ServerEntry = { name: string; path: string; directory: boolean }
export type ServerList = { path: string; parent: string | null; entries: ServerEntry[] }

type LoadFiles = (modality: Modality, files: File[]) => Promise<void>
type Status = (message: string, error?: boolean) => void

type ExportState = {
  remote: boolean
  configLoaded: boolean
  destination: 'local' | 'workstation'
  localHandle: FileSystemDirectoryHandle | null
  remotePath: string
  remoteSelected: boolean
  chain: Promise<void>
  browsePath: string
}

declare global {
  interface Window {
    brainanaAlignSaveBlob?: (blob: Blob, filename: string) => Promise<void>
  }
}

const cleanName = (name: string) => String(name || 'brainana-align-output').replace(/[\\/:*?"<>|]/g, '_')
const joinPath = (a: string, b: string) => [a, b].filter(Boolean).join('/').replace(/\/{2,}/g, '/')
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]!))

async function getJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((payload as { error?: string }).error || `Request failed (${response.status})`)
  return payload as T
}

export function installRuntimeIntegration(loadFiles: LoadFiles, setStatus: Status) {
  const state: ExportState = {
    remote: false, configLoaded: false, destination: 'local', localHandle: null,
    remotePath: '', remoteSelected: false, chain: Promise.resolve(), browsePath: '',
  }
  let config: RuntimeConfig | null = null
  let browserModality: Modality = 'mri'
  let browserPath = ''
  let activeLoadController: AbortController | null = null

  const style = document.createElement('style')
  style.textContent = `
    .server-load{white-space:nowrap}.server-browser-list{min-height:220px;max-height:55vh;overflow:auto;border:1px solid #46505d;border-radius:6px}
    .server-entry{border-bottom:1px solid #39424d}.server-entry label,.server-directory-button{display:flex;width:100%;gap:10px;align-items:center;padding:10px 12px;text-align:left;background:transparent;border:0}
    .browser-card{width:min(720px,92vw)}.browser-location,.browser-actions{display:flex;align-items:center;gap:8px;padding:10px 0}.browser-location code{overflow-wrap:anywhere}.browser-actions{justify-content:flex-end}
    #ba-export-panel{margin:12px 0;padding:12px;border:1px solid #59606b;border-radius:8px;background:#20252c}#ba-folder-controls{display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap}
    #ba-folder-path{font-size:12px;color:#aeb8c6;overflow-wrap:anywhere}#ba-export-status{min-height:18px;margin-top:8px;font-size:12px}
    .ba-overlay{position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,.72);display:none;align-items:center;justify-content:center}.ba-dialog{width:min(680px,90vw);max-height:80vh;background:#242a32;border:1px solid #697382;border-radius:10px;display:flex;flex-direction:column}
    .ba-dialog header{padding:14px 16px;font-weight:700;border-bottom:1px solid #4d5663}.ba-nav,.ba-actions{padding:10px 14px;display:flex;gap:8px;align-items:center}.ba-list{min-height:220px;overflow:auto;border-top:1px solid #404854;border-bottom:1px solid #404854}.ba-folder-row{width:100%;text-align:left;border:0;border-bottom:1px solid #38404a;border-radius:0;background:transparent;padding:10px 14px;display:flex;gap:10px}.ba-actions{justify-content:flex-end}.ba-empty{padding:16px;color:#aab4c0}.ba-msg{padding:0 14px;min-height:20px;color:#ff9696}
  `
  document.head.appendChild(style)

  const imageGroup = document.querySelector('.workflow-group.image-loads')
  for (const modality of ['mri','ct'] as Modality[]) {
    const button = document.createElement('button')
    button.id = `${modality}-server`; button.className = 'server-load hidden'; button.textContent = `Browse ${modality.toUpperCase()}`
    imageGroup?.appendChild(button)
  }

  const browser = document.createElement('div')
  browser.id = 'server-browser-modal'; browser.className = 'modal hidden'; browser.setAttribute('role','dialog'); browser.setAttribute('aria-modal','true')
  browser.innerHTML = `<div class="modal-card browser-card"><div class="modal-head"><h2 id="server-browser-title">Files</h2><button id="server-browser-close" aria-label="Close">×</button></div><div class="browser-location"><button id="server-browser-up" disabled>↑</button><code id="server-browser-path">/</code></div><div id="server-browser-list" class="server-browser-list"></div><div class="browser-actions"><button id="server-browser-cancel">Cancel</button><button id="server-browser-load" class="primary" disabled>Load selected</button></div></div>`
  document.body.appendChild(browser)

  const listElement = browser.querySelector<HTMLDivElement>('#server-browser-list')!
  const loadButton = browser.querySelector<HTMLButtonElement>('#server-browser-load')!
  const selectedPaths = () => Array.from(listElement.querySelectorAll<HTMLInputElement>('input:checked')).map(input => input.value)
  const closeBrowser = () => {
    if (activeLoadController) activeLoadController.abort()
    activeLoadController = null
    browser.classList.add('hidden')
  }

  async function listPath(path = '') {
    const data = await getJson<ServerList>(`/api/list?path=${encodeURIComponent(path)}`)
    browserPath = data.path || ''
    browser.querySelector<HTMLElement>('#server-browser-path')!.textContent = `/${browserPath}`.replace(/\/$/, '') || '/'
    listElement.innerHTML = ''
    if (!data.entries.length) listElement.innerHTML = '<div class="empty">No supported volumes or folders in this location.</div>'
    for (const entry of data.entries) {
      const row = document.createElement('div'); row.className = `server-entry ${entry.directory ? 'directory' : 'file'}`
      if (entry.directory) {
        const button = document.createElement('button'); button.className = 'server-directory-button'; button.textContent = `📁 ${entry.name}`
        button.addEventListener('click', () => listPath(entry.path).catch(error => setStatus(error.message, true))); row.appendChild(button)
      } else {
        const label = document.createElement('label'), input = document.createElement('input'), span = document.createElement('span')
        input.type = 'checkbox'; input.value = entry.path; span.textContent = entry.name
        input.addEventListener('change', () => { loadButton.disabled = selectedPaths().length === 0 }); label.append(input, span); row.appendChild(label)
      }
      listElement.appendChild(row)
    }
    const up = browser.querySelector<HTMLButtonElement>('#server-browser-up')!; up.disabled = data.parent === null; up.dataset.parent = data.parent ?? ''; loadButton.disabled = true
  }

  async function openBrowser(modality: Modality) {
    browserModality = modality
    browser.querySelector<HTMLElement>('#server-browser-title')!.textContent = `${config?.mode === 'remote' ? 'Workstation' : 'Local'} ${modality.toUpperCase()} files`
    browser.classList.remove('hidden'); await listPath(browserPath)
  }

  async function loadSelection() {
    const paths = selectedPaths(); if (!paths.length) return
    activeLoadController?.abort()
    const controller = new AbortController()
    activeLoadController = controller
    loadButton.disabled = true
    const cancelButton = browser.querySelector<HTMLButtonElement>('#server-browser-cancel')!
    cancelButton.textContent = 'Cancel loading'
    try {
      const files: File[] = []
      for (let index = 0; index < paths.length; index++) {
        const path = paths[index]
        setStatus(`Loading ${index + 1} of ${paths.length}: ${path.split('/').pop() || path}…`)
        const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`, { signal: controller.signal })
        if (!response.ok) throw new Error((await response.text()) || `Unable to load ${path}`)
        const blob = await response.blob()
        files.push(new File([blob], path.split('/').pop() || 'volume', { type: blob.type || 'application/octet-stream' }))
      }
      activeLoadController = null
      browser.classList.add('hidden')
      await loadFiles(browserModality, files)
    } catch (error) {
      if (controller.signal.aborted) setStatus('Workstation file loading cancelled.')
      else throw error
    } finally {
      if (activeLoadController === controller) activeLoadController = null
      cancelButton.textContent = 'Cancel'
      loadButton.disabled = false
    }
  }

  browser.querySelector('#server-browser-close')!.addEventListener('click', closeBrowser)
  browser.querySelector('#server-browser-cancel')!.addEventListener('click', closeBrowser)
  browser.querySelector<HTMLButtonElement>('#server-browser-up')!.addEventListener('click', event => listPath((event.currentTarget as HTMLButtonElement).dataset.parent ?? '').catch(error => setStatus(error.message, true)))
  loadButton.addEventListener('click', () => loadSelection().catch(error => setStatus(error.message, true)))
  browser.addEventListener('click', event => { if (event.target === browser) closeBrowser() })

  const exportBody = document.querySelector('#export-modal .modal-card')
  const panel = document.createElement('div'); panel.id = 'ba-export-panel'
  panel.innerHTML = `<div id="ba-destination-row"><label>Export destination <select id="ba-destination"><option value="local">This Mac</option><option value="workstation">Workstation</option></select></label></div><div id="ba-folder-controls"><button id="ba-folder-button" type="button">Choose local export folder</button><span id="ba-folder-path">Browser downloads if no folder is selected</span></div><div id="ba-export-status"></div>`
  exportBody?.insertBefore(panel, exportBody.querySelector('.export-grid'))
  const exportStatus = panel.querySelector<HTMLElement>('#ba-export-status')!
  const exportSetStatus = (message: string, error = false) => { exportStatus.textContent = message; exportStatus.style.color = error ? '#ff9696' : '#b7c1cf' }

  const folderOverlay = document.createElement('div'); folderOverlay.className = 'ba-overlay'
  folderOverlay.innerHTML = `<div class="ba-dialog" role="dialog" aria-modal="true" tabindex="-1"><header>Choose workstation export folder</header><div class="ba-nav"><button id="ba-remote-up">Up</button><button id="ba-remote-new">New folder</button><code id="ba-remote-path">/</code></div><div id="ba-remote-list" class="ba-list"></div><div id="ba-remote-msg" class="ba-msg"></div><div class="ba-actions"><button id="ba-remote-cancel">Cancel</button><button id="ba-remote-select" class="primary">Select this folder</button></div></div>`
  document.body.appendChild(folderOverlay)
  const renderPanel = () => {
    panel.querySelector<HTMLElement>('#ba-destination-row')!.style.display = state.remote ? 'block' : 'none'
    if (!state.remote) state.destination = 'local'
    ;(panel.querySelector<HTMLSelectElement>('#ba-destination')!).value = state.destination
    const button = panel.querySelector<HTMLButtonElement>('#ba-folder-button')!, path = panel.querySelector<HTMLElement>('#ba-folder-path')!
    if (state.remote && state.destination === 'workstation') { button.textContent = 'Choose workstation export folder'; path.textContent = state.remoteSelected ? (`/${state.remotePath}`.replace(/\/$/, '') || '/') : 'No workstation folder selected' }
    else { button.textContent = 'Choose local export folder'; path.textContent = state.localHandle ? state.localHandle.name : 'Browser downloads if no folder is selected' }
  }
  async function refreshConfig() { try { config = await getJson<RuntimeConfig>('/api/config'); state.remote = config.mode === 'remote' || config.remote === true; state.configLoaded = true } catch { state.remote = false; state.configLoaded = true } renderPanel() }
  const directDownload = (blob: Blob, filename: string) => { const url=URL.createObjectURL(blob), anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),3000) }
  async function saveLocal(blob: Blob, filename: string) { if (!state.localHandle) { directDownload(blob,filename); exportSetStatus(`Downloaded locally: ${filename}`); return } const file=await state.localHandle.getFileHandle(filename,{create:true}), writable=await file.createWritable();await writable.write(blob);await writable.close();exportSetStatus(`Saved locally: ${filename}`) }
  async function saveRemote(blob: Blob, filename: string) { if(!state.remoteSelected)throw new Error('Choose a workstation export folder before exporting.');const relative=joinPath(state.remotePath,filename)
    const send=async(overwrite:boolean)=>{const response=await fetch(`/api/save-file?path=${encodeURIComponent(relative)}&overwrite=${overwrite?'1':'0'}`,{method:'POST',headers:{'content-type':blob.type||'application/octet-stream'},body:blob});const payload=await response.json().catch(()=>({}));if(response.status===409)return{exists:true};if(!response.ok)throw new Error((payload as any).error||`Workstation save failed (${response.status})`);return payload as any}
    let result=await send(false);if(result.exists){if(!window.confirm(`/${relative} already exists. Replace it?`))throw new Error('Save cancelled.');result=await send(true)}exportSetStatus(`Saved to workstation: /${result.path||relative}`)}
  window.brainanaAlignSaveBlob = (blob, filename) => { state.chain = state.chain.then(async()=>{const safe=cleanName(filename);if(!state.configLoaded)await refreshConfig();exportSetStatus(`Saving ${safe}…`);if(state.remote&&state.destination==='workstation')await saveRemote(blob,safe);else await saveLocal(blob,safe)}).catch(error=>{exportSetStatus(error instanceof Error?error.message:String(error),true);console.error(error)});return state.chain }

  async function listRemote(path='') { const data=await getJson<ServerList>(`/api/save-list?path=${encodeURIComponent(path)}`);state.browsePath=data.path||'';folderOverlay.querySelector<HTMLElement>('#ba-remote-path')!.textContent=`/${state.browsePath}`.replace(/\/$/,'')||'/';const list=folderOverlay.querySelector<HTMLElement>('#ba-remote-list')!;list.innerHTML='';if(!data.entries.length)list.innerHTML='<div class="ba-empty">No subfolders</div>';for(const entry of data.entries.filter(e=>e.directory)){const button=document.createElement('button');button.className='ba-folder-row';button.innerHTML=`<span>📁</span><span>${escapeHtml(entry.name)}</span>`;button.addEventListener('click',()=>listRemote(entry.path).catch(error=>folderOverlay.querySelector<HTMLElement>('#ba-remote-msg')!.textContent=error.message));list.appendChild(button)};(folderOverlay.querySelector<HTMLButtonElement>('#ba-remote-up')!).disabled=!state.browsePath }
  const closeFolder=()=>folderOverlay.style.display='none'
  panel.querySelector<HTMLSelectElement>('#ba-destination')!.addEventListener('change',event=>{state.destination=(event.target as HTMLSelectElement).value as 'local'|'workstation';renderPanel()})
  panel.querySelector<HTMLButtonElement>('#ba-folder-button')!.addEventListener('click',async()=>{try{await refreshConfig();if(state.remote&&state.destination==='workstation'){folderOverlay.style.display='flex';await listRemote(state.remoteSelected?state.remotePath:'');return}if(!window.showDirectoryPicker){exportSetStatus('Local folder selection is unavailable in this browser. Files will download normally.');return}state.localHandle=await window.showDirectoryPicker({mode:'readwrite'});renderPanel()}catch(error){if((error as DOMException).name!=='AbortError')exportSetStatus(error instanceof Error?error.message:String(error),true)}})
  folderOverlay.querySelector('#ba-remote-cancel')!.addEventListener('click',closeFolder);folderOverlay.querySelector('#ba-remote-select')!.addEventListener('click',()=>{state.remotePath=state.browsePath;state.remoteSelected=true;closeFolder();renderPanel()})
  folderOverlay.querySelector('#ba-remote-up')!.addEventListener('click',()=>{const parts=state.browsePath.split('/').filter(Boolean);parts.pop();listRemote(parts.join('/')).catch(error=>exportSetStatus(error.message,true))})
  folderOverlay.querySelector('#ba-remote-new')!.addEventListener('click',async()=>{const name=window.prompt('Name for the new workstation folder:');if(!name)return;try{await getJson('/api/save-mkdir',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:joinPath(state.browsePath,cleanName(name))})});await listRemote(state.browsePath)}catch(error){folderOverlay.querySelector<HTMLElement>('#ba-remote-msg')!.textContent=error instanceof Error?error.message:String(error)}})

  refreshConfig().then(() => {
    if (config?.mode === 'remote') for (const modality of ['mri','ct'] as Modality[]) { const button=document.querySelector<HTMLButtonElement>(`#${modality}-server`)!;button.classList.remove('hidden');button.textContent=`Workstation ${modality.toUpperCase()}`;button.addEventListener('click',()=>openBrowser(modality).catch(error=>setStatus(error.message,true))) }
  })
}
