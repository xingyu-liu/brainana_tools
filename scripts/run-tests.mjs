#!/usr/bin/env node
// Runs every tests/*_test.mjs in a child process and reports a summary.
// A test file signals failure with a non-zero exit; it may skip (exit 0 with a SKIP line)
// when an optional dependency (e.g. ssh2) is unavailable in the environment.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testDir = path.join(root, 'tests')
const tests = readdirSync(testDir)
  .filter((name) => name.endsWith('_test.mjs'))
  .sort()

if (tests.length === 0) {
  console.error('No tests found in tests/')
  process.exit(1)
}

let failed = 0
for (const test of tests) {
  console.log(`\n=== ${test} ===`)
  const result = spawnSync(process.execPath, [path.join(testDir, test)], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) failed += 1
}

console.log(`\n${tests.length - failed}/${tests.length} test file(s) passed`)
process.exit(failed ? 1 : 0)
