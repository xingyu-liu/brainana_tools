import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../source/package.json', import.meta.url))
const { chromium, firefox, webkit } = require('playwright-core')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'source', 'dist')
const required = new Set((process.env.BRAINANA_REQUIRE_BROWSER_ENGINES || '').split(',').map(s => s.trim()).filter(Boolean))
const engines = [
  ['chromium', chromium, process.env.CHROMIUM_PATH || '/usr/bin/chromium'],
  ['firefox', firefox, process.env.FIREFOX_PATH || firefox.executablePath()],
  ['webkit', webkit, process.env.WEBKIT_PATH || webkit.executablePath()],
]
const results = []
for (const [name, engine, executablePath] of engines) {
  if (!executablePath || !fs.existsSync(executablePath)) {
    results.push({ engine: name, status: 'not-installed', executablePath })
    if (required.has(name)) throw new Error(`${name} is required but its browser executable is unavailable: ${executablePath}`)
    continue
  }
  let browser
  try {
    browser = await engine.launch({ executablePath, headless: true, args: name === 'chromium' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [] })
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const indexHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
    const cssName = indexHtml.match(/href="\/assets\/([^"]+\.css)"/)?.[1]
    const jsName = indexHtml.match(/src="\/assets\/([^"]+\.js)"/)?.[1]
    assert.ok(cssName && jsName)
    await page.setContent(`<style>${fs.readFileSync(path.join(dist,'assets',cssName),'utf8')}</style><div id="app"></div>`)
    await page.evaluate(() => {
      window.location.hash = `session=${'b'.repeat(64)}`
      window.fetch = async input => {
        const url = typeof input === 'string' ? input : input.url
        if (url === '/api/config') return new Response(JSON.stringify({ enabled: true, mode: 'local', label: 'This Mac' }), { headers: { 'content-type': 'application/json' } })
        throw new Error(`Unexpected fetch: ${url}`)
      }
    })
    await page.addScriptTag({ content: fs.readFileSync(path.join(dist,'assets',jsName),'utf8'), type: 'module' })
    await page.waitForSelector('#mri-sagittal-placeholder')
    for (const plane of ['sagittal','coronal','axial']) {
      assert.equal((await page.locator(`#mri-${plane}-placeholder`).textContent())?.trim(), 'No MRI selected')
      assert.equal((await page.locator(`#ct-${plane}-placeholder`).textContent())?.trim(), 'No CT selected')
      assert.equal(await page.locator(`#mri-${plane}-window-layer`).count(), 1)
      assert.equal(await page.locator(`#ct-${plane}-window-layer`).count(), 1)
    }
    const caps = await page.evaluate(() => ({
      ua: navigator.userAgent,
      pointerEvents: 'PointerEvent' in window,
      downloads: 'download' in document.createElement('a'),
      webgl2: !!document.createElement('canvas').getContext('webgl2'),
      devicePixelRatio,
    }))
    assert.equal(caps.pointerEvents, true, `${name} lacks Pointer Events`)
    assert.equal(caps.downloads, true, `${name} lacks download fallback`)
    assert.deepEqual(errors, [], `${name} page errors: ${errors.join('\n')}`)
    results.push({ engine: name, status: 'passed', version: await browser.version(), capabilities: caps })
  } catch (error) {
    results.push({ engine: name, status: 'failed', error: String(error?.stack || error) })
    if (required.has(name)) throw error
  } finally {
    if (browser) await browser.close()
  }
}
const reportPath = process.env.BRAINANA_BROWSER_REPORT || path.join(root, 'browser-engine-results.json')
fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), required: [...required], results }, null, 2) + '\n')
console.log(JSON.stringify(results, null, 2))
if (!results.some(r => r.status === 'passed')) throw new Error('No browser engine completed the matrix')
