import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const token =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const auth = { "X-Brainana-Session": token };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "brainana-somato-"));
const withSomato = path.join(root, "sub-frosty", "anat", "atlas_space-T1w");
const withoutSomato = path.join(root, "sub-yellow1", "anat", "atlas_space-T1w");
fs.mkdirSync(withSomato, { recursive: true });
fs.mkdirSync(withoutSomato, { recursive: true });
for (const dir of [withSomato, withoutSomato])
  fs.writeFileSync(
    path.join(dir, "atlas-retinotopy_space-T1w_test.nii.gz"),
    "",
  );
fs.writeFileSync(
  path.join(withSomato, "atlas-somatotopy_space-T1w_sub-frostyT1.nii.gz"),
  "",
);
const port = 18883;
const server = spawn(
  process.execPath,
  [
    "server.mjs",
    "--output-dir",
    root,
    "--port",
    String(port),
    "--session-token",
    token,
  ],
  { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
);
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server timeout")), 10000);
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes(String(port))) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on("data", (chunk) => {
      const text = String(chunk);
      if (text) console.error(text);
    });
    server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  const frosty = await (
    await fetch(`http://127.0.0.1:${port}/api/monkeys/sub-frosty`, {
      headers: auth,
    })
  ).json();
  const yellow = await (
    await fetch(`http://127.0.0.1:${port}/api/monkeys/sub-yellow1`, {
      headers: auth,
    })
  ).json();
  assert.equal(frosty.capabilities.somatotopy, true);
  assert.match(
    frosty.function.somatotopy.combined,
    /atlas-somatotopy_space-T1w_sub-frostyT1\.nii\.gz$/,
  );
  assert.equal(yellow.capabilities.somatotopy, false);
  assert.equal(yellow.function.somatotopy, null);
  console.log("somatotopy manifest detection is monkey-specific");
} finally {
  server.kill("SIGTERM");
  fs.rmSync(root, { recursive: true, force: true });
}
