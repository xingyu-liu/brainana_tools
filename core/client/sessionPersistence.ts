// Remember recently-used source specs across launches (localStorage).
// SECURITY: secrets (passwords, private keys, passphrases) are NEVER persisted — only the
// non-sensitive shape needed to re-offer a source (type, path/host/user/root, label).
import type { LocalSourceSpec, RemoteSourceSpec } from './sourceManager.ts'

const KEY = 'brainana.recentSources.v1'
const MAX = 10

export interface RecentLocal {
  type: 'local'
  path: string
  label?: string
}

export interface RecentRemote {
  type: 'remote'
  host: string
  port?: number
  username: string
  remoteRoot: string
  label?: string
}

export type RecentSource = RecentLocal | RecentRemote

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null // Safari private mode et al.
  }
}

export function loadRecent(): RecentSource[] {
  const store = storage()
  if (!store) return []
  try {
    const raw = store.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as RecentSource[]) : []
  } catch {
    return []
  }
}

function keyOf(s: RecentSource): string {
  return s.type === 'local' ? `local:${s.path}` : `remote:${s.username}@${s.host}:${s.remoteRoot}`
}

/** Record a source spec (stripping secrets) at the front of the recents list. */
export function rememberLocal(spec: LocalSourceSpec): void {
  save({ type: 'local', path: spec.path, label: spec.label })
}

export function rememberRemote(spec: RemoteSourceSpec): void {
  save({
    type: 'remote',
    host: spec.connection.host,
    port: spec.connection.port,
    username: spec.connection.username,
    remoteRoot: spec.remoteRoot,
    label: spec.label,
  })
}

function save(entry: RecentSource): void {
  const store = storage()
  if (!store) return
  const existing = loadRecent().filter((s) => keyOf(s) !== keyOf(entry))
  const next = [entry, ...existing].slice(0, MAX)
  try {
    store.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage full / disabled — recents are best-effort.
  }
}

export function clearRecent(): void {
  storage()?.removeItem(KEY)
}
