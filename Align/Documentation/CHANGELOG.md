# Changelog

## 0.16.0-parity.8

- Reproject landmark markers and optimization windows after zoom and mouse-drag pan in MRI, CT, and overlay panels.
- Restore overlay navigation synchronization with both the fixed and original moving image coordinates.
- Make optimization-window drawing use a shared view-card capture path for sagittal, coronal, and axial planes.
- Preserve the current slice depth explicitly while converting window gestures from screen coordinates to image coordinates.

## 0.16.0-parity.8

- Fixed silent exit after choosing Remote workstation on macOS when no profiles exist.
- Added visible Terminal-based SSH authentication and Duo/passphrase support.
- Added launcher diagnostics, persistent logs, and user-facing failure dialogs.
- Preserved the overlay crosshair synchronization fix from parity.2.

## 0.16.0-parity.8
- Fixed overlay crosshair synchronization so navigation in any overlay slice updates all three overlay planes while preserving MRI/CT linkage.

## 0.16.0-parity.8

- Restored complete v0.15.4 production frontend behavior.
- Bundled arm64 and x86_64 Node runtimes.
- Added local-only workstation architecture using persistent system SSH.
- Removed remote runtime upload, remote Node server, and SSH HTTP forwarding.
- Added health, version, and runtime diagnostics.
- Removed embedded example institutional profiles.

## 0.16.0-parity.8

Improved cold-browser startup by requesting the macOS default browser immediately after starting the bundled server, while retaining health and process-failure checks.

## 0.16.0-parity.8

Performance and reliability pass: coalesced redraws, cancellable remote loading, abandoned SSH-stream cleanup, live SSH health reporting, and explicit busy-port handling.

## 0.16.0-parity.8

Automatic operating-system-assigned browser ports replace manual port entry and collision dialogs. The default browser opens only after the assigned local server is healthy.


## 0.16.0-parity.11

Robust per-launch port handshake, synchronous atomic port publication, explicit startup errors, native Bash timing loops, and consistent IPv4 loopback URLs.
# Brainana Align 0.16.0-parity.11

## Fixed

- MRI axial optimization-window drawing now uses the same direct canvas, SVG overlay, and view-card capture path as every other MRI/CT plane.
- Optimization windows are evaluated as independent optional 2D constraints. A plane with no window is unrestricted and all voxels remain eligible with respect to that plane.
- Removed the precomputed 3D intersection step that could report that MRI windows did not intersect before sampling began.
- Improved the refinement error message when the windows that are actually defined leave too few fixed-image samples.

## Unchanged

- Rigid fitting, manual transforms, normalized mutual-information calculation, ROI handling, export calculations, workstation access, and startup/port behavior are unchanged from parity.9.

## 0.16.0-parity.13

Corrected initial MRI and CT panel messaging so that Loading is shown only during an actual file load.
