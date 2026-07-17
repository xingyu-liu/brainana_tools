# Desktop app (Electron packaging)

The Viewer ships two ways from the **same code**:

- **Browser mode** — `npm start` boots the loopback server and opens the user's default browser.
- **Desktop mode** — a native standalone app (Windows/macOS/Linux) that bundles its own browser
  engine (Chromium, via **Electron**) and runs the same server in-process. No external browser, no
  dependence on what the user has installed.

This document covers desktop mode: why Electron, how it reuses the existing architecture, how to run
and build it, and the known gotchas.

## Why Electron (and not a lighter shell)

The renderer is **NiiVue, which hard-requires WebGL2** (gated in
`packages/core-client/browserCapabilities.ts`). A native app must therefore embed a web engine with
reliable WebGL2 — there is no "pure native, no browser" path without reimplementing NiiVue.

- **Electron bundles Chromium** → uniform, reliable WebGL2 on all three OSes, matching the existing
  Chromium-tested capability gate. The Node backend (`packages/core-server/*`, ~1.4k LOC incl. `ssh2`
  SFTP and HTTP range streaming; FreeSurfer parsing lives in the app domain,
  `apps/viewer/server/freesurfer.mjs`) runs **in-process**, so nothing is ported.
- **System-webview shells** (Tauri/Wails/Neutralino) use **WebKitGTK on Linux**, whose WebGL2 is the
  weakest/flakiest target — unacceptable for a WebGL2-critical viewer on a required OS. They also
  can't host Node in-process (forcing a backend rewrite or a Node sidecar), which erases most of
  their size advantage here.

Cost: Electron is ~180–260 MB installed (Chromium-dominated; the app's own code is ~3 MB). Installers
compress to ~80–120 MB.

## Architecture: reuse the loopback server, swap the "opener"

Browser mode and desktop mode share one bootstrap. The server templates the per-launch **session
token** into `index.html` and sets a loopback cookie at serve time, so an Electron window that loads
`http://127.0.0.1:PORT/` authenticates **exactly like a browser** — the frontend, security model, and
data sources are byte-for-byte unchanged.

```
                              ┌── openBrowser(url)        → system browser   (npm start)
bootServer(options)           │
  token → free loopback port  ┤
  → startServer → { url }     │
                              └── new BrowserWindow().loadURL(url)  → Electron  (dev:desktop / packaged)
```

- **`bootServer(options)`** in `packages/core-launcher/launch.mjs` is the shared core (mint token,
  find free port, start server, log; returns `{ server, address, url, token, cache }`). It installs
  **no** signal handlers and opens **no** window — those are the caller's concern.
- **`launch(options)`** (browser) calls `bootServer`, then `openBrowser` + SIGINT/SIGTERM handlers.
  Its observable behavior is identical to before this split.
- **`@brainana/core-desktop`** (the Electron main process) calls `bootServer`, then creates the
  window. Electron's `app` owns the process lifecycle, so it never touches signals or `process.exit`.

## Component map (desktop-specific)

| File | Role |
|---|---|
| `packages/core-desktop/main.mjs` | Tool-agnostic Electron main process (`runDesktop(options)`): single-instance lock, GPU-blocklist opt-out, `bootServer`, window creation, server-tied-to-window shutdown. Domain-free — mirrors `core-launcher`. |
| `packages/core-desktop/window.mjs` | `createMainWindow(url, { appLabel })`: the hardened `BrowserWindow` (`contextIsolation` on, `nodeIntegration` off, `sandbox` on). Reused unchanged by future tools. |
| `packages/core-desktop/menu.mjs` | `applyAppMenu(appLabel)`: a curated role-based application menu (preserves Quit/Copy/Paste/Reload/DevTools/Zoom accelerators) replacing Electron's noisy default. Reused by future tools. |
| `packages/core-launcher/launch.mjs` | Now exports **`bootServer`** (shared core) alongside `launch` (browser opener). |
| `apps/viewer/desktop.mjs` | Composition root: injects `viewerManifestProvider` + Viewer identity into `runDesktop`. The only place Viewer domain meets the desktop shell. Structurally identical to `apps/viewer/launch.mjs`. |
| `apps/viewer/electron-builder.yml` | Packaging config: per-OS targets, asar, file include/exclude, native-module unpack. |
| root `package.json` | `main` (Electron entry), `dev:desktop` / `dist:desktop` scripts, `electron` + `electron-builder` devDeps, and the three `@brainana/*` runtime deps (see Packaging). |

The core-purity invariant still holds: `core-desktop` imports only `core-launcher`/`core-server`,
never a tool domain. It is listed in `tests/core-purity_test.mjs` so the guard covers it.

## Running in dev

```sh
npm run dev:desktop     # npm run build (SPA → dist/), then launch Electron against it
```

This builds `apps/viewer/dist/` and opens the native window. Browser mode is unaffected:

```sh
npm start               # unchanged — loopback server + system browser
```

## Building installers

```sh
npm run dist:desktop    # build SPA, then electron-builder → apps/viewer/release/
```

`electron-builder` produces one artifact per OS (see `apps/viewer/electron-builder.yml`):

| OS | Artifacts | User flow |
|---|---|---|
| macOS | `.dmg`, `.zip` | open dmg → drag `.app` to Applications → launch |
| Windows | `.exe` (NSIS) | run installer → Start-menu shortcut |
| Linux | `.AppImage`, `.deb` | AppImage: `chmod +x` and run; deb: `apt install ./file.deb` |

**Cross-compilation caveat:** each OS's artifact must be built on that OS (macOS signing/notarization
requires macOS, etc.). Build all three via a CI matrix (macos/windows/ubuntu runners) — not yet added
(see "Not yet done"). `apps/viewer/release/` is gitignored.

