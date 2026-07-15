import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const FILESYSTEM_ADAPTER_METHODS = Object.freeze([
  "cleanRelative",
  "stat",
  "exists",
  "list",
  "createReadStream",
  "mkdir",
  "writeStream",
]);

export function assertFilesystemAdapter(adapter, label = "filesystem adapter") {
  for (const method of FILESYSTEM_ADAPTER_METHODS) {
    if (typeof adapter?.[method] !== "function") {
      throw new TypeError(`${label} is missing required method ${method}()`);
    }
  }
  return adapter;
}

export class LocalFilesystem {
  constructor({ root }) {
    if (!root) throw new Error("Local filesystem root is required");
    this.root = path.resolve(root);
  }

  cleanRelative(raw = "") {
    const value = String(raw).replace(/\\/g, "/").replace(/^\/+/, "");
    const parts = value.split("/").filter(Boolean);
    if (
      parts.some((part) => part === "." || part === ".." || part.includes("\0"))
    ) {
      throw new Error("Invalid local path");
    }
    return parts.join("/");
  }

  absolute(relative = "") {
    const clean = this.cleanRelative(relative);
    const resolved = path.resolve(
      this.root,
      ...clean.split("/").filter(Boolean),
    );
    if (
      resolved !== this.root &&
      !resolved.startsWith(`${this.root}${path.sep}`)
    ) {
      throw new Error("Local path is outside configured root");
    }
    return resolved;
  }

  stat(relative) {
    const info = fs.statSync(this.absolute(relative));
    return {
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  }

  exists(relative, kind = null) {
    try {
      const info = this.stat(relative);
      return kind === "file"
        ? info.isFile
        : kind === "directory"
          ? info.isDirectory
          : true;
    } catch {
      return false;
    }
  }

  list(
    relative = "",
    { recursive = false, maxDepth = 1, includeHidden = false } = {},
  ) {
    const base = this.absolute(relative);
    const output = [];
    const walk = (folder, depth) => {
      if (depth > maxDepth) return;
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!includeHidden && entry.name.startsWith(".")) continue;
        const absolutePath = path.join(folder, entry.name);
        const rel = path
          .relative(this.root, absolutePath)
          .split(path.sep)
          .join("/");
        const info = fs.statSync(absolutePath);
        output.push({
          type: entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : "other",
          absolutePath,
          relativePath: rel,
          name: entry.name,
          size: info.size,
          mtimeMs: info.mtimeMs,
        });
        if (recursive && entry.isDirectory()) walk(absolutePath, depth + 1);
      }
    };
    walk(base, 1);
    return output;
  }

  createReadStream(relative) {
    return fs.createReadStream(this.absolute(relative));
  }

  mkdir(relative) {
    const clean = this.cleanRelative(relative);
    if (!clean) throw new Error("A folder name is required");
    fs.mkdirSync(this.absolute(clean), { recursive: false });
    return clean;
  }

  async writeStream(relative, readable, { overwrite = false } = {}) {
    const clean = this.cleanRelative(relative);
    if (!clean) throw new Error("A filename is required");
    const destination = this.absolute(clean);
    if (!overwrite && this.exists(clean)) return { exists: true };
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const temp = `${destination}.brainana-partial-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    try {
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(temp, { flags: "wx" });
        readable.on("error", reject);
        output.on("error", reject);
        output.on("finish", resolve);
        readable.pipe(output);
      });
      if (!overwrite && this.exists(clean)) {
        await fsp.rm(temp, { force: true });
        return { exists: true };
      }
      await fsp.rename(temp, destination);
      return { exists: false, bytes: fs.statSync(destination).size };
    } catch (error) {
      await fsp.rm(temp, { force: true });
      throw error;
    }
  }
}
