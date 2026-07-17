// Headless smoke test (plan §9): start the server UNBOUND, add a LOCAL source over a
// fixture, list monkeys, build a manifest, fetch a byte range, and assert loopback bind +
// token rejection. Also builds a manifest against the real output dir when it is present.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '@brainana/core-server/runtime.mjs'
import { generateSessionToken } from '@brainana/core-server/security.mjs'
import { viewerManifestProvider } from '../apps/viewer/server/manifest.mjs'

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
  const write = async (dir, name) => {
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, name), ANAT_BYTES)
  }
  // flat: sub-flat/anat/... — has BOTH an fsnative atlas dir (with volumes) and a T1w one, so the
  // single-dir selection must pick fsnative for every volume-side asset (volume + LUT + retino/somato).
  const flatAnat = path.join(root, 'sub-flat', 'anat')
  await write(flatAnat, 'sub-flat_space-T1w_desc-preproc_T1w.nii.gz')
  const flatFsnative = path.join(flatAnat, 'atlas_space-fsnative')
  await write(flatFsnative, 'atlas-ARM1_space-fsnative_sub-flat.nii.gz')
  await write(flatFsnative, 'atlas-ARM1.tsv')
  await write(flatFsnative, 'atlas-ARM1_space-fsnative_hemi-L_sub-flat.func.gii')
  await write(flatFsnative, 'atlas-ARM1_space-fsnative_hemi-R_sub-flat.func.gii')
  await write(flatFsnative, 'atlas-retinotopy_space-fsnative_sub-flat.nii.gz')
  await write(flatFsnative, 'atlas-somatotopy_space-fsnative_sub-flat.nii.gz')
  const flatT1w = path.join(flatAnat, 'atlas_space-T1w') // present but must LOSE to fsnative
  await write(flatT1w, 'atlas-ARM1_space-T1w_sub-flat.nii.gz')
  await write(flatT1w, 'atlas-ARM1.tsv')
  // session: sub-ses/ses-001/anat/... — NO fsnative atlas VOLUMES (only surface .func.gii), so the
  // chosen volume dir falls back to T1w, yet the atlas surface overlay still resolves from fsnative.
  const sesAnat = path.join(root, 'sub-ses', 'ses-001', 'anat')
  await write(sesAnat, 'sub-ses_ses-001_space-T1w_desc-preproc_T1w.nii.gz')
  const sesT1w = path.join(sesAnat, 'atlas_space-T1w')
  await write(sesT1w, 'atlas-ARM1_space-T1w_sub-ses_ses-001.nii.gz')
  await write(sesT1w, 'atlas-ARM1.tsv')
  const sesFsnative = path.join(sesAnat, 'atlas_space-fsnative') // func.gii only, no volume
  await write(sesFsnative, 'atlas-ARM1_space-fsnative_hemi-L_sub-ses_ses-001.func.gii')
  await write(sesFsnative, 'atlas-ARM1_space-fsnative_hemi-R_sub-ses_ses-001.func.gii')
  // a non-subject dir to confirm filtering
  await fsp.mkdir(path.join(root, 'logs'), { recursive: true })
  return root
}

async function main() {
  const fixtureRoot = await buildFixture()
  const token = generateSessionToken()
  const { server, address } = await startServer({ token, port: 0, manifestProvider: viewerManifestProvider })
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

    // --- single atlas space directory: fsnative wins, everything volume-side from that one dir ---
    const flatM = await (await fetch(`${base}/api/sources/${source.id}/manifest/sub-flat`, { headers: auth })).json()
    const arm = flatM.atlases.find((a) => a.name === 'ARM1')
    assert.ok(arm, 'sub-flat lists the ARM1 atlas')
    assert.match(arm.volume, /atlas_space-fsnative\/atlas-ARM1_space-fsnative_/, 'atlas volume comes from the fsnative dir, not T1w')
    assert.match(arm.labels, /atlas_space-fsnative\/atlas-ARM1\.tsv$/, 'atlas LUT comes from the same chosen (fsnative) dir')
    assert.ok(arm.surface && arm.surface.left && arm.surface.right, 'atlas surface pair resolved from fsnative func.gii')
    assert.match(flatM.function.retinotopy.combined, /atlas_space-fsnative\/atlas-retinotopy_space-fsnative_/, 'retinotopy volume from fsnative dir')
    assert.deepEqual(flatM.function.retinotopy.frames, { polar: 0, polarF: 1, eccentricity: 2, eccentricityF: 3 }, 'retinotopy frame map intact')
    assert.match(flatM.function.somatotopy.combined, /atlas_space-fsnative\/atlas-somatotopy_space-fsnative_/, 'somatotopy volume from fsnative dir')
    assert.deepEqual(flatM.function.somatotopy.frames, { phase: 0, fstat: 1 }, 'somatotopy frame map intact')
    assert.equal(flatM.capabilities.atlases, true)
    assert.equal(flatM.capabilities.retinotopy, true)
    assert.equal(flatM.capabilities.somatotopy, true)
    ok('fsnative dir wins; atlas volume + LUT + retino/somato all sourced from it')

    // --- T1w fallback when fsnative has no atlas VOLUME, but surface stays fsnative ---
    const sesM = await (await fetch(`${base}/api/sources/${source.id}/manifest/sub-ses`, { headers: auth })).json()
    const sesArm = sesM.atlases.find((a) => a.name === 'ARM1')
    assert.ok(sesArm, 'sub-ses lists the ARM1 atlas')
    assert.match(sesArm.volume, /atlas_space-T1w\/atlas-ARM1_space-T1w_/, 'atlas volume falls back to the T1w dir')
    assert.match(sesArm.labels, /atlas_space-T1w\/atlas-ARM1\.tsv$/, 'atlas LUT from the same chosen (T1w) dir')
    assert.ok(sesArm.surface && sesArm.surface.left && sesArm.surface.right, 'surface still resolves from fsnative func.gii despite T1w volume')
    ok('T1w volume fallback keeps fsnative-only surface overlay')

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

    // --- optional: real brainana output dir, exercised only when BRAINANA_TEST_OUTPUT points at one ---
    const realRoot = process.env.BRAINANA_TEST_OUTPUT
    if (realRoot && fs.existsSync(realRoot)) {
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
