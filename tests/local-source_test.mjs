// Headless smoke test (plan §9): start the server UNBOUND, add a LOCAL source over a
// fixture, list monkeys, build a manifest, fetch a byte range, and assert loopback bind +
// token rejection. Also builds a manifest against the real output dir when it is present.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../core/server/runtime.mjs'
import { generateSessionToken } from '../core/server/security.mjs'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok - ${name}`)
}

// ---------------------------------------------------------------------------
// Build a tiny fixture: one flat-layout subject and one session-layout subject.
// ---------------------------------------------------------------------------
const ANAT_BYTES = Buffer.from('BRAINANA-FIXTURE-VOLUME-0123456789', 'utf8')

async function buildFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainana-fixture-'))
  // flat: sub-flat/anat/...
  const flatAnat = path.join(root, 'sub-flat', 'anat')
  await fsp.mkdir(flatAnat, { recursive: true })
  await fsp.writeFile(path.join(flatAnat, 'sub-flat_space-T1w_desc-preproc_T1w.nii.gz'), ANAT_BYTES)
  // session: sub-ses/ses-001/anat/...
  const sesAnat = path.join(root, 'sub-ses', 'ses-001', 'anat')
  await fsp.mkdir(sesAnat, { recursive: true })
  await fsp.writeFile(path.join(sesAnat, 'sub-ses_ses-001_space-T1w_desc-preproc_T1w.nii.gz'), ANAT_BYTES)
  // a non-subject dir to confirm filtering
  await fsp.mkdir(path.join(root, 'logs'), { recursive: true })
  return root
}

async function main() {
  const fixtureRoot = await buildFixture()
  const token = generateSessionToken()
  const { server, address } = await startServer({ token, port: 0 })
  const base = `http://127.0.0.1:${address.port}`
  const auth = { Authorization: `Bearer ${token}` }

  try {
    // --- loopback bind ---
    assert.equal(address.address, '127.0.0.1', 'server bound to loopback only')
    ok('server binds 127.0.0.1')

    // --- health is unauthenticated; sources require the token ---
    assert.equal((await fetch(`${base}/api/health`)).status, 200)
    assert.equal((await fetch(`${base}/api/sources`)).status, 401, 'unauthenticated /api/sources rejected')
    assert.equal((await fetch(`${base}/api/sources`, { headers: { Authorization: 'Bearer wrong' } })).status, 401)
    ok('token guard rejects missing/invalid token; health is open')

    // --- create a local source ---
    const createRes = await fetch(`${base}/api/sources`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'local', path: fixtureRoot, label: 'fixture' }),
    })
    assert.equal(createRes.status, 200)
    const source = await createRes.json()
    assert.match(source.id, /^local-[0-9a-f]{12}$/, 'source id is scoped local-<hex>')
    ok('POST /api/sources opens a local source')

    // --- list monkeys (both flat + session subjects) ---
    const monkeys = await (await fetch(`${base}/api/sources/${source.id}/monkeys`, { headers: auth })).json()
    const ids = monkeys.map((m) => m.id).sort()
    assert.deepEqual(ids, ['sub-flat', 'sub-ses'], 'both flat and session subjects detected, non-subjects filtered')
    ok('listMonkeys finds flat + session subjects, excludes non-subjects')

    // --- manifest for each subject ---
    for (const subjectId of ['sub-flat', 'sub-ses']) {
      const manifest = await (await fetch(`${base}/api/sources/${source.id}/manifest/${subjectId}`, { headers: auth })).json()
      assert.equal(manifest.id, subjectId)
      assert.ok(manifest.anatomy, `${subjectId} manifest has anatomy URL`)
      assert.ok(manifest.anatomy.startsWith(`/brainana-data/${source.id}/`), 'anatomy URL is source-scoped')
      assert.equal(manifest.capabilities.volume, true)
    }
    ok('buildManifest returns source-scoped anatomy URL for flat + session layouts')

    // --- ranged byte fetch of the anatomy volume ---
    const flatManifest = await (await fetch(`${base}/api/sources/${source.id}/manifest/sub-flat`, { headers: auth })).json()
    const dataUrl = `${base}${flatManifest.anatomy}`
    const full = await fetch(dataUrl, { headers: auth })
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('accept-ranges'), 'bytes')
    assert.equal(Buffer.from(await full.arrayBuffer()).toString('utf8'), ANAT_BYTES.toString('utf8'), 'full body matches')

    const ranged = await fetch(dataUrl, { headers: { ...auth, Range: 'bytes=2-5' } })
    assert.equal(ranged.status, 206, 'range request returns 206')
    assert.equal(ranged.headers.get('content-range'), `bytes 2-5/${ANAT_BYTES.length}`)
    assert.equal(Buffer.from(await ranged.arrayBuffer()).toString('utf8'), ANAT_BYTES.slice(2, 6).toString('utf8'), 'ranged bytes correct')
    ok('ranged /brainana-data fetch returns 206 with correct bytes')

    // --- data route also requires the token ---
    assert.equal((await fetch(dataUrl)).status, 401, 'unauthenticated data fetch rejected')
    ok('data route enforces the token')

    // --- cookie auth (the path NiiVue's own loaders rely on) ---
    const cookieOk = await fetch(dataUrl, { headers: { Cookie: `brainana_token=${token}` } })
    assert.equal(cookieOk.status, 200, 'data fetch authenticates via the loopback cookie (no bearer)')
    assert.equal((await fetch(dataUrl, { headers: { Cookie: 'brainana_token=wrong' } })).status, 401, 'wrong cookie rejected')
    ok('data route accepts the loopback session cookie (NiiVue path)')

    // --- delete the source ---
    assert.equal((await fetch(`${base}/api/sources/${source.id}`, { method: 'DELETE', headers: auth })).status, 200)
    assert.equal((await (await fetch(`${base}/api/sources`, { headers: auth })).json()).length, 0)
    ok('DELETE /api/sources tears the source down')

    // --- optional: real brainana output dir, if mounted here ---
    const realRoot = process.env.BRAINANA_TEST_OUTPUT || '/mnt/DataDrive3/xliu/prep_test/brainana_test/preproc/dataset_devtest_docker_v1.3.0/preprocessed'
    if (fs.existsSync(realRoot)) {
      const r = await (await fetch(`${base}/api/sources`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'local', path: realRoot }) })).json()
      const realMonkeys = await (await fetch(`${base}/api/sources/${r.id}/monkeys`, { headers: auth })).json()
      assert.ok(Array.isArray(realMonkeys) && realMonkeys.length > 0, 'real output dir exposes monkeys')
      const m = await (await fetch(`${base}/api/sources/${r.id}/manifest/${realMonkeys[0].id}`, { headers: auth })).json()
      assert.equal(m.id, realMonkeys[0].id)
      console.log(`  ok - real output: ${realMonkeys.length} monkeys; ${realMonkeys[0].id} manifest built (session=${m.session ?? 'flat'}, volume=${m.capabilities.volume}, surfaces=${m.capabilities.surfaces})`)
      passed++
    } else {
      console.log('  skip - real output dir not mounted here')
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await fsp.rm(fixtureRoot, { recursive: true, force: true })
  }

  console.log(`local-source_test: ${passed} checks passed`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