### What ships (and what doesn't)

- **Included:** the built `dist/` (Vite bundles NiiVue/fflate/nifti-reader-js into it), the app's
  `.mjs` server/desktop code, and — via `node_modules` — the `@brainana/core-{desktop,launcher,server}`
  packages + `ssh2`.
- **The three `@brainana/*` packages are declared as production `dependencies` in the root
  `package.json`.** This is required: electron-builder derives the shipped `node_modules` from the
  root dependency tree and dereferences those workspace symlinks into the `app.asar`. Without the
  declaration, the bare-specifier imports (`@brainana/core-desktop/…`) fail to resolve in the
  packaged app. The frontend packages (`core-client`/`ui`/`niivue-kit`/`imaging-math`) are **not**
  listed — Vite already bundled them into `dist/`.
- **Excluded:** all `.ts` sources, tests, maps, and build configs (`files` globs in the yml).

### Native modules (`ssh2`)

`ssh2`'s native accelerator (`cpu-features`) is an **optional** dependency; `ssh2` falls back to pure
JS if it's absent. electron-builder runs `@electron/rebuild` automatically, rebuilding `cpu-features`
against Electron's Node ABI, and `asarUnpack: ["**/*.node"]` places native binaries on disk (they
cannot load from inside an asar). Net: SFTP works either way.

## WebGL2 notes

- Hardware acceleration is on by default. **Never call `app.disableHardwareAcceleration()`** — it
  would fail the `hasWebGL2()` gate.
- Linux only: Chromium blocklists some GPU/driver combos and can silently drop WebGL2 to software.
  `main.mjs` sets `--ignore-gpu-blocklist`; `--use-gl=angle` is the documented escape hatch if a
  specific box still fails. Windows/macOS need no flags.
- Electron's UA contains `Chrome/…`, so `browserCapabilities.ts` reports `{ webgl2, chromium }` and
  needs no change.

## Distribution & signing

- **v1 — unsigned (free):** publish artifacts on **GitHub Releases**. First launch warns:
  macOS Gatekeeper → **right-click → Open** (or `xattr -dr com.apple.quarantine <app>`); Windows
  SmartScreen → "More info → Run anyway"; Linux has no such gate. Fine for you + known users. The
  `mac.identity: null` in the yml selects ad-hoc (unsigned) signing.
- **Wider — signed + notarized:** an Apple Developer account ($99/yr) removes the macOS warning; a
  Windows code-signing cert (~$100–400/yr) removes SmartScreen. electron-builder automates both.

## Gotchas

- **`ELECTRON_RUN_AS_NODE`** — if this env var is set, the Electron binary runs as plain Node and the
  GUI API is unavailable (symptom: `Cannot read properties of undefined (reading 'whenReady')`).
  Some sandboxes/CI set it; `unset` it before `dev:desktop`.
- **Single instance** — a second launch focuses the existing window instead of starting a second
  server (`app.requestSingleInstanceLock()`).
- **Shutdown** — closing the window closes the loopback server (which drops SFTP connections), so no
  orphaned port/token. This intentionally overrides the macOS "stay resident" convention.
- **Port in use** — inherited from `bootServer`: it scans near 5173 and falls back to an OS-chosen
  ephemeral port.

## Not yet done

- A **GitHub Actions release matrix** to build all three OS artifacts on a tag.
- Code signing / notarization (needed only for wider distribution).
- Auto-update (`electron-updater` against GitHub Releases) — an easy later add-on.
