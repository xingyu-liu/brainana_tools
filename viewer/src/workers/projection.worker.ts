// Web Worker: builds the ribbon cache once, then projects atlas/function volumes onto the
// surface. Volumes are cached in the worker (sent once as transferable ArrayBuffers); project
// calls pass only ids + scalar params, and results return as transferred Float32Arrays.
import { buildRibbon, projectAtlas, projectFunction, type WorldToVox, type FunctionMode } from '../data/projection.ts'

interface BuildMsg {
  type: 'buildRibbon'
  left: { whitePts: Float32Array; pialPts: Float32Array; map: WorldToVox }
  right: { whitePts: Float32Array; pialPts: Float32Array; map: WorldToVox }
}
interface LoadVolumeMsg {
  type: 'loadVolume'
  id: string
  buffer: ArrayBuffer // Float32
}
interface ProjectAtlasMsg {
  type: 'projectAtlas'
  jobId: number
  id: string
}
interface ProjectFunctionMsg {
  type: 'projectFunction'
  jobId: number
  valueId: string
  thresholdId: string
  cutoff: number
  mode: FunctionMode
  cap: number
}
type InMsg = BuildMsg | LoadVolumeMsg | ProjectAtlasMsg | ProjectFunctionMsg

interface WorkerCtx {
  onmessage: ((e: { data: InMsg }) => void) | null
  postMessage: (msg: unknown, transfer?: Transferable[]) => void
}
const ctx = self as unknown as WorkerCtx

let leftRibbon: Int32Array | null = null
let rightRibbon: Int32Array | null = null
let leftCount = 0
let rightCount = 0
const volumes = new Map<string, Float32Array>()

ctx.onmessage = (e) => {
  const msg = e.data
  if (msg.type === 'buildRibbon') {
    leftRibbon = buildRibbon(msg.left)
    rightRibbon = buildRibbon(msg.right)
    leftCount = msg.left.whitePts.length / 3
    rightCount = msg.right.whitePts.length / 3
    ctx.postMessage({ type: 'ribbonReady' })
    return
  }
  if (msg.type === 'loadVolume') {
    volumes.set(msg.id, new Float32Array(msg.buffer))
    return
  }
  if (!leftRibbon || !rightRibbon) return
  if (msg.type === 'projectAtlas') {
    const vol = volumes.get(msg.id)
    if (!vol) return
    const left = projectAtlas(leftRibbon, vol, leftCount)
    const right = projectAtlas(rightRibbon, vol, rightCount)
    ctx.postMessage({ type: 'result', jobId: msg.jobId, left, right }, [left.buffer, right.buffer])
    return
  }
  if (msg.type === 'projectFunction') {
    const values = volumes.get(msg.valueId)
    const thr = volumes.get(msg.thresholdId)
    if (!values || !thr) return
    const left = projectFunction(leftRibbon, values, thr, msg.cutoff, msg.mode, msg.cap, leftCount)
    const right = projectFunction(rightRibbon, values, thr, msg.cutoff, msg.mode, msg.cap, rightCount)
    ctx.postMessage({ type: 'result', jobId: msg.jobId, left, right }, [left.buffer, right.buffer])
    return
  }
}
