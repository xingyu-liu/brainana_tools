// CLI entry for the server (`npm run server`). Thin wrapper over startServer.
// Flags:
//   --output-dir <path>   open a local source at startup (optional; server can start unbound)
//   --port <n>            port (default 5173; 0 = ephemeral)
//   --token <t>           session token (default: none → guard disabled, loopback only)
//   --dist <path>         static assets dir to serve (default: ./dist if present)
//   --legacy              enable legacy-compat unscoped data route for the old bundle
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startServer } from './runtime.mjs'
import { versionInfo } from './version.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const argv = process.argv.slice(2)

function arg(name, fallback) {
  const eq = argv.find((v) => v.startsWith(`${name}=`))
  if (eq) return eq.slice(name.length + 1)
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const hasFlag = (name) => argv.includes(name)

const outputDir = arg('--output-dir', process.env.BRAINANA_OUTPUT_DIR)
const port = Number(arg('--port', process.env.PORT || 5173))
const token = arg('--token', process.env.BRAINANA_TOKEN || null)
const distArg = arg('--dist', null)
const distRoot = distArg ? path.resolve(distArg) : fs.existsSync(path.join(repoRoot, 'dist')) ? path.join(repoRoot, 'dist') : null
const legacyCompat = hasFlag('--legacy') || process.env.BRAINANA_LEGACY === '1'

const initialSources = outputDir ? [{ type: 'local', path: path.resolve(outputDir), label: path.basename(path.resolve(outputDir)) }] : []

const { server, address } = await startServer({ token, distRoot, initialSources, legacyCompat, port })

console.log(`Brainana Viewer ${versionInfo.version} (${versionInfo.buildId})`)
console.log(`Listening on http://127.0.0.1:${address.port}${token ? ' (token required)' : ''}`)
if (outputDir) console.log(`Startup local source: ${path.resolve(outputDir)}`)
if (distRoot) console.log(`Serving static assets from ${distRoot}${legacyCompat ? ' (legacy-compat route enabled)' : ''}`)
if (!outputDir) console.log('No startup source — add sources in-app via POST /api/sources')

process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})
