import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..')
const tests = readdirSync(path.join(root, 'tests')).filter((name) => name.endsWith('_test.mjs')).sort()
let failed = false
for (const test of tests) {
  const result = spawnSync(process.execPath, [path.join(root, 'tests', test)], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) failed = true
}
process.exit(failed ? 1 : 0)
