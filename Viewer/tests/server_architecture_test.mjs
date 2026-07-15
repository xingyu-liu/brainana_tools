import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
const token =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const auth = { "X-Brainana-Session": token };
const tmp = mkdtempSync(path.join(os.tmpdir(), "brainana-viewer-test-"));
const anat = path.join(tmp, "sub-test", "anat");
mkdirSync(anat, { recursive: true });
for (const name of [
  "sub-test_space-T1w_desc-preproc_T1w.nii.gz",
  "sub-test_from-D99_to-T1w_mode-image_xfm.nii.gz",
  "sub-test_from-T1w_to-D99_mode-image_xfm.nii.gz",
  "sub-test_from-Custom2028_to-T1w_mode-image_xfm.nii.gz",
  "sub-test_from-scanner_to-T1w_mode-image_xfm.mat",
])
  writeFileSync(path.join(anat, name), "");
const remotePort = 32331;
const proxyPort = 32332;
const remote = spawn(process.execPath, [
  path.join(root, "server.mjs"),
  "--port",
  String(remotePort),
  "--output-dir",
  tmp,
  "--mode",
  "remote",
  "--session-token",
  token,
]);
const proxy = spawn(process.execPath, [
  path.join(root, "server.mjs"),
  "--port",
  String(proxyPort),
  "--remote-base",
  `http://127.0.0.1:${remotePort}`,
  "--mode",
  "proxy",
  "--session-token",
  token,
]);
const wait = async (url) => {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, { headers: auth });
      if (r.ok) return r;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout: ${url}`);
};
try {
  const runtime = await (
    await wait(`http://127.0.0.1:${proxyPort}/api/runtime`)
  ).json();
  assert.equal(runtime.workstation, true);
  assert.equal(runtime.version, "2.4.0");
  let manifest = await (
    await wait(`http://127.0.0.1:${proxyPort}/api/monkeys/sub-test`)
  ).json();
  assert.equal(manifest.transforms.templates.D99.import.enabled, true);
  assert.equal(manifest.transforms.templates.D99.export.enabled, false);
  assert.equal(manifest.transforms.templates.Custom2028.import.enabled, true);
  assert.equal(
    Object.keys(manifest.transforms.templates).some(
      (k) => k.toLowerCase() === "scanner",
    ),
    false,
  );
  writeFileSync(
    path.join(anat, "sub-test_space-D99_desc-preproc_T1w.nii.gz"),
    "",
  );
  manifest = await (
    await fetch(`http://127.0.0.1:${proxyPort}/api/monkeys/sub-test`, {
      headers: auth,
    })
  ).json();
  assert.equal(manifest.transforms.templates.D99.export.enabled, true);
  for (const dir of ["sub-test/viewer", "sub-test/viewer/snapshots"]) {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/api/save-mkdir`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ path: dir }),
    });
    assert.ok(r.ok);
  }
  const bytes = new TextEncoder().encode("brainana-binary-test");
  const save = await fetch(
    `http://127.0.0.1:${proxyPort}/api/save-file?path=${encodeURIComponent("sub-test/viewer/snapshots/test.bin")}`,
    { method: "POST", headers: auth, body: bytes },
  );
  assert.ok(save.ok);
  console.log("server architecture test passed");
} finally {
  remote.kill("SIGTERM");
  proxy.kill("SIGTERM");
  rmSync(tmp, { recursive: true, force: true });
}
