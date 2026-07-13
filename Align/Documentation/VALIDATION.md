# Validation: Brainana Align 0.16.0-parity.11

## Completed

- Clean dependency installation with `npm ci`.
- TypeScript compilation and production Vite build.
- Local server smoke test.
- Launcher shell syntax validation.
- Server JavaScript syntax validation.
- Existing repeated and concurrent port-handshake stress test.
- Source inspection confirming direct optimization-window pointer capture on the view card, canvas, and SVG overlay.
- Source inspection confirming undefined planes are ignored and therefore impose no optimization restriction.
- Source inspection confirming the old precomputed 3D-window intersection error path is absent.
- Apple Silicon and Intel bundled Node binaries retained and checked as executable Mach-O files.
- ZIP integrity and executable-permission checks.

## Real-machine checks still required

- Draw an MRI axial optimization window and verify that it appears immediately.
- Draw windows in any subset of MRI and CT planes and verify that undefined planes remain unrestricted.
- Run refinement using sagittal and coronal MRI windows with no axial MRI window.
