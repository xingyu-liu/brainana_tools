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

## 2.2.0 hardening status

The 2.2.0 release intentionally does not change scientific calculations, visualization controls, data formats, coordinate handling, or export semantics. It adds release and configuration hardening around the 2.1.1 behavior.

- Existing Viewer interface and scientific functionality: preserved
- Local-only SSH workstation architecture: preserved
- Adaptive surface spacing: preserved
- Dynamic template handling: preserved
- Workstation export workflow: preserved
- Saved profiles: preserved and migrated from TSV to schema-versioned JSON
- Bundled Apple Silicon and Intel Node runtimes: preserved
- Consolidated documentation: improved
- Reproducible validation gate: improved
- Chromium browser smoke harness: added, but not executed in this environment
- Linux and Windows packaged applications: still require implementation

## 2.2.2 surface source handling

- Inflated: preserved, sourced from the real `lh.inflated` and `rh.inflated` pair.
- Very Inflated: corrected, sourced only from `lh.veryinflated` and `rh.veryinflated`.
- Synthetic Very Inflated generation from ordinary inflated geometry: removed.
- Adaptive hemisphere spacing: preserved and applied independently to each available surface pair using translation only.
- Missing or incomplete Very Inflated pairs: the option remains unavailable rather than silently substituting another surface.
- Local and workstation discovery: both covered by automated regression tests.

## Export destinations and lifecycle

- Workstation mode supports direct export either to a local browser-selected folder or to a workstation folder over SSH.
- Destination selection only configures the output location; the main Export button performs the export.
- The local Viewer server tracks active browser sessions and shuts down after the final Viewer tab closes.
- The launcher then closes the SSH control connection and schedules closure of its own Terminal tab.

## Lifecycle parity in 2.4.0

- Local and workstation scientific, visualization, loading, and export behavior are unchanged.
- Persistent launcher Terminal windows were intentionally removed.
- Closing the browser no longer terminates the server immediately. Relaunching the same local configuration reopens the existing session.
- Remote launches continue to use normal system SSH prompts and no remote runtime.

## 2.4.0 hardening additions

- Existing scientific and visualization behavior: preserved.
- Existing local and workstation workflows: preserved.
- WebGL startup failure: improved with a visible diagnostic instead of a black screen.
- Detached application lifecycle: improved with authenticated status/quit controls and idle cleanup.
- Filesystem behavior: formalized through a shared adapter contract without changing path or export semantics.
- Cross-platform source validation: added through CI definitions; Linux and Windows packages remain future work.
