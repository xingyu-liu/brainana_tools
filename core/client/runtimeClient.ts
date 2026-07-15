// Framework-agnostic client for the core server runtime.
// Reads the per-launch session token from the <meta name="brainana-token"> tag the server
// templates into index.html (loopback only), and injects it on every request — so the
// token is never placed in a navigable URL or browser history.

export interface VersionInfo {
  app: string
  version: string
  buildId: string
}

export interface RuntimeInfo extends VersionInfo {
  unbound: boolean
  capabilities: { serverSideExport: boolean; multiSource: boolean; remoteRuntime: boolean }
  sources: Array<{ id: string; type: string; label: string }>
}

function readToken(): string | null {
  if (typeof document === 'undefined') return null
  const meta = document.querySelector('meta[name="brainana-token"]')
  return meta?.getAttribute('content') ?? null
}

export class RuntimeClient {
  readonly token: string | null

  constructor(token: string | null = readToken()) {
    this.token = token
  }

  /** Authenticated fetch against an /api or /brainana-data path. */
  async apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`)
    return fetch(path, { ...init, headers })
  }

  /** Authenticated fetch that parses JSON and throws on non-2xx with the server message. */
  async apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.apiFetch(path, init)
    const text = await res.text()
    const body = text ? JSON.parse(text) : null
    if (!res.ok) {
      const message = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `Request failed (${res.status})`
      throw new Error(message)
    }
    return body as T
  }

  /**
   * Raw data URL for NiiVue / the projection worker to fetch. These loaders cannot set
   * request headers, so authentication rides on the loopback session cookie the server
   * sets on index.html (same-origin, sent automatically). Returned unchanged — importantly,
   * no `?token=` query is appended, which would corrupt NiiVue's file-extension detection.
   * The `?raw` fallback query param remains accepted server-side if a cookie is unavailable.
   */
  dataUrl(dataUrl: string): string {
    return dataUrl
  }

  health(): Promise<{ ok: boolean } & VersionInfo> {
    return this.apiJson('/api/health')
  }

  version(): Promise<VersionInfo> {
    return this.apiJson('/api/version')
  }

  runtime(): Promise<RuntimeInfo> {
    return this.apiJson('/api/runtime')
  }
}
