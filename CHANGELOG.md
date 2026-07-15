# Changelog

All notable changes to Brainana Viewer are documented here.

## [0.1.0] — unreleased

### Added
- **Core platform layer** (`core/`), tool-agnostic and reusable:
  - `runtime.mjs` — HTTP server factory that binds `127.0.0.1` and guards `/api/*`
    and data routes with a per-launch session token.
  - `security.mjs` — session token (timing-safe compare) + path containment helpers.
  - `dataSource.mjs` — `DataSource` interface + in-process source registry; the server
    starts **unbound** and holds `Map<sourceId, DataSource>`.
  - `localSource.mjs` — local filesystem data source.
  - `sftpSource.mjs` / `sftpClient.mjs` — non-blocking remote source over `ssh2`/SFTP
    (SFTP subsystem only; no code runs on the workstation), with an async cache.
  - `cache.mjs` — async remote-file cache (sha256 + size + mtime), atomic writes.
  - `export.mjs` — server-side save-list / mkdir / save-file, atomic temp + rename.
  - `launcher/launch.mjs` — cross-platform launcher (free-port scan, token, open browser).
- **Viewer domain layer** (`viewer/server/`): `manifest.mjs` + `freesurfer.mjs`, with
  flexible anat/fastsurfer discovery (flat `sub-*/anat` or session `sub-*/ses-*/anat`).
- **Source-scoped file URLs** (`/brainana-data/<sourceId>/<rel>`) enabling simultaneous
  multi-source loading; server binds loopback only and requires the session token.
- **Client platform layer** (`core/client/`, TS): `runtimeClient` (token from meta tag →
  authed fetch), `sourceManager` (add/list/remove sources), `filesystemClient`
  (monkeys/manifest/browse per source), `sessionPersistence` (recents, no secrets),
  `exportDestination` (server-side export + ZIP fallback), `browserCapabilities` (WebGL2 gate).
- **In-app source chooser** (`viewer/src/`): add local + remote sources and browse each
  source's subjects with a manifest summary, no relaunch. Vite build → `dist/`.
- `scripts/generate-version.mjs` — single source of version + build id.
- CI skeleton (macOS/Linux/Windows matrix); headless tests for server, security, sftp,
  and the built frontend (token injection).

### Not yet done
- Phase 3 NiiVue rendering + full panel set (surfaces, atlases, retino/somato, ROI,
  projection, snapshot/state/ZIP export); Phase 4 per-OS packaging/signing;
  Phase 5 full test matrix + docs.
