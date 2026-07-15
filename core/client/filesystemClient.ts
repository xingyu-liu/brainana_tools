// Source-scoped filesystem/browse client. Every call targets a specific sourceId so the
// UI can hold and query several sources at once.
import type { RuntimeClient } from './runtimeClient.ts'

export interface MonkeySummary {
  id: string
  label: string
  relativePath: string
}

export interface DirectoryEntry {
  name: string
  path: string
  isMonkey: boolean
}

export interface DirectoryListing {
  path: string
  displayPath: string
  parent: string
  selectable: boolean
  entries: DirectoryEntry[]
}

export interface ImportFileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number | null
  url: string | null
}

export interface ImportListing {
  path: string
  displayPath: string
  parent: string
  entries: ImportFileEntry[]
}

// The manifest shape is broad and consumed structurally by the viewer; keep it open here.
export type Manifest = Record<string, unknown> & { id: string; label: string; session: string | null }

export class FilesystemClient {
  #client: RuntimeClient

  constructor(client: RuntimeClient) {
    this.#client = client
  }

  #base(sourceId: string): string {
    return `/api/sources/${encodeURIComponent(sourceId)}`
  }

  listMonkeys(sourceId: string): Promise<MonkeySummary[]> {
    return this.#client.apiJson(`${this.#base(sourceId)}/monkeys`)
  }

  getManifest(sourceId: string, subjectId: string): Promise<Manifest> {
    return this.#client.apiJson(`${this.#base(sourceId)}/manifest/${encodeURIComponent(subjectId)}`)
  }

  listDirectories(sourceId: string, rel = ''): Promise<DirectoryListing> {
    return this.#client.apiJson(`${this.#base(sourceId)}/directories?path=${encodeURIComponent(rel)}`)
  }

  listImportFiles(sourceId: string, rel = '', query = ''): Promise<ImportListing> {
    return this.#client.apiJson(`${this.#base(sourceId)}/import-files?path=${encodeURIComponent(rel)}&q=${encodeURIComponent(query)}`)
  }
}
