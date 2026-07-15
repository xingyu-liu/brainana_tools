import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "tests", "synthetic");
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(
    new URL(request.url, "http://127.0.0.1").pathname,
  ).replace(/^\/+/, "");
  const file = path.resolve(source, pathname);
  if (!file.startsWith(`${source}${path.sep}`) || !fs.existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  fs.createReadStream(file).pipe(response);
});
await new Promise((resolve, reject) =>
  server.listen(8765, "127.0.0.1", resolve).once("error", reject),
);
try {
  const child = spawn(
    path.join(
      root,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx",
    ),
    [path.join(root, "tests", "verify_transforms.ts")],
    { cwd: root, stdio: "inherit" },
  );
  const status = await new Promise((resolve) => child.once("exit", resolve));
  if (status !== 0) process.exitCode = status ?? 1;
} finally {
  server.close();
}
