<p align="center">
  <img src="docs/_static/brainana_logo_side.png" alt="Brainana logo" width="500">
</p>

# Brainana Viewer

Cross-platform NiiVue viewer for per-subject (`sub-*`) output of the
[**Brainana**](https://github.com/xingyu-liu/brainana) macaque MRI pipeline.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL--v3-blue.svg)](LICENSE)

> **Status:** Source-first rebuild (fresh `0.x` line). Phases 0–2 complete
> (foundation, core platform, unified multi-source data path); Phase 3 (NiiVue SPA)
> substantially built; Phase 4 desktop packaging (Electron) built and verified.
> Release CI and the full browser/test matrix are still ahead. See
> [docs/technical-route.md](docs/technical-route.md).

## Requirements

- **Node ≥ 22.18** — unit tests import `.ts` sources directly via Node type stripping
- A modern desktop browser with **WebGL2** (Chrome/Edge baseline; Firefox/Safari supported)

## Quick start

A trimmed demo subject (`sub-example`) ships in
[datasets/demo_viewer/](datasets/demo_viewer/) — no data of your own needed:

```sh
npm install                                                       # workspace deps (single lockfile)
npm run server -- --port 5174 --output-dir datasets/demo_viewer   # Terminal 1: API + demo data
npm run dev:web                                                   # Terminal 2: Vite UI → http://localhost:5173
```

Open the URL Vite prints and select `sub-example`. Alternatively, launch unbound
(`npm start` or `npm run dev:desktop`) and add `datasets/demo_viewer` in-app via the
local-source picker.

## Develop

```sh
npm test               # headless: domain math, server, security, sftp, built-frontend token injection, core-purity guard
npm run dev:web        # Vite dev server (client HMR) — pair with `npm run server`
npm start              # launch the Viewer: free port, 127.0.0.1 bind, open browser
npm run dev:desktop    # launch as a native Electron app (bundled Chromium)
npm run dist:desktop   # build per-OS desktop installers → apps/viewer/release/
```

See [docs/dev_guideline.md](docs/dev_guideline.md) for the two-process model, ports, and
troubleshooting, and [docs/desktop-app.md](docs/desktop-app.md) for the Electron shell.

## Architecture

An **npm-workspaces monorepo**: tool-agnostic shared `packages/*` consumed by per-tool
`apps/*`. Adding a sibling tool (Aligner, Editor) means a new `apps/<tool>/` — no duplicated
platform code ([docs/adding-a-tool.md](docs/adding-a-tool.md)).

| Package             | Responsibility                                                        |
| ------------------- | --------------------------------------------------------------------- |
| `core-server`       | HTTP runtime, security, DataSource registry (local + SFTP), cache, export |
| `core-launcher`     | `bootServer()` (token → free port → server) + `launch()` (opens browser)   |
| `core-desktop`      | Electron shell: `runDesktop()` loads the loopback URL natively        |
| `core-client`       | Browser platform: runtime/source/filesystem clients, session, WebGL2 gate |
| `ui` / `niivue-kit` | Design-token theme + DOM helpers / generic NiiVue helpers             |
| `imaging-math`      | Pure headless math (ROI warp, volume→surface projection)              |
| `apps/viewer`       | The Viewer: SPA + manifest/FreeSurfer server + launch/desktop entries |

Cross-package imports use `@brainana/*` specifiers whose `exports` map points at **raw
source**, so Vite and Node's `.ts` tests resolve identically — no build step in the test path.

## Data sources

The server starts **unbound** and holds a registry of sources you add in-app without a
relaunch: a **local** folder or a **remote** workstation over SSH/SFTP. Multiple sources
load simultaneously; each subject is tagged with its `sourceId` and file URLs are
source-scoped (`/brainana-data/<sourceId>/<rel>`).

## Security

The server binds `127.0.0.1` only. Every `/api/*` and data request requires a per-launch
**session token** (timing-safe compare) that the launcher generates and the server templates
into `index.html` at serve time — so the token never appears in a URL or browser history.
See `packages/core-server/security.mjs`.

## License

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0), the same license
as the parent [**Brainana**](https://github.com/xingyu-liu/brainana) pipeline. See
[LICENSE](LICENSE). Bundled fonts (Source Sans 3, IBM Plex Mono) are under the SIL Open Font
License 1.1 ([packages/ui/fonts/](packages/ui/fonts/)); full dependency inventory in
[docs/dependency-audit.md](docs/dependency-audit.md).
