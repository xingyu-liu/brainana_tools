# Brainana Tools — Technical Route

**Scope:** `/home/star/github/brainana_tools` — an **npm-workspaces monorepo**: tool-agnostic shared
`packages/*` consumed by per-tool `apps/*`. Today the only app is the **Viewer**; the Aligner and
Editor are planned as future `apps/*` reusing the same packages (see
[adding-a-tool.md](adding-a-tool.md)).
**Version:** app `0.1.0`
**Date:** 2026-07-15

> This document describes the current technical route **as implemented**: what the tools are, the
> principles they are built on, the component map, and how each part works. The workspace was
> refactored out of the earlier single-`core/`+`viewer/` layout on 2026-07-15.

---

## 1. What this tool is

A NiiVue-based desktop viewer for per-subject (`sub-*`) neuroimaging output from the `brainana`
Nextflow pipeline: multi-planar NIfTI volumes, FreeSurfer/GIFTI cortical surfaces, categorical and
continuous atlases (ARM/D99/MacBNA/CortHierarchy/…), retinotopy/somatotopy functional maps with
F-threshold masking, morphology overlays, a
yellow surface marker, and per-crosshair coordinate/anatomy/function reports plus a visual-field
plot.

It runs as a **local Node HTTP server + a browser SPA**. The server starts **unbound** and holds a
registry of *data sources*; the user adds a **local folder** and/or a **remote workstation (over
SSH/SFTP)** in-app, and can hold subjects from several sources at once without relaunching. It
targets **macOS, Linux, and Windows** on evergreen desktop browsers, with **WebGL2** as the one
hard requirement (gated at runtime with a friendly message).

The **same code** also ships as a **native standalone desktop app** (Electron), which bundles its own
Chromium (uniform WebGL2) and runs the server in-process — no external browser required. Desktop and
browser modes share one bootstrap; see [desktop-app.md](desktop-app.md).

## 2. Design principles in force

1. **Source-first, cross-platform.** `packages/*` + `apps/*/src` are authoritative and committed;
   `apps/*/dist` is the Vite build (gitignored, produced in CI). Targets macOS + Linux + Windows.
   Cross-package imports use `@brainana/*` specifiers whose `exports` map points at **raw source**,
   so Vite and Node `.ts` type-stripping tests resolve identically (no build step in the test path).
2. **Dependency-light server.** A plain Node HTTP server with correct HTTP **range** support and
   extension-preserving file URLs (NiiVue selects its parser from the URL suffix). The only runtime
   dependency is `ssh2`, and it is **lazily imported** so the server and the local-data path work
   without it.
3. **Loopback-only + per-launch session token** on every data endpoint (see §4.5).
4. **`ssh2`/SFTP for the remote adapter** — non-blocking and remote-OS-agnostic (SFTP subsystem
   only; **no code runs on the workstation**, clean on shared boxes).
5. **Multiple data sources simultaneously** — local *and* remote subjects at once, source-scoped
   throughout so identical relative paths in two sources never collide.
6. **Server-side export everywhere** — atomic temp+rename on both local and remote, so no browser
   needs the File System Access API and there is no per-browser export branching.
7. **Tool-agnostic shared packages** (`packages/core-*`, `ui`, `niivue-kit`, `imaging-math`) that
   the Viewer and future sibling tools reuse. The domain boundary is **inverted and enforced**: a
   shared package never imports a tool's domain — the app injects its manifest provider into the
   core `DataSource`. `tests/core-purity_test.mjs` fails the build if a `packages/*` file imports
   `apps/` or `viewer/` code.

## 3. Component map

Tool-agnostic shared **`packages/*`** consumed by per-tool **`apps/*`** (today: `apps/viewer`).

