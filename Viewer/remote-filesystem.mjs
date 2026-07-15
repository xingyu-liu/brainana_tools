import { assertFilesystemAdapter } from "./filesystem-adapter.mjs";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function quote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

const SSH_BIN = process.env.BRAINANA_SSH_BIN || "/usr/bin/ssh";

export class SshFilesystem {
  constructor({ target, controlSocket, root, cacheRoot }) {
    if (!target || !controlSocket || !root || !cacheRoot)
      throw new Error("Incomplete SSH filesystem configuration");
    this.target = target;
    this.controlSocket = controlSocket;
    this.root = root.replace(/\/+$/, "") || "/";
    this.cacheRoot = cacheRoot;
    fs.mkdirSync(cacheRoot, { recursive: true });
  }

  cleanRelative(raw = "") {
    const value = String(raw).replace(/\\/g, "/").replace(/^\/+/, "");
    const parts = value.split("/").filter(Boolean);
    if (
      parts.some((part) => part === "." || part === ".." || part.includes("\0"))
    )
      throw new Error("Invalid remote path");
    return parts.join("/");
  }

  absolute(relative = "") {
    const clean = this.cleanRelative(relative);
    return clean ? `${this.root}/${clean}` : this.root;
  }

  relative(absolute) {
    const normalized = String(absolute).replace(/\/+$/, "");
    if (normalized === this.root) return "";
    if (!normalized.startsWith(`${this.root}/`))
      throw new Error("Remote path is outside configured root");
    return normalized.slice(this.root.length + 1);
  }

