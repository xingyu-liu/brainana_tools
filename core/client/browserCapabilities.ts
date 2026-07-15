// Browser capability gate (plan §6.3). WebGL2 is the one hard requirement for NiiVue
// rendering; Chromium is the primary-tested baseline. This module is framework-agnostic
// so it can run before any UI framework mounts and show a friendly fallback.

export interface CapabilityReport {
  /** WebGL2 is available (the hard requirement). */
  webgl2: boolean
  /** Running on a Chromium-based browser (Chrome/Edge) — the primary-tested baseline. */
  chromium: boolean
  /** Human-readable reasons the environment is unsupported (empty when fully supported). */
  messages: string[]
}

/** Probe for a usable WebGL2 context without leaking the test canvas/context. */
export function hasWebGL2(): boolean {
  if (typeof document === 'undefined') return false
  const canvas = document.createElement('canvas')
  let gl: WebGL2RenderingContext | null = null
  try {
    gl = canvas.getContext('webgl2')
  } catch {
    gl = null
  }
  const ok = gl != null
  // Release the context promptly so probing never holds a GPU context open.
  gl?.getExtension('WEBGL_lose_context')?.loseContext()
  return ok
}

/** Best-effort Chromium detection via userAgentData, falling back to the UA string. */
export function isChromium(): boolean {
  if (typeof navigator === 'undefined') return false
  const uaData = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } }).userAgentData
  if (uaData?.brands?.length) {
    return uaData.brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand))
  }
  const ua = navigator.userAgent
  return /Chrome|Chromium|Edg\//.test(ua) && !/OPR\//.test(ua)
}

/** Assemble a capability report for the current environment. */
export function detectCapabilities(): CapabilityReport {
  const webgl2 = hasWebGL2()
  const chromium = isChromium()
  const messages: string[] = []
  if (!webgl2) {
    messages.push('This viewer requires WebGL2, which is unavailable or disabled in this browser. Try an up-to-date Chrome or Edge, or enable hardware acceleration.')
  }
  return { webgl2, chromium, messages }
}

/** True when the environment can run the viewer (WebGL2 present). */
export function isSupported(report: CapabilityReport = detectCapabilities()): boolean {
  return report.webgl2
}
