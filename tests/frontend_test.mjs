// Verifies the built frontend is served correctly: the server injects the per-launch
// session token into index.html as a <meta> tag (so the client reads it without the token
// ever entering a URL). Skips when dist/ has not been built yet.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '../core/server/runtime.mjs'
import { generateSessionToken } from '../core/server/security.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = path.join(repoRoot, 'dist')

if (!fs.existsSync(path.join(distRoot, 'index.html'))) {
  console.log('  skip - dist/ not built (run `npm run build`)')
  console.log('frontend_test: skipped')
  process.exit(0)
}

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

async function main() {
  const token = generateSessionToken()
  const { server, address } = await startServer({ token, distRoot, port: 0 })
  const base = `http://127.0.0.1:${address.port}`

  try {
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') || '', /text\/html/)
    const html = await res.text()
    assert.ok(html.includes('<div id="app">'), 'serves the app shell')
    assert.ok(html.includes(`<meta name="brainana-token" content="${token}" />`), 'injects the session token as a meta tag')
    assert.ok(!res.url.includes('token='), 'token is not in the URL')
    ok('index.html is served with the session token injected as a meta tag')

    // A hashed asset should be served with a long cache and correct content type.
    const asset = (html.match(/\/assets\/[\w.-]+\.js/) || [])[0]
    assert.ok(asset, 'index.html references a built JS asset')
    const assetRes = await fetch(`${base}${asset}`)
    assert.equal(assetRes.status, 200)
    assert.match(assetRes.headers.get('content-type') || '', /javascript/)
    ok('built JS asset is served')

    // Unknown client route falls back to index.html (SPA), still token-injected.
    const spa = await fetch(`${base}/some/deep/route`)
    assert.equal(spa.status, 200)
    assert.ok((await spa.text()).includes('brainana-token'), 'SPA fallback also injects the token')
    ok('unknown routes fall back to the token-injected SPA shell')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  console.log(`frontend_test: ${passed} checks passed`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
