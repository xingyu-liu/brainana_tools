export type GraphicsSupport = {
  webgl2: boolean
  reason?: string
  renderer?: string
}

export function detectGraphicsSupport(): GraphicsSupport {
  const canvas = document.createElement('canvas')
  try {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      failIfMajorPerformanceCaveat: false,
    })
    if (!gl) return { webgl2: false, reason: 'WebGL 2 is unavailable or disabled in this browser.' }
    const renderer = String(gl.getParameter(gl.RENDERER) ?? '')
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return { webgl2: true, renderer }
  } catch (error) {
    return { webgl2: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function renderGraphicsFailure(support: GraphicsSupport): void {
  document.body.innerHTML = `
    <main id="graphics-compatibility-error" role="alert" style="max-width:760px;margin:48px auto;padding:24px;font-family:system-ui,sans-serif;line-height:1.45">
      <h1>Brainana Viewer cannot start graphics</h1>
      <p>This browser did not provide the WebGL 2 graphics support required for neuroimaging display.</p>
      <p><strong>Details:</strong> ${escapeHtml(support.reason ?? 'Unknown graphics initialization failure')}</p>
      <p>Try enabling hardware acceleration, updating the browser or graphics driver, or opening the Viewer in another supported browser.</p>
    </main>`
}

export function installWebGLContextLifecycleReporting(): void {
  const attach = (canvas: HTMLCanvasElement) => {
    if (canvas.dataset.brainanaContextLifecycle === '1') return
    canvas.dataset.brainanaContextLifecycle = '1'
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      document.body.dataset.webglContext = 'lost'
      console.error('Brainana Viewer WebGL context lost')
    })
    canvas.addEventListener('webglcontextrestored', () => {
      document.body.dataset.webglContext = 'restored'
      console.info('Brainana Viewer WebGL context restored')
      window.dispatchEvent(new CustomEvent('brainana:webgl-restored'))
    })
  }
  document.querySelectorAll('canvas').forEach((node) => attach(node as HTMLCanvasElement))
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof HTMLCanvasElement) attach(node)
      if (node instanceof Element) node.querySelectorAll('canvas').forEach((canvas) => attach(canvas as HTMLCanvasElement))
    }
  }).observe(document.documentElement, { childList: true, subtree: true })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character)
}