  run(
    script,
    { input, encoding = "utf8", maxBuffer = 128 * 1024 * 1024 } = {},
  ) {
    const result = spawnSync(
      SSH_BIN,
      [
        "-S",
        this.controlSocket,
        "-o",
        "BatchMode=yes",
        this.target,
        `sh -c ${quote(script)}`,
      ],
      {
        input,
        encoding,
        maxBuffer,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        (result.stderr || `Remote command failed with status ${result.status}`)
          .toString()
          .trim(),
      );
    return result.stdout;
  }

  health() {
    return (
      String(this.run("printf brainana-ssh-ok")).trim() === "brainana-ssh-ok"
    );
  }

  stat(relative) {
    const abs = this.absolute(relative);
    const text = String(
      this.run(`stat -L -c '%F\t%s\t%Y' -- ${quote(abs)}`),
    ).trim();
    const [kind, size, mtime] = text.split("\t");
    return {
      isFile: kind === "regular file",
      isDirectory: kind === "directory",
      size: Number(size),
      mtimeMs: Number(mtime) * 1000,
    };
  }

  exists(relative, kind = null) {
    const abs = this.absolute(relative);
    const test = kind === "file" ? "-f" : kind === "directory" ? "-d" : "-e";
    const result = spawnSync(SSH_BIN, [
      "-S",
      this.controlSocket,
      "-o",
      "BatchMode=yes",
      this.target,
      `sh -c ${quote(`test ${test} ${quote(abs)}`)}`,
    ]);
    return result.status === 0;
  }

  list(
    relative = "",
    { recursive = false, maxDepth = 1, includeHidden = false } = {},
  ) {
    const abs = this.absolute(relative);
    const depth = recursive ? Math.max(1, Number(maxDepth) || 1) : 1;
    const hiddenClause = includeHidden ? "" : ` ! -path '*/.*'`;
    const script = `find -L ${quote(abs)} -mindepth 1 -maxdepth ${depth}${hiddenClause} -printf '%y\t%p\t%s\t%T@\n'`;
    const output = String(this.run(script));
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [type, fullPath, size, mtime] = line.split("\t");
        return {
          type:
            type === "d"
              ? "directory"
              : type === "f" || type === "l"
                ? "file"
                : "other",
          absolutePath: fullPath,
          relativePath: this.relative(fullPath),
          name: path.posix.basename(fullPath),
          size: Number(size),
          mtimeMs: Math.floor(Number(mtime) * 1000),
        };
      });
  }

  cachePath(relative) {
    const clean = this.cleanRelative(relative);
    const digest = crypto
      .createHash("sha256")
      .update(`${this.target}\0${this.root}\0${clean}`)
      .digest("hex")
      .slice(0, 20);
    const basename = path.basename(clean) || "root";
    return path.join(this.cacheRoot, "files", digest, basename);
  }

  ensureCached(relative) {
    const clean = this.cleanRelative(relative);
    const info = this.stat(clean);
    if (!info.isFile) throw new Error("Remote path is not a file");
    const dest = this.cachePath(clean);
    const metaPath = `${dest}.brainana-meta.json`;
    let valid = false;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      valid =
        fs.existsSync(dest) &&
        meta.size === info.size &&
        meta.mtimeMs === info.mtimeMs &&
        fs.statSync(dest).size === info.size;
    } catch {}
    if (valid) return dest;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const temp = `${dest}.partial-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(temp, "wx");
    let result;
    try {
      result = spawnSync(
        SSH_BIN,
        [
          "-S",
          this.controlSocket,
          "-o",
          "BatchMode=yes",
          this.target,
          `cat -- ${quote(this.absolute(clean))}`,
        ],
        {
          stdio: ["ignore", fd, "pipe"],
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        },
      );
    } finally {
      fs.closeSync(fd);
    }
    if (result.error) {
      fs.rmSync(temp, { force: true });
      throw result.error;
    }
    if (result.status !== 0) {
      fs.rmSync(temp, { force: true });
      throw new Error(
        (result.stderr || "Unable to download remote file").toString().trim(),
      );
    }
    if (fs.statSync(temp).size !== info.size) {
      fs.rmSync(temp, { force: true });
      throw new Error("Remote file transfer was incomplete");
    }
    fs.renameSync(temp, dest);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        size: info.size,
        mtimeMs: info.mtimeMs,
        relative: clean,
      }),
    );
    return dest;
  }

  createReadStream(relative) {
    const clean = this.cleanRelative(relative);
    return spawn(
      SSH_BIN,
      [
        "-S",
        this.controlSocket,
        "-o",
        "BatchMode=yes",
        this.target,
        `cat -- ${quote(this.absolute(clean))}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  }

  mkdir(relative) {
    const clean = this.cleanRelative(relative);
    if (!clean) throw new Error("A folder name is required");
    this.run(`mkdir -- ${quote(this.absolute(clean))}`);
    return clean;
  }

  async writeStream(relative, readable, { overwrite = false } = {}) {
    const clean = this.cleanRelative(relative);
    if (!clean) throw new Error("A filename is required");
    const dest = this.absolute(clean);
    const parent = path.posix.dirname(dest);
    const temp = `${dest}.brainana-partial-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (!overwrite && this.exists(clean)) return { exists: true };
    const script = `set -e; mkdir -p -- ${quote(parent)}; cat > ${quote(temp)}; ${overwrite ? "" : `if test -e ${quote(dest)}; then rm -f -- ${quote(temp)}; exit 73; fi; `}mv -f -- ${quote(temp)} ${quote(dest)}; stat -c '%s' -- ${quote(dest)}`;
    const child = spawn(
      SSH_BIN,
      [
        "-S",
        this.controlSocket,
        "-o",
        "BatchMode=yes",
        this.target,
        `sh -c ${quote(script)}`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    readable.pipe(child.stdin);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const status = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    if (status === 73) return { exists: true };
    if (status !== 0)
      throw new Error(
        stderr.trim() || `Remote write failed with status ${status}`,
      );
    return { exists: false, bytes: Number(stdout.trim()) };
  }
}

export function createSshFilesystem(options) {
  return assertFilesystemAdapter(
    new SshFilesystem(options),
    "SSH filesystem adapter",
  );
}
