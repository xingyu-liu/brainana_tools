import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const appPkg = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, '..', 'apppkg')
const app = path.join(appPkg, 'Brainana Align.app')
const source = path.join(root, 'source')
const meta = JSON.parse(fs.readFileSync(path.join(source, 'VERSION.json'), 'utf8'))
const failures = []
const read = p => fs.readFileSync(p, 'utf8')
const mustContain = (p, text, label) => { if (!read(p).includes(text)) failures.push(`${label} does not contain ${text}`) }
const mustNotContain = (p, text, label) => { if (read(p).includes(text)) failures.push(`${label} unexpectedly contains ${text}`) }
const runtime = path.join(app, 'Contents', 'Resources', 'runtime')
const launcher = path.join(app, 'Contents', 'MacOS', 'brainana-align-launcher')
const plist = path.join(app, 'Contents', 'Info.plist')
const docsDir = path.join(appPkg, 'Documentation')
const docsVersion = path.join(docsDir, 'VERSION.json')
const requiredDocs = ['README.md','BUILD.md','CHANGELOG.md','ARCHITECTURE.md','FEATURE_PARITY.md','VALIDATION.md','TECHNICAL_FINDINGS.md','VERSION.json']
for (const p of [app, runtime, path.join(runtime, 'platformCore.mjs'), path.join(runtime, 'sftpClient.mjs'), launcher, plist, docsVersion]) if (!fs.existsSync(p)) failures.push(`Missing ${p}`)
for (const name of requiredDocs) if (!fs.existsSync(path.join(docsDir, name))) failures.push(`Missing Documentation/${name}`)
if (fs.existsSync(docsDir)) {
  const versionedDocs = fs.readdirSync(docsDir).filter(name => /^(ARCHITECTURE|CHANGELOG|VALIDATION)-.+\.md$/i.test(name))
  if (versionedDocs.length) failures.push(`Version-stamped documentation present: ${versionedDocs.join(', ')}`)
}
if (fs.existsSync(path.join(appPkg, 'Documentation-release'))) failures.push('Duplicate Documentation-release directory present')
if (!failures.length) {
  mustContain(path.join(runtime, 'version.mjs'), JSON.stringify(meta.version), 'runtime version.mjs')
  mustContain(path.join(runtime, 'version.mjs'), JSON.stringify(meta.buildId), 'runtime version.mjs')
  mustContain(path.join(runtime, 'version.env'), `VERSION=${JSON.stringify(meta.version)}`, 'runtime version.env')
  mustContain(path.join(runtime, 'version.env'), `BUILD_ID=${JSON.stringify(meta.buildId)}`, 'runtime version.env')
  mustContain(plist, `<string>${meta.version}</string>`, 'Info.plist')
  mustContain(plist, `<string>${meta.bundleVersion}</string>`, 'Info.plist')
  mustContain(launcher, 'version.env', 'launcher')
  mustNotContain(launcher, 'VERSION="0.', 'launcher')
  const docMeta = JSON.parse(read(docsVersion))
  if (docMeta.version !== meta.version || docMeta.buildId !== meta.buildId) failures.push('Documentation VERSION.json disagrees with source VERSION.json')
}
function hash(p){return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}
const sourceDist = path.join(source, 'dist')
const appDist = path.join(runtime, 'dist')
if (fs.existsSync(sourceDist) && fs.existsSync(appDist)) {
  const walk = d => fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)])
  const rels = walk(sourceDist).map(p=>path.relative(sourceDist,p)).sort()
  const appRels = walk(appDist).map(p=>path.relative(appDist,p)).sort()
  if (JSON.stringify(rels)!==JSON.stringify(appRels)) failures.push('Packaged frontend file list differs from source dist')
  for (const rel of rels) if (fs.existsSync(path.join(appDist,rel)) && hash(path.join(sourceDist,rel))!==hash(path.join(appDist,rel))) failures.push(`Frontend hash mismatch: ${rel}`)
} else failures.push('Missing source or packaged dist')
for (const arch of ['darwin-arm64','darwin-x64']) {
  const node = path.join(runtime, arch, 'node')
  if (!fs.existsSync(node)) failures.push(`Missing bundled runtime ${arch}`)
  else if (!(fs.statSync(node).mode & 0o111)) failures.push(`Bundled runtime not executable ${arch}`)
}
if (failures.length) {
  console.error('RELEASE VERIFICATION FAILED')
  for (const f of failures) console.error(`- ${f}`)
  process.exit(1)
}
console.log(`Release verified: ${meta.version} (${meta.buildId})`)
