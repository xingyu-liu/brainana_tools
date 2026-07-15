import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "brainana-profile-test-"));
const json = path.join(tmp, "connections.json");
const tsv = path.join(tmp, "connections.tsv");
const helper = path.join(root, "scripts/profile-store.mjs");
writeFileSync(
  tsv,
  "Tést Profile\tuser name\thost.example\t/data/路径\t23456\n",
);
const run = (...args) =>
  spawnSync(process.execPath, [helper, ...args], { encoding: "utf8" });
try {
  let r = run("init", json, tsv);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(`${tsv}.migrated`));
  let data = JSON.parse(readFileSync(json, "utf8"));
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.profiles[0].name, "Tést Profile");
  assert.equal(data.profiles[0].root, "/data/路径");
  r = run(
    "upsert",
    json,
    tsv,
    "Tést Profile",
    "Updated",
    "newuser",
    "newhost",
    "/new root",
    "34567",
  );
  assert.equal(r.status, 0, r.stderr);
  r = run("get-shell", json, tsv, "Updated");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PROFILE_NAME='Updated'/);
  assert.match(r.stdout, /OUTPUT_DIR='\/new root'/);
  r = run("delete", json, tsv, "Updated");
  assert.equal(r.status, 0, r.stderr);
  data = JSON.parse(readFileSync(json, "utf8"));
  assert.equal(data.profiles.length, 0);
  assert.equal(statSync(json).mode & 0o777, 0o600);
  console.log("profile JSON migration and atomic storage test passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
