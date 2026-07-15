// Export destinations. The primary path is SERVER-SIDE export (identical for local and
// remote sources, no per-browser branching). A universal ZIP download is the fallback when
// there is no writable source (or the user just wants a bundle).
import { zipSync, type Zippable } from 'fflate'
import type { RuntimeClient } from './runtimeClient.ts'

export interface SaveResult {
  path: string
  bytes?: number
  exists?: boolean
}

export class ServerExport {
  #client: RuntimeClient

  constructor(client: RuntimeClient) {
    this.#client = client
  }

  #base(sourceId: string): string {
    return `/api/sources/${encodeURIComponent(sourceId)}`
  }

  listFolders(sourceId: string, rel = ''): Promise<{ path: string; entries: Array<{ name: string; path: string }> }> {
    return this.#client.apiJson(`${this.#base(sourceId)}/save-list?path=${encodeURIComponent(rel)}`)
  }

  mkdir(sourceId: string, rel: string): Promise<{ path: string }> {
    return this.#client.apiJson(`${this.#base(sourceId)}/save-mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: rel }),
    })
  }

  /** Write a file into the source. Returns { exists:true } (409) when overwrite is refused. */
  async saveFile(sourceId: string, rel: string, data: BlobPart, overwrite = false): Promise<SaveResult> {
    const res = await this.#client.apiFetch(`${this.#base(sourceId)}/save-file?path=${encodeURIComponent(rel)}&overwrite=${overwrite ? '1' : '0'}`, {
      method: 'POST',
      body: new Blob([data]),
    })
    const body = (await res.json()) as SaveResult & { error?: string }
    if (res.status === 409) return { path: body.path ?? rel, exists: true }
    if (!res.ok) throw new Error(body.error ?? `Save failed (${res.status})`)
    return body
  }
}

/** Build a ZIP Blob from named byte payloads (universal client-side fallback). */
export function buildZip(files: Record<string, Uint8Array>): Blob {
  const zipped = zipSync(files as Zippable)
  // Copy into a fresh ArrayBuffer-backed view so the Blob owns standalone bytes.
  return new Blob([zipped.slice()], { type: 'application/zip' })
}

/** Trigger a browser download of a Blob under `filename`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
