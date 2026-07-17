// Source-scoped filesystem/browse client. Every call targets a specific sourceId so the
// UI can hold and query several sources at once.
import { sourceBase, type RuntimeClient } from './runtimeClient.ts'
import type { RemoteConnection } from './sourceManager.ts'

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

export interface BrowseEntry {
  name: string
  path: string
  isDir: boolean
}

export interface BrowseListing {
  path: string
  // Absolute parent path, or null when `path` is a filesystem root.
  parent: string | null
  entries: BrowseEntry[]
}

// The manifest shape is broad and consumed structurally by the viewer; keep it open here.
export type Manifest = Record<string, unknown> & { id: string; label: string; session: string | null }

export class FilesystemClient {
  #client: RuntimeClient

  constructor(client: RuntimeClient) {
    this.#client = client
  }

  listMonkeys(sourceId: string): Promise<MonkeySummary[]> {
    return this.#client.apiJson(`${sourceBase(sourceId)}/monkeys`)
  }

  getManifest(sourceId: string, subjectId: string): Promise<Manifest> {
    return this.#client.apiJson(`${sourceBase(sourceId)}/manifest/${encodeURIComponent(subjectId)}`)
  }

  listDirectories(sourceId: string, rel = ''): Promise<DirectoryListing> {
    return this.#client.apiJson(`${sourceBase(sourceId)}/directories?path=${encodeURIComponent(rel)}`)
  }

  listImportFiles(sourceId: string, rel = '', query = ''): Promise<ImportListing> {
    return this.#client.apiJson(`${sourceBase(sourceId)}/import-files?path=${encodeURIComponent(rel)}&q=${encodeURIComponent(query)}`)
  }

  // Browse absolute server directories for the local-source folder picker (unscoped: there is
  // no source yet). Empty `abs` lets the server default to its home directory.
  browseFs(abs = ''): Promise<BrowseListing> {
    return this.#client.apiJson(`/api/fs/browse?path=${encodeURIComponent(abs)}`)
  }

  // Open a pre-add SFTP connection for interactive remote browsing; returns a session token used
  // by browseRemote/disconnectRemote. The password is sent once and never persisted server-side.
  connectRemote(connection: RemoteConnection): Promise<{ token: string }> {
    return this.#client.apiJson('/api/remote/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection }),
    })
  }

  // List directories under an absolute remote path on an open connection. Empty `abs` starts at the
  // remote home directory (server-resolved). Same shape as browseFs so the picker is shared.
  browseRemote(token: string, abs = ''): Promise<BrowseListing> {
    return this.#client.apiJson(`/api/remote/browse?token=${encodeURIComponent(token)}&path=${encodeURIComponent(abs)}`)
  }

  // Close a pre-add remote browse session (best-effort; frees the server-side SFTP socket).
  disconnectRemote(token: string): Promise<{ ok: boolean }> {
    return this.#client.apiJson('/api/remote/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
  }
}
