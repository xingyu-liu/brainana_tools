# Brainana Viewer — Technical Route & Improvement Plan

**Scope:** `/home/star/github/brainana_viewer` (standalone viewer for `brainana` pipeline output)
**Version:** app `0.1.0`
**Date:** 2026-07-14

> This document has two parts: **Part I** describes the current technical route as implemented; **Part II** is the forward plan for the work still ahead.

---

# Part I — Current technical route

## 1. What this tool is

A NiiVue-based desktop viewer for per-subject (`sub-*`) neuroimaging output from the `brainana` Nextflow pipeline: multi-planar NIfTI volumes, FreeSurfer/GIFTI cortical surfaces, ARM/D99 atlases, retinotopy/somatotopy functional maps, morphology overlays, imported volumes with surface projection, ROI generation, and snapshot/state export.

It runs as a **local Node HTTP server + a browser SPA**. The server starts **unbound** and holds a registry of *data sources*; the user adds a **local folder** and/or a **remote workstation (over SSH/SFTP)** in-app, and can hold subjects from several sources at once without relaunching. It targets **macOS, Linux, and Windows**.

## 2. Component map

The codebase is split into a tool-agnostic **`core/`** platform layer and a Viewer-specific **`viewer/`** domain layer, so the platform can later be reused by a sibling tool.

| Layer | File(s) | Role |
|---|---|---|
| Core server | `core/server/runtime.mjs` | HTTP server factory: `127.0.0.1` bind, session-token guard, source registry, source-scoped routes, static serving |
| Core security | `core/server/security.mjs` | Per-launch session token (timing-safe compare), path containment (`isWithin`/`cleanRelative`/`resolveWithin`) |
| Data sources | `core/server/dataSource.mjs`, `localSource.mjs`, `sftpSource.mjs`, `sftpClient.mjs`, `cache.mjs` | `DataSource` contract + registry; local FS source; non-blocking `ssh2`/SFTP source; async remote cache |
| Export | `core/server/export.mjs` | Atomic server-side write (temp + rename) |
| Version | `core/server/version.mjs` (generated) | Single source of app version + build id |
| Entry / launcher | `core/server/main.mjs`, `core/launcher/launch.mjs` | CLI server entry; cross-platform launcher (free port, token, open browser) |
| Viewer domain | `viewer/server/manifest.mjs`, `freesurfer.mjs` | Manifest + template discovery; FreeSurfer binary parse, GIFTI shape, adaptive hemisphere spacing |
| Frontend SPA | `viewer/src/` | NiiVue rendering + UI (in progress) |
| Build/test | `package.json`, `tsconfig.json`, `scripts/generate-version.mjs`, `scripts/run-tests.mjs`, `.github/workflows/ci.yml` | Build, version generation, headless tests, CI matrix |
| Build output | `dist/` | Vite build output — **gitignored** |

## 3. Technical route (how it works)

### 3.1 Server runtime (`core/server/runtime.mjs`)
- Dependency-light Node HTTP server that **starts unbound** — no data directory is required at launch. It keeps a `Map<sourceId, DataSource>` and exposes a small REST surface to open, list, and close sources.
- **Binds `127.0.0.1` only.** Every `/api/*` and `/brainana-data/*` request requires a **per-launch session token** (timing-safe compare). The launcher generates the token and the server templates it into `index.html` at serve time (loopback only), so the client reads it from a `<meta>` tag — the token never appears in a URL or history. `/api/health` and `/api/version` are the only unauthenticated endpoints.
- **Source-scoped data routes.** Manifest file URLs are `/brainana-data/<sourceId>/<encoded rel>`, and data-management endpoints are `/api/sources/:id/{monkeys,manifest,directories,import-files,save-list,save-mkdir,save-file}`. Because every URL and every loaded subject carries its `sourceId`, subjects from multiple sources coexist without path collisions.
- **File serving** honors HTTP **range** requests and preserves the real filename extension in the URL (NiiVue selects its mesh/overlay parser from the URL suffix), with extension-driven content types.

### 3.2 DataSource model (`core/server/dataSource.mjs`)
A `DataSource` is the uniform interface the runtime talks to:

