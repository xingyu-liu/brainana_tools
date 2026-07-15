type InitMessage = {
  type: 'init'
  leftWhite: Float32Array
  leftPial: Float32Array
  rightWhite: Float32Array
  rightPial: Float32Array
  origin: number[]
  axisX: number[]
  axisY: number[]
  axisZ: number[]
  dims: [number, number, number]
  sampleCount: number
}
type AtlasMessage = { type: 'projectAtlas'; id: number; values: Float32Array }
type FunctionMessage = {
  type: 'projectFunction'
  id: number
  values: Float32Array
  thresholds: Float32Array | null
  cutoff: number
  mode: 'polar' | 'eccentricity' | 'somatotopy'
}
type ImportedMessage = { type: 'projectImported'; id: number; values: Float32Array; method: 'mean' | 'maximum' | 'maxabs' | 'modal'; zeroBackground: boolean }
type Message = InitMessage | AtlasMessage | FunctionMessage | ImportedMessage

type HemisphereCache = { indices: Int32Array; vertexCount: number; sampleCount: number }
let leftCache: HemisphereCache | null = null
let rightCache: HemisphereCache | null = null
const weights = new Float32Array([1, 2, 3, 4, 5, 4, 3, 2, 1])

function postProgress(id: number, progress: number, label: string) {
  postMessage({ type: 'progress', id, progress, label })
}

function buildCache(
  white: Float32Array,
  pial: Float32Array,
  origin: number[],
  axisX: number[],
  axisY: number[],
  axisZ: number[],
  dims: [number, number, number],
  sampleCount: number,
): HemisphereCache {
  const vertexCount = Math.min(white.length, pial.length) / 3
  const indices = new Int32Array(vertexCount * sampleCount)
  indices.fill(-1)
  const [nx, ny, nz] = dims
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const base = vertex * 3
    const wx = white[base], wy = white[base + 1], wz = white[base + 2]
    const px = pial[base], py = pial[base + 1], pz = pial[base + 2]
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const t = sampleCount === 1 ? 0.5 : (sample + 1) / (sampleCount + 1)
      const x = wx + (px - wx) * t
      const y = wy + (py - wy) * t
      const z = wz + (pz - wz) * t
      const i = Math.round(origin[0] + x * axisX[0] + y * axisY[0] + z * axisZ[0])
      const j = Math.round(origin[1] + x * axisX[1] + y * axisY[1] + z * axisZ[1])
      const k = Math.round(origin[2] + x * axisX[2] + y * axisY[2] + z * axisZ[2])
      if (i >= 0 && i < nx && j >= 0 && j < ny && k >= 0 && k < nz) {
        indices[vertex * sampleCount + sample] = i + j * nx + k * nx * ny
      }
    }
  }
  return { indices, vertexCount, sampleCount }
}

function projectAtlas(cache: HemisphereCache, values: Float32Array): Float32Array {
  const output = new Float32Array(cache.vertexCount)
  const counts = new Map<number, number>()
  for (let vertex = 0; vertex < cache.vertexCount; vertex += 1) {
    counts.clear()
    let bestValue = 0
    let bestWeight = 0
    for (let sample = 0; sample < cache.sampleCount; sample += 1) {
      const index = cache.indices[vertex * cache.sampleCount + sample]
      if (index < 0 || index >= values.length) continue
      const value = Math.round(values[index])
      if (!Number.isFinite(value) || value === 0) continue
      const weight = weights[sample] ?? 1
      const total = (counts.get(value) ?? 0) + weight
      counts.set(value, total)
      if (total > bestWeight) {
        bestWeight = total
        bestValue = value
      }
    }
    output[vertex] = bestValue
  }
  return output
}

