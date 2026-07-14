# Validation status

## Current release: 0.16.26-docs.1

This release changes documentation organization and release validation only. Application source and runtime behavior are unchanged from 0.16.25-local-start.1.

Completed checks:

- TypeScript and Vite production build
- release identity consistency
- documentation-layout enforcement
- source architecture checks
- coordinate, crosshair, landmark, and optimization-window tests
- scientific transform regression tests
- session and export tests
- server smoke, security, storage, and local-export tests
- platform path and SFTP transport tests
- browser UI and compatibility tests
- Chromium production-bundle engine test in the available environment
- launch-handshake and detached-lifecycle stress tests
- macOS runtime-selection, launchd, SSH cancellation, Terminal-helper, and Local-mode startup tests
- packaged frontend hash comparison
- bundled runtime and launcher verification
- ZIP integrity, release manifest, documentation inventory, and checksum validation

## Browser certification boundary

The repository requires Chromium, Firefox, and WebKit automation in CI. In the current build environment, only Chromium was available for execution. Firefox, WebKit, native Safari, and native Edge are not claimed as certified until their required tests run successfully. Native Safari remains necessary because WebKit automation does not fully test Safari-specific WebGL, graphics-driver, privacy, and file-dialog behavior.

## Native system boundary

Finder launch, Dock behavior, Terminal LaunchServices behavior, interactive institutional SSH authentication, sleep/wake, and real network interruption require validation on actual macOS hardware. The current remote authentication flow has been confirmed by the user on macOS after the SSH correction. Linux and Windows remain architectural foundations rather than deployable packages.

## Historical validation policy

Major changes to validation are summarized in `CHANGELOG.md`. Detailed historical snapshots remain available in prior release archives and version-control history rather than duplicated inside every new source package.
