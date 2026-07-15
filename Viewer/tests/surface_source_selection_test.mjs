import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const token =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const auth = { "X-Brainana-Session": token };
const tmp = mkdtempSync(path.join(os.tmpdir(), "brainana-surface-source-"));
const anat = path.join(tmp, "sub-test", "anat");
const surf = path.join(tmp, "fastsurfer", "sub-test", "surf");
mkdirSync(anat, { recursive: true });
mkdirSync(surf, { recursive: true });
writeFileSync(
  path.join(anat, "sub-test_space-T1w_desc-preproc_T1w.nii.gz"),
  "",
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

function readVertices(buffer) {
  let offset = 3;
  offset = buffer.indexOf(10, offset) + 1;
  offset = buffer.indexOf(10, offset) + 1;
  const count = buffer.readInt32BE(offset);
  offset += 8;
  const vertices = [];
  for (let i = 0; i < count; i++) {
    vertices.push([
      buffer.readFloatBE(offset),
      buffer.readFloatBE(offset + 4),
      buffer.readFloatBE(offset + 8),
    ]);
    offset += 12;
  }
  return vertices;
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const inflatedLeft = [
  [-5, 0, 0],
  [-3, 1, 0],
  [-4, 0, 2],
];
const inflatedRight = [
  [3, 0, 0],
  [5, 1, 0],
  [4, 0, 2],
];
const veryLeft = [
  [-11, 0, 0],
  [-7, 4, 0],
  [-9, 0, 6],
];
const veryRight = [
  [7, 0, 0],
  [11, 4, 0],
  [9, 0, 6],
];
writeFileSync(path.join(surf, "lh.inflated"), makeSurface(inflatedLeft));
writeFileSync(path.join(surf, "rh.inflated"), makeSurface(inflatedRight));
writeFileSync(path.join(surf, "lh.veryinflated"), makeSurface(veryLeft));

const port = 32551;
const server = spawn(process.execPath, [
  path.join(root, "server.mjs"),
  "--port",
  String(port),
  "--output-dir",
  tmp,
  "--mode",
  "local",
  "--session-token",
  token,
]);
let stderr = "";
server.stderr.on("data", (chunk) => (stderr += chunk));
const wait = async (url) => {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(url, { headers: auth });
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout: ${url}\n${stderr}`);
};

try {
  let manifest = await (
    await wait(`http://127.0.0.1:${port}/api/monkeys/sub-test`)
  ).json();
  assert.ok(manifest.surfaces.inflated, "inflated pair should be available");
  assert.equal(
    manifest.surfaces.veryinflated,
    null,
    "very inflated must be unavailable until both hemispheres exist",
  );

  writeFileSync(path.join(surf, "rh.veryinflated"), makeSurface(veryRight));
  manifest = await (
    await fetch(`http://127.0.0.1:${port}/api/monkeys/sub-test`, {
      headers: auth,
    })
  ).json();
  assert.ok(
    manifest.surfaces.veryinflated,
    "real very-inflated pair should be available",
  );

  const getSurface = async (relativeUrl) =>
    Buffer.from(
      await (
        await fetch(`http://127.0.0.1:${port}${relativeUrl}`, { headers: auth })
      ).arrayBuffer(),
    );
  const inflatedOutput = readVertices(
    await getSurface(manifest.surfaces.inflated.left),
  );
  const veryOutput = readVertices(
    await getSurface(manifest.surfaces.veryinflated.left),
  );

  assert.ok(
    Math.abs(
      distance(inflatedOutput[0], inflatedOutput[1]) -
        distance(inflatedLeft[0], inflatedLeft[1]),
    ) < 1e-5,
    "inflated geometry should change only by translation",
  );
  assert.ok(
    Math.abs(
      distance(veryOutput[0], veryOutput[1]) -
        distance(veryLeft[0], veryLeft[1]),
    ) < 1e-5,
    "very-inflated geometry should change only by translation",
  );
  assert.notEqual(
    distance(inflatedOutput[0], inflatedOutput[1]),
    distance(veryOutput[0], veryOutput[1]),
    "inflated and very-inflated outputs must come from their distinct source files",
  );
  console.log("surface source selection test passed");
} finally {
  server.kill("SIGTERM");
  rmSync(tmp, { recursive: true, force: true });
}