```
interface DataSource {
  listMonkeys(), buildManifest(subjectId),
  listDirectories(rel), listImportFiles(rel, q),
  openFile(rel, rangeHeader) -> { total, contentType, start, end, partial, stream },
  saveList(rel), mkdir(rel), saveFile(rel, stream, {overwrite}),
  fileUrl(absOrRel), close()
}
```

- **`LocalDataSource`** — backed by a local filesystem root; all listing, manifest, serving, and export operations hang off that root with source-scoped URLs and full path containment.
- **`SftpDataSource`** — backed by a remote workstation over **`ssh2`/SFTP**. It is **non-blocking** (async ssh2, never blocking the event loop) and **remote-OS-agnostic** (SFTP subsystem only — no reliance on remote shell utilities), and **no code runs on the workstation**. Remote files are cached locally (`cache.mjs`, validated by size + mtime, atomic temp + rename). For manifest building it materializes a subject into a local mirror (directory placeholders + real surface binaries) and then runs the same manifest builder as the local source, so the Viewer-domain logic is written once. `ssh2` is **lazily imported**, so the server and the local-data path work even if the remote dependency is not installed.

### 3.3 Viewer domain (`viewer/server/`)
- **`manifest.mjs`** (`buildManifest`): regex-matches BIDS-ish filenames per subject to locate anatomy, ARM1–6 + D99 atlases, retinotopy/somatotopy 4D maps (with frame indices), scanner + template transforms, surfaces, and morphology; emits JSON of source-scoped URLs. `fileUrl` is **injected by the data source** so the manifest stays URL-scheme-agnostic. The anat directory and the fastsurfer directory are resolved **flexibly**: a subject may store anat directly (`sub-*/anat`) or under a BIDS session (`sub-*/ses-*/anat`), and fastsurfer output may be keyed by subject or subject+session.
- **Template discovery** (`discoverTemplateTransforms`): parses `from-X_to-Y_mode-image_xfm.nii(.gz)` names to build per-template import/export capability, excluding `T1w`/`scanner`.
- **`freesurfer.mjs`** (`ensureDerivedAssets`): parses **FreeSurfer binary** surfaces/morphology in Node, writes GIFTI `.shape.gii`, and computes **adaptive per-subject hemisphere spacing** for inflated/veryinflated/sphere. Cached under `<root>/.brainana-viewer-cache/`, mtime-invalidated.

### 3.4 Security & export
- **Path containment** (`isWithin`, `cleanRelative`, `resolveWithin`) guards every filesystem and remote path; traversal (`..`), absolute breakouts, and NUL are rejected.
- **Server-side export** (`/api/sources/:id/save-*`) writes into the source with containment + atomic temp-file rename — identical for local and remote, so there is no per-browser export branching.

### 3.5 Launcher (`core/launcher/launch.mjs`)
Cross-platform Node launcher: generate a per-launch session token, scan for a free loopback port, start the server, and open the default browser (`open` / `start` / `xdg-open`). The per-OS cache directory resolves to `%LOCALAPPDATA%` / `$XDG_CACHE_HOME` / `~/Library/Caches` with a `~/.cache` fallback. `core/server/main.mjs` is the CLI entry for headless/`npm run server` use.

### 3.6 Version & build
`scripts/generate-version.mjs` emits `core/server/version.mjs` from `package.json` (and the git tag/commit when available). It is the single source of the app version and build id — there are no hardcoded copies.

## 4. Current status & strengths

**Implemented and verified (Phase 0 + Phase 1):** the foundation and the full core platform — runtime, security, the DataSource registry with local + remote sources, async cache, atomic export, launcher, version generation, the Viewer-domain manifest/FreeSurfer code, CI skeleton, and a headless test suite. The **NiiVue frontend** (`viewer/src/`) is the remaining large piece (Part II, Phase 3).

Strengths carried by the current design:
- Clean, dependency-light server with correct **range** support and **extension-preserving** file URLs.
- **Loopback-only bind + per-launch session token** on all data endpoints.
- Solid **path containment** and **atomic writes** on local and remote save paths.
- **Server-side export** everywhere — no browser folder-API dependency.
- Robust **derived-asset caching** with mtime invalidation; FreeSurfer binary parsing avoids external tools.
- Remote access is **local-only** — no code installed/executed on the workstation (clean on shared boxes), and remote-OS-agnostic via SFTP.
- **Source-first**: `src/` authoritative & committed, `dist/` built in CI.

