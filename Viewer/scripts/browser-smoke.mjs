import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, firefox, webkit } from "playwright-core";

if (process.env.BRAINANA_BROWSER_SMOKE !== "1") {
  console.log(
    "browser smoke skipped: set BRAINANA_BROWSER_SMOKE=1 in a browser-enabled environment",
  );
  process.exit(0);
}

const engineName = process.env.BRAINANA_BROWSER_ENGINE || "chromium";
const engine = { chromium, firefox, webkit }[engineName];
if (!engine) throw new Error(`Unsupported browser engine: ${engineName}`);
const root = path.resolve(import.meta.dirname, "..");
const token = "b".repeat(64);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "brainana-browser-smoke-"));
fs.mkdirSync(path.join(temp, "sub-test", "anat"), { recursive: true });
const handshake = path.join(temp, "handshake.json");
const server = spawn(
  process.execPath,
  [
    path.join(root, "server.mjs"),
    "--port",
    "0",
    "--output-dir",
    temp,
    "--session-token",
    token,
    "--handshake-file",
    handshake,
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);

for (let i = 0; i < 200 && !fs.existsSync(handshake); i += 1)
  await new Promise((resolve) => setTimeout(resolve, 25));
if (!fs.existsSync(handshake)) throw new Error("server handshake timeout");
const { port } = JSON.parse(fs.readFileSync(handshake, "utf8"));
let browser;
try {
  const launchOptions = { headless: true };
  if (engineName === "chromium")
    launchOptions.args = [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--use-gl=swiftshader",
    ];
  browser = await engine.launch(launchOptions);
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/#session=${token}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(2_000);
  const body = await page.locator("body").innerText();
  if (!/Brainana/i.test(body))
    throw new Error("production frontend did not render Brainana content");
  const graphicsError = await page
    .locator("#graphics-compatibility-error")
    .count();
  const canvasCount = await page.locator("canvas").count();
  if (!graphicsError && canvasCount < 1)
    throw new Error(
      "frontend created neither a WebGL canvas nor a graphics compatibility message",
    );
  if (pageErrors.length)
    throw new Error(`frontend page error: ${pageErrors.join(" | ")}`);
  const statusResponse = await page.evaluate(() =>
    fetch("/api/application/status").then((response) => response.json()),
  );
  if (statusResponse.version !== "2.4.0")
    throw new Error(
      "production frontend connected to an unexpected server version",
    );
  console.log(`production-bundle ${engineName} smoke test passed`);
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
  fs.rmSync(temp, { recursive: true, force: true });
}
