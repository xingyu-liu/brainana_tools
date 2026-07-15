// Client-side registry of data sources. Mirrors the server's source registry and lets the
// UI create/list/delete local + remote sources without relaunching the app.
import type { RuntimeClient } from './runtimeClient.ts'

export interface SourceSummary {
  id: string
  type: 'local' | 'remote'
  label: string
}

export interface LocalSourceSpec {
  type: 'local'
  path: string
  label?: string
}

export interface RemoteConnection {
  host: string
  port?: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface RemoteSourceSpec {
  type: 'remote'
  connection: RemoteConnection
  remoteRoot: string
  cacheRoot: string
  label?: string
}

export type SourceSpec = LocalSourceSpec | RemoteSourceSpec

type Listener = (sources: SourceSummary[]) => void

export class SourceManager {
  #client: RuntimeClient
  #sources: SourceSummary[] = []
  #listeners = new Set<Listener>()

  constructor(client: RuntimeClient) {
    this.#client = client
  }

  /** Subscribe to registry changes; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener)
    listener(this.#sources)
    return () => this.#listeners.delete(listener)
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.#sources)
  }

  list(): SourceSummary[] {
    return this.#sources
  }

  /** Refresh from the server (source of truth). */
  async refresh(): Promise<SourceSummary[]> {
    this.#sources = await this.#client.apiJson<SourceSummary[]>('/api/sources')
    this.#emit()
    return this.#sources
  }

  /** Open a source on the server and add it to the registry. */
  async add(spec: SourceSpec): Promise<SourceSummary> {
    const created = await this.#client.apiJson<SourceSummary>('/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
    })
    await this.refresh()
    return created
  }

  addLocal(path: string, label?: string): Promise<SourceSummary> {
    return this.add({ type: 'local', path, label })
  }

  addRemote(spec: Omit<RemoteSourceSpec, 'type'>): Promise<SourceSummary> {
    return this.add({ type: 'remote', ...spec })
  }

  /** Close a source on the server and drop it from the registry. */
  async remove(id: string): Promise<void> {
    await this.#client.apiFetch(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await this.refresh()
  }
}