function projectFunctional(
  cache: HemisphereCache,
  values: Float32Array,
  thresholds: Float32Array | null,
  cutoff: number,
  mode: 'polar' | 'eccentricity' | 'somatotopy',
): Float32Array {
  const output = new Float32Array(cache.vertexCount)
  output.fill(-1000)
  const binCount = 256
  const votes = new Float32Array(binCount)
  const sumSin = new Float32Array(binCount)
  const sumCos = new Float32Array(binCount)
  const sums = new Float32Array(binCount)
  const sumWeights = new Float32Array(binCount)
  for (let vertex = 0; vertex < cache.vertexCount; vertex += 1) {
    votes.fill(0); sumSin.fill(0); sumCos.fill(0); sums.fill(0); sumWeights.fill(0)
    for (let sample = 0; sample < cache.sampleCount; sample += 1) {
      const index = cache.indices[vertex * cache.sampleCount + sample]
      if (index < 0 || index >= values.length) continue
      const value = Number(values[index])
      const threshold = thresholds ? Number(thresholds[index]) : 1
      if (!Number.isFinite(value) || !Number.isFinite(threshold) || threshold < cutoff) continue
      const weight = weights[sample] ?? 1
      let bin: number
      if (mode === 'polar') {
        const wrapped = ((value + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
        bin = Math.min(binCount - 1, Math.floor(wrapped / (2 * Math.PI) * binCount))
        sumSin[bin] += Math.sin(value) * weight
        sumCos[bin] += Math.cos(value) * weight
      } else {
        const maximum = mode === 'somatotopy' ? 100 : 10
        if (value < 0 || value > maximum) continue
        bin = Math.min(binCount - 1, Math.floor(value / maximum * binCount))
        sums[bin] += value * weight
        sumWeights[bin] += weight
      }
      votes[bin] += weight
    }
    let bestBin = -1
    let bestVote = 0
    for (let bin = 0; bin < binCount; bin += 1) {
      if (votes[bin] > bestVote) { bestVote = votes[bin]; bestBin = bin }
    }
    if (bestBin >= 0) {
      output[vertex] = mode === 'polar'
        ? Math.atan2(sumSin[bestBin], sumCos[bestBin])
        : sums[bestBin] / Math.max(sumWeights[bestBin], 1e-6)
    }
  }
  return output
}


function projectImported(cache: HemisphereCache, values: Float32Array, method: 'mean' | 'maximum' | 'maxabs' | 'modal', zeroBackground: boolean): Float32Array {
  if (method === 'modal') return projectAtlas(cache, values)
  const output = new Float32Array(cache.vertexCount)
  for (let vertex = 0; vertex < cache.vertexCount; vertex += 1) {
    let sum = 0
    let weightSum = 0
    let selected = 0
    let selectedMagnitude = -1
    let found = false
    for (let sample = 0; sample < cache.sampleCount; sample += 1) {
      const index = cache.indices[vertex * cache.sampleCount + sample]
      if (index < 0 || index >= values.length) continue
      const value = Number(values[index])
      if (!Number.isFinite(value) || (zeroBackground && value === 0)) continue
      const weight = weights[sample] ?? 1
      found = true
      if (method === 'mean') {
        sum += value * weight
        weightSum += weight
      } else if (method === 'maximum') {
        if (selectedMagnitude < 0 || value > selected) selected = value
        selectedMagnitude = 1
      } else {
        const magnitude = Math.abs(value)
        if (magnitude > selectedMagnitude) { selectedMagnitude = magnitude; selected = value }
      }
    }
    output[vertex] = !found ? 0 : method === 'mean' ? sum / Math.max(weightSum, 1e-6) : selected
  }
  return output
}

self.onmessage = (event: MessageEvent<Message>) => {
  const message = event.data
  if (message.type === 'init') {
    leftCache = buildCache(message.leftWhite, message.leftPial, message.origin, message.axisX, message.axisY, message.axisZ, message.dims, message.sampleCount)
    postMessage({ type: 'progress', id: 0, progress: 50, label: 'Building right ribbon cache…' })
    rightCache = buildCache(message.rightWhite, message.rightPial, message.origin, message.axisX, message.axisY, message.axisZ, message.dims, message.sampleCount)
    postMessage({ type: 'ready', leftVertices: leftCache.vertexCount, rightVertices: rightCache.vertexCount })
    return
  }
  if (!leftCache || !rightCache) {
    postMessage({ type: 'error', id: message.id, message: 'Ribbon cache is not initialized' })
    return
  }
  try {
    postProgress(message.id, 10, 'Projecting left hemisphere…')
    const left = message.type === 'projectAtlas'
      ? projectAtlas(leftCache, message.values)
      : message.type === 'projectFunction'
        ? projectFunctional(leftCache, message.values, message.thresholds, message.cutoff, message.mode)
        : projectImported(leftCache, message.values, message.method, message.zeroBackground)
    postProgress(message.id, 55, 'Projecting right hemisphere…')
    const right = message.type === 'projectAtlas'
      ? projectAtlas(rightCache, message.values)
      : message.type === 'projectFunction'
        ? projectFunctional(rightCache, message.values, message.thresholds, message.cutoff, message.mode)
        : projectImported(rightCache, message.values, message.method, message.zeroBackground)
    postMessage({ type: 'result', id: message.id, left, right })
  } catch (error) {
    postMessage({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error) })
  }
}
