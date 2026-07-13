# Feature parity status

This release reconstructs the retained v0.15.4 frontend behavior in readable TypeScript. The recovered minified frontend and injected export patch are not part of the production runtime.

| Feature | v0.15.4 reference | 0.16.0-parity.11 | Source status |
|---|---:|---:|---|
| MRI and CT loading | Yes | Yes | Readable TypeScript |
| Landmark editing | Yes | Yes | Readable TypeScript |
| Rigid fit and manual adjustment | Yes | Yes | Readable TypeScript |
| Automatic NMI refinement | Yes | Yes | Readable TypeScript |
| Optimization refinement windows | Yes | Yes | Readable TypeScript |
| Review overlay | Yes | Yes | Readable TypeScript |
| Transform and aligned-volume export | Yes | Yes | Readable TypeScript |
| Session save/load, including windows | Yes | Yes | Readable TypeScript |
| Workstation file browser | Yes | Yes | Readable TypeScript |
| Workstation export folder browser | Yes | Yes | Readable TypeScript |
| Bundled dual-architecture Node | No | Yes | Packaged runtime |
| Remote Node/server upload | Yes | No | Replaced with local SSH architecture |
| Compiled recovered frontend required | Yes | No | Absent from production runtime |

## Validation boundary

Build, static parity, server, packaging, and synthetic algorithm checks were completed in the current environment. Finder launch, interactive WebGL behavior, and institutional SSH/Duo remain real-machine smoke tests.


## Overlay crosshair synchronization
Validated in source and production build: changing the crosshair in any overlay plane updates sagittal, coronal, and axial overlay views through the shared 3D coordinate state.
