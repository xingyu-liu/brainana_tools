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

/** Forget a single recent entry (matched by identity, ignoring its label). No-op without storage. */
export function forgetRecent(entry: RecentSource): void {
  const store = storage()
  if (!store) return
  const next = loadRecent().filter((s) => keyOf(s) !== keyOf(entry))
  try {
    store.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage full / disabled — best-effort.
  }
}

export function clearRecent(): void {
  storage()?.removeItem(KEY)
}

// --- Remote connection profiles ---------------------------------------------------------------
// A connection profile is about a host (host/port/user), independent of any dataset path — saved
// automatically on a successful Connect so the user can reload prior connections. Like recents,
// secrets are NEVER stored: only host/port/username. Separate store from RecentSource.
const PROFILES_KEY = 'brainana.remoteProfiles.v1'

export interface RemoteProfile {
  host: string
  port?: number
  username: string
}

function profileKey(p: RemoteProfile): string {
  return `${p.username}@${p.host}:${p.port ?? 22}`
}

export function loadProfiles(): RemoteProfile[] {
  const store = storage()
  if (!store) return []
  try {
    const raw = store.getItem(PROFILES_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as RemoteProfile[]) : []
  } catch {
    return []
  }
}

/** Save (or move-to-front / update) a connection profile, keyed by host+port+user. */
export function rememberProfile(profile: RemoteProfile): void {
  const store = storage()
  if (!store) return
  const clean: RemoteProfile = { host: profile.host, port: profile.port, username: profile.username }
  const next = [clean, ...loadProfiles().filter((p) => profileKey(p) !== profileKey(clean))].slice(0, MAX)
  try {
    store.setItem(PROFILES_KEY, JSON.stringify(next))
  } catch {
    // Storage full / disabled — best-effort.
  }
}

/** Forget a single connection profile (matched by host+port+user). */
export function forgetProfile(profile: RemoteProfile): void {
  const store = storage()
  if (!store) return
  const next = loadProfiles().filter((p) => profileKey(p) !== profileKey(profile))
  try {
    store.setItem(PROFILES_KEY, JSON.stringify(next))
  } catch {
    // Storage full / disabled — best-effort.
  }
}
