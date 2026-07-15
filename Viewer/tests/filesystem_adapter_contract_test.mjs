import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  LocalFilesystem,
  assertFilesystemAdapter,
} from "../filesystem-adapter.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "brainana-fs-contract-"));
try {
  const adapter = assertFilesystemAdapter(new LocalFilesystem({ root }));
  adapter.mkdir("subject");
  const result = await adapter.writeStream(
    "subject/test.bin",
    Readable.from(Buffer.from([1, 2, 3])),
  );
  assert.equal(result.exists, false);
  assert.equal(result.bytes, 3);
  assert.equal(adapter.exists("subject/test.bin", "file"), true);
  assert.deepEqual(
    fs.readFileSync(path.join(root, "subject", "test.bin")),
    Buffer.from([1, 2, 3]),
  );
  assert.equal(adapter.list("subject")[0].name, "test.bin");
  assert.throws(() => adapter.cleanRelative("../escape"), /Invalid local path/);
  const conflict = await adapter.writeStream(
    "subject/test.bin",
    Readable.from(Buffer.from([4])),
  );
  assert.equal(conflict.exists, true);
  console.log("filesystem adapter contract test passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
