# Validation report

Validated in the build environment:

- Clean `npm ci`
- TypeScript compilation and Vite production build
- All eight automated tests
- Dynamic detection of D99 and an unknown future template
- Import enabled independently from export
- Export disabled without a template-space anatomical T1w reference
- Export enabled after the matching reference is added
- Scanner excluded from generic templates
- Local-proxy-to-remote-server configuration forwarding
- Workstation directory creation and exact binary write through the proxy
- Path-contained atomic server writes
- Server, launcher, and packaged-server syntax checks
- Launcher executable permission
- Version-specific remote runtime path
- Plain localhost URL opened through the macOS default-browser command

The build environment is Linux, so macOS AppleScript dialogs, a real SSH/Duo session, and interactive WebGL rendering on the target Mac were not executable here. The package is therefore a source-built release candidate, with those target-environment smoke tests still required.

## 2.2.0 validation gate

Run `npm run validate`. This executes version consistency, TypeScript compilation, linting, formatting checks, unit/integration tests, production build, Chromium production-bundle smoke testing when Chromium is available, and release-structure checks. Native Safari, real Penn SSH/Duo, Linux packaging, and Windows packaging remain untested in this release.

## 2.2.0 executed results

Executed in the Linux build environment on 2026-07-14:

- dependency installation from `package-lock.json`: passed
- TypeScript compilation: passed
- Vite production build: passed
- ESLint: passed
- Prettier check: passed
- 11 Node unit/integration tests: passed
- synthetic NMT, scanner, import, and Gaussian ROI transform validation: passed
- version consistency check: passed
- consolidated-documentation check: passed
- release-source checklist: passed
- macOS launcher shell syntax: passed
- server and profile-store syntax: passed
- bundled Apple Silicon and Intel Node files identified as Mach-O executables: passed

Not executed in this environment:

- production-bundle browser smoke test, because Chromium access to localhost is blocked by the execution environment
- native Safari
- native Firefox
- native Edge
- real macOS application launch
- real Penn SSH, key-passphrase, or Duo authentication
- real workstation file loading and export
- Linux application packaging
- Windows application packaging

## 2.2.2 surface validation

Executed automated tests verify that:

- an inflated pair is discovered independently of a very-inflated pair;
- Very Inflated is unavailable when either `lh.veryinflated` or `rh.veryinflated` is missing;
- a complete real very-inflated pair becomes available;
- the derived display surfaces preserve within-hemisphere geometry except for translation;
- inflated and very-inflated outputs retain their distinct source geometry;
- workstation materialization retrieves both very-inflated files;
- the old `surface-spacing-v2` cache is not reused.

## 2.2.2 validation additions

- Verified separate local and workstation export destination controls in source and regression tests.
- Verified that selecting a destination does not initiate export; the main Export button remains authoritative.
- Integration-tested browser-session lifecycle shutdown using a real local server and EventSource connection.
- Verified that the server remains alive while a browser session is connected and exits cleanly after the final session disconnects and the grace period expires.
- Statically validated launcher Terminal-tab cleanup logic and shell syntax. The actual Terminal window-closing behavior requires a real macOS smoke test.

## 2.4.0 lifecycle validation

Executed in the build environment: TypeScript build, production bundle build, lint, formatting, complete Node regression suite, authenticated localhost server tests, detached-server persistence test, launcher lifecycle structural checks, local-only SSH adapter tests, scientific transform tests, documentation checks, and release-structure checks.

Statically inspected but not executed here: macOS `launchctl submit`, Finder/Dock relaunch, Terminal SSH helper presentation and closure, actual default-browser opening, macOS sleep/wake, and real Penn SSH/Duo authentication. These require real-macOS smoke testing.

## 2.4.0 portability and browser hardening

Validated in the build environment: TypeScript, production build, linting, formatting, unit and integration tests, scientific transforms, filesystem-adapter contract, authenticated lifecycle endpoints, JSON schema presence, release consistency, and package integrity.

Playwright production-bundle tests are configured for Chromium, Firefox, and WebKit and run in CI when browser runtimes are installed. Native Safari and native Edge remain separate real-platform tests and are not represented by Playwright WebKit or Chromium.

Linux and Windows shared-source CI is configured. Linux and Windows distributable application packages are not yet included in this release.
