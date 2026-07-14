import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const docs = path.join(root, 'Documentation')
const required = [
  'README.md',
  'BUILD.md',
  'CHANGELOG.md',
  'ARCHITECTURE.md',
  'FEATURE_PARITY.md',
  'VALIDATION.md',
  'TECHNICAL_FINDINGS.md',
]
const failures = []
if (fs.existsSync(path.join(root, 'Documentation-release'))) failures.push('Duplicate Documentation-release directory exists')
if (!fs.existsSync(docs)) failures.push('Documentation directory is missing')
else {
  const files = fs.readdirSync(docs)
  for (const name of required) if (!files.includes(name)) failures.push(`Missing Documentation/${name}`)
  const versioned = files.filter(name => /^(ARCHITECTURE|CHANGELOG|VALIDATION)-.+\.md$/i.test(name))
  if (versioned.length) failures.push(`Version-stamped documentation is prohibited: ${versioned.join(', ')}`)
  const extraMarkdown = files.filter(name => name.endsWith('.md') && !required.includes(name))
  if (extraMarkdown.length) failures.push(`Unexpected Markdown documentation: ${extraMarkdown.join(', ')}`)
}
if (failures.length) {
  console.error('DOCUMENTATION LAYOUT FAILED')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('Documentation layout verified')
