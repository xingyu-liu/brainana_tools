import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "brainana-lifecycle-"));
fs.mkdirSync(path.join(temp, "sub-test", "anat"), { recursive: true });
const token = "a".repeat(64);
const child = spawn(
  process.execPath,
  [
    "server.mjs",
    "--port",
    "0",
    "--output-dir",
    temp,
    "--session-token",
    token,
    "--idle-timeout-ms",
    "60000",
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);
let port;
let output = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (data) => {
  output += data;
  const match = output.match(/Viewer: http:\/\/127\.0\.0\.1:(\d+)/);
  if (match) port = Number(match[1]);
});
for (let i = 0; i < 100 && !port; i += 1)
  await new Promise((r) => setTimeout(r, 50));
assert.ok(port, "server did not start");
const headers = { "X-Brainana-Session": token };
const status = await fetch(`http://127.0.0.1:${port}/api/application/status`, {
  headers,
});
assert.equal(status.status, 200);
const payload = await status.json();
assert.equal(payload.version, "2.4.0");
const restart = await fetch(
  `http://127.0.0.1:${port}/api/application/restart`,
  { method: "POST", headers },
);
assert.equal(restart.status, 501);
const quit = await fetch(`http://127.0.0.1:${port}/api/application/quit`, {
  method: "POST",
  headers,
});
assert.equal(quit.status, 202);
const exitCode = await new Promise((resolve) => child.on("exit", resolve));
assert.equal(exitCode, 0);
fs.rmSync(temp, { recursive: true, force: true });
console.log("application lifecycle control test passed");
