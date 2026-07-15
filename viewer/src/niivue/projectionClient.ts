// Main-thread wrapper around the projection worker. Loads volumes once (transferred),
// builds the ribbon once, and offers Promise-based project calls with single-in-flight
// latest-wins per channel (so dragging the F-threshold doesn't queue a backlog).
import type { WorldToVox, FunctionMode } from '../data/projection.ts'

export interface HemiPts {
  whitePts: Float32Array
  pialPts: Float32Array
  map: WorldToVox
}
export interface ProjectionResult {
  left: Float32Array
  right: Float32Array
}

interface ResultMsg {
  type: 'result' | 'ribbonReady'
  jobId?: number
  left?: Float32Array
  right?: Float32Array
}

export class ProjectionClient {
  #worker: Worker
  #jobId = 0
  #latest = new Map<string, number>()
  #pending = new Map<number, (r: ProjectionResult | null) => void>()
  #ribbonReady: Promise<void>
  #resolveRibbon: () => void = () => {}

  constructor() {
    this.#worker = new Worker(new URL('../workers/projection.worker.ts', import.meta.url), { type: 'module' })
    this.#ribbonReady = new Promise((res) => {
      this.#resolveRibbon = res
    })
    this.#worker.onmessage = (e: MessageEvent<ResultMsg>) => {
      const m = e.data
      if (m.type === 'ribbonReady') {
        this.#resolveRibbon()
        return
      }
      if (m.type === 'result' && m.jobId != null) {
        const cb = this.#pending.get(m.jobId)
        if (cb) {
          this.#pending.delete(m.jobId)
          cb({ left: m.left as Float32Array, right: m.right as Float32Array })
        }
      }
    }
  }

  buildRibbon(left: HemiPts, right: HemiPts): Promise<void> {
    this.#ribbonReady = new Promise((res) => {
      this.#resolveRibbon = res
    })
    this.#worker.postMessage({ type: 'buildRibbon', left, right })
    return this.#ribbonReady
  }

  // Copy so the caller's typed array is not neutered by the transfer.
  loadVolume(id: string, data: Float32Array): void {
    const copy = data.slice()
    this.#worker.postMessage({ type: 'loadVolume', id, buffer: copy.buffer }, [copy.buffer])
  }

  #project(channel: string, msg: Record<string, unknown>): Promise<ProjectionResult | null> {
    const jobId = ++this.#jobId
    this.#latest.set(channel, jobId)
    return this.#ribbonReady.then(
      () =>
        new Promise<ProjectionResult | null>((resolve) => {
          this.#pending.set(jobId, (r) => {
            resolve(this.#latest.get(channel) === jobId ? r : null) // drop stale
          })
          this.#worker.postMessage({ ...msg, jobId })
        }),
    )
  }

  projectAtlas(id: string): Promise<ProjectionResult | null> {
    return this.#project('atlas', { type: 'projectAtlas', id })
  }

  projectFunction(valueId: string, thresholdId: string, cutoff: number, mode: FunctionMode, cap: number): Promise<ProjectionResult | null> {
    return this.#project('function', { type: 'projectFunction', valueId, thresholdId, cutoff, mode, cap })
  }

  terminate(): void {
    this.#worker.terminate()
  }
}