| Layer | File(s) | Role |
|---|---|---|
| Core server | `packages/core-server/runtime.mjs` | HTTP server factory: `127.0.0.1` bind, session-token guard, source registry, source-scoped routes, static serving. `manifestProvider` is injected — core imports no domain. |
| Core security | `packages/core-server/security.mjs` | Per-launch session token (timing-safe compare), path containment (`isWithin`/`cleanRelative`/`resolveWithin`) |
| Data sources | `packages/core-server/{dataSource,localSource,sftpSource,sftpClient,cache}.mjs` | `DataSource` contract + registry; local FS source; non-blocking `ssh2`/SFTP source; async remote cache. Local/SFTP sources take an injected `manifest` provider (required). |
| Export | `packages/core-server/export.mjs` | Atomic server-side write (temp + rename) |
| Server CLI + version + paths | `packages/core-server/{main.mjs,version.mjs,paths.mjs}` | Generic `runServerCli(options)`; generated version (gitignored); per-OS cache paths (`paths.mjs` lives here to keep the package graph acyclic) |
| Launcher | `packages/core-launcher/launch.mjs` | Generic `bootServer(options)` (shared core: free port + retry, token, start server) and `launch(options)` (adds open-browser + signal handlers) |
| Desktop shell | `packages/core-desktop/{main.mjs,window.mjs}` | Tool-agnostic Electron main process: `runDesktop(options)` calls `bootServer`, then loads the loopback URL in a hardened `BrowserWindow` (Chromium ⇒ reliable WebGL2). Domain-free; see [desktop-app.md](desktop-app.md) |
| Client platform | `packages/core-client/*.ts` | `runtimeClient` (token → authed fetch), `sourceManager`, `filesystemClient`, `sessionPersistence`, `exportDestination`, `browserCapabilities` |
| Shared UI | `packages/ui/` | Design-token theme (`theme.css` + self-hosted `fonts/`), `h()` DOM helper, generic components (`colorbar`, `slider`, `rangeControl`, `legend`) |
| NiiVue kit | `packages/niivue-kit/` | Generic NiiVue helpers: `orientation.ts` (gizmo), `marker.ts` (landmark/crosshair) |
| Imaging math | `packages/imaging-math/` | Pure, headless math: `roiWarp.ts`, `projection.ts` (rigid/landmark/coordinate land here) |
| Viewer domain (server) | `apps/viewer/server/{manifest.mjs,freesurfer.mjs}` | Manifest + template discovery (exports `viewerManifestProvider`); FreeSurfer binary parse, GIFTI shape, adaptive hemisphere spacing |
| Viewer SPA | `apps/viewer/src/` | WebGL2 gate, source chooser, NiiVue rendering (`niivue/multiView.ts`), panels, unified color display, reports, visual-field plot; colormap catalog + colormap-coupled components (deferred, not yet generic) |
| Viewer entries | `apps/viewer/{launch.mjs,server.mjs,desktop.mjs}` | Composition roots: inject `viewerManifestProvider` + Viewer identity into the generic launcher (browser) / server CLI (headless) / desktop shell (Electron) |
| Build/test | `package.json` (root scripts + `workspaces`), `apps/*/package.json`, `tsconfig{,.base}.json`, `apps/viewer/vite.config.ts`, `apps/viewer/electron-builder.yml`, `scripts/generate-version.mjs`, `scripts/run-tests.mjs`, `.github/workflows/ci.yml` | Workspace build, desktop packaging config, per-app version generation, workspace-aware headless tests, CI matrix |
| Build output | `apps/*/dist/` (Vite SPA), `apps/*/release/` (electron-builder installers) | Build output — **gitignored** |

## 4. How it works

### 4.1 Server runtime (`packages/core-server/runtime.mjs`)
- Dependency-light Node HTTP server that **starts unbound** — no data directory is required at
  launch. It keeps a `Map<sourceId, DataSource>` and exposes a small REST surface to open, list,
  and close sources.
- **Binds `127.0.0.1` only.** Every `/api/*` and `/brainana-data/*` request requires the
  **per-launch session token** (§4.5). `/api/health` and `/api/version` are the only
  unauthenticated endpoints.