---

# Part II — Forward plan

## 5. Design decisions (in force)

1. **Source-first, cross-platform.** `src/` is authoritative and committed; `dist/` is built in CI. Target **macOS + Linux + Windows**.
2. **Evergreen desktop browsers.** Baseline/primary-tested **Chrome + Edge** (Chromium); supported **Firefox** and **Safari** (last 2 major versions each), encoded once as a [Browserslist](https://browsersl.ist) query. Hard requirement: **WebGL2** (gated with a friendly message). Out of scope: mobile/legacy browsers. Full cross-browser is realistic because export is server-side (§6.3), so no browser needs the File System Access API.
3. **`ssh2`/SFTP** for the remote adapter — non-blocking and remote-OS-agnostic.
4. **Multiple data sources simultaneously** — hold local *and* remote subjects at once, source-scoped throughout.
5. **SOTA distribution** — signed/notarized release artifacts built by CI.
6. **Tool-agnostic `core/` layer** so a future sibling tool can reuse it. Keep the core/domain boundary clean so package extraction stays cheap; do not extract a separate published package yet.

**Intended outcome:** a source-first, cross-platform, testable Viewer where the user launches the app, then loads local and/or remote monkey data in-browser without relaunching — built on a reusable core.

## 6. Target architecture

The clean **core (platform, tool-agnostic) / viewer (domain)** split below; **bold** entries exist today, the rest are planned.

```
brainana_viewer/
  core/                         # tool-agnostic platform layer
    server/
      runtime.mjs               # **http server factory; 127.0.0.1 bind; token guard; source registry**
      security.mjs              # **session token, timing-safe compare, path containment**
      dataSource.mjs            # **DataSource contract + in-process registry**
      localSource.mjs           # **LocalDataSource (fs)**
      sftpSource.mjs            # **SftpDataSource (ssh2, non-blocking)**
      sftpClient.mjs            # **ssh2 SFTP wrapper: connect/list/stat/read-range/upload + keepalive**
      cache.mjs                 # **async remote file cache (sha256+size+mtime), atomic**
      export.mjs                # **atomic save (temp+rename)**
      version.mjs               # **generated single source of version/buildId**
      main.mjs                  # **CLI server entry**
    client/                     # framework-agnostic frontend infra (TS)
      runtimeClient.ts          # **/api/runtime, health, version, token injection**
      sourceManager.ts          # **create/list/delete sources; client-side multi-source registry**
      filesystemClient.ts       # **browse/list/import scoped to a source session**
      sessionPersistence.ts     # **remember last sources (no secrets)**
      browserCapabilities.ts    # **WebGL2 gate with friendly messaging**
      exportDestination.ts      # **server-side export (+ ZIP fallback)**
    launcher/
      launch.mjs                # **cross-platform: free port, start server w/ token, open browser**
      platform/                 # macos .app, linux .desktop/AppImage, windows .cmd/.ps1 shims — planned
  viewer/                       # Viewer domain layer
    server/
      manifest.mjs              # **buildManifest + template discovery**
      freesurfer.mjs            # **FS binary parse, GIFTI shape, adaptive hemisphere spacing**
    src/                        # **source chooser UI**; NiiVue rendering + panels — planned
  scripts/                      # **generate-version, run-tests**; package-<os>, verify-release — planned
  tests/                        # **local smoke + security + sftp**; browser-compat — planned
  dist/                         # BUILD OUTPUT — gitignored
```

### 6.1 Client source manager & chooser UI
`core/client` gains a source manager (create/list/delete sources) and the browser gains an in-app chooser so the user adds local/remote sources without relaunching. Each loaded subject stays tagged with its `sourceId`; the browser holds subjects from multiple sources at once.

### 6.2 Frontend
Implement the NiiVue UI and every panel to full behavior: surfaces, ARM/D99 atlases, retinotopy + somatotopy (with the F-threshold & LUT handling), morphology, imported-volume projection, yellow-marker modes, ROI generation, visual-field plot, and snapshot/state/ZIP export. `browserCapabilities.ts` gates on **WebGL2** with a friendly fallback.

### 6.3 Distribution & browser support
- **Distribution (SOTA):** CI matrix (mac/linux/win) → typecheck → build → tests → package → sign/notarize (mac) → attach release artifacts. Bundle per-OS Node (darwin/linux/win x64+arm64) or require system Node ≥ 20 for the CLI path.
- **Export:** standardize on **server-side export** with a universal **ZIP download** fallback — no per-browser branching.
- **Browsers:** Chrome + Edge (baseline), Firefox, Safari (last 2 majors), encoded once as a Browserslist query that Vite/TS read for the build target; WebGL2 is the one hard requirement.

## 7. Phased execution

| Phase | Focus | Status |
|---|---|---|
| **0 Foundation** | `core/`+`viewer/` layout; `.gitignore dist/`; `generate-version.mjs`; CI skeleton (mac/linux/win) + headless smoke test | **Done** |
| **1 Core platform** | `runtime.mjs` (127.0.0.1 + token), `dataSource` registry, `LocalDataSource`, `SftpDataSource` (ssh2 + async cache), `export.mjs`, `launch.mjs`; Viewer-domain manifest/FreeSurfer | **Done** |
| **2 Unified data source** | `core/client` source manager + chooser UI; source-scoped manifests/URLs surfaced in-app; simultaneous multi-source | **Done** |
| **3 Frontend** | NiiVue UI + every panel to full parity (surfaces, ARM/D99, retino+somato, morphology, imported projection, yellow-marker modes, ROI, visual-field plot, snapshot/state/ZIP export) | Next |
| **4 Packaging/release** | Per-OS launchers/packaging; mac signing/notarization; CI release pipeline | Planned |
| **5 Tests + docs** | Unit (manifest/template/freesurfer), server security (token, containment), storage/export (atomic), sftp (fake SFTP server), **browser-compat matrix**; architecture + browser-support docs | Partial (server-side tests done) |

Phase 3 (the NiiVue frontend) is the largest remaining chunk; Phase 2 delivers the in-app unified data path; 4–5 harden and ship.

## 8. Edge cases & risks

- **Flexible subject layout** — anat may be flat (`sub-*/anat`) or session-nested (`sub-*/ses-*/anat`); fastsurfer output may be keyed by subject or subject+session. Discovery tolerates both and is exercised against real pipeline output.
- **Frontend is the largest remaining cost** — parity is verified feature-by-feature.
- **Remote OS variance** — ssh2/SFTP is remote-OS-agnostic (no reliance on GNU `find`/`stat`), keeping the "no code runs on the workstation" property (SFTP subsystem only).
- **Multi-source correctness** — source-scoped URLs prevent collisions when the same relative path exists in two sources; each layer/subject is tagged with its `sourceId`.
- **Token handling** — templated into loopback-served HTML (not URL/history); regenerated per launch; timing-safe compare; length-mismatch is safely false, never a throw.
- **Range / overwrite** — range requests are clamped to file size; saves use atomic temp+rename with existence re-checked after write, on both local and remote.
- **Optional remote dependency** — `ssh2` is lazily imported, so the server and the local path work without it; the SFTP test skips cleanly when it is absent.
- **No auto-cleanup on shared boxes** — ssh-connection and cache teardown is explicit/opt-in only; no background process-killing or cache-wiping.
- **Core kept Viewer-agnostic** — a future sibling tool can depend on it without Viewer coupling; package extraction deferred but structurally cheap.

## 9. Verification

- `npm ci && npm run build && npm test` on a clean clone, across the CI matrix (mac/linux/win).
- **Headless (implemented):** start the server unbound → create a **local** source on a fixture (and, when mounted, the real output dir) → list monkeys → build manifest → ranged byte fetch; create a **remote** source against a **fake SFTP server** → connect, list, ranged read through the cache, atomic upload; confirm the **`127.0.0.1` bind** and **token rejection** of unauthenticated calls. All current tests pass.
- **In a browser (planned):** launch → load a local subject (NiiVue volume + surfaces render) → add a second remote source and load another subject simultaneously → server-side export writes back atomically; repeat the render + export smoke check across the evergreen matrix (Chrome/Edge, Firefox, Safari) and assert the WebGL2 gate shows a friendly message where WebGL2 is unavailable.
