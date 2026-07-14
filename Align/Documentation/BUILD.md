# Build and packaging

## Requirements for source development

- Node and npm compatible with the lockfile
- Python 3 for stress-test helpers
- Bash for macOS launcher tests
- Official Node executables for each packaged runtime architecture

The distributed macOS application itself does not require users to install these tools.

## Build the frontend and run validation

From `source/`:

```bash
npm ci
npm run check
```

The check gate builds TypeScript and Vite output, then runs scientific, coordinate, session, export, server, security, storage, SFTP, browser, launcher, SSH, and lifecycle tests. Browser engines unavailable in a local environment must not be represented as certified; CI is expected to require Chromium, Firefox, and WebKit.

## Assemble the macOS application

From the repository root:

```bash
scripts/assemble-macos-app.sh \
  --arm64-node /path/to/darwin-arm64/node \
  --x64-node /path/to/darwin-x64/node \
  --out /path/to/output
```

Run `scripts/verify-release.mjs` against the assembled package before creating ZIP files.

## Required release artifacts

Every release must include:

- self-contained packaged application
- complete shared source
- full release bundle
- `README-FIRST.md`
- consolidated `Documentation/` directory
- `VERSION.json`
- `RELEASE_CONTENTS.txt`
- `SHA256SUMS.txt`

The documentation directory must contain only the maintained documentation set. Version-stamped `ARCHITECTURE-*`, `CHANGELOG-*`, and `VALIDATION-*` files and a duplicate `Documentation-release/` tree are prohibited.
