# Brainana Viewer

Cross-platform NiiVue-based viewer for per-subject (`sub-*`) output from the `brainana`
Nextflow pipeline. This is the **source-first rebuild** (fresh `0.x` line) tracked in
`docs/technical-route-and-improvement-plan.md`.

> Status: **Phase 0 + Phase 1 complete** — foundation and core platform.
> The NiiVue frontend rebuild (Phase 3) is not done yet; the reference `dist/`
> bundle is served through a legacy-compat route so the app remains usable.

## Layout

```
core/       tool-agnostic platform layer (server runtime, data sources, launcher, client infra)
viewer/     Viewer domain layer (manifest + FreeSurfer parsing; rebuilt UI lands in viewer/src)
scripts/    generate-version, test runner, packaging
tests/      headless server smoke + security + sftp tests
dist/       BUILD OUTPUT — gitignored
```

## Requirements

- Node **>= 20**
- A modern desktop browser with **WebGL2** (Chrome/Edge baseline; Firefox/Safari supported)

## Develop

```sh
npm install                 # install deps (ssh2 + build/frontend toolchain)
npm run generate-version    # emit core/server/version.mjs from package.json
npm test                    # headless: local data source, security, sftp
npm start                   # launch: free port, 127.0.0.1 bind, open browser
```

## Data sources

The server starts **unbound** and holds a registry of data sources. You add sources
in-app (no relaunch): a **local** folder or a **remote** workstation over SSH/SFTP.
Multiple sources can be loaded simultaneously; each subject is tagged with its `sourceId`
and file URLs are source-scoped (`/brainana-data/<sourceId>/<rel>`).

## Security

The server binds `127.0.0.1` only. Every `/api/*` and data request requires a
per-launch **session token** (timing-safe compare) that the launcher generates and the
server templates into `index.html` at serve time — so the token never appears in a URL
or browser history. See `core/server/security.mjs`.
