#!/usr/bin/env node
// Runs every *_test.mjs in a child process and reports a per-file PASS/SKIP/FAIL summary.
// Workspace-aware: discovers tests in the root tests/ dir AND in packages/*/tests and
// apps/*/tests, so a package/app can keep its tests co-located and self-contained.
// A test file signals failure with a non-zero exit; it signals a skip (an optional dependency
// such as ssh2 is unavailable, or dist/ is not built) by exiting 0 after printing a line that
// ends with ": skipped". Skips are reported distinctly so they can never masquerade as passes.
import { spawnSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Preloaded into every test process so a late unhandledRejection/uncaughtException (after the
// test already printed its summary) becomes a non-zero exit instead of a silent false PASS.
const harnessUrl = pathToFileURL(path.join(root, 'tests', '_harness.mjs')).href

// Collect *_test.mjs files directly under a given directory (non-recursive).
function testsIn(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('_test.mjs'))
    .map((e) => path.join(dir, e.name))
}

// Every workspace group that may hold a tests/ dir, plus the root tests/ dir.
function workspaceTestDirs() {
  const dirs = [path.join(root, 'tests')]
  for (const group of ['packages', 'apps']) {
    const base = path.join(root, group)
    if (!existsSync(base)) continue
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(path.join(base, e.name, 'tests'))
    }
  }
  return dirs
}

const tests = workspaceTestDirs()
  .flatMap(testsIn)
  .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))

if (tests.length === 0) {
  console.error('No *_test.mjs files found in tests/, packages/*/tests, or apps/*/tests')
  process.exit(1)
}

// A test signals a skip with a dedicated summary line `<name>: skipped` — matched as a whole
// line so an incidental "...: skipped" logged mid-run can't mis-classify a real pass as a skip.
const SKIP_RE = /^\S*:\s*skipped\s*$/m
// A genuine pass prints at least one `  ok - <name>` assertion line. Requiring evidence of work
// means a test that exits 0 having run zero assertions (empty loop, early return, silent crash
// before any output) is caught instead of counted as PASS.
const OK_RE = /^\s*ok\s*-\s/m

let failed = 0
let skipped = 0
for (const test of tests) {
  const label = path.relative(root, test)
  console.log(`\n=== ${label} ===`)
  // Capture stdout so we can classify skip vs pass, then echo it through unchanged.
  // A per-file timeout guarantees one hung test (e.g. a server that never closes) fails
  // fast instead of stalling the whole matrix leg until CI's hard timeout.
  const result = spawnSync(process.execPath, ['--import', harnessUrl, test], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
    timeout: 120000,
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  const out = result.stdout || ''
  // spawnSync reports a timeout as ETIMEDOUT with status === null and the kill signal set.
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL'
  if (timedOut) {
    failed += 1
    console.log('  --> FAIL (timed out after 120s — likely a resource left open, e.g. an unclosed server)')
  } else if (result.status !== 0) {
    failed += 1
    console.log(`  --> FAIL (exit ${result.status})`)
  } else if (SKIP_RE.test(out)) {
    skipped += 1
    console.log('  --> SKIP')
  } else if (!OK_RE.test(out)) {
    // Exited 0, not a skip, but produced no assertion — treat "no work" as a failure so a
    // broken/empty test can never masquerade as passing.
    failed += 1
    console.log('  --> FAIL (no assertions ran — 0 checks)')
  } else {
    console.log('  --> PASS')
  }
}

const passed = tests.length - failed - skipped
console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed (of ${tests.length} test file(s))`)
process.exit(failed ? 1 : 0)
