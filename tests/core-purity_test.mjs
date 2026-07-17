// Guards the central invariant of the multi-tool workspace: the shared platform packages
// (packages/core-*, ui, niivue-kit, imaging-math) must NEVER import a tool's domain (apps/*
// or the old viewer/ tree). This is exactly the coupling that rotted the old repo, where the
// "tool-agnostic" core reached up into the Viewer's manifest module. If this test fails, a
// shared package took a domain dependency — invert it (inject the domain, don't import it).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHARED = ['core-server', 'core-launcher', 'core-desktop', 'core-client', 'ui', 'niivue-kit', 'imaging-math'].map((p) => path.join(root, 'packages', p))

// A shared package may not import from apps/, the legacy viewer/ tree, or a *ManifestProvider.
const FORBIDDEN = [/from\s+['"][^'"]*\/apps\//, /from\s+['"][^'"]*\/viewer\//, /\bimport\s*\(\s*['"][^'"]*\/(apps|viewer)\//, /ManifestProvider\b.*from/]

function walk(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full)
    return /\.(mjs|ts)$/.test(e.name) ? [full] : []
  })
}

let passed = 0
const violations = []
for (const pkg of SHARED) {
  for (const file of walk(pkg)) {
    // Only inspect import statements/expressions, not comments/prose.
    const importLines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => /(^|\s)(import|export)\b/.test(l) && /from\s+['"]|import\s*\(/.test(l))
    for (const line of importLines) {
      if (FORBIDDEN.some((re) => re.test(line))) violations.push(`${path.relative(root, file)}: ${line.trim()}`)
    }
  }
}

assert.deepEqual(violations, [], `shared packages must not import a tool domain:\n${violations.join('\n')}`)
passed++
console.log('  ok - no shared package imports apps/ or viewer/ domain code')
console.log(`core-purity_test: ${passed} checks passed`)
