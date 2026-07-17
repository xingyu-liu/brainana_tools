// Client-side registry of data sources. Mirrors the server's source registry and lets the
// UI create/list/delete local + remote sources without relaunching the app.
import type { RuntimeClient } from './runtimeClient.ts'

export interface SourceSummary {
  id: string
  type: 'local' | 'remote'
  /** Server-derived name (folder basename or user@host:root). Immutable identity shown to users. */
  label: string
  /** User-editable display name overriding `label` in pickers; null when unset. RAM-only server-side. */
  customLabel: string | null
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
    // The POST response IS the authoritative new-source summary; append it and emit rather
    // than firing a second GET to re-list what we already know.
    const created = await this.#client.apiJson<SourceSummary>('/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
    })
    this.#sources = [...this.#sources, created]
    this.#emit()
    return created
  }

  addLocal(path: string, label?: string): Promise<SourceSummary> {
    return this.add({ type: 'local', path, label })
  }

  addRemote(spec: Omit<RemoteSourceSpec, 'type'>): Promise<SourceSummary> {
    return this.add({ type: 'remote', ...spec })
  }

  /** Set (or clear, with null) a source's custom display label. Persists server-side for the
   *  session; the returned summary replaces the cached one and subscribers are notified. */
  async setLabel(id: string, label: string | null): Promise<SourceSummary> {
    const updated = await this.#client.apiJson<SourceSummary>(`/api/sources/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customLabel: label ?? '' }),
    })
    this.#sources = this.#sources.map((source) => (source.id === id ? updated : source))
    this.#emit()
    return updated
  }

  /** Close a source on the server and drop it from the registry. Throws if the server refuses. */
  async remove(id: string): Promise<void> {
    // apiJson throws (with the server's message) on a non-2xx DELETE, so a failed removal can no
    // longer masquerade as success. On success, drop it locally and emit — no re-list round-trip.
    await this.#client.apiJson(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE' })
    this.#sources = this.#sources.filter((source) => source.id !== id)
    this.#emit()
  }
}
