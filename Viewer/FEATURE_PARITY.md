# Feature parity and architecture status

## Preserved from the recovered v1.2.25 source

- Multi-planar NIfTI viewing and surface viewing
- ARM and D99 atlas display/reporting
- Retinotopy and somatotopy display
- Morphology overlays
- Imported NIfTI layers
- Gaussian ROI generation and transform validation outputs
- Surface projection and direct surface-marker dragging
- Snapshot images, metadata, state, and ZIP/local-folder export

## Integrated from the recent packaged Viewer

- Adaptive per-subject, per-surface hemisphere spacing
- Local and workstation launch modes
- Saved workstation profiles with add/edit/delete
- Random editable browser-facing port for every workstation launch
- macOS default-browser launch with a plain localhost URL
- Local proxy plus SSH-tunneled workstation data server
- Server-side workstation snapshot export with path containment and atomic writes

## New source-first architecture

- Shared profiles only; executable runtimes are version-specific
- Remote runtime: `~/.brainana-viewer/runtimes/2.0.0/`
- Atomic remote deployment and remote version verification
- `/api/health`, `/api/version`, and `/api/runtime`
- Explicit launcher, local server, remote server, and frontend build identity
- Dynamic template discovery from transform filenames
- Direction-specific import and export capabilities
- Template export requires both the T1w-to-template transform and a template-space anatomical T1w reference
- T1w and scanner are excluded from generic template discovery

## Browser behavior

The launcher uses the macOS default browser. Workstation export is server-side and does not depend on Chrome folder APIs. In local mode, direct folder saving is used when the browser supports it; otherwise ZIP download remains available.
