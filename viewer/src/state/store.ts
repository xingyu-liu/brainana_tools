// Tiny typed observable store, framework-free. Two design points from the audit:
//  1. SELECTIVE subscriptions per key, so a change to one field notifies only its listeners.
//  2. A separate HIGH-FREQUENCY crosshair channel: crosshair moves happen at pointer-move
//     rate and must update only the coordinate/report text nodes, never trigger a heavy render.
// Heavy consumers coalesce their work into a single rAF (see subscribeBatched).

export type MarkerMode = 'crosshair3d' | 'nearestNode'
export type Layout = 'grid' | 'row' | 'column'

export interface Crosshair {
  mm: [number, number, number]
  vox: [number, number, number] | null
  hemisphere: 'Left' | 'Right' | null
}

export interface ViewerState {
  sourceId: string | null
  subjectId: string | null
  volumeKey: string | null // manifest.volumes[].key of the base volume
  surfaceKind: string // pial | white | smoothwm | inflated | veryinflated | sphere
  volumeVisible: boolean
  surfaceVisible: boolean
  layout: Layout
  markerMode: MarkerMode
  activeAtlas: string | null // e.g. 'ARM' | 'D99'
  atlasLevel: number // ARM level 1..6
  activeFunction: 'retinotopy' | 'somatotopy' | null
}

type Listener<T> = (value: T, prev: T) => void

// Independent per-key event channels over a plain object.
export class Store<S extends object> {
  #state: S
  #listeners = new Map<keyof S, Set<Listener<unknown>>>()

  constructor(initial: S) {
    this.#state = { ...initial }
  }

  get<K extends keyof S>(key: K): S[K] {
    return this.#state[key]
  }

  snapshot(): Readonly<S> {
    return this.#state
  }

  set<K extends keyof S>(key: K, value: S[K]): void {
    const prev = this.#state[key]
    if (Object.is(prev, value)) return
    this.#state[key] = value
    const set = this.#listeners.get(key)
    if (set) for (const fn of set) (fn as Listener<S[K]>)(value, prev)
  }

  update(patch: Partial<S>): void {
    for (const key of Object.keys(patch) as Array<keyof S>) this.set(key, patch[key] as S[typeof key])
  }

  // Subscribe to one key; returns unsubscribe. Fires immediately with the current value.
  on<K extends keyof S>(key: K, fn: Listener<S[K]>): () => void {
    let set = this.#listeners.get(key)
    if (!set) {
      set = new Set()
      this.#listeners.set(key, set)
    }
    set.add(fn as Listener<unknown>)
    fn(this.#state[key], this.#state[key])
    return () => set!.delete(fn as Listener<unknown>)
  }
}

// A high-frequency channel decoupled from the store's keyed events: crosshair updates fan
// out synchronously to lightweight text-only subscribers (coordinate/anatomy/function reports).
export class Channel<T> {
  #subs = new Set<(v: T) => void>()
  #last: T | null = null

  emit(value: T): void {
    this.#last = value
    for (const fn of this.#subs) fn(value)
  }

  subscribe(fn: (v: T) => void): () => void {
    this.#subs.add(fn)
    if (this.#last != null) fn(this.#last)
    return () => this.#subs.delete(fn)
  }
}

// Coalesce many rapid calls into one rAF tick (falls back to a microtask off-DOM).
export function rafBatch(fn: () => void): () => void {
  let scheduled = false
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16)
  return () => {
    if (scheduled) return
    scheduled = true
    raf(() => {
      scheduled = false
      fn()
    })
  }
}

export function createViewerStore(): { store: Store<ViewerState>; crosshair: Channel<Crosshair> } {
  const store = new Store<ViewerState>({
    sourceId: null,
    subjectId: null,
    volumeKey: null,
    surfaceKind: 'inflated',
    volumeVisible: true,
    surfaceVisible: true,
    layout: 'column',
    markerMode: 'crosshair3d',
    activeAtlas: null,
    atlasLevel: 6,
    activeFunction: null,
  })
  return { store, crosshair: new Channel<Crosshair>() }
}
