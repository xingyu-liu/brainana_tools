import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "brainana-lifecycle-"));
mkdirSync(path.join(tmp, "sub-test", "anat"), { recursive: true });
const port = 32441;
const token =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const child = spawn(process.execPath, [
  path.join(root, "server.mjs"),
  "--port",
  String(port),
  "--output-dir",
  tmp,
  "--session-token",
  token,
]);
const waitFor = async (fn, timeout = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timeout");
};
try {
  await waitFor(
    async () =>
      (
        await fetch(`http://127.0.0.1:${port}/api/health`, {
          headers: { "X-Brainana-Session": token },
        })
      ).ok,
  );
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(
    child.exitCode,
    null,
    "detached lifecycle server must remain alive when no browser tab is open",
  );
  const second = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { "X-Brainana-Session": token },
  });
  assert.equal(second.ok, true);
  console.log("detached lifecycle persistence test passed");
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  rmSync(tmp, { recursive: true, force: true });
}
