import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const token =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const auth = { "X-Brainana-Session": token };
const tmp = mkdtempSync(path.join(os.tmpdir(), "brainana-local-ssh-test-"));
const remoteRoot = path.join(tmp, "remote");
const cache = path.join(tmp, "cache");
const anat = path.join(remoteRoot, "sub-test", "anat");
const surf = path.join(remoteRoot, "fastsurfer", "sub-test", "surf");
mkdirSync(anat, { recursive: true });
mkdirSync(surf, { recursive: true });
const anatomyName = "sub-test_space-T1w_desc-preproc_T1w.nii.gz";
const anatomyBytes = Buffer.from("synthetic-nifti-bytes");
writeFileSync(path.join(anat, anatomyName), anatomyBytes);
writeFileSync(
  path.join(anat, "sub-test_from-D99_to-T1w_mode-image_xfm.nii.gz"),
  Buffer.from("import-warp"),
);
writeFileSync(
  path.join(anat, "sub-test_from-T1w_to-D99_mode-image_xfm.nii.gz"),
  Buffer.from("export-warp"),
);
writeFileSync(
  path.join(anat, "sub-test_space-D99_desc-preproc_T1w.nii.gz"),
  Buffer.from("d99-reference"),
);

function makeSurface(vertices) {
  const header = Buffer.from([0xff, 0xff, 0xfe]);
  const comments = Buffer.from("created by test\n\n", "ascii");
  const counts = Buffer.alloc(8);
  counts.writeInt32BE(vertices.length, 0);
  counts.writeInt32BE(0, 4);
  const coordinates = Buffer.alloc(vertices.length * 12);
  let offset = 0;
  for (const [x, y, z] of vertices) {
    coordinates.writeFloatBE(x, offset);
    coordinates.writeFloatBE(y, offset + 4);
    coordinates.writeFloatBE(z, offset + 8);
    offset += 12;
  }
  return Buffer.concat([header, comments, counts, coordinates]);
}
for (const [name, vertices] of Object.entries({
  "lh.inflated": [
    [-5, 0, 0],
    [-3, 1, 0],
    [-4, 0, 2],
  ],
  "rh.inflated": [
    [3, 0, 0],
    [5, 1, 0],
    [4, 0, 2],
  ],
  "lh.veryinflated": [
    [-11, 0, 0],
    [-7, 4, 0],
    [-9, 0, 6],
  ],
  "rh.veryinflated": [
    [7, 0, 0],
    [11, 4, 0],
    [9, 0, 6],
  ],
}))
  writeFileSync(path.join(surf, name), makeSurface(vertices));

const fakeSsh = path.join(tmp, "ssh");
writeFileSync(
  fakeSsh,
  `#!/bin/bash\nset -e\ncmd="\${!#}"\nexec /bin/sh -c "$cmd"\n`,
);
chmodSync(fakeSsh, 0o755);
const port = 32441;
const server = spawn(
  process.execPath,
  [
    path.join(root, "server.mjs"),
    "--port",
    String(port),
    "--mode",
    "workstation",
    "--ssh-target",
    "test@example",
    "--ssh-control",
    path.join(tmp, "control.sock"),
    "--remote-root",
    remoteRoot,
    "--cache-dir",
    cache,
    "--session-token",
    token,
  ],
  {
    env: { ...process.env, BRAINANA_SSH_BIN: fakeSsh },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let stderr = "";
server.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const wait = async (url) => {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(url, { headers: auth });
      if (r.ok) return r;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout: ${url}\n${stderr}`);
};
try {
  const runtime = await (
    await wait(`http://127.0.0.1:${port}/api/runtime`)
  ).json();
  assert.equal(runtime.mode, "workstation");
  assert.equal(runtime.workstation, true);
  assert.equal(runtime.capabilities.remoteRuntime, false);
  const config = await (
    await fetch(`http://127.0.0.1:${port}/api/config`, { headers: auth })
  ).json();
  assert.deepEqual(
    config.monkeys.map((m) => m.id),
    ["sub-test"],
  );
  const manifest = await (
    await fetch(`http://127.0.0.1:${port}/api/monkeys/sub-test`, {
      headers: auth,
    })
  ).json();
  assert.equal(manifest.transforms.templates.D99.import.enabled, true);
  assert.equal(manifest.transforms.templates.D99.export.enabled, true);
  assert.ok(manifest.surfaces.inflated);
  assert.ok(manifest.surfaces.veryinflated);
  const data = Buffer.from(
    await (
      await fetch(`http://127.0.0.1:${port}${manifest.anatomy}`, {
        headers: auth,
      })
    ).arrayBuffer(),
  );
  assert.deepEqual(data, anatomyBytes);
  const mkdir = await fetch(`http://127.0.0.1:${port}/api/save-mkdir`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ path: "sub-test/viewer" }),
  });
  assert.ok(mkdir.ok, await mkdir.text());
  const outputBytes = Buffer.from("remote-export-test");
  const save = await fetch(
    `http://127.0.0.1:${port}/api/save-file?path=${encodeURIComponent("sub-test/viewer/test.bin")}`,
    { method: "POST", headers: auth, body: outputBytes },
  );
  assert.ok(save.ok, await save.text());
  assert.deepEqual(
    readFileSync(path.join(remoteRoot, "sub-test", "viewer", "test.bin")),
    outputBytes,
  );
  console.log("local-only SSH filesystem test passed");
} finally {
  server.kill("SIGTERM");
  rmSync(tmp, { recursive: true, force: true });
}
