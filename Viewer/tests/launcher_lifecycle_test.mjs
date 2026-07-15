import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const launcher = fs.readFileSync(
  path.join(root, "launcher", "brainana-launcher"),
  "utf8",
);
assert.match(launcher, /launchctl submit/);
assert.match(launcher, /--handshake-file/);
assert.match(launcher, /--port 0/);
assert.match(launcher, /active\.json/);
assert.match(launcher, /#session=\$SESSION_TOKEN/);
assert.match(launcher, /reopen_matching_local/);
assert.match(launcher, /ssh -M -S/);
assert.doesNotMatch(launcher, /wait "\$LOCAL_SERVER_PID"/);
assert.doesNotMatch(launcher, /schedule_terminal_close/);
console.log("detached launcher lifecycle checks passed");