- **Source-scoped data routes.** File URLs are `/brainana-data/<sourceId>/<encoded rel>` and
  data-management endpoints are `/api/sources/:id/{monkeys,manifest,directories,import-files,save-list,save-mkdir,save-file}`.
  The `<sourceId>` route pattern is built from a single `SOURCE_ID_PATTERN` exported by
  `dataSource.mjs`, so routing can never drift from the id generator.
- **Registry + pre-add routes.** Beyond the scoped `:id/<action>` routes: `GET /api/runtime`
  (runtime + capabilities + sources), `GET/POST /api/sources`, `PATCH /api/sources/:id` (rename a
  source's `customLabel`), `DELETE /api/sources/:id`, and the pre-add folder pickers
  `GET /api/fs/browse` (local) and `POST /api/remote/connect` · `GET /api/remote/browse` ·
  `POST /api/remote/disconnect` (a transient SSH/SFTP browse session; the password is sent once and
  never persisted).
- **File serving** honors HTTP **range** requests (clamped to file size), preserves the real
  filename extension in the URL, and uses extension-driven content types. The source read stream is
  **released as soon as the client disconnects**, so NiiVue's many aborted range requests do not
  leak file descriptors / cached remote reads.
- **Robust startup.** Opening a startup source that fails is logged and skipped (non-fatal) rather
  than rejecting a shared readiness promise and 500-ing all later traffic. `startServer` attaches an
  `error` handler and **rejects on `EADDRINUSE`** instead of hanging.

### 4.2 DataSource model (`packages/core-server/dataSource.mjs`)
A `DataSource` is the uniform interface the runtime talks to: `listMonkeys`, `buildManifest`,
`listDirectories`, `listImportFiles`, `openFile` (range-aware), `saveList`/`mkdir`/`saveFile`,
`fileUrl`, `close`.

- **Injected manifest provider.** Subject discovery + manifest building are **domain** concerns, so
  `LocalDataSource`/`SftpDataSource` take a `manifest` provider (`{ isSubjectDir, resolveAnatDir,
  buildManifest }`) in their constructor (**required** — a missing provider throws). The app supplies
  it (`viewerManifestProvider`); core imports no domain module. This is the inversion of the old leak
  where core reached into `viewer/server/manifest.mjs`.
- **`LocalDataSource`** — backed by a local filesystem root; all listing, manifest, serving, and
  export hang off that root with source-scoped URLs and full path containment.
- **`SftpDataSource`** — backed by a remote workstation over **`ssh2`/SFTP**. It is **non-blocking**
  and **remote-OS-agnostic** (SFTP subsystem only; **no code runs on the workstation**). Remote
  files are cached locally (`cache.mjs`, validated by size + mtime, atomic temp + rename); for
  manifest building it materializes a subject into a local mirror (directory placeholders + real
  surface binaries) and runs the same manifest builder as the local source, so the Viewer-domain
  logic is written once. Directory listings **resolve symlinks to their target type** (a symlinked
  directory is listed as a directory, not hidden as a file). The SSH connection is torn down if the
  SFTP subsystem fails to start, and a failed upload cleans up its remote temp file.

### 4.3 Viewer domain — server (`apps/viewer/server/`)
- **`manifest.mjs`** (`buildManifest`): regex-matches BIDS-ish filenames per subject to locate
  anatomy, atlases (**generic discovery** of every `atlas-<name>_space-*.nii.gz` in the chosen
  space dir — e.g. ARM1–6, D99, MacBNA, CortHierarchy, FuncNetwork — emitted as a flat `atlases`
  array, ARM ordered numerically first), retinotopy/somatotopy 4D maps (with frame indices),
  transforms, surfaces, and morphology; emits JSON of source-scoped URLs. `fileUrl` is **injected
  by the data source** so the manifest stays URL-scheme-agnostic. The anat and fastsurfer
  directories are resolved **flexibly**: a subject may store anat flat (`sub-*/anat`) or under a
  BIDS session (`sub-*/ses-*/anat`), and fastsurfer output may be keyed by subject or
  subject+session. The atlas **space** is chosen once per subject
  (`atlas_space-fsnative` → `atlas_space-T1w` → `atlas_space-scanner`, first with an atlas volume);
  all volume-side assets come from that single dir while surface `.func.gii` overlays are always
  fsnative (see `data-contract.md`).
- **`freesurfer.mjs`** (`ensureDerivedAssets`): parses **FreeSurfer binary** surfaces/morphology in
  Node, writes GIFTI `.shape.gii`, and computes **adaptive per-subject hemisphere spacing** for
  inflated/veryinflated/sphere. Cached under `<root>/.brainana-viewer-cache/`, mtime-invalidated.

### 4.4 Frontend SPA (`apps/viewer/src/`)
- **Bootstrap** (`main.ts`): gates on **WebGL2** (`browserCapabilities`) — an unsupported browser
  gets a friendly message; otherwise it mounts the single-screen dashboard.
- **Source chooser** (`ui/dialogs/sources.ts`): add a local folder or a remote SSH/SFTP workstation
  and browse each source's subjects with a manifest summary, no relaunch. A pre-add folder picker
  browses local or (over a transient connection) remote directories; saved connection profiles
  (host/port/user, no passwords) and per-source editable custom labels are supported. Each loaded
  subject stays tagged with its `sourceId`; several sources coexist.
- **Rendering** (`niivue/multiView.ts`): a `MultiView` holds **two** NiiVue instances — a
  multiplanar **slice montage** and a 3D **surface render** — with manual crosshair coupling between
  them. The base volume, the **atlas overlay** (categorical parcellations via the discrete label
  shader, or continuous float-scalar atlases quantized into 256 colormap bins), and the
  **functional 4D overlay** (with F-threshold
  masking) live on the slices; cortical **surfaces**, **morphology shading** (curvature
  binary/continuous · sulc · thickness), the precomputed **atlas/function surface layer**, and the
  draggable **yellow marker** live on the render. Custom retinotopy/somatotopy/curvature LUTs are
  registered on both instances.
- **Panels & controls** (`ui/`): atlas (generic — every atlas in the manifest, including continuous
  float-scalar atlases such as CortHierarchy rendered via a colormap), morphology, and function pickers; a unified
  **Color display** section (colormap picker, legend, display range, clip) that targets whichever
  overlay is active; per-crosshair coordinate/anatomy/function reports; a **visual-field plot**;
  arrow-key crosshair nudging; layout presets and camera view presets.
- **Staged, not yet wired into the UI:** imported-volume **surface projection**
  (`@brainana/imaging-math/projection.ts` + `workers/projection.worker.ts` + `niivue/projectionClient.ts`)
  and **ROI generation** (`@brainana/imaging-math/roiWarp.ts`). These are implemented and unit-tested
  but have no UI entry point yet, along with snapshot/state/ZIP export.

### 4.5 Security & export
- **Session token.** The launcher mints a per-launch, high-entropy token. The server templates it
  into `index.html` as `<meta name="brainana-token">` **and** sets it as a loopback `Set-Cookie`
  (`brainana_token`, `HttpOnly; SameSite=Strict`) so NiiVue's own header-less loaders authenticate
  on same-origin data fetches. The token is accepted from `Authorization: Bearer`, `X-Brainana-Token`,
  or the cookie — **never from a `?token=` query param**, which would leak it into URLs, history,
  and logs. Comparison is timing-safe (both sides hashed to a fixed width first, so a length
  mismatch is safely false, never a throw).
- **Legacy-compat is explicit opt-in.** The built `dist/` IS the source-scoped, token-guarded SPA;
  it never uses the unscoped route. The token-exempt unscoped `/brainana-data/<rel>` route exists
  only when `--legacy` is passed, never merely because a build is present.
- **Path containment** (`isWithin`, `cleanRelative`, `resolveWithin`) guards every filesystem and
  remote path; traversal (`..`), absolute breakouts, and NUL are rejected.
- **Server-side export** (`/api/sources/:id/save-*`) writes into the source with containment +
  atomic temp-file rename — identical for local and remote, so there is no per-browser branching.

### 4.6 Launcher (`packages/core-launcher/launch.mjs`)
Generic, tool-agnostic `launch(options)`: generate a per-launch session token, scan for a free
loopback port, start the core server (with the app's injected `manifestProvider`), and open the
default browser (`open` / `start` / `xdg-open`). If the chosen port is taken between probe and bind
it **retries the next candidate**, falling back to an OS-chosen ephemeral port, so it never hangs on
a busy box. The app supplies identity (banner label, `cacheApp`, `distRoot`, `preferredPort`) — see
`apps/viewer/launch.mjs`. The per-OS cache directory (`packages/core-server/paths.mjs`) resolves to
`%LOCALAPPDATA%` / `$XDG_CACHE_HOME` / `~/Library/Caches`. `packages/core-server/main.mjs` exports the
generic `runServerCli(options)` for headless use; `apps/viewer/server.mjs` (`npm run server`) is the
Viewer's thin composition entry over it.

### 4.7 Version & build
`scripts/generate-version.mjs` emits `packages/core-server/version.mjs` from a package.json (and the
git tag/commit when available) — the single source of the app version and build id. It is
**parametrised** (`--app <name>` / `--version-from <pkg.json>` / `--out <path>`) so each tool can emit
its own identity; the default is `brainana-viewer`. The generated file is **gitignored** and
regenerated by the `pre{build,dev,start,server,test}` npm hooks, so no run path uses a stale copy and
there is no committed churn. `tsc` typechecks the browser TS across the workspace (`packages/core-client`,
`packages/ui`, `packages/niivue-kit`, `packages/imaging-math`, `apps/viewer/src`); `vite build --config
apps/viewer/vite.config.ts` (root pinned via `import.meta.dirname`) produces `apps/viewer/dist/`.
Supported browsers are encoded once as a `browserslist` query in `package.json`. **Node ≥ 22.18** is
required (the unit tests import `.ts` sources directly, relying on Node's type stripping).

## 5. Status & strengths

**Implemented and verified:** the full core platform (runtime, security, the DataSource registry
with local + remote sources, async cache, atomic export, launcher, version generation), the
Viewer-domain manifest/FreeSurfer code, the client platform layer + in-app multi-source chooser, and
a substantial NiiVue frontend (dual-instance rendering, surfaces, generic categorical + continuous
atlas overlays, retinotopy/somatotopy with F-threshold masking, morphology shading, yellow-marker modes, the unified
color-display section, crosshair reports, and the visual-field plot). A headless test suite covers
the server (bind + token rejection, ranged fetch, local + fake-SFTP round-trips) and the pure
domain math (atlas/colormap/functional/gifti/projection/range/roiWarp/visualfield), run across a
CI matrix (macOS/Linux/Windows).

**Desktop packaging (Electron):** the native standalone app is built and verified end-to-end — the
tool-agnostic `core-desktop` shell, the `apps/viewer/desktop.mjs` entry, and `electron-builder.yml`
producing per-OS artifacts (the packaged binary boots the loopback server and resolves all bundled
`@brainana/*` imports). See [desktop-app.md](desktop-app.md). Remaining: a GitHub Actions release
matrix to build all three OSes on a tag, and code signing/notarization for wider distribution.

**Not yet wired:** imported-volume surface projection and ROI generation (implemented + unit-tested,
no UI entry point yet), snapshot/state/ZIP export, and the full browser-compat test matrix.

Design strengths carried by the current route:
- Dependency-light server with correct **range** support and **extension-preserving** file URLs.
- **Loopback-only bind + per-launch session token** on all data endpoints; token never in a URL.
- Solid **path containment** and **atomic writes** on local and remote save paths.
- **Server-side export everywhere** — no browser folder-API dependency.
- Robust **derived-asset caching** with mtime invalidation; FreeSurfer binary parsing avoids
  external tools.
- Remote access is **local-only** — no code installed/executed on the workstation, remote-OS-agnostic
  via SFTP.
- **Source-first** with clean tool-agnostic shared `packages/*` a sibling tool reuses (boundary
  enforced by `tests/core-purity_test.mjs`).
