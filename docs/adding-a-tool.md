# Adding a sibling tool (Aligner, Editor, …)

The repo is an **npm-workspaces monorepo**: shared `packages/*` consumed by per-tool `apps/*`.
A new tool is a new `apps/<tool>/` that composes the shared platform — it should add **no**
duplicate server/launcher/client/UI code. If you find yourself copying a file from `apps/viewer`,
that file probably belongs in a shared package instead.

## What you reuse (never re-implement)

| Package | Gives you |
|---|---|
| `@brainana/core-server` | Loopback HTTP runtime, session-token guard, `DataSource` registry (local + SFTP), remote cache, atomic export, per-OS paths. `runServerCli(options)` for a headless entry. |
| `@brainana/core-launcher` | `bootServer(options)` — mint token, free port, start server (shared core); `launch(options)` adds open-browser + signal handlers. |
| `@brainana/core-desktop` | `runDesktop(options)` — the Electron shell: boots the server via `bootServer`, loads the loopback URL in a hardened `BrowserWindow`. Same options object as `launch`. See [desktop-app.md](desktop-app.md). |
| `@brainana/core-client` | Browser platform: `RuntimeClient`, `SourceManager`, `FilesystemClient`, session persistence, export destinations, WebGL2 capability gate. |
| `@brainana/ui` | Design-token theme (`theme.css` + fonts), the `h()` DOM helper, generic components (colorbar, slider, range control, legend). |
| `@brainana/niivue-kit` | Generic NiiVue helpers: orientation gizmo, landmark/crosshair markers. |
| `@brainana/imaging-math` | Pure, headless math: ROI warp, volume→surface projection (add rigid/landmark/coordinate here). |

## What your app owns

- Its **domain manifest provider** — a `{ isSubjectDir, resolveAnatDir, buildManifest }` object the
  core `DataSource` is given so core never imports your domain. See
  `apps/viewer/server/manifest.mjs` (`viewerManifestProvider`).
- Its **UI** (dashboard, panels, domain-specific components) and any **domain math/data shaping**.
- Thin **composition entries** that inject identity + provider into the shared platform:
  `apps/<tool>/launch.mjs` (browser, calls `launch(...)`), `apps/<tool>/server.mjs` (headless, calls
  `runServerCli(...)`), and — for a native desktop build — `apps/<tool>/desktop.mjs` (calls
  `runDesktop(...)`). Copy `apps/viewer/{launch,server,desktop}.mjs` and change the identity strings.

## Steps

1. `mkdir apps/<tool>` with `package.json` (`name: @brainana/<tool>`, depend on the `@brainana/*`
   packages you use + `@niivue/niivue`), `index.html`, `vite.config.ts` (`root: import.meta.dirname`),
   `src/main.ts`, `server/manifest.mjs` (your provider), and `launch.mjs` + `server.mjs`.
2. Import the shared theme first: `import '@brainana/ui/theme.css'` before your app CSS — do **not**
   redefine the design tokens; add only layout rules.
3. Add root `package.json` scripts (or use `npm run <script> --workspace @brainana/<tool>`), and emit
   the tool's version with `node scripts/generate-version.mjs --app brainana-<tool>`.
4. Put tests under `apps/<tool>/tests/` or `packages/<pkg>/tests/` — the runner
   (`scripts/run-tests.mjs`) discovers `tests/`, `packages/*/tests`, and `apps/*/tests` automatically.

## Invariants (enforced)

- **`tests/core-purity_test.mjs`** fails the build if any `packages/*` shared package imports `apps/`
  or `viewer/` domain code. Keep the dependency arrow pointing **app → package**, never the reverse.
- Package `exports` maps point at **raw source** (`.ts`/`.mjs`) — no build step — so Vite and Node
  `.ts` type-stripping tests resolve identically. Keep the explicit file extension in importers.
- A shared module lives in **exactly one place**. If a second tool needs a Viewer-specific component
  (e.g. the colormap picker), promote it by **parameterizing** it (pass the registry in) and moving it
  to a package — do not copy it.
