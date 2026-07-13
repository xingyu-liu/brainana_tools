# Changelog

## 0.16.0-parity.6

- Fixed silent exit after choosing Remote workstation on macOS when no profiles exist.
- Added visible Terminal-based SSH authentication and Duo/passphrase support.
- Added launcher diagnostics, persistent logs, and user-facing failure dialogs.
- Preserved the overlay crosshair synchronization fix from parity.2.

## 0.16.0-parity.6
- Fixed overlay crosshair synchronization so navigation in any overlay slice updates all three overlay planes while preserving MRI/CT linkage.

## 0.16.0-parity.6

- Restored complete v0.15.4 production frontend behavior.
- Bundled arm64 and x86_64 Node runtimes.
- Added local-only workstation architecture using persistent system SSH.
- Removed remote runtime upload, remote Node server, and SSH HTTP forwarding.
- Added health, version, and runtime diagnostics.
- Removed embedded example institutional profiles.

## 0.16.0-parity.6

Improved cold-browser startup by requesting the macOS default browser immediately after starting the bundled server, while retaining health and process-failure checks.

## 0.16.0-parity.6

Performance and reliability pass: coalesced redraws, cancellable remote loading, abandoned SSH-stream cleanup, live SSH health reporting, and explicit busy-port handling.
